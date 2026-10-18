import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { pdf } from "@opentradesos/core";
import { test, expect, run, newCustomer } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * A JOB AS A WORK ORDER (M10, M01)
 *
 * The office downloads a job's work order from its page, with prices, and the
 * copy for the van without them, and both are read back to check they are
 * files a reader can open and say what the job says: its branch's code, the
 * customer and the address, the visit and who is on it, what was used, and a
 * line to sign.
 *
 * The branch and the job are made through the API, and the part used is
 * written directly, as the phone's sync would write it, because none of that
 * is what is being tested.
 */
const read = (bytes: Uint8Array) => pdf.inspectPdf(bytes, (b) => new Uint8Array(inflateSync(b)));

test("a job's work order downloads from its page, and the technician's copy has no prices", async ({ owner }) => {
  const code = `W${run.slice(-4).toUpperCase()}`;
  const branch = await owner.request.post("/api/v1/business-units", { data: { name: `Work order branch ${run}`, code } });
  expect(branch.ok()).toBe(true);
  const branchId = (await branch.json() as { id: string }).id;

  const customer = `Wren Order ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, address: { street: "9 Signature Way", city: "Round Rock", state: "TX", zip: "78664" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const booked = await owner.request.post("/api/v1/jobs", {
    data: { customerId, propertyId, summary: `Compressor will not start ${run}`, businessUnitId: branchId },
  });
  expect(booked.ok()).toBe(true);
  const jobId = (await booked.json() as { id: string }).id;

  const db = createClient();
  try {
    await db.execute(sql`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price)
      values (${E2E_ORGANIZATION_ID}, ${jobId}, 'part', 'Hard start kit', '1', '74.25')`);
  } finally {
    await db.$close();
  }

  await owner.goto(`/jobs/${jobId}`);
  const [office] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("link", { name: "Download the work order" }).click(),
  ]);
  expect(office.suggestedFilename()).toMatch(new RegExp(`^work-order-(${code}-)?\\d+\\.pdf$`));
  const file = read(new Uint8Array(readFileSync((await office.path())!)));
  expect(file.problems).toEqual([]);
  expect(file.text).toContain("Work order");
  expect(file.text).toContain(`Work order branch ${run} (${code})`);
  expect(file.text).toContain(customer);
  expect(file.text).toContain("9 Signature Way, Round Rock, TX 78664");
  expect(file.text).toContain(`Compressor will not start ${run}`);
  expect(file.text).toContain("Hard start kit");
  expect(file.text).toContain("$74.25");
  expect(file.text).toContain("Customer sign off");

  const [van] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("link", { name: "Print for the technician, without prices" }).click(),
  ]);
  expect(van.suggestedFilename()).toMatch(/-technician\.pdf$/);
  const copy = read(new Uint8Array(readFileSync((await van.path())!)));
  expect(copy.problems).toEqual([]);
  expect(copy.text).toContain("Printed for the technician");
  expect(copy.text).toContain("Hard start kit");
  expect(copy.text).not.toContain("$");
});

/**
 * WHAT THE PHONE TOOK, ON THE WORK ORDER
 *
 * A photograph and the signature already drawn on the phone are printed under their visit. The
 * office copy, which is handed to the customer, prints only the photograph somebody chose to show
 * the customer and says it held the other back; the technician's copy prints both.
 */
test("a work order carries the photographs and the signature taken on the phone, and the office copy holds back what the customer may not see", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Pia Pictures ${run}`, address: { street: "5 Snapshot Street", city: "Round Rock", state: "TX", zip: "78664" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const start = new Date(Date.now() + 3 * 86_400_000);
  const booked = await owner.request.post("/api/v1/jobs", {
    data: {
      customerId, propertyId, summary: `Photographed job ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3600_000).toISOString() },
    },
  });
  expect(booked.ok()).toBe(true);
  const { id: jobId } = await booked.json() as { id: string };
  const job = await (await owner.request.get(`/api/v1/jobs/${jobId}`)).json() as { visits: { id: string }[] };
  const visitId = job.visits[0]!.id;

  /** A JPEG the PDF can carry: only its size and channels are read. */
  const jpeg = (marker: number) => Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xfe, 0x00, 0x03, marker, 0xff, 0xd9,
  ]);
  const upload = async (bytes: Buffer, kind: "photo" | "signature", fileName: string, phase?: "before" | "after") => {
    const made = await owner.request.post("/api/v1/attachments", {
      data: { entityType: "visit", entityId: visitId, fileName, bytes: bytes.toString("base64"), kind, ...(phase ? { phase } : {}) },
    });
    expect(made.ok()).toBe(true);
    return (await made.json() as { id: string }).id;
  };
  const shown = await upload(jpeg(1), "photo", "before.jpg", "before");
  await upload(jpeg(2), "photo", "after.jpg", "after");
  await upload(jpeg(3), "signature", "signature.jpg");
  const shared = await owner.request.post(`/api/v1/attachments/${shown}/customer-sharing`, { data: { shared: true } });
  expect(shared.ok()).toBe(true);

  await owner.goto(`/jobs/${jobId}`);
  const [office] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("link", { name: "Download the work order" }).click(),
  ]);
  const handed = read(new Uint8Array(readFileSync((await office.path())!)));
  expect(handed.problems).toEqual([]);
  // The photograph chosen for the customer and the customer's own signature; the other is held back and said so.
  // The company's logo, which is masked, is not one of them.
  expect(handed.images.filter((image) => !image.masked)).toHaveLength(2);
  expect(handed.text).toContain("Signed on the phone");
  expect(handed.text).toContain("Before, ");
  expect(handed.text).not.toContain("After, ");
  expect(handed.text).toContain("One photograph is not printed on this copy because it is not marked to show the customer.");

  const [van] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("link", { name: "Print for the technician, without prices" }).click(),
  ]);
  const carried = read(new Uint8Array(readFileSync((await van.path())!)));
  expect(carried.problems).toEqual([]);
  expect(carried.images.filter((image) => !image.masked)).toHaveLength(3);
  expect(carried.text).toContain("Before, ");
  expect(carried.text).toContain("After, ");
  expect(carried.text).not.toContain("$");
});
