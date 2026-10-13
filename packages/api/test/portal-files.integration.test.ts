import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { files as fileRules, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as files from "../src/services/files";
import * as portal from "../src/services/portal";
import * as portalFiles from "../src/services/portal-files";
import * as portalSignIn from "../src/services/portal-sign-in";
import {
  ConflictError, InvalidGrantError, NotFoundError, TooManyRequestsError, inTenant, type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER ADDING A PHOTOGRAPH OR A PDF TO THEIR OWN JOB (M05)
 *
 * The scope comes first, because what matters is where a file can never
 * land: another customer's job, another company's, a cancelled job or visit,
 * and from a link rather than a sign in. Then what can never be kept: a
 * program renamed as a photograph, a file over the cap, one file too many.
 * Then what the office and the technician see, and taking a file back only
 * until the company has opened it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-files:org");
const USER = fixtureId("portal-files:user");
const OTHER_ORG = fixtureId("portal-files:other-org");
const OTHER_USER = fixtureId("portal-files:other-user");
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@portal-files.test`;
const ELI = `eli.${RUN}@portal-files.test`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, marker, RUN.length]);
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${RUN}\n%%EOF\n`);
const b64 = (bytes: Buffer) => bytes.toString("base64");

let ipSeq = 0;
const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

async function aCustomer(org: string, name: string, email: string | null) {
  const c = await customers.create(as(["owner"], org, org === ORG ? USER : OTHER_USER), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    ...(email ? { email } : {}),
  });
  const [p] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${name.length} Cedar Ln`}, 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${org}, ${c.id}, ${p!.id}, true)`;
  return { id: c.id as string, propertyId: p!.id };
}

let jobNumber = 4100;
async function aJob(org: string, customer: { id: string; propertyId: string }, status = "scheduled", visitStatus = "scheduled") {
  jobNumber += 1;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, summary, status)
    values (${org}, ${jobNumber}, ${customer.id}, ${customer.propertyId}, 'No hot water', ${status}) returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${org}, ${job!.id}, ${visitStatus}, now() + interval '2 days', now() + interval '2 days 2 hours') returning id`;
  return { jobId: job!.id, visitId: visit!.id };
}

async function codeSentTo(address: string): Promise<string | null> {
  const [row] = await raw<{ body: string }[]>`
    select body from public.message
     where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
     order by created_at desc limit 1`;
  return /\b(\d{6})\b/.exec(row?.body ?? "")?.[1] ?? null;
}

async function signIn(address: string): Promise<string> {
  await portalSignIn.requestCode(db(), { organizationSlug: "portal-files-plumbing", address }, { ip: ip() });
  const code = await codeSentTo(address);
  if (!code) throw new Error(`No code went to ${address}`);
  const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: "portal-files-plumbing", address, code }, { ip: ip() });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  return verdict.token;
}

/** How many attachments exist for a record, counting removed ones, straight from the table. */
async function rowsOn(entityId: string) {
  return raw<{ id: string; kind: string; deleted_at: Date | null; uploaded_by_customer_id: string | null }[]>`
    select id, kind, deleted_at, uploaded_by_customer_id from public.attachment where entity_id = ${entityId}`;
}

let dana = { id: "", propertyId: "" };
let eli = { id: "", propertyId: "" };
let danaToken = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Plumbing", slug: "portal-files-plumbing" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Somebody Else's Plumbing", slug: "portal-files-other" });
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%' or key like 'portal-file:%'`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@portal-files.test" })})`;
  dana = await aCustomer(ORG, "Dana Cedar", DANA);
  eli = await aCustomer(ORG, "Eli Cedar", ELI);
  danaToken = await signIn(DANA);
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.public_rate_limit where key like 'portal-file:%'`;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

/* =============================================================== scope === */

run("where a customer's file can never land", () => {
  it("is refused on another customer's job, as not found", async () => {
    const theirs = await aJob(ORG, eli);
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: theirs.jobId, fileName: "unit.jpg", contentType: "image/jpeg", bytes: b64(jpeg(1)),
    })).rejects.toThrow(NotFoundError);
    // And a visit of Dana's own job does not open a door to Eli's.
    const mine = await aJob(ORG, dana);
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: mine.jobId, visitId: theirs.visitId, fileName: "unit.jpg", bytes: b64(jpeg(2)),
    })).rejects.toThrow(NotFoundError);
    expect(await rowsOn(theirs.jobId)).toEqual([]);
    expect(await rowsOn(theirs.visitId)).toEqual([]);
  });

  it("is refused on a job of another company, as not found", async () => {
    const stranger = await aCustomer(OTHER_ORG, "Fay Elsewhere", null);
    const elsewhere = await aJob(OTHER_ORG, stranger);
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: elsewhere.jobId, fileName: "unit.jpg", bytes: b64(jpeg(3)),
    })).rejects.toThrow(NotFoundError);
    expect(await rowsOn(elsewhere.jobId)).toEqual([]);
  });

  it("is refused on a cancelled job and on a cancelled visit, in words", async () => {
    const cancelled = await aJob(ORG, dana, "cancelled", "cancelled");
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: cancelled.jobId, fileName: "unit.jpg", bytes: b64(jpeg(4)),
    })).rejects.toThrow(/cancelled/);
    const live = await aJob(ORG, dana, "scheduled", "cancelled");
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: live.jobId, visitId: live.visitId, fileName: "unit.jpg", bytes: b64(jpeg(5)),
    })).rejects.toThrow(ConflictError);
    // Neither is offered as somewhere to add a file.
    const { targets } = await portalFiles.list(db(), { token: danaToken });
    expect(targets.map((t) => t.jobId)).not.toContain(cancelled.jobId);
    expect(targets.map((t) => t.visitId)).not.toContain(live.visitId);
  });

  it("is refused from an account link: only a sign in may add a file", async () => {
    const job = await aJob(ORG, dana);
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana.id, scope: "customer", expiresInDays: 30,
    }));
    await expect(portalFiles.add(db(), {
      token: link.token, jobId: job.jobId, fileName: "unit.jpg", bytes: b64(jpeg(6)),
    })).rejects.toThrow(InvalidGrantError);
    await expect(portalFiles.list(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
  });
});

/* ======================================================= what is kept === */

run("what can never be kept", () => {
  it("refuses a program renamed .jpg, by its bytes, and keeps nothing", async () => {
    const job = await aJob(ORG, dana);
    const program = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04]);
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, fileName: "boiler.jpg", contentType: "image/jpeg", bytes: b64(program),
    })).rejects.toThrow(/program/);
    expect(await rowsOn(job.jobId)).toEqual([]);
    const [kept] = await raw<{ n: number }[]>`select count(*)::int as n from public.stored_file
      where organization_id = ${ORG} and sha256 = ${files.sha256(program)}`;
    expect(kept!.n).toBe(0);
  });

  it("refuses a file over the cap", async () => {
    const job = await aJob(ORG, dana);
    const big = Buffer.alloc(fileRules.CUSTOMER_UPLOADS.maxFileBytes + 1);
    pdf("big").copy(big);
    await expect(portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, fileName: "scan.pdf", bytes: b64(big),
    })).rejects.toThrow(/MB/);
    expect(await rowsOn(job.jobId)).toEqual([]);
  });

  it("refuses one file more than a job takes, counting the job and its visits together", async () => {
    const job = await aJob(ORG, eli);
    const eliToken = await signIn(ELI);
    for (let i = 0; i < fileRules.CUSTOMER_UPLOADS.maxFilesPerJob; i += 1) {
      await portalFiles.add(db(), {
        token: eliToken, jobId: job.jobId, ...(i % 2 === 0 ? { visitId: job.visitId } : {}),
        fileName: `page-${i}.pdf`, bytes: b64(pdf(`page-${i}`)),
      });
    }
    await expect(portalFiles.add(db(), {
      token: eliToken, jobId: job.jobId, fileName: "one-more.pdf", bytes: b64(pdf("one-more")),
    })).rejects.toThrow(/up to 10 files/);
  });

  it("refuses more than the hourly limit for one customer, counting refused tries too", async () => {
    const job = await aJob(ORG, dana);
    await raw`insert into public.public_rate_limit (key, window_start, hits)
      values (${`portal-file:${ORG}:${dana.id}`}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600),
        ${fileRules.CUSTOMER_UPLOADS.perHour})
      on conflict (key, window_start) do update set hits = excluded.hits`;
    try {
      await expect(portalFiles.add(db(), {
        token: danaToken, jobId: job.jobId, fileName: "unit.jpg", bytes: b64(jpeg(9)),
      })).rejects.toThrow(TooManyRequestsError);
      expect(await rowsOn(job.jobId)).toEqual([]);
    } finally {
      await raw`delete from public.public_rate_limit where key = ${`portal-file:${ORG}:${dana.id}`}`;
    }
  });
});

/* ================================================ the office and the van === */

run("a file the customer added", () => {
  it("is kept once, as from the customer, and shows to the office on the job and to the technician on the visit", async () => {
    const job = await aJob(ORG, dana);
    const first = await portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, visitId: job.visitId, fileName: "broken unit.jpg",
      contentType: "image/jpeg", bytes: b64(jpeg(20)),
    });
    // The same bytes again are the same file: a retry after a lost answer adds nothing.
    const again = await portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, visitId: job.visitId, fileName: "broken unit.jpg",
      contentType: "image/jpeg", bytes: b64(jpeg(20)),
    });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ contentType: "image/jpeg", seen: false, removable: true, jobId: job.jobId });
    expect(first.fileName).toBe("broken unit.jpg");

    const onVisit = await files.attachmentsFor(owner(), { entityType: "visit", entityId: job.visitId });
    expect(onVisit).toHaveLength(1);
    expect(onVisit[0]).toMatchObject({ kind: "customer_file", addedByCustomer: true, seenAt: null });

    const [audited] = await raw<{ actor_portal_grant_id: string | null; actor_user_id: string | null }[]>`
      select actor_portal_grant_id, actor_user_id from public.audit_log
       where entity_id = ${first.id} and action = 'attachment.customer_added'`;
    expect(audited?.actor_portal_grant_id).toBeTruthy();
    expect(audited?.actor_user_id).toBeNull();

    const tech = as(["technician"]);
    const forVan = await inTenant(tech, (tx) => files.customerFilesForVisits(tx, tech, [{ visitId: job.visitId, jobId: job.jobId }]));
    expect(forVan.get(job.visitId)?.map((f) => f.id)).toEqual([first.id]);
    // A role that may not read documents gets none on the phone.
    const reader = as(["accountant"]);
    const none = await inTenant(reader, (tx) => files.customerFilesForVisits(tx, reader, [{ visitId: job.visitId, jobId: job.jobId }]));
    expect(none.get(job.visitId) ?? []).toEqual([]);
  });

  it("is never shown back on the customer's own pages as a document or a photograph", async () => {
    const job = await aJob(ORG, dana);
    const added = await portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, fileName: "warranty.pdf", bytes: b64(pdf("warranty")),
    });
    await expect(files.shareWithCustomer(owner(), { attachmentId: added.id, shared: true })).rejects.toThrow(ConflictError);
  });

  it("can be taken back until the company opens it, and never after", async () => {
    const job = await aJob(ORG, dana);
    const early = await portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, fileName: "wrong photo.jpg", bytes: b64(jpeg(30)),
    });
    expect(await portalFiles.remove(db(), { token: danaToken, id: early.id })).toEqual({ id: early.id, removed: true });
    // Twice is still removed, and it is gone from the office's list and the customer's.
    expect(await portalFiles.remove(db(), { token: danaToken, id: early.id })).toEqual({ id: early.id, removed: true });
    expect(await files.attachmentsFor(owner(), { entityType: "job", entityId: job.jobId })).toEqual([]);
    expect((await portalFiles.list(db(), { token: danaToken })).files.map((f) => f.id)).not.toContain(early.id);

    const kept = await portalFiles.add(db(), {
      token: danaToken, jobId: job.jobId, fileName: "model plate.jpg", bytes: b64(jpeg(31)),
    });
    const seen = await files.markSeen(owner(), { attachmentId: kept.id });
    expect(seen.seenAt).not.toBeNull();
    // Opening it again does not move the time or the person.
    expect((await files.markSeen(owner(), { attachmentId: kept.id })).seenAt).toBe(seen.seenAt);
    const listed = (await portalFiles.list(db(), { token: danaToken })).files.find((f) => f.id === kept.id);
    expect(listed).toMatchObject({ seen: true, removable: false });
    await expect(portalFiles.remove(db(), { token: danaToken, id: kept.id })).rejects.toThrow(/already opened/);
    expect((await rowsOn(job.jobId)).find((r) => r.id === kept.id)?.deleted_at).toBeNull();
  });

  it("never lets the customer remove a file the office added, or another customer's", async () => {
    const job = await aJob(ORG, dana);
    const officeFile = await files.upload(owner(), {
      entityType: "job", entityId: job.jobId, fileName: "permit.pdf", contentType: "application/pdf",
      bytes: b64(pdf("permit")), kind: "document",
    });
    await expect(portalFiles.remove(db(), { token: danaToken, id: officeFile.id })).rejects.toThrow(NotFoundError);
    // Marking an office file seen changes nothing about it.
    expect((await files.markSeen(owner(), { attachmentId: officeFile.id })).seenAt).toBeNull();

    const eliJob = await aJob(ORG, eli);
    const eliToken = await signIn(ELI);
    const eliFile = await portalFiles.add(db(), {
      token: eliToken, jobId: eliJob.jobId, fileName: "eli.jpg", bytes: b64(jpeg(40)),
    });
    await expect(portalFiles.remove(db(), { token: danaToken, id: eliFile.id })).rejects.toThrow(NotFoundError);
    expect((await rowsOn(eliJob.jobId)).find((r) => r.id === eliFile.id)?.deleted_at).toBeNull();
    expect((await rowsOn(job.jobId)).find((r) => r.id === officeFile.id)?.deleted_at).toBeNull();
  });
});
