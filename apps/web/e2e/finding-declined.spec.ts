import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE CUSTOMER SAID NO, AND WHY
 *
 * A finding on a unit is declined from the unit's page with a reason from a
 * fixed list. "Already booked with another company" is what plumbing's water
 * heater capture leaves out; the customer's own words are kept beside it and
 * never read for that.
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

test("a finding on a water heater is declined from the unit's page as booked with another company", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Heater Hank ${run}`, address: { street: `${run.slice(-4)} Tank Ter`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const unit = await api<{ id: string }>(owner, "post", "/v1/equipment", {
    propertyId: data[0]!.id, category: "Water heater", tag: `WH ${run}`, installedOn: "2011-05-01",
  });
  await findingOn(unit.id, `Tank weeping ${run}`);

  await owner.goto(`/equipment/${unit.id}`);
  const faults = owner.getByRole("region", { name: "Faults found" });
  await expect(faults).toContainText(`Tank weeping ${run}`);
  await faults.getByText("The customer said no").click();
  await faults.getByLabel("Why").selectOption("booked_elsewhere");
  await faults.getByLabel("Their words, if any").fill("Their cousin is doing it");
  await faults.getByRole("button", { name: "Record it" }).click();

  await expect(faults).toContainText("The customer said no: Already booked with another company");
  await expect(faults).toContainText("Their cousin is doing it");
  const history = await api<{ deficiencies: { declineCode: string | null; declineReason: string | null }[] }>(
    owner, "get", `/v1/equipment/${unit.id}/history`);
  expect(history.deficiencies[0]).toMatchObject({ declineCode: "booked_elsewhere", declineReason: "Their cousin is doing it" });
});
