import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { pdf } from "@opentradesos/core";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * FILES A CUSTOMER IS HANDED, AND RECORDS THAT HAVE A PAGE OF THEIR OWN
 *
 * An invoice saved as a PDF from its page and from the customer's link, read
 * back to check it is a file a reader can open and says what the screen says.
 * Then a unit reached from the records behind a report: the report's drill
 * opens the visit on its own page, and the visit's unit opens on its own page,
 * where a unit's links used to stop at the address it was at.
 *
 * The API is used where a step is not the point of the test: registering a
 * unit, booking a visit and recording the unit's outcome on it, and issuing a
 * customer's invoice link.
 */

const read = (bytes: Uint8Array) => pdf.inspectPdf(bytes, (b) => new Uint8Array(inflateSync(b)));

test("an invoice downloads as a PDF from its page and from the customer's link", async ({ owner, stranger }) => {
  const name = `Petra Paper ${run}`;
  const customerId = await newCustomer(owner, { name });

  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Blower motor replacement");
  await owner.getByLabel("Line 1 unit price").fill("640.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = owner.url().split("/").pop()!;
  const number = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

  const [office] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("link", { name: "Download PDF" }).click(),
  ]);
  expect(office.suggestedFilename()).toBe(`invoice-${number}.pdf`);
  const file = read(new Uint8Array(readFileSync((await office.path())!)));
  expect(file.problems).toEqual([]);
  expect(file.text).toContain(`Invoice ${number}`);
  expect(file.text).toContain(name);
  expect(file.text).toContain("Blower motor replacement");
  expect(file.text).toContain("$640.00");

  // The customer, holding only the link the invoice email carries.
  const grant = await owner.request.post("/api/v1/portal/grants", {
    data: { customerId, scope: "invoice", subjectId: invoiceId, expiresInDays: 30 },
  });
  expect(grant.ok()).toBe(true);
  await stranger.goto((await grant.json() as { url: string }).url);
  const [theirs] = await Promise.all([
    stranger.waitForEvent("download"),
    stranger.getByRole("link", { name: "Download a PDF of this invoice" }).click(),
  ]);
  const copy = read(new Uint8Array(readFileSync((await theirs.path())!)));
  expect(copy.problems).toEqual([]);
  expect(copy.text).toContain("$640.00");
});

test("a unit opens on its own page from the records behind a report, through the visit that worked it", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Ulla Unit ${run}`, address: { street: "9 Condenser Way", city: "Austin", state: "TX", zip: "78702" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;

  const unit = await owner.request.post("/api/v1/equipment", {
    data: { propertyId, category: "condenser", tag: `CU-${run}`, manufacturer: "Trane", serialNumber: `T${run}` },
  });
  expect(unit.ok()).toBe(true);
  const unitId = (await unit.json() as { id: string }).id;

  const start = new Date(Date.now() + 2 * 3600_000);
  const booked = await owner.request.post("/api/v1/jobs", {
    data: {
      customerId, propertyId, summary: `Condenser check ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3600_000).toISOString() },
    },
  });
  expect(booked.ok()).toBe(true);
  const jobId = (await booked.json() as { id: string }).id;
  const job = await (await owner.request.get(`/api/v1/jobs/${jobId}`)).json() as {
    number: number; visits: { id: string }[];
  };
  const visitId = job.visits[0]!.id;
  expect((await owner.request.put(`/api/v1/visits/${visitId}/units`, { data: { equipmentIds: [unitId] } })).ok()).toBe(true);
  expect((await owner.request.post(`/api/v1/visits/${visitId}/units/${unitId}/outcome`, {
    data: { outcome: "pass", notes: "Coil clean, pressures good" },
  })).ok()).toBe(true);

  // The report, and the number for unassigned visits: the records behind it.
  await owner.goto("/reports/built-in/visits-by-technician");
  const row = owner.getByRole("row").filter({ hasText: /Unassigned.*Unassigned/ }).first();
  await row.getByRole("link").last().click();
  await expect(owner).toHaveURL(/\/reports\/drill\?/);

  // The visit opens on its own page, not on its job.
  const record = owner.getByRole("link", { name: `#${job.number} visit 1` });
  await expect(record).toHaveAttribute("href", `/visits/${visitId}`);
  await record.click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`Visit 1 of ${job.number}`);
  const worked = owner.getByRole("region", { name: "Units worked" });
  await expect(worked).toContainText("Coil clean, pressures good");

  // And the unit opens on its own page.
  await worked.getByRole("link", { name: `CU-${run} condenser` }).click();
  await expect(owner).toHaveURL(new RegExp(`/equipment/${unitId}$`));
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(`CU-${run} Trane`);
  await expect(owner.getByText(`T${run}`)).toBeVisible();
  const history = owner.getByRole("region", { name: "Service history" });
  await expect(history.getByRole("link", { name: "Checked on a visit" })).toHaveAttribute("href", `/visits/${visitId}`);
  await expect(owner.getByRole("link", { name: "9 Condenser Way, Austin" }).first()).toHaveAttribute("href", `/properties/${propertyId}`);
});
