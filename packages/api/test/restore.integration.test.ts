import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { portability, type Actor } from "@opentradesos/core";
import * as dataExport from "../src/services/export";
import * as restoreService from "../src/services/restore";
import * as files from "../src/services/files";
import * as workflows from "../src/services/workflows";
import { writeArchive } from "../src/portability/archive";
import { writeNdjson } from "../src/portability/ndjson";
import { openCopy } from "../src/portability/reader";
import type { ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PUTTING A COPY BACK
 *
 * THE TEST THAT MATTERS is the round trip: take the demo company the seed
 * builds (a day of work, invoices, payments and the ledger behind them, an
 * estimate, agreements, payroll, stock, a logo) plus a photograph and a
 * customer who referred another, copy it, restore the copy into a new company,
 * copy THAT, and compare the two copies table by table: the same number of
 * rows, and the same values in every column that left.
 *
 * Twice, because the two ways a restore can go are different code: beside the
 * original on the same deployment, where every id has to be renumbered and
 * every reference to it rewritten, and onto a deployment where the original is
 * not, where every id is kept. The second is staged here by removing the
 * original and its people before restoring, which is what "another
 * deployment" looks like from inside the database.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const TARGET = fixtureId("restore30:target");
const RESTORER = fixtureId("restore30:restorer");
const RESTORER_EMAIL = "restore30-target@test.local";
const OTHER = fixtureId("restore30:other");
const OTHER_USER = fixtureId("restore30:other-user");

let raw: postgres.Sql;
let folder: string;
const db = () => testDb(url!);

const actor = (organizationId: string, userId: string, roles: string[] = ["owner"]): ServiceContext => ({
  actor: { userId, organizationId, roles: roles as Actor["roles"] }, db: db(),
});

const exec = promisify(execFile);

/** The demo company, built by the seed itself, so this test copies what a contractor would see. */
async function seedDemo(): Promise<{ org: string; owner: string }> {
  await exec("pnpm", ["exec", "tsx", "src/seed/index.ts"], {
    cwd: join(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: url! }, timeout: 180_000,
  });
  const [org] = await raw<{ id: string }[]>`select id from public.organization where slug = 'ridgeline'`;
  const [owner] = await raw<{ id: string }[]>`select id from public."user" where email = 'owner@ridgeline.example'`;
  return { org: org!.id, owner: owner!.id };
}

/** A photograph, a referral and the things a restore holds back, on top of the seed. */
async function enrich(org: string, owner: string): Promise<void> {
  const ctx = actor(org, owner);
  const [job] = await raw<{ id: string }[]>`select id from public.job where organization_id = ${org} limit 1`;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b3f5d90000000049454e44ae426082", "hex");
  await files.upload(ctx, { entityType: "job", entityId: job!.id, fileName: "before.png", bytes: png.toString("base64") });
  const [first, second] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${org} order by id limit 2`;
  await raw`update public.customer set referred_by_customer_id = ${first!.id} where id = ${second!.id}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref)
            values (${org}, 'messaging', 'twilio', 'connected', 'RIDGELINE_TWILIO_TOKEN')`;
  await raw`insert into public.webhook_endpoint (organization_id, url, secret_ref, events)
            values (${org}, 'https://example.test/hook', 'whsec_live_secret', '["job.created"]'::jsonb)`;
}

/** A copy of a company, as either file, on disk. */
async function takeCopy(ctx: ServiceContext, format: "archive" | "ndjson", name: string): Promise<string> {
  const chunks: Buffer[] = [];
  await dataExport.withSnapshot(ctx, "archive", (source) =>
    (format === "archive" ? writeArchive : writeNdjson)(source, async (chunk) => { chunks.push(Buffer.from(chunk)); }));
  const path = join(folder, name);
  await writeFile(path, Buffer.concat(chunks));
  return path;
}

/**
 * Every table's rows in a copy, as canonical text, after the company's id is
 * made the same on both sides and, when renumbering, every id is made the same
 * placeholder. What remains is every value that is not an id.
 */
async function census(path: string, organizationId: string, ids: "kept" | "renumbered") {
  const copy = await openCopy(path);
  try {
    const out = new Map<string, string[]>();
    for (const table of copy.manifest.tables) {
      const rows: string[] = [];
      for await (const batch of copy.rows(table.table)) {
        for (const row of batch.rows) {
          let text = JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]));
          text = text.split(organizationId).join("<company>");
          if (ids === "renumbered") text = text.replace(portability.UUID_IN_TEXT, "<id>");
          rows.push(text);
        }
      }
      out.set(table.table, rows.sort());
    }
    return { tables: out, manifest: copy.manifest, files: [...copy.files.keys()].map((k) => k.split(organizationId).join("<company>")).sort() };
  } finally {
    await copy.close();
  }
}

/** The two copies hold the same company: every table the same rows, the trail of the restore itself aside. */
function expectSameCompany(
  before: Awaited<ReturnType<typeof census>>, after: Awaited<ReturnType<typeof census>>,
  /** The person restoring, when the copy did not have them: their membership is the one row the restore adds. */
  addedMember?: string,
) {
  for (const [table, rows] of before.tables) {
    let restored = after.tables.get(table) ?? [];
    if (table === "membership" && addedMember) restored = restored.filter((row) => !row.includes(addedMember));
    if (table === "audit_log" || table === "restore_run") {
      // The restored company's own trail (the restore, the copy of it) comes on top of the original's.
      const left = [...restored];
      for (const row of rows) {
        const at = left.indexOf(row);
        expect(at, `an audit line of the original is missing from the restored company: ${row.slice(0, 200)}`).toBeGreaterThanOrEqual(0);
        left.splice(at, 1);
      }
      continue;
    }
    expect(restored.length, `${table} has ${rows.length} rows in the original and ${restored.length} restored`).toBe(rows.length);
    expect(restored, `${table} differs`).toEqual(rows);
  }
  expect(after.files).toEqual(before.files);
  const company = (m: dataExport.Manifest) => ({ ...m.company, created_at: null });
  expect(company(after.manifest)).toEqual(company(before.manifest));
  expect(after.manifest.people.filter((p) => p.userId !== addedMember).map((p) => p.email).sort())
    .toEqual(before.manifest.people.map((p) => p.email).sort());
}

async function freshTarget(): Promise<void> {
  await seedOrg(raw, { organizationId: TARGET, userId: RESTORER, name: "Fresh Start", slug: "restore30-target" });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  folder = await mkdtemp(join(tmpdir(), "ots-restore-"));
});
afterAll(async () => {
  if (raw) {
    await resetOrg(raw, TARGET);
    await resetOrg(raw, OTHER);
    await raw.end();
  }
  if (folder) await rm(folder, { recursive: true, force: true });
});

run("the round trip", () => {
  it("restores the demo company beside itself, renumbering every id, and the copy of the copy is the same company", { timeout: 300_000 }, async () => {
    const demo = await seedDemo();
    await enrich(demo.org, demo.owner);
    await freshTarget();
    /**
     * The person restoring runs the original too, which is the case of
     * restoring a copy beside the company it was taken from: the original's
     * people are linked rather than refused.
     */
    await raw`insert into public.membership (organization_id, user_id, role) values (${demo.org}, ${RESTORER}, 'owner')`;

    const original = await takeCopy(actor(demo.org, demo.owner), "archive", "original.zip");
    const checked = await restoreService.restore(actor(TARGET, RESTORER), {
      path: original, source: "upload", sourceName: "original.zip", dryRun: true, keepSending: true,
    });
    expect(checked.report.refusals).toEqual([]);
    expect(checked.report.outcome).toBe("checked");
    const [row1] = await raw<{ n: number }[]>`select count(*)::int as n from public.customer where organization_id = ${TARGET}`;
    const { n: nothingYet } = row1!;
    expect(nothingYet).toBe(0);

    const done = await restoreService.restore(actor(TARGET, RESTORER), {
      path: original, source: "upload", sourceName: "original.zip", dryRun: false, keepSending: true,
    });
    expect(done.report.refusals).toEqual([]);
    expect(done.report.outcome).toBe("restored");
    expect(done.report.ids).toBe("renumbered");
    expect(done.report.files.restored).toBe(1);
    expect(done.report.restoredRows).toBeGreaterThan(300);
    expect(done.report.people.find((p) => p.email === RESTORER_EMAIL)?.outcome).toBe("you");
    expect(done.report.people.find((p) => p.email === "owner@ridgeline.example")?.outcome).toBe("linked");

    // Nothing in the restored company points at the original.
    const [row2] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.job j
      where j.organization_id = ${TARGET} and exists (select 1 from public.job o where o.id = j.id and o.organization_id = ${demo.org})`;
    const { n: strays } = row2!;
    expect(strays).toBe(0);
    const [referred] = await raw<{ ok: boolean }[]>`
      select bool_and(r.organization_id = ${TARGET}) as ok from public.customer c
      join public.customer r on r.id = c.referred_by_customer_id where c.organization_id = ${TARGET}`;
    expect(referred!.ok).toBe(true);
    const [photo] = await raw<{ storage_key: string; size: number }[]>`
      select storage_key, octet_length(bytes) as size from public.stored_file where organization_id = ${TARGET}`;
    expect(photo!.storage_key.startsWith(`${TARGET}/`)).toBe(true);
    expect(photo!.size).toBeGreaterThan(0);
    const [row3] = await raw<{ balanced: string }[]>`
      select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::text as balanced
      from public.ledger_entry where organization_id = ${TARGET}`;
    const { balanced } = row3!;
    expect(Number(balanced)).toBe(0);

    const restored = await takeCopy(actor(TARGET, RESTORER), "archive", "restored.zip");
    const before = await census(original, demo.org, "renumbered");
    const after = await census(restored, TARGET, "renumbered");
    // The person restoring was already in the company; the copy's own row for them is merged, not added.
    expectSameCompany(before, after);
  });

  it("restores onto a deployment where the original is not, keeping every id", { timeout: 300_000 }, async () => {
    const demo = await seedDemo();
    await enrich(demo.org, demo.owner);
    const original = await takeCopy(actor(demo.org, demo.owner), "ndjson", "original.ndjson");
    const [customer] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${demo.org} limit 1`;

    // Another deployment: the company and the people it had are not here.
    await resetOrg(raw, demo.org);
    await raw`delete from public."user" where email like '%@ridgeline.example'`;
    await freshTarget();

    const done = await restoreService.restore(actor(TARGET, RESTORER), {
      path: original, source: "upload", sourceName: "original.ndjson", dryRun: false, keepSending: true,
    });
    expect(done.report.refusals).toEqual([]);
    expect(done.report.ids).toBe("kept");
    expect(done.report.people.filter((p) => p.outcome === "new").length).toBe(4);
    const [kept] = await raw<{ organization_id: string }[]>`select organization_id from public.customer where id = ${customer!.id}`;
    expect(kept!.organization_id).toBe(TARGET);

    const restored = await takeCopy(actor(TARGET, RESTORER), "ndjson", "restored.ndjson");
    expectSameCompany(await census(original, demo.org, "kept"), await census(restored, TARGET, "kept"), RESTORER);

    // The people came back as accounts with no password, ready for a first-password link.
    const [row4] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.credential c join public."user" u on u.id = c.user_id
      where u.email like '%@ridgeline.example'`;
    const { n: passwords } = row4!;
    expect(passwords).toBe(0);
    // The demo company back as the seed makes it, for whatever runs next. It holds the same ids, so the restore goes first.
    await resetOrg(raw, TARGET);
    await seedDemo();
  });
});

run("refusing", () => {
  let copyPath: string;

  /** Small Co and its owner are not on this deployment: the copy is all there is of them. */
  async function forgetSmallCo() {
    await resetOrg(raw, OTHER);
    await raw`delete from public."user" where id = ${OTHER_USER}`;
  }

  beforeEach(async () => {
    await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Small Co", slug: "restore30-other" });
    await raw`insert into public.customer (organization_id, type, name, payment_terms_days) values (${OTHER}, 'residential', 'Only One', 0)`;
    await raw`insert into public.portal_grant (organization_id, scope, entity_id, token_hash, expires_at)
              select ${OTHER}, 'customer', id, ${"f".repeat(64)}, now() + interval '1 day'
              from public.customer where organization_id = ${OTHER}`.catch(() => undefined);
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref)
              values (${OTHER}, 'messaging', 'twilio', 'connected', 'SMALL_TWILIO_TOKEN')`;
    await raw`insert into public.webhook_endpoint (organization_id, url, secret_ref, events)
              values (${OTHER}, 'https://example.test/hook', 'whsec_live_secret', '[]'::jsonb)`;
    copyPath = await takeCopy(actor(OTHER, OTHER_USER), "archive", "small.zip");
    await freshTarget();
  });

  it("refuses a company that already has records, and says what they are", async () => {
    await raw`insert into public.customer (organization_id, type, name, payment_terms_days) values (${TARGET}, 'residential', 'Already Here', 0)`;
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: true,
    });
    expect(result.report.outcome).toBe("refused");
    expect(result.report.refusals.join(" ")).toMatch(/already has records.*1 customer/);
  });

  it("takes a company that was just signed up for, whose starter automations the copy replaces", async () => {
    await forgetSmallCo();
    await workflows.installStarters(actor(TARGET, RESTORER));
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: false,
    });
    expect(result.report.refusals).toEqual([]);
    const [row5] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.workflow w where organization_id = ${TARGET}
      and exists (select 1 from public.workflow x where x.organization_id = ${TARGET} and x.template_key = w.template_key and x.id <> w.id)`;
    const { n } = row5!;
    expect(n).toBe(0);
  });

  it("refuses a copy that stops part way", async () => {
    const bytes = await readFile(copyPath);
    const cut = join(folder, "cut.zip");
    await writeFile(cut, bytes.subarray(0, bytes.length - 40));
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: cut, source: "upload", sourceName: "cut.zip", dryRun: true,
    });
    expect(result.report.outcome).toBe("refused");
    expect(result.report.refusals.join(" ")).toMatch(/stopped part way/);
  });

  it("refuses to add an existing account that works for a company the person restoring does not run", async () => {
    // The copy's owner has an account here, with Small Co, which the restorer has nothing to do with.
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: true,
    });
    expect(result.report.people.find((p) => p.email === "restore30-other@test.local")?.outcome).toBe("elsewhere");
    expect(result.report.refusals.join(" ")).toMatch(/restore30-other@test\.local already has an account/);
  });

  it("writes nothing on a dry run, and remembers that it was checked", async () => {
    await forgetSmallCo();
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: true,
    });
    expect(result.report.refusals).toEqual([]);
    expect(result.report.outcome).toBe("checked");
    expect(result.report.tables.find((t) => t.table === "customer")).toMatchObject({ inCopy: 1, restored: 1 });
    const [row6] = await raw<{ n: number }[]>`select count(*)::int as n from public.customer where organization_id = ${TARGET}`;
    const { n } = row6!;
    expect(n).toBe(0);
    const runs = await restoreService.listRuns(actor(TARGET, RESTORER));
    expect(runs[0]).toMatchObject({ id: result.runId, dryRun: true, outcome: "checked" });
  });

  it("lists what was held back to set up again, and holds sending until somebody has looked", async () => {
    await forgetSmallCo();
    const result = await restoreService.restore(actor(TARGET, RESTORER), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: false,
    });
    expect(result.report.refusals).toEqual([]);
    expect(result.report.setUpAgain.map((s) => `${s.table}.${s.column}`)).toContain("webhook_endpoint.secret_ref");
    expect(result.report.secretNames).toEqual(["SMALL_TWILIO_TOKEN"]);
    expect(result.report.held).toEqual({ connections: 1, webhooks: 1 });
    const [connection] = await raw<{ status: string }[]>`select status from public.integration_connection where organization_id = ${TARGET}`;
    expect(connection!.status).toBe("needs_reauth");
    const [hook] = await raw<{ active: boolean; secret_ref: string }[]>`select active, secret_ref from public.webhook_endpoint where organization_id = ${TARGET}`;
    expect(hook!.active).toBe(false);
    // A secret the database requires is a fresh one that matches nothing, never the original.
    expect(hook!.secret_ref).not.toBe("whsec_live_secret");
  });

  it("answers a retry of a restore that went through with the same restore", async () => {
    await forgetSmallCo();
    const ctx = { ...actor(TARGET, RESTORER), idempotencyKey: "restore30-retry" };
    const first = await restoreService.restore(ctx, { path: copyPath, source: "upload", sourceName: "small.zip", dryRun: false });
    const again = await restoreService.restore(ctx, { path: copyPath, source: "upload", sourceName: "small.zip", dryRun: false });
    expect(again.runId).toBe(first.runId);
    expect(again.report.outcome).toBe("restored");
  });

  it("needs data:import", async () => {
    await expect(restoreService.restore(actor(TARGET, RESTORER, ["admin"]), {
      path: copyPath, source: "upload", sourceName: "small.zip", dryRun: true,
    })).rejects.toThrow(/permission/);
  });
});
