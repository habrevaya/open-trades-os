import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE CONTAINER A LINE ON THE JOB BILLS
 *
 * A roll off hire sold at a flat price has its price on the job, and revenue
 * per container month needs each can's share. On a job at an address where a
 * container has been, "Used on this job" offers each one, and the office names
 * which a line bills; the job's lines then say so.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A container that was on the site, and a flat priced line on the job. */
async function aHireOn(jobId: string, propertyId: string, identifier: string): Promise<{ rentalId: string; lineId: string }> {
  const db = createClient();
  try {
    const [hire] = await db.execute<{ id: string }>(sql`
      with can as (
        insert into public.rentable_asset (organization_id, asset_type, identifier, size)
        select id, 'roll_off', ${identifier}, '20 yd' from public.organization where slug = 'ridgeline' returning id, organization_id
      )
      insert into public.rental (organization_id, asset_id, property_id, delivered_at, picked_up_at)
      select organization_id, id, ${propertyId}, now() - interval '9 days', now() - interval '2 days' from can returning id`);
    const [line] = await db.execute<{ id: string }>(sql`
      insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price)
      select organization_id, id, 'other', '20 yard container, 7 day rental', '1', '475' from public.job where id = ${jobId}
      returning id`);
    return { rentalId: hire!.id, lineId: line!.id };
  } finally {
    await db.$close();
  }
}

test("the office names the container a line on a roll off job bills", async ({ owner }) => {
  test.setTimeout(120_000);
  const identifier = `C${run.slice(-6)}`;
  const customerId = await newCustomer(owner, {
    name: `Roll off ${run}`, address: { street: `${run.slice(-4)} Dumpster Dr`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId: data[0]!.id, summary: `Remodel hire ${run}` });
  const { rentalId, lineId } = await aHireOn(job.id, data[0]!.id, identifier);

  await owner.goto(`/jobs/${job.id}`);
  const used = owner.getByRole("region", { name: "Used on this job" });
  const row = used.getByRole("row").filter({ hasText: "20 yard container, 7 day rental" });
  const choice = row.getByLabel("Container 20 yard container, 7 day rental bills");
  await expect(choice).toHaveValue("");
  await choice.selectOption(rentalId);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  const lines = await api<{ data: { id: string; rentalId: string | null }[] }>(owner, "get", `/v1/jobs/${job.id}/lines`);
  expect(lines.data.find((l) => l.id === lineId)?.rentalId).toBe(rentalId);
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Used on this job" }).getByLabel("Container 20 yard container, 7 day rental bills")).toHaveValue(rentalId);
});
