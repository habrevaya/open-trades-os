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
