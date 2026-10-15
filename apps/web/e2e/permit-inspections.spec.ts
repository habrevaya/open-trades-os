import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A PERMIT ON A JOB, AND THE CITY'S VISITS UNDER IT
 *
 * The office files a permit on the job's page, records the inspector failing
 * the rough in for our work (refused until it says whose work it was), then
 * the reinspection passing, and the page says the job is not a first time
 * pass. Taking the fail off as a mistake makes it one.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function aJobType(name: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.job_type (organization_id, name, code, revenue_class)
      select id, ${name}, ${`PI${run.slice(-6).toUpperCase()}`}, 'install'::job_revenue_class
        from public.organization where slug = 'ridgeline' returning id`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

test("a permit filed on a job, a fail for our work and a pass, and the job's standing", async ({ owner }) => {
  test.setTimeout(120_000);
  const today = companyToday();
  const typeId = await aJobType(`Panel change ${run}`);
  const customerId = await newCustomer(owner, { name: `Permit ${run}`, address: { street: `${run.slice(-4)} Breaker Rd`, city: "Austin", state: "TX", zip: "78702" } });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, jobTypeId: typeId, summary: `Swap the panel ${run}`,
  });

  await owner.goto(`/jobs/${job.id}`);
  const section = owner.getByRole("region", { name: "Permits and inspections" });
  await expect(section).toContainText("No permit on this job yet.");

  /** Filed from the job, with its number and who issued it. */
  await section.getByLabel("What it is").fill("Electrical permit");
  await section.getByLabel("Permit number").fill(`BP-${run}`);
  await section.getByLabel("Issued by").fill("City of Austin");
  await section.getByRole("button", { name: "File the permit" }).click();
  await expect(section.getByRole("heading", { name: /Electrical permit, number BP-/ })).toBeVisible();
  await expect(section).toContainText("No inspection recorded yet.");

  /** A fail with no answer to whose work it was is refused, in words. */
  await section.getByLabel("Day the inspector came").fill(today);
  await section.getByLabel("Stage").fill("Rough in");
  await section.getByLabel("Result").selectOption("failed");
  await section.getByLabel("What the inspector found").fill("No bonding jumper at the water line");
  await section.getByRole("button", { name: "Record the inspection" }).click();
  await expect(section.getByRole("alert").filter({ hasText: "Say whose work the inspector failed" })).toBeVisible();

  await section.getByLabel("If it failed, whose work was it?").selectOption("our_work");
  await section.getByRole("button", { name: "Record the inspection" }).click();
  const table = section.getByRole("table", { name: /Inspections under Electrical permit/ });
  await expect(table.getByRole("row").filter({ hasText: "Rough in" })).toContainText("Failed");
  await expect(table.getByRole("row").filter({ hasText: "Rough in" })).toContainText("Our work");
  await expect(table.getByRole("row").filter({ hasText: "Rough in" })).toContainText("No bonding jumper at the water line");
  await expect(section).toContainText("An inspector failed our work on this job, so it is not a first time pass.");

  /** The reinspection passes; the job is still not a first time pass. */
  await section.getByLabel("Day the inspector came").fill(today);
  await section.getByLabel("Stage").fill("Reinspection");
  await section.getByLabel("Result").selectOption("passed");
  await section.getByLabel("If it failed, whose work was it?").selectOption("");
  await section.getByLabel("What the inspector found").fill("");
  await section.getByRole("button", { name: "Record the inspection" }).click();
  await expect(table.getByRole("row").filter({ hasText: "Reinspection" })).toContainText("Passed");
  await expect(section).toContainText("An inspector failed our work on this job");

  /** The fail was typed on the wrong job: taken off, and the job reads as passing. */
  await table.getByRole("row").filter({ hasText: "Rough in" }).getByRole("button", { name: "Take off" }).click();
  await expect(table.getByRole("row").filter({ hasText: "Rough in" })).toHaveCount(0);
  await expect(section).toContainText("Every inspection so far passed the first time.");
});
