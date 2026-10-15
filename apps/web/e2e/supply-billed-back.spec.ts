import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A SUPPLY BILLED BACK AT COST
 *
 * Paper and liners stocked for a commercial account and billed back at what
 * they cost are a pass through, and the supply cost share of revenue leaves
 * them out. The office marks a supply on the job's "Used on this job" list,
 * and can take the mark off.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A supply used on the job, as the phone records one. */
async function supplyOn(jobId: string, name: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.job_line (organization_id, job_id, kind, source, name, quantity, unit_price, unit_cost)
      select organization_id, id, 'part', 'field', ${name}, 4, 12, 12 from public.job where id = ${jobId}`);
  } finally {
    await db.$close();
  }
}

test("a supply is marked billed back at cost on the job, and the mark taken off", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Office Park ${run}`, address: { street: `${run.slice(-4)} Commerce Dr`, city: "Austin", state: "TX", zip: "78701" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId: data[0]!.id, summary: `Nightly clean ${run}` });
  await supplyOn(job.id, `Paper towels ${run}`);

  await owner.goto(`/jobs/${job.id}`);
  const used = owner.getByRole("region", { name: "Used on this job" });
  const row = used.getByRole("row").filter({ hasText: `Paper towels ${run}` });
  await expect(row).toContainText("No");
  await row.getByRole("button", { name: "Billed back at cost" }).click();
  await expect(row).toContainText("Yes, a pass through");

  const lines = await api<{ data: { name: string; billedBackAt: string | null }[] }>(owner, "get", `/v1/jobs/${job.id}/lines`);
  expect(lines.data.find((l) => l.name === `Paper towels ${run}`)!.billedBackAt).not.toBeNull();

  await row.getByRole("button", { name: "Not billed back" }).click();
  await expect(row.getByRole("button", { name: "Billed back at cost" })).toBeVisible();
});
