import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE CUSTOMER SAID NO, FROM THE BACKLOG
 *
 * A finding is declined from the inspections page with a reason from the fixed
 * list, without opening the piece of equipment. It leaves the backlog, and the
 * unit's page still says why, with the code, so plumbing's water heater capture
 * reads it the same way as when the unit's own page records it.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A finding on the unit, as an inspection on the phone records one. */
async function findingOn(equipmentId: string, description: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.deficiency (organization_id, property_id, customer_id, equipment_id, status, severity, description, found_on)
      select e.organization_id, e.property_id, cp.customer_id, e.id, 'open', 'advisory', ${description}, current_date
      from public.equipment e
      join public.customer_property cp on cp.property_id = e.property_id
      where e.id = ${equipmentId}
      limit 1`);
  } finally {
    await db.$close();
  }
}

test("a finding is declined from the backlog with a code, leaves the list, and the unit's page says why", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Backlog Bea ${run}`, address: { street: `${run.slice(-4)} Queue Ct`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const unit = await api<{ id: string }>(owner, "post", "/v1/equipment", {
    propertyId: data[0]!.id, category: "Water heater", tag: `WH ${run}`, installedOn: "2009-03-01",
  });
  await findingOn(unit.id, `Relief valve weeping ${run}`);
  await findingOn(unit.id, `Anode rod spent ${run}`);

  await owner.goto("/inspections");
  const row = owner.getByRole("listitem").filter({ hasText: `Relief valve weeping ${run}` });
  await row.getByText("The customer said no").click();

  /** No reason, no record. */
  await row.getByRole("button", { name: "Record it" }).click();
  await expect(row.getByRole("alert").filter({ hasText: "Say why they said no" })).toBeVisible();

  await row.getByLabel("Why").selectOption("booked_elsewhere");
  await row.getByLabel("Their words, if any").fill("Their cousin is doing it");
  await row.getByRole("button", { name: "Record it" }).click();

  await expect(owner.getByRole("status").filter({ hasText: "Recorded as declined" })).toBeVisible();
  await expect(owner.getByText(`Relief valve weeping ${run}`)).toHaveCount(0);
  /** The other finding on the same unit is untouched. */
  await expect(owner.getByText(`Anode rod spent ${run}`)).toBeVisible();

  const history = await api<{ deficiencies: { description: string; status: string; declineCode: string | null; declineReason: string | null }[] }>(
    owner, "get", `/v1/equipment/${unit.id}/history`);
  expect(history.deficiencies.find((d) => d.description === `Relief valve weeping ${run}`))
    .toMatchObject({ status: "declined", declineCode: "booked_elsewhere", declineReason: "Their cousin is doing it" });
  expect(history.deficiencies.find((d) => d.description === `Anode rod spent ${run}`)).toMatchObject({ status: "open", declineCode: null });

  await owner.goto(`/equipment/${unit.id}`);
  await expect(owner.getByRole("region", { name: "Faults found" }))
    .toContainText("The customer said no: Already booked with another company");

  /** A code alone stands as the reason when no words are given. */
  await owner.goto("/inspections");
  const other = owner.getByRole("listitem").filter({ hasText: `Anode rod spent ${run}` });
  await other.getByText("The customer said no").click();
  await other.getByLabel("Why").selectOption("price");
  await other.getByRole("button", { name: "Record it" }).click();
  await expect(owner.getByText(`Anode rod spent ${run}`)).toHaveCount(0);
  const after = await api<{ deficiencies: { description: string; declineCode: string | null; declineReason: string | null }[] }>(
    owner, "get", `/v1/equipment/${unit.id}/history`);
  expect(after.deficiencies.find((d) => d.description === `Anode rod spent ${run}`))
    .toMatchObject({ declineCode: "price", declineReason: "Too dear" });
});
