import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import * as inspections from "../src/services/inspections";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as fieldOps from "../src/services/field";
import { applyTradePack, upgradeTo } from "../src/services/trade-pack";
import { dispatch } from "../src/http/dispatch";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY WRITES ITS OWN INSPECTION PROGRAMME
 *
 * A programme came only from a trade pack, and every programme a pack ships
 * today asks for a reading with no range somewhere, which core refuses to
 * judge: an inspection could not be filed against any of them. So a company
 * running inspections had no programme it could actually use, and no way to
 * write one.
 *
 * These are the rules that make one safe to write: it is checked at the save,
 * a revision publishes a new version and keeps the old one whole, an
 * inspection keeps the version it was done under (including one done offline
 * against a version since replaced), and a copy of a pack's programme says
 * where it came from.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("own-programme:org");
const USER = fixtureId("own-programme:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], grants: Actor["grants"] = [], revocations: Actor["revocations"] = []): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, grants, revocations }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let technicianId = "";
const inspector = () => as(["technician"], ["compliance:read", "compliance:write"]);

const CHECKPOINTS = [
  { key: "shutoff", label: "Number 1 shutoff holds", severityOnFail: "critical" as const },
  {
    key: "psi", label: "Differential pressure", requiresReading: true, unit: "psid",
    range: { min: 5, max: null }, severityOnFail: "major" as const, assetCategory: "backflow-assembly",
  },
  {
    key: "housekeeping", label: "Enclosure tidy", severityOnFail: "advisory" as const,
    remedies: [{ priceBookItemKey: "ENCL-CLEAN", label: "Clear the enclosure", quantity: 1, rationale: "Access for the next test." }],
  },
];

const OURS = {
  name: "Our backflow test",
  standard: "AWWA C510",
  reportAudience: "authority" as const,
  authorityName: "City of Austin Water",
  frequencyMonths: 12,
  checkpoints: CHECKPOINTS,
};

const at = new Date("2026-05-01T15:00:00Z");
const answer = (itemKey: string, value: unknown) => ({ itemKey, value: value as never, at, by: "Ray Nunez" });
const allPass = [
  answer("shutoff", { kind: "pass_fail", passed: true }),
  answer("psi", { kind: "reading", raw: 9 }),
  answer("housekeeping", { kind: "pass_fail", passed: true }),
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Own Programme Co", slug: "own-programme-co" });

  const customer = await customers.create(owner(), {
    type: "commercial", name: "Lakeside Offices", phone: "+15125550931",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "31 Lakeside Dr", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  const [membership] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.deficiency where organization_id = ${ORG}`;
  await raw`delete from public.inspection where organization_id = ${ORG}`;
  await raw`delete from public.inspection_program where organization_id = ${ORG}`;
});

run("writing a programme of the company's own", () => {
  it("is version 1, offered at once, kept whole, and audited", async () => {
    const row = await inspections.defineProgram(owner(), { ...OURS, note: "First go" });
    expect(row).toMatchObject({ version: 1, active: true, tradePackId: null, copiedFrom: null });

    const view = await inspections.program(owner(), { id: row.id });
    expect(view.program).toMatchObject({ name: "Our backflow test", ready: true, problems: [], checkpointCount: 3 });
    expect(view.program.checkpoints[1]).toMatchObject({ key: "psi", assetCategory: "backflow-assembly", range: { min: 5, max: null } });
    expect(view.versions).toEqual([expect.objectContaining({ version: 1, note: "First go", changed: [] })]);

    const [kept] = await raw<{ version: number; name: string; published_by_user_id: string }[]>`
      select version, name, published_by_user_id from public.inspection_program_version where program_id = ${row.id}`;
    expect(kept).toMatchObject({ version: 1, name: "Our backflow test", published_by_user_id: USER });
    const [line] = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${row.id}`;
    expect(line).toMatchObject({ action: "inspection_program.defined" });

    expect((await inspections.programs(owner())).map((p) => p.name)).toContain("Our backflow test");
  });

  it("refuses a checkpoint whose fail is a finding and does not say how serious", async () => {
    /**
     * Core will not default it, and the pack loader defaults it to minor. A
     * person who left the box empty has not decided a fail is wear.
     */
    await expect(inspections.defineProgram(owner(), {
      ...OURS, checkpoints: [{ key: "gate", label: "Gate latches" }],
    })).rejects.toThrow(/"Gate latches" does not say how serious a fail is/);

    /**
     * Saying a fail is not a finding does not get round it: core still will
     * not take an item that can fail with no meaning for the failure.
     */
    await expect(inspections.defineProgram(owner(), {
      ...OURS, checkpoints: [{ key: "gate", label: "Gate latches", failIsDeficiency: false }],
    })).rejects.toThrow(/does not say what a failure means/);
  });

  it("refuses what core would not judge, at the save, in core's words", async () => {
    await expect(inspections.defineProgram(owner(), {
      ...OURS,
      checkpoints: [{ key: "psi", label: "Differential pressure", requiresReading: true, unit: "psid", severityOnFail: "major" as const }],
    })).rejects.toThrow(/no acceptable range/i);
  });

  it("will not offer two programmes under one name, unless the new one takes the old one's place", async () => {
    const first = await inspections.defineProgram(owner(), OURS);
    await expect(inspections.defineProgram(owner(), { ...OURS, name: "  our BACKFLOW test " }))
      .rejects.toThrow(/already offered a programme called "Our backflow test"/);

    const second = await inspections.defineProgram(owner(), { ...OURS, replaces: first.id });
    const offered = await inspections.programs(owner());
    expect(offered.filter((p) => p.name === "Our backflow test").map((p) => p.id)).toEqual([second.id]);
    const all = await inspections.programs(owner(), { includeRetired: true });
    expect(all.find((p) => p.id === first.id)).toMatchObject({ active: false });

    const [line] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and entity_id = ${first.id} and action = 'inspection_program.withdrawn'`;
    expect(line!["after"]).toMatchObject({ active: false, replacedBy: second.id });
  });

  it("refuses a role without compliance:write, and lets compliance:read look", async () => {
    await expect(inspections.defineProgram(as(["office_manager"], ["compliance:read"]), OURS))
      .rejects.toBeInstanceOf(PermissionError);
    const row = await inspections.defineProgram(owner(), OURS);
    await expect(inspections.program(as(["office_manager"], ["compliance:read"]), { id: row.id })).resolves.toBeTruthy();
    await expect(inspections.program(as(["technician"]), { id: row.id })).rejects.toBeInstanceOf(PermissionError);
    await expect(inspections.reviseProgram(as(["office_manager"], ["compliance:read"]), { id: row.id, standard: "x" }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(inspections.setOffered(as(["office_manager"], ["compliance:read"]), { id: row.id, offered: false }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("revising it", () => {
  it("publishes a new version, keeps the old one whole, and says what changed", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    const revised = await inspections.reviseProgram(owner(), {
      id: row.id, baseVersion: 1, note: "The water authority wants the gauge checked",
      standard: "AWWA C510 (2024)",
      checkpoints: [...CHECKPOINTS, { key: "gauge", label: "Gauge in calibration", severityOnFail: "major" as const }],
    });
    expect(revised.version).toBe(2);

    const view = await inspections.program(owner(), { id: row.id });
    expect(view.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(view.versions[0]).toMatchObject({ changed: ["checkpoints", "standard"], note: "The water authority wants the gauge checked" });

    const old = await inspections.programVersion(owner(), { id: row.id, version: 1 });
    expect(old).toMatchObject({ current: false, standard: "AWWA C510" });
    expect(old.checkpoints.map((c) => c.key)).toEqual(["shutoff", "psi", "housekeeping"]);
    const now = await inspections.programVersion(owner(), { id: row.id, version: 2 });
    expect(now.checkpoints.map((c) => c.key)).toEqual(["shutoff", "psi", "housekeeping", "gauge"]);
    await expect(inspections.programVersion(owner(), { id: row.id, version: 7 })).rejects.toThrow(/Version 7/);
  });

  it("refuses to write over a version somebody else published while it was open", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    await inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, frequencyMonths: 6 });
    await expect(inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, frequencyMonths: 24 }))
      .rejects.toThrow(/Somebody published version 2/);
    const [current] = await raw`select version, frequency_months from public.inspection_program where id = ${row.id}`;
    expect(current).toMatchObject({ version: 2, frequency_months: 6 });
  });

  it("publishes nothing when nothing changed", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    const same = await inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, ...OURS });
    expect(same.version).toBe(1);
    const [{ count }] = await raw<{ count: number }[]>`
      select count(*)::int as count from public.inspection_program_version where program_id = ${row.id}`;
    expect(count).toBe(1);
  });

  it("keeps a pack's programme's name, and keeps the version a pack set up before versions were kept", async () => {
    /** As a pack set one up before this change: a row and no kept version. */
    const [pack] = await raw<{ id: string }[]>`
      insert into public.inspection_program (organization_id, name, standard, trade_pack_id, checkpoints, version)
      values (${ORG}, 'Pack backflow test', 'AWWA', 'plumbing@2', ${raw.json(CHECKPOINTS as never)}, 3)
      returning id`;
    await expect(inspections.reviseProgram(owner(), { id: pack!.id, baseVersion: 3, name: "Renamed" }))
      .rejects.toThrow(/came with a trade pack, which knows it by that name/);

    await inspections.reviseProgram(owner(), { id: pack!.id, baseVersion: 3, standard: "AWWA C511" });
    const view = await inspections.program(owner(), { id: pack!.id });
    expect(view.versions.map((v) => v.version)).toEqual([4, 3]);
    expect((await inspections.programVersion(owner(), { id: pack!.id, version: 3 })).standard).toBe("AWWA");
  });
});

run("an inspection keeps the version it was done under", () => {
  it("prints the name, standard and authority it was done under after they are revised", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    const filed = await inspections.record(owner(), { programId: row.id, propertyId, customerId, answers: allPass });

    await inspections.reviseProgram(owner(), {
      id: row.id, baseVersion: 1, name: "Our backflow and gauge test", standard: "Local rule 9",
      authorityName: "Travis County", checkpoints: [CHECKPOINTS[0]!],
    });

    const report = await inspections.report(owner(), { id: filed.id });
    expect(report.program).toMatchObject({
      name: "Our backflow test", standard: "AWWA C510", authorityName: "City of Austin Water", version: 1,
    });
    expect(report.items.map((i) => i.key)).toEqual(["shutoff", "psi", "housekeeping"]);
  });

  it("files one done offline against the version the technician was shown", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    // The office drops the housekeeping checkpoint while the technician is in a plant room with version 1.
    await inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, checkpoints: CHECKPOINTS.slice(0, 2) });

    /** Without the version, the answers are judged against version 2 and the work is refused, as core says. */
    await expect(inspections.record(owner(), { programId: row.id, propertyId, customerId, answers: allPass }))
      .rejects.toThrow();

    const filed = await inspections.record(owner(), {
      programId: row.id, programVersion: 1, propertyId, customerId,
      answers: [...allPass.slice(0, 2), answer("housekeeping", { kind: "pass_fail", passed: false })],
    });
    expect(filed).toMatchObject({ result: "pass_with_deficiencies", deficiencies: 1 });
    const [kept] = await raw<{ program_version: number; checkpoints: { key: string }[] }[]>`
      select program_version, checkpoints from public.inspection where id = ${filed.id}`;
    expect(kept!.program_version).toBe(1);
    expect(kept!.checkpoints.map((c) => c.key)).toEqual(["shutoff", "psi", "housekeeping"]);
    const [finding] = await raw<{ remedies: { priceBookItemKey: string }[] }[]>`
      select remedies from public.deficiency where inspection_id = ${filed.id}`;
    expect(finding!.remedies[0]!.priceBookItemKey).toBe("ENCL-CLEAN");
  });

  it("files from the phone against the version the phone ran", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    await inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, checkpoints: CHECKPOINTS.slice(0, 2) });

    const [job] = await raw<{ id: string }[]>`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 9301, ${customerId}, ${propertyId}, 'scheduled', 'Backflow test') returning id`;
    const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start)
      values (${ORG}, ${job!.id}, 'working', now()) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;
    const device = (await fieldOps.register(inspector(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;
    const inspectionId = crypto.randomUUID();
    const result = await fieldOps.sync(inspector(), {
      deviceId: device,
      operations: [{
        clientId: crypto.randomUUID(), sequence: 1, kind: "inspection.record", subjectId: inspectionId,
        occurredAt: at.toISOString(),
        payload: {
          visitId: visit!.id, programId: row.id, programVersion: 1,
          answers: allPass.map((a) => ({ ...a, at: a.at.toISOString() })),
        },
      }],
    });
    expect(result.results[0]).toMatchObject({ status: "applied", rejection: null });
    const [kept] = await raw`select program_version from public.inspection where id = ${inspectionId}`;
    expect(kept).toMatchObject({ program_version: 1 });
  });
});

run("offering it to technicians", () => {
  it("stops offering one and keeps it, and will not offer again one that cannot be filed", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    await inspections.setOffered(owner(), { id: row.id, offered: false });
    expect((await inspections.programs(owner())).map((p) => p.id)).not.toContain(row.id);

    const replacement = await inspections.defineProgram(owner(), OURS);
    await expect(inspections.setOffered(owner(), { id: row.id, offered: true }))
      .rejects.toThrow(/already offered a programme called/);
    await inspections.setOffered(owner(), { id: replacement.id, offered: false });
    await inspections.setOffered(owner(), { id: row.id, offered: true });
    expect((await inspections.programs(owner())).map((p) => p.id)).toContain(row.id);

    /** A pack's programme as shipped: a reading with no range, which nobody can finish. */
    const [broken] = await raw<{ id: string }[]>`
      insert into public.inspection_program (organization_id, name, checkpoints, active)
      values (${ORG}, 'Broken', ${raw.json([{ key: "r", label: "A reading", requiresReading: true, unit: "V", severityOnFail: "major" }] as never)}, false)
      returning id`;
    await expect(inspections.setOffered(owner(), { id: broken!.id, offered: true }))
      .rejects.toThrow(/Broken cannot be filed as it stands/);
    const listed = await inspections.programs(owner(), { includeRetired: true });
    expect(listed.find((p) => p.id === broken!.id)).toMatchObject({ ready: false, active: false });
    expect(listed.find((p) => p.id === broken!.id)!.problems.join(" ")).toMatch(/no acceptable range/);

    const actions = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${row.id} order by created_at`;
    expect(actions.map((a) => a.action)).toEqual([
      "inspection_program.defined", "inspection_program.withdrawn", "inspection_program.offered",
    ]);
  });
});

run("starting from a trade pack's programme", () => {
  const plumbing = packById("plumbing")!;
  const backflow = plumbing.inspectionPrograms.find((p) => p.code === "backflow-annual")!;

  it("lists every pack's programmes, the company's trade first, with what needs fixing", async () => {
    await applyTradePack(owner(), "plumbing");
    const listed = await inspections.packPrograms(owner());
    expect(listed[0]!.packId).toBe("plumbing");
    const entry = listed.find((p) => p.packId === "plumbing" && p.code === "backflow-annual")!;
    expect(entry).toMatchObject({ yourTrade: true, name: backflow.name, packVersion: plumbing.version });
    expect(entry.problems.join(" ")).toMatch(/no acceptable range/);
    /** The pack set its own copy up when it was applied, and it is named, so a copy can take its place. */
    expect(entry.inCompany).toMatchObject({ offered: true });

    /** Applying the pack kept version 1 of what it set up. */
    const [kept] = await raw<{ trade_pack_id: string }[]>`
      select trade_pack_id from public.inspection_program_version where program_id = ${entry.inCompany!.id} and version = 1`;
    expect(kept!.trade_pack_id).toBe(`plumbing@${plumbing.version}`);
  });

  it("saves a fixed copy that says where it came from, in the pack's place, under the pack's name", async () => {
    await applyTradePack(owner(), "plumbing");
    const entry = (await inspections.packPrograms(owner())).find((p) => p.code === "backflow-annual")!;
    const fixed = entry.checkpoints.map((c) => (c.requiresReading ? { ...c, unit: c.unit ?? "psid", range: { min: 1, max: null } } : c));

    await expect(inspections.defineProgram(owner(), {
      name: entry.name, checkpoints: fixed, copiedFrom: { kind: "trade_pack", packId: "plumbing", code: "backflow-annual" },
    })).rejects.toThrow(/already offered/);

    const copy = await inspections.defineProgram(owner(), {
      name: entry.name, standard: entry.standard, frequencyMonths: entry.frequencyMonths, checkpoints: fixed,
      copiedFrom: { kind: "trade_pack", packId: "plumbing", code: "backflow-annual" },
      replaces: entry.inCompany!.id,
    });
    expect(copy.copiedFrom).toEqual({
      kind: "trade_pack", packId: "plumbing", packVersion: plumbing.version, code: "backflow-annual", name: backflow.name,
    });
    expect(copy.tradePackId).toBeNull();
    const offered = (await inspections.programs(owner())).filter((p) => p.name === entry.name);
    expect(offered.map((p) => p.id)).toEqual([copy.id]);

    await expect(inspections.defineProgram(owner(), {
      ...OURS, copiedFrom: { kind: "trade_pack", packId: "plumbing", code: "no-such-programme" },
    })).rejects.toThrow(/Trade pack programme/);
  });

  it("copies one of the company's own, naming the version it was copied from", async () => {
    const row = await inspections.defineProgram(owner(), OURS);
    await inspections.reviseProgram(owner(), { id: row.id, baseVersion: 1, frequencyMonths: 6 });
    const copy = await inspections.defineProgram(owner(), {
      ...OURS, name: "Our backflow test, kitchens", copiedFrom: { kind: "program", programId: row.id },
    });
    expect(copy.copiedFrom).toEqual({ kind: "program", programId: row.id, version: 2, name: "Our backflow test" });
  });

  it("keeps each version a pack upgrade writes over one nobody here touched", async () => {
    await applyTradePack(owner(), "plumbing");
    const [seeded] = await raw<{ id: string }[]>`
      select id from public.inspection_program where organization_id = ${ORG} and name = ${backflow.name}`;
    const next: TradePack = {
      ...plumbing,
      version: plumbing.version + 1,
      inspectionPrograms: plumbing.inspectionPrograms.map((p) => (p.code === "backflow-annual" ? { ...p, frequencyMonths: 24 } : p)),
    } as TradePack;
    await upgradeTo(owner(), next);

    const versions = await raw<{ version: number; trade_pack_id: string; frequency_months: number | null; changed: string[] }[]>`
      select version, trade_pack_id, frequency_months, changed from public.inspection_program_version
      where program_id = ${seeded!.id} order by version`;
    expect(versions.map((v) => [v.version, v.trade_pack_id, v.frequency_months])).toEqual([
      [1, `plumbing@${plumbing.version}`, backflow.frequencyMonths ?? null],
      [2, `plumbing@${plumbing.version + 1}`, 24],
    ]);
    expect(versions[1]!.changed).toEqual(["frequencyMonths"]);
  });
});

run("over HTTP", () => {
  const call = async (ctx: ServiceContext, method: string, path: string, body?: unknown, key?: string) => {
    const response = await dispatch(new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { db: db(), resolveSession: async () => ctx });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it("writes, revises, reads a version, and stops offering one", async () => {
    const key = crypto.randomUUID();
    const made = await call(owner(), "POST", "/v1/inspection-programs", OURS, key);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "Our backflow test", version: 1, ready: true });
    /** A retry with the same key is answered with the first answer, not a second programme. */
    const again = await call(owner(), "POST", "/v1/inspection-programs", OURS, key);
    expect(again.body["id"]).toBe(made.body["id"]);

    const id = made.body["id"] as string;
    const publishKey = crypto.randomUUID();
    const revised = await call(owner(), "POST", `/v1/inspection-programs/${id}/versions`, {
      ...OURS, baseVersion: 1, frequencyMonths: 24, note: "Every two years now",
    }, publishKey);
    expect(revised.status).toBe(201);
    expect(revised.body).toMatchObject({ version: 2, frequencyMonths: 24 });
    /** The same publish sent twice is one version, not a refusal and not a version 3. */
    const twice = await call(owner(), "POST", `/v1/inspection-programs/${id}/versions`, {
      ...OURS, baseVersion: 1, frequencyMonths: 24, note: "Every two years now",
    }, publishKey);
    expect(twice.body).toMatchObject({ version: 2 });

    const one = await call(owner(), "GET", `/v1/inspection-programs/${id}/versions/1`);
    expect(one.body).toMatchObject({ version: 1, current: false, frequencyMonths: 12 });
    const detail = await call(owner(), "GET", `/v1/inspection-programs/${id}`);
    expect((detail.body["versions"] as { version: number }[]).map((v) => v.version)).toEqual([2, 1]);

    const reader = as(["office_manager"], ["compliance:read"]);
    expect((await call(reader, "PUT", `/v1/inspection-programs/${id}/offered`, { offered: false })).status).toBe(403);
    expect((await call(reader, "GET", "/v1/inspection-programs/trade-packs")).status).toBe(200);
    const off = await call(owner(), "PUT", `/v1/inspection-programs/${id}/offered`, { offered: false });
    expect(off.body).toMatchObject({ offered: false, version: 2 });
    const listed = await call(owner(), "GET", "/v1/inspection-programs?includeRetired=true");
    expect((listed.body["programs"] as { id: string; active: boolean }[]).find((p) => p.id === id)).toMatchObject({ active: false });
  });

  it("refuses a checkpoint with no severity in words, and a stale base version", async () => {
    const refused = await call(owner(), "POST", "/v1/inspection-programs", {
      ...OURS, checkpoints: [{ key: "gate", label: "Gate latches" }],
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("does not say how serious a fail is");

    const made = await call(owner(), "POST", "/v1/inspection-programs", OURS);
    const stale = await call(owner(), "POST", `/v1/inspection-programs/${made.body["id"] as string}/versions`, {
      ...OURS, baseVersion: 4,
    });
    expect(stale.status).toBe(409);
  });
});
