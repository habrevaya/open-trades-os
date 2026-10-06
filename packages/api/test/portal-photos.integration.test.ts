import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as files from "../src/services/files";
import * as portal from "../src/services/portal";
import * as portalSettings from "../src/services/portal-settings";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * JOB PHOTOGRAPHS ON THE CUSTOMER'S JOB LINK
 *
 * The token that already lets somebody see a job is what lets them see its
 * photographs, and only the ones somebody chose to show (or all of them,
 * when the company says so). Never a signature, never another job's, and
 * never a private one by guessing its id.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-photos:org");
const USER = fixtureId("portal-photos:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

const png = (marker: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, marker, 7]);

let customerId = "";
let propertyId = "";

async function aJob(summary: string) {
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e8)}, ${customerId}, ${propertyId}, 'completed', ${summary}) returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'completed', now() - interval '1 day', now() - interval '20 hours') returning id`;
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId, scope: "job", subjectId: job!.id, expiresInDays: 30,
  }));
  return { jobId: job!.id, visitId: visit!.id, token: link.token };
}

async function photo(entityType: string, entityId: string, marker: number, kind = "photo") {
  return inTenant(owner(), async (tx) => {
    const { file } = await files.put(tx, ORG, { bytes: png(marker) });
    return files.attach(tx, ORG, {
      entityType, entityId, storageKey: file.storageKey, kind,
      contentType: file.contentType, sizeBytes: file.sizeBytes, phase: "after",
    });
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Photo Electric", slug: "photo-electric" });
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Ida Lens') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Shutter Way', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("job photographs on the job link", () => {
  it("shows none until somebody chooses one, then that one, and serves only what it shows", async () => {
    await portalSettings.set(owner(), { jobPhotos: "chosen" });
    const { visitId, token } = await aJob("Panel swap");
    const chosen = await photo("visit", visitId, 11);
    const kept = await photo("visit", visitId, 12);
    const signature = await photo("visit", visitId, 13, "signature");

    expect((await portal.viewJob(db(), { token })).photos).toEqual([]);
    expect(await portal.jobPhotoFor(db(), token, chosen.id)).toBeNull();

    await files.shareWithCustomer(owner(), { attachmentId: chosen.id, shared: true });
    const view = await portal.viewJob(db(), { token });
    expect(view.photos.map((p) => p.id)).toEqual([chosen.id]);
    expect(view.photos[0]!.phase).toBe("after");

    const bytes = await portal.jobPhotoFor(db(), token, chosen.id);
    expect(bytes?.contentType).toBe("image/png");
    expect(Buffer.from(bytes!.bytes).equals(Buffer.from(png(11)))).toBe(true);
    expect(await portal.jobPhotoFor(db(), token, kept.id)).toBeNull();
    expect(await portal.jobPhotoFor(db(), token, signature.id)).toBeNull();

    // Stopping showing it stops serving it.
    await files.shareWithCustomer(owner(), { attachmentId: chosen.id, shared: false });
    expect(await portal.jobPhotoFor(db(), token, chosen.id)).toBeNull();
  });

  it("shows every photograph, and still no signature, when the company shows them all", async () => {
    await portalSettings.set(owner(), { jobPhotos: "all" });
    try {
      const { jobId, visitId, token } = await aJob("Rewire");
      const one = await photo("visit", visitId, 21);
      const two = await photo("job", jobId, 22);
      await photo("visit", visitId, 23, "signature");
      const view = await portal.viewJob(db(), { token });
      expect(view.photos.map((p) => p.id).sort()).toEqual([one.id, two.id].sort());
    } finally {
      await portalSettings.set(owner(), { jobPhotos: "chosen" });
    }
  });

  it("never serves another job's photograph through this job's link", async () => {
    await portalSettings.set(owner(), { jobPhotos: "all" });
    try {
      const mine = await aJob("Outlet");
      const theirs = await aJob("Breaker");
      const elsewhere = await photo("visit", theirs.visitId, 31);
      expect(await portal.jobPhotoFor(db(), mine.token, elsewhere.id)).toBeNull();
      expect((await portal.jobPhotoFor(db(), theirs.token, elsewhere.id))?.contentType).toBe("image/png");
    } finally {
      await portalSettings.set(owner(), { jobPhotos: "chosen" });
    }
  });

  it("is a choice for whoever may publish a service report, and only for a photograph on a job", async () => {
    const { visitId } = await aJob("Fan");
    const one = await photo("visit", visitId, 41);
    await expect(files.shareWithCustomer(as(["technician"]), { attachmentId: one.id, shared: true }))
      .rejects.toThrow(PermissionError);
    const [cust] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} limit 1`;
    const onCustomer = await photo("customer", cust!.id, 42);
    await expect(files.shareWithCustomer(owner(), { attachmentId: onCustomer.id, shared: true }))
      .rejects.toThrow(ConflictError);
    await expect(files.shareWithCustomer(owner(), { attachmentId: fixtureId("nope"), shared: true }))
      .rejects.toThrow(NotFoundError);
  });
});
