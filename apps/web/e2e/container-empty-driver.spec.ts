import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * "IT CAME BACK EMPTY", FROM THE DRIVER'S DAY
 *
 * A collected can the customer put nothing in has no tip to wait for. The
 * driver says so on /my-day, under the can's tip, and the mark reaches the
 * hire as the office's "Came back empty" does. Once marked, the stop says so
 * and offers neither the tip nor the mark again.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

test("a driver says a collected can came back empty, and it reaches the hire", async ({ tech, owner }) => {
  test.setTimeout(180_000);
  const identifier = `ED${run.slice(-6)}`;
  const db = createClient();
  let assetId = "";
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.rentable_asset (organization_id, asset_type, identifier, size)
      select id, 'roll_off_container', ${identifier}, '20 yd' from public.organization where slug = 'ridgeline' returning id`);
    assetId = row!.id;
  } finally {
    await db.$close();
  }
  const customerId = await newCustomer(owner, {
    name: `Roll off ${run} Empty`, address: { street: `${run.slice(-4)} Empty Can Ct`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const propertyId = data[0]!.id;
  const hire = await api<{ id: string }>(owner, "post", "/v1/rentals", { assetId, propertyId, deliveredOn: dayBefore(companyToday()) });
  await api(owner, "post", `/v1/rentals/${hire.id}/pickup`, { pickedUpAt: new Date(Date.now() - 2 * 60_000).toISOString() });
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Collection ${run}` });

  /** The collection stop, on the seeded driver's day, pointing at the hire. Taken off again after. */
  const setup = createClient();
  let visitId = "";
  try {
    const [visit] = await setup.execute<{ id: string }>(sql`
      insert into public.visit (organization_id, job_id, sequence, status, rental_id, rental_event, window_start, window_end)
      select organization_id, id, 9, 'scheduled', ${hire.id}, 'pickup', now(), now() + interval '1 hour'
      from public.job where id = ${job.id} returning id`);
    visitId = visit!.id;
    await setup.execute(sql`
      insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      select v.organization_id, v.id, t.id, true from public.visit v
      join public.technician t on t.organization_id = v.organization_id
      where v.id = ${visitId}
      order by t.created_at, t.id limit 1`);
  } finally {
    await setup.$close();
  }

  try {
    await tech.goto("/my-day");
    const panel = tech.getByRole("region", { name: "Container times" });
    const emptied = `Container ${identifier} (20 yd) emptied at the facility`;
    const empty = `Container ${identifier} (20 yd) came back empty`;
    await expect(panel).toContainText(`${emptied}: not recorded yet`);
    await expect(panel).toContainText("Nothing in it, so nothing to tip?");
    await panel.getByRole("button", { name: `Save: ${empty}` }).click();

    // The stop says so at once, and offers neither the tip nor the mark again.
    await expect(panel).toContainText(`${empty}: collected`);
    await expect(panel.getByRole("button", { name: `Save: ${emptied}` })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: `Save: ${empty}` })).toHaveCount(0);

    await expect(async () => {
      const rental = await api<{ cameBackEmptyAt: string | null }>(owner, "get", `/v1/rentals/${hire.id}`);
      expect(rental.cameBackEmptyAt).not.toBeNull();
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
