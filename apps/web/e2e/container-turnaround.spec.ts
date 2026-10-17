import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * THE TIMES A CONTAINER'S TURNAROUND IS MADE OF
 *
 * Turnaround between pickup and redelivery is hours from a can emptied at the
 * facility to it put down on the next site, leaving out a can out for repair or
 * held for a customer in between. The office sets the hour of a drop recorded
 * as a day and the time a load was emptied on the containers board, holds a can
 * for a customer and ends the hold; the driver taps the drop on their day.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function aContainer(identifier: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.rentable_asset (organization_id, asset_type, identifier, size)
      select id, 'roll_off_container', ${identifier}, '20 yd' from public.organization where slug = 'ridgeline' returning id`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

/** A site of its own, through the customer screen. */
async function aSite(owner: Page, street: string): Promise<{ customerId: string; propertyId: string }> {
  const customerId = await newCustomer(owner, {
    name: `Roll off ${street}`, address: { street, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  return { customerId, propertyId: data[0]!.id };
}

const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

test("the office times a drop and a tip, and holds a can for a customer", async ({ owner }) => {
  test.setTimeout(180_000);
  const identifier = `T${run.slice(-6)}`;
  const assetId = await aContainer(identifier);
  const { propertyId } = await aSite(owner, `${run.slice(-4)} Turnaround Ln`);
  const yesterday = dayBefore(companyToday());
  const hire = await api<{ id: string; deliveredTimeKnown: boolean }>(owner, "post", "/v1/rentals", {
    assetId, propertyId, deliveredOn: yesterday,
  });
  expect(hire.deliveredTimeKnown).toBe(false);

  await owner.goto("/fleet/containers");
  const hires = owner.getByRole("table", { name: "Out on hire" });
  let row = hires.getByRole("row").filter({ hasText: identifier });
  await expect(row).toContainText("no time");
  await row.getByLabel(`Time dropped on ${yesterday}`).fill("09:30");
  await row.getByRole("button", { name: "Save drop time" }).click();
  row = owner.getByRole("table", { name: "Out on hire" }).getByRole("row").filter({ hasText: identifier });
  await expect(row).toContainText("9:30 AM");
  await expect(row.getByRole("button", { name: "Save drop time" })).toHaveCount(0);

  /** Collected, and the ticket arrives later: the office types when the load was emptied. */
  await api(owner, "post", `/v1/rentals/${hire.id}/pickup`, {});
  await owner.reload();
  row = owner.getByRole("table", { name: "Out on hire" }).getByRole("row").filter({ hasText: identifier });
  await row.getByLabel("Emptied at the facility").fill(`${dayBefore(yesterday)}T08:00`);
  await row.getByRole("button", { name: "Save time emptied" }).click();
  await expect(row.getByRole("alert").filter({ hasText: "before the can was delivered" })).toBeVisible();
  await row.getByLabel("Emptied at the facility").fill(`${companyToday()}T00:01`);
  await row.getByRole("button", { name: "Save time emptied" }).click();
  row = owner.getByRole("table", { name: "Out on hire" }).getByRole("row").filter({ hasText: identifier });
  await expect(row).toContainText("emptied");
  await expect(row.getByRole("button", { name: "Save time emptied" })).toHaveCount(0);

  /** Held for a customer who asked, from now until the office ends it. */
  const register = () => owner.getByRole("table", { name: "The register" }).getByRole("row").filter({ hasText: identifier });
  await register().getByLabel(`Who asked for ${identifier} to be held`).fill("Bob wants this one Monday");
  await register().getByRole("button", { name: "Hold for a customer" }).click();
  await expect(register()).toContainText("Held for a customer");
  const holds = owner.getByRole("region", { name: "Repairs and holds" });
  await expect(holds.getByRole("listitem").filter({ hasText: identifier })).toContainText("still running");
  await register().getByRole("button", { name: "End the hold" }).click();
  await expect(register()).not.toContainText("Held for a customer");
  await expect(holds.getByRole("listitem").filter({ hasText: identifier })).not.toContainText("still running");
});

/** The seeded technician's own id: the first technician the seed made. */
async function seededTechnician(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      select t.id from public.technician t
      join public.organization o on o.id = t.organization_id
      where o.slug = 'ridgeline' order by t.created_at, t.id limit 1`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

test("a driver taps the moment a can was put down, and it reaches the hire", async ({ tech, owner }) => {
  test.setTimeout(180_000);
  const identifier = `D${run.slice(-6)}`;
  const assetId = await aContainer(identifier);
  const { customerId, propertyId } = await aSite(owner, `${run.slice(-4)} Drop Off Ct`);
  const hire = await api<{ id: string }>(owner, "post", "/v1/rentals", { assetId, propertyId, deliveredOn: companyToday() });
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Drop off ${run}` });

  /** The drop off stop, on the seeded driver's day, pointing at the hire. Taken off again after. */
  const db = createClient();
  let visitId = "";
  try {
    const [visit] = await db.execute<{ id: string }>(sql`
      insert into public.visit (organization_id, job_id, sequence, status, rental_id, rental_event, window_start, window_end)
      select organization_id, id, 9, 'scheduled', ${hire.id}, 'delivery', now(), now() + interval '1 hour'
      from public.job where id = ${job.id} returning id`);
    visitId = visit!.id;
    await db.execute(sql`
      insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      select organization_id, id, ${await seededTechnician()}, true from public.visit where id = ${visitId}`);
  } finally {
    await db.$close();
  }

  try {
    await tech.goto("/my-day");
    const panel = tech.getByRole("region", { name: "Container times" });
    const label = `Container ${identifier} (20 yd) dropped`;
    await expect(panel).toContainText(`${label}: not recorded yet`);
    await panel.getByLabel(`${label}, time if not now`).fill("after lunch");
    await panel.getByRole("button", { name: `Save: ${label}` }).click();
    await expect(panel.getByRole("alert").filter({ hasText: "like 14:30" })).toBeVisible();
    await panel.getByLabel(`${label}, time if not now`).fill("");
    await panel.getByRole("button", { name: `Save: ${label}` }).click();
    await expect(panel).not.toContainText(`${label}: not recorded yet`);

    await expect(async () => {
      const rental = await api<{ deliveredTimeKnown: boolean }>(owner, "get", `/v1/rentals/${hire.id}`);
      expect(rental.deliveredTimeKnown).toBe(true);
    }).toPass({ timeout: 60_000 });
  } finally {
    const end = createClient();
    try {
      await end.execute(sql`delete from public.visit_assignment where visit_id = ${visitId}`);
      await end.execute(sql`delete from public.visit where id = ${visitId}`);
    } finally {
      await end.$close();
    }
  }
});
