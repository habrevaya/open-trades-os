import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * WHY A JOB WAITED, AND WHETHER IT WAS ALWAYS GOING TO TAKE TWO VISITS
 *
 * The first time fix rate leaves out a job planned as more than one visit and,
 * for plumbers and electricians, one held for a part order. The office says
 * both on the job's page: the plan before anybody goes out, and the hold with
 * its reason and the purchase order the part is on, which the order's own page
 * then lists as a job waiting on it. Taking the job off hold puts it back where
 * it was. The scorecard computes the figure.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function api<T>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A purchase order that went to a supplier, written as purchasing would have left it. */
async function sentOrder(vendorName: string): Promise<{ id: string; number: number }> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string; number: number }>(sql`
      with org as (select id from public.organization where slug = 'ridgeline'),
      v as (
        insert into public.vendor (organization_id, name) select id, ${vendorName} from org returning id, organization_id
      )
      insert into public.purchase_order (organization_id, number, vendor_id, default_location_id, status, submitted_at)
      select v.organization_id,
             (select coalesce(max(number), 0) + 1 from public.purchase_order where organization_id = v.organization_id),
             v.id,
             (select l.id from public.location l where l.organization_id = v.organization_id order by l.created_at limit 1),
             'submitted', now()
      from v returning id, number`);
    return { id: row!.id, number: Number(row!.number) };
  } finally {
    await db.$close();
  }
}

test("a job planned for two visits, put on hold for a part on an order, and taken off it", async ({ owner }) => {
  test.setTimeout(120_000);
  const name = `Held Up ${run}`;
  const customerId = await newCustomer(owner, { name, address: { street: `${run.slice(-4)} Valve Rd`, city: "Austin", state: "TX", zip: "78702" } });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const start = new Date(`${plus(companyToday(), 9)}T15:00:00Z`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Replace the water heater ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
  });

  /** Planned for more than one visit, said before anybody has gone out. */
  await owner.goto(`/jobs/${job.id}`);
  await owner.getByRole("button", { name: "Planned for more than one visit" }).click();
  await expect(owner.getByText("Planned for more than one visit", { exact: true })).toBeVisible();
  await expect(owner.getByText(/Left out of the first time fix rate/)).toBeVisible();

  /** A part with no order is refused in words that say where to go. */
  const order = await sentOrder(`Supply House ${run}`);
  await owner.locator("summary", { hasText: "Put on hold" }).click();
  await owner.getByLabel("Why is the job waiting?").selectOption("part");
  await owner.getByRole("button", { name: "Put on hold" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Name the purchase order the part is on" })).toBeVisible();

  /** Named, the job is on hold for the part, with the order linked. */
  await owner.getByLabel("For a part: the purchase order it is on").selectOption(order.id);
  await owner.getByLabel("What it is waiting for (which part, which inspection)").fill("A 50 gallon tank");
  await owner.getByRole("button", { name: "Put on hold" }).click();
  const held = owner.getByRole("region", { name: "On hold" });
  await expect(held).toContainText("On hold: Waiting on a part. A 50 gallon tank");
  await expect(held.getByRole("link", { name: `purchase order ${order.number}` })).toBeVisible();
  await expect(held).toContainText("sent");

  /** The order says who is waiting for it. */
  await held.getByRole("link", { name: `purchase order ${order.number}` }).click();
  const waiting = owner.getByRole("region", { name: "Jobs waiting on this order" });
  await expect(waiting).toContainText(`Replace the water heater ${run}`);
  await expect(waiting).toContainText("on hold since");

  /** Off hold, the job is booked again and can be held for another reason. */
  await owner.goto(`/jobs/${job.id}`);
  await owner.getByRole("region", { name: "On hold" }).getByRole("button", { name: "Take off hold" }).click();
  await expect(owner.getByRole("region", { name: "On hold" })).toHaveCount(0);
  await expect(owner.locator("summary", { hasText: "Put on hold" })).toBeVisible();
  const after = await api<{ status: string; multiVisitPlannedAt: string | null }>(owner, "get", `/v1/jobs/${job.id}`);
  expect(after.status).toBe("scheduled");
  expect(after.multiVisitPlannedAt).not.toBeNull();
  const holds = await api<{ data: { reason: string; releasedAt: string | null }[] }>(owner, "get", `/v1/jobs/${job.id}/holds`);
  expect(holds.data).toEqual([expect.objectContaining({ reason: "part" })]);
  expect(holds.data[0]!.releasedAt).not.toBeNull();

  /** The scorecard computes the figure rather than naming what it needs. */
  await owner.goto("/reports/scorecard");
  const fix = owner.getByRole("listitem").filter({ hasText: "First time fix rate" });
  await expect(fix).toBeVisible();
  await expect(fix).not.toContainText("Needs:");
});
