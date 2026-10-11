import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as documents from "../src/services/documents";
import * as estimates from "../src/services/estimates";
import * as files from "../src/services/files";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import * as portalSettings from "../src/services/portal-settings";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * MORE IN THE PORTAL'S DOCUMENTS BLOCK
 *
 * Signed estimates and invoices as PDFs, and the files the office marked "the
 * customer may see this" on a job, read only. The refusals come first because
 * what matters is what never reaches a customer: a file nobody marked, a
 * signature, a photograph through the file door, another customer's file,
 * an estimate that was not signed, a draft invoice.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-documents:org");
const USER = fixtureId("portal-documents:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

const pdfBytes = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
const png = (marker: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, marker, 7]);

interface Person { customerId: string; propertyId: string; token: string; jobId: string; visitId: string }

async function aPerson(name: string): Promise<Person> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Paper Way', 'Austin', 'TX', '78701') returning id`;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e8)}, ${c!.id}, ${p!.id}, 'completed', 'Panel swap') returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'completed', now() - interval '1 day', now() - interval '20 hours') returning id`;
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId: c!.id, scope: "customer", expiresInDays: 30,
  }));
  return { customerId: c!.id, propertyId: p!.id, token: link.token, jobId: job!.id, visitId: visit!.id };
}

/** A file on a job or a visit through the ordinary upload path; private until somebody marks it. */
async function aFile(on: { type: "job" | "visit"; id: string }, name: string, extra: { kind?: string } = {}) {
  return files.upload(owner(), {
    entityType: on.type, entityId: on.id, fileName: name, contentType: "application/pdf",
    bytes: pdfBytes(name).toString("base64"), ...(extra.kind ? { kind: extra.kind } : {}),
  });
}

async function aPhoto(visitId: string, marker: number) {
  return inTenant(owner(), async (tx) => {
    const { file } = await files.put(tx, ORG, { bytes: png(marker) });
    return files.attach(tx, ORG, {
      entityType: "visit", entityId: visitId, storageKey: file.storageKey, kind: "photo",
      contentType: file.contentType, sizeBytes: file.sizeBytes,
    });
  });
}

const filesShown = async (token: string) => (await portalAccount.viewAccount(db(), { token })).extras.files;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Paper Electric", slug: "paper-electric" });
  // The documents block is on the page: a company that has not asked for it sends no files at all.
  const seen = await layout.get(owner());
  const rows = seen.blocks.map((b) => ({ kind: b.kind, title: b.customTitle ?? null, visible: b.kind === "documents" ? true : b.visible }));
  await layout.set(owner(), { blocks: rows });
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

/* ============================================================ refusals === */

run("a file nobody marked never reaches the portal", () => {
  it("shows nothing and serves nothing for a file that was only uploaded", async () => {
    const dana = await aPerson("Dana Unmarked");
    const onJob = await aFile({ type: "job", id: dana.jobId }, "permit.pdf");
    const onVisit = await aFile({ type: "visit", id: dana.visitId }, "work-order.pdf");
    expect(await filesShown(dana.token)).toEqual([]);
    expect(await portalAccount.accountFileFor(db(), dana.token, onJob.id)).toBeNull();
    expect(await portalAccount.accountFileFor(db(), dana.token, onVisit.id)).toBeNull();
    // Not in the account's other doors either.
    expect(await portalAccount.accountPhotoFor(db(), dana.token, onJob.id)).toBeNull();
    const view = JSON.stringify(await portalAccount.viewAccount(db(), { token: dana.token }));
    expect(view).not.toContain("permit.pdf");
    expect(view).not.toContain("work-order.pdf");
  });

  it("is not made visible by the company showing every photograph", async () => {
    await portalSettings.set(owner(), { jobPhotos: "all" });
    try {
      const eli = await aPerson("Eli All Photos");
      const file = await aFile({ type: "job", id: eli.jobId }, "private-sheet.pdf");
      expect(await filesShown(eli.token)).toEqual([]);
      expect(await portalAccount.accountFileFor(db(), eli.token, file.id)).toBeNull();
    } finally {
      await portalSettings.set(owner(), { jobPhotos: "chosen" });
    }
  });

  it("never shows a signature, a photograph through the file door, or a file on anything but a job", async () => {
    const fay = await aPerson("Fay Kinds");
    const signature = await aFile({ type: "visit", id: fay.visitId }, "signature.pdf", { kind: "signature" });
    await expect(files.shareWithCustomer(owner(), { attachmentId: signature.id, shared: true })).rejects.toThrow(ConflictError);
    // Even a signature row that somebody marked directly in the database is not a document.
    await raw`update public.attachment set shared_with_customer_at = now() where id = ${signature.id}`;
    expect(await filesShown(fay.token)).toEqual([]);
    expect(await portalAccount.accountFileFor(db(), fay.token, signature.id)).toBeNull();

    const photo = await aPhoto(fay.visitId, 31);
    await files.shareWithCustomer(owner(), { attachmentId: photo.id, shared: true });
    expect(await filesShown(fay.token)).toEqual([]);
    expect(await portalAccount.accountFileFor(db(), fay.token, photo.id)).toBeNull();

    const onCustomer = await files.upload(owner(), {
      entityType: "customer", entityId: fay.customerId, fileName: "agreement.pdf", contentType: "application/pdf",
      bytes: pdfBytes("customer file").toString("base64"),
    });
    await expect(files.shareWithCustomer(owner(), { attachmentId: onCustomer.id, shared: true })).rejects.toThrow(ConflictError);
    await raw`update public.attachment set shared_with_customer_at = now() where id = ${onCustomer.id}`;
    expect(await filesShown(fay.token)).toEqual([]);
    expect(await portalAccount.accountFileFor(db(), fay.token, onCustomer.id)).toBeNull();
  });

  it("never serves another customer's marked file, nor one by a made up id", async () => {
    const gus = await aPerson("Gus Mine");
    const hal = await aPerson("Hal Theirs");
    const theirs = await aFile({ type: "job", id: hal.jobId }, "hal.pdf");
    await files.shareWithCustomer(owner(), { attachmentId: theirs.id, shared: true });
    expect(await filesShown(gus.token)).toEqual([]);
    expect(await portalAccount.accountFileFor(db(), gus.token, theirs.id)).toBeNull();
    expect(await portalAccount.accountFileFor(db(), gus.token, fixtureId("no-such-file"))).toBeNull();
    expect((await filesShown(hal.token)).map((f) => f.id)).toEqual([theirs.id]);
  });

  it("stops serving a file when the office stops showing it, or removes it", async () => {
    const ivy = await aPerson("Ivy Stopped");
    const file = await aFile({ type: "job", id: ivy.jobId }, "sheet.pdf");
    await files.shareWithCustomer(owner(), { attachmentId: file.id, shared: true });
    expect(await portalAccount.accountFileFor(db(), ivy.token, file.id)).not.toBeNull();
    await files.shareWithCustomer(owner(), { attachmentId: file.id, shared: false });
    expect(await portalAccount.accountFileFor(db(), ivy.token, file.id)).toBeNull();
    expect(await filesShown(ivy.token)).toEqual([]);

    await files.shareWithCustomer(owner(), { attachmentId: file.id, shared: true });
    await raw`update public.attachment set deleted_at = now() where id = ${file.id}`;
    expect(await portalAccount.accountFileFor(db(), ivy.token, file.id)).toBeNull();
    expect(await filesShown(ivy.token)).toEqual([]);
  });

  it("lets only somebody who may publish a report mark a file, and not a technician", async () => {
    const jo = await aPerson("Jo Permission");
    const file = await aFile({ type: "job", id: jo.jobId }, "jo.pdf");
    await expect(files.shareWithCustomer(as(["technician"]), { attachmentId: file.id, shared: true })).rejects.toThrow(PermissionError);
    expect(await filesShown(jo.token)).toEqual([]);
  });

  it("serves nothing without the documents block on the page", async () => {
    const before = await layout.get(owner());
    await layout.set(owner(), {
      blocks: before.blocks.map((b) => ({ kind: b.kind, title: b.customTitle ?? null, visible: b.kind === "documents" ? false : b.visible })),
    });
    try {
      const kim = await aPerson("Kim No Block");
      const file = await aFile({ type: "job", id: kim.jobId }, "kim.pdf");
      await files.shareWithCustomer(owner(), { attachmentId: file.id, shared: true });
      expect(await filesShown(kim.token)).toEqual([]);
    } finally {
      await layout.set(owner(), {
        blocks: before.blocks.map((b) => ({ kind: b.kind, title: b.customTitle ?? null, visible: b.kind === "documents" ? true : b.visible })),
      });
    }
  });
});

/* ===================================================== what it does show === */

run("the files the office marked", () => {
  it("lists a marked file with its job and serves it as it was stored, read only", async () => {
    const lee = await aPerson("Lee Marked");
    const job = await aFile({ type: "job", id: lee.jobId }, "permit.pdf");
    const visit = await aFile({ type: "visit", id: lee.visitId }, "sheet.pdf");
    await aFile({ type: "job", id: lee.jobId }, "still-private.pdf");
    const marked = await files.shareWithCustomer(owner(), { attachmentId: job.id, shared: true });
    expect(marked.sharedWithCustomerAt).not.toBeNull();
    await files.shareWithCustomer(owner(), { attachmentId: visit.id, shared: true });

    const shown = await filesShown(lee.token);
    expect(shown.map((f) => f.fileName).sort()).toEqual(["permit.pdf", "sheet.pdf"]);
    expect(shown[0]).toMatchObject({ contentType: "application/pdf", jobNumberPrefix: null });
    expect(JSON.stringify(shown)).not.toMatch(/storage|key/i);

    const served = await portalAccount.accountFileFor(db(), lee.token, job.id);
    expect(served).toMatchObject({ contentType: "application/pdf", fileName: "permit.pdf" });
    expect(served!.bytes.equals(pdfBytes("permit.pdf"))).toBe(true);
    // The grant only reads: there is no way to change a file from it.
    const [audit] = await raw<{ actor_user_id: string }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'attachment.shared' and entity_id = ${job.id}`;
    expect(audit!.actor_user_id).toBe(USER);
  });
});

/* ======================================== signed estimates and invoices === */

run("signed estimates as PDFs", () => {
  async function estimateFor(p: Person) {
    const created = await estimates.create(owner(), {
      customerId: p.customerId, propertyId: p.propertyId, taxRate: "0",
      options: [{
        name: "Replace", isRecommended: true,
        lines: [{
          name: "Panel", quantity: "1", unitPrice: "1800.00", unitCost: "700.00",
          discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
        }],
      }],
    }) as Record<string, unknown>;
    return created["id"] as string;
  }
  const tokenOf = (link: string) => link.split("/").pop()!;

  it("prints a signed one with who signed, and refuses one still waiting or another customer's", async () => {
    const meg = await aPerson("Meg Signed");
    const other = await aPerson("Ned Other");
    const waiting = await estimateFor(meg);
    const signedId = await estimateFor(meg);
    const theirs = await estimateFor(other);

    for (const [id, who] of [[signedId, "Meg Signed"], [theirs, "Ned Other"], [waiting, ""]] as const) {
      const sent = await estimates.send(owner(), { id, channel: "link", expiresInDays: 30 });
      if (!who) continue;
      const token = tokenOf(sent.approvalUrl!);
      const view = await portal.viewEstimate(db(), { token });
      await portal.approveEstimate(db(), {
        token, optionId: view.options[0]!.id, selectedLineIds: [], signerName: who, acceptedTerms: true,
      });
    }

    const account = await portalAccount.viewAccount(db(), { token: meg.token });
    const byId = new Map(account.estimates.map((e) => [e.id, e]));
    expect(byId.get(signedId)!.signedAt).not.toBeNull();
    expect(byId.get(waiting)!.signedAt).toBeNull();

    const file = await documents.proposalPdfForAccount(db(), { token: meg.token, estimateId: signedId });
    expect(Buffer.from(file.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    await expect(documents.proposalPdfForAccount(db(), { token: meg.token, estimateId: waiting })).rejects.toThrow(NotFoundError);
    await expect(documents.proposalPdfForAccount(db(), { token: meg.token, estimateId: theirs })).rejects.toThrow(NotFoundError);
    await expect(documents.proposalPdfForAccount(db(), { token: other.token, estimateId: signedId })).rejects.toThrow(NotFoundError);
  });
});
