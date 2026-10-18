import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { can, pdf, type Actor } from "@opentradesos/core";
import * as documents from "../src/services/documents";
import * as files from "../src/services/files";
import * as portalSettings from "../src/services/portal-settings";
import { inTenant, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHAT THE PHONE TOOK, ON THE WORK ORDER (M10)
 *
 * The photographs of a job and the signature already drawn on the phone, each under its visit at
 * a printable size. Read back through `inspectPdf`, so "left off" means no picture was drawn.
 * A photograph is printed only for somebody who may open one, the office copy (the one handed to
 * the customer) prints what the customer's own link would show, and the technician's copy,
 * which stays with the company, prints them all and still no price.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("wo-pictures:org");
const OWNER = fixtureId("wo-pictures:owner");
const TECH_USER = fixtureId("wo-pictures:tech");
const BOOKS_USER = fixtureId("wo-pictures:books");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const read = (file: documents.PdfFile) => pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));

/** A JPEG the PDF can carry: its size and channels are all the layout reads. */
const jpeg = (width: number, height: number, marker: number) => Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xfe, 0x00, 0x03, marker, 0xff, 0xd9,
]);

/** A real, plain RGB PNG, so it is drawn as it is. */
function png(width: number, height: number, shade: number): Uint8Array {
  const chunk = (type: string, body: number[]) => {
    const typed = [...type].map((c) => c.charCodeAt(0));
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return [...u32(body.length), ...typed, ...body, ...u32(crc32(Uint8Array.from([...typed, ...body])))];
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const row = [0, ...Array.from({ length: width * 3 }, () => shade)];
  const raw = Uint8Array.from(Array.from({ length: height }, () => row).flat());
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32(width), ...u32(height), 8, 2, 0, 0, 0]),
    ...chunk("IDAT", [...deflateSync(raw)]),
    ...chunk("IEND", []),
  ]);
}

let jobId = "";
let visitOne = "";
let visitTwo = "";
let cancelledVisit = "";
let technicianId = "";
let marker = 0;

async function attach(entityType: "job" | "visit", entityId: string, bytes: Uint8Array, extra: {
  kind?: string; phase?: string; shared?: boolean;
} = {}): Promise<string> {
  const id = await inTenant(owner(), async (tx) => {
    const { file } = await files.put(tx, ORG, { bytes });
    const made = await files.attach(tx, ORG, {
      entityType, entityId, storageKey: file.storageKey, kind: extra.kind ?? "photo",
      contentType: file.contentType, sizeBytes: file.sizeBytes, phase: extra.phase ?? null,
    });
    return made.id;
  });
  if (extra.shared) await files.shareWithCustomer(owner(), { attachmentId: id, shared: true });
  return id;
}
const photo = (on: string, extra: Parameters<typeof attach>[3] = {}, type: "job" | "visit" = "visit") =>
  attach(type, on, jpeg(4000, 3000, (marker += 1)), extra);

const technician = (): ServiceContext => as(TECH_USER, ["technician"], { technicianId });
const bookkeeper = (): ServiceContext => as(BOOKS_USER, ["accountant"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Picture Air", slug: "wo-pictures" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public."user" where id in (${TECH_USER}, ${BOOKS_USER})`;
  await raw`insert into public."user" (id, email, name) values (${TECH_USER}, 'ray@wo-pictures.test', 'Ray Ortiz')`;
  await raw`insert into public."user" (id, email, name) values (${BOOKS_USER}, 'bea@wo-pictures.test', 'Bea Books')`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH_USER}, 'technician') returning id`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${BOOKS_USER}, 'accountant')`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Ortiz') returning id`;
  technicianId = tech!.id as string;

  const [customer] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Dana Pictures') returning id`;
  const [property] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Pecan Hollow', 'Round Rock', 'TX', '78664') returning id`;
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 4242, ${customer!.id}, ${property!.id}, 'in_progress', 'No cooling upstairs') returning id`;
  jobId = job!.id as string;
  const visit = async (status: string, start: string, end: string) => (await raw`insert into public.visit
    (organization_id, job_id, status, window_start, window_end) values (${ORG}, ${jobId}, ${status}::visit_status, ${start}, ${end}) returning id`)[0]!.id as string;
  visitOne = await visit("completed", "2026-10-06T14:00:00Z", "2026-10-06T16:00:00Z");
  visitTwo = await visit("scheduled", "2026-10-08T14:00:00Z", "2026-10-08T16:00:00Z");
  cancelledVisit = await visit("cancelled", "2026-10-05T14:00:00Z", "2026-10-05T16:00:00Z");
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${visitOne}, ${technicianId}, true)`;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where id in (${TECH_USER}, ${BOOKS_USER})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.attachment where organization_id = ${ORG}`;
  await portalSettings.set(owner(), { jobPhotos: "chosen" });
});

const picturesOf = async (ctx: ServiceContext, forTechnician = false) =>
  read(await documents.workOrderPdf(ctx, { id: jobId, forTechnician }));

run("the work order carries what the phone took", () => {
  it("prints each photograph and the signature under their visit, at a printable size, on the technician's copy", async () => {
    await photo(visitOne, { phase: "before" });
    await photo(visitOne, { phase: "after" });
    await photo(visitTwo);
    await attach("visit", visitOne, png(300, 100, 40), { kind: "signature" });
    const printed = await picturesOf(owner(), true);
    expect(printed.problems).toEqual([]);
    expect(printed.images).toHaveLength(4);
    for (const said of ["Signed on the phone", "Customer signed", "Photographs from visit 1", "Photographs from visit 2", "Before, ", "After, ", "Photograph, "]) {
      expect(printed.text).toContain(said);
    }
    // Under their visits, in the order the visits run, and the paper lines still follow.
    expect(printed.text.indexOf("Visit 1:")).toBeLessThan(printed.text.indexOf("Photographs from visit 1"));
    expect(printed.text.indexOf("Photographs from visit 1")).toBeLessThan(printed.text.indexOf("Visit 2:"));
    expect(printed.text.indexOf("Photographs from visit 2")).toBeLessThan(printed.text.indexOf("Customer sign off"));
    // A printable size: nothing taller than the limit, so a 4000 by 3000 photograph is not a page of its own.
    expect(printed.images.every((image) => image.width > 0 && image.height > 0)).toBe(true);
    // The times are the company's clock, in words.
    expect(printed.text).toMatch(/Before, \w{3}, \w{3} \d+, \d+:\d\d (AM|PM) (CDT|CST)/);
  });

  it("keeps the technician's copy free of money with pictures on it", async () => {
    await photo(visitOne);
    const printed = await picturesOf(owner(), true);
    expect(printed.images).toHaveLength(1);
    expect(printed.text).not.toContain("$");
  });

  it("is the same as before when nothing was taken", async () => {
    const printed = await picturesOf(owner());
    expect(printed.images).toEqual([]);
    expect(printed.text).not.toContain("Photographs");
    expect(printed.text).not.toContain("Signed on the phone");
  });

  it("leaves a cancelled visit's pictures off, as it leaves the visit off", async () => {
    await photo(cancelledVisit);
    const printed = await picturesOf(owner(), true);
    expect(printed.images).toEqual([]);
  });

  it("prints a photograph on the job itself, and uses the latest signature when there are two", async () => {
    await photo(jobId, {}, "job");
    await attach("visit", visitOne, png(300, 100, 40), { kind: "signature" });
    await attach("visit", visitOne, png(300, 100, 90), { kind: "signature" });
    const printed = await picturesOf(owner(), true);
    expect(printed.text).toContain("Photographs on the job");
    expect(printed.images).toHaveLength(2);
  });

  it("says a picture it cannot print is on the job's page, and does not drop the rest", async () => {
    // A bitmap this file cannot carry: a PNG of a kind the layout refuses (sixteen bits).
    const sixteen = png(4, 4, 10);
    sixteen[24] = 16;
    await attach("visit", visitOne, sixteen);
    await photo(visitOne);
    const printed = await picturesOf(owner(), true);
    expect(printed.images).toHaveLength(1);
    expect(printed.text).toContain("this picture is on the job's page and is not a kind this file can print");
  });

  it("prints at most the limit, and says how many more are on the job's page", async () => {
    for (let i = 0; i < documents.WORK_ORDER_MAX_PHOTOS + 2; i += 1) await photo(visitOne);
    const printed = await picturesOf(owner(), true);
    expect(printed.images).toHaveLength(documents.WORK_ORDER_MAX_PHOTOS);
    expect(printed.text).toContain("2 more photographs are on the job's page and not printed here.");
  });
});

run("the office copy is the one handed to the customer", () => {
  it("prints only the photographs somebody marked to show the customer, and says how many it held back", async () => {
    await photo(visitOne, { shared: true });
    await photo(visitOne);
    await photo(visitOne);
    const office = await picturesOf(owner());
    expect(office.images).toHaveLength(1);
    expect(office.text).toContain("2 photographs are not printed on this copy because they are not marked to show the customer. The technician's copy has them.");
    const van = await picturesOf(owner(), true);
    expect(van.images).toHaveLength(3);
    expect(van.text).not.toContain("not marked to show the customer");
  });

  it("prints every photograph when the company shows the customer every photograph", async () => {
    await photo(visitOne);
    await photo(visitOne);
    await portalSettings.set(owner(), { jobPhotos: "all" });
    const office = await picturesOf(owner());
    expect(office.images).toHaveLength(2);
    expect(office.text).not.toContain("not marked");
  });

  it("prints the customer's own signature on both copies, shared or not", async () => {
    await attach("visit", visitOne, png(300, 100, 40), { kind: "signature" });
    expect((await picturesOf(owner())).images).toHaveLength(1);
    expect((await picturesOf(owner(), true)).images).toHaveLength(1);
  });

  it("never prints a file the customer sent in or a document", async () => {
    await attach("visit", visitOne, jpeg(800, 600, 201), { kind: "customer_file" });
    await attach("visit", visitOne, jpeg(800, 600, 202), { kind: "document" });
    expect((await picturesOf(owner(), true)).images).toEqual([]);
  });
});

run("only the pictures the reader may open", () => {
  it("shows a role that can read the job and not open documents none, and says so", async () => {
    // The guard on what this test assumes about the roles.
    const books = bookkeeper().actor;
    expect(can(books, "job:read")).toBe(true);
    expect(can(books, "document:read")).toBe(false);
    await photo(visitOne, { shared: true });
    await attach("visit", visitOne, png(300, 100, 40), { kind: "signature" });
    const printed = await picturesOf(bookkeeper());
    expect(printed.images).toEqual([]);
    expect(printed.text).toContain("Photographs and signatures taken on the phone are not shown to your role.");
    // And it says nothing when there is nothing to hide.
    await raw`delete from public.attachment where organization_id = ${ORG}`;
    expect((await picturesOf(bookkeeper())).text).not.toContain("not shown to your role");
  });

  it("gives a technician the pictures of their own job and a not found for the rest", async () => {
    await photo(visitOne);
    const mine = read(await documents.workOrderPdf(technician(), { id: jobId, forTechnician: true }));
    expect(mine.images).toHaveLength(1);
    const [customer] = await raw`select id from public.customer where organization_id = ${ORG} limit 1`;
    const [property] = await raw`select id from public.property where organization_id = ${ORG} limit 1`;
    const [other] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 4243, ${customer!.id}, ${property!.id}, 'scheduled', 'Somebody else') returning id`;
    await expect(documents.workOrderPdf(technician(), { id: other!.id as string })).rejects.toThrow(NotFoundError);
    await raw`delete from public.job where id = ${other!.id}`;
  });
});
