import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * GETTING A JOB READY, AND HOW MUCH WORK A JOB IS
 *
 * Lawn and landscape's production per crew hour is a job's units of work over
 * the crew's hours on site, leaving out the time loading, driving out and
 * unloading. The technician clocks in for that against one of the day's stops
 * on /my-day, which the clock then says, and the office records how much work
 * the job is on its page, beside the hours, refused in words when it is not
 * an amount.
 */

/** A job type measured in square feet, and the job just booked made one of them. */
async function asInstall(jobId: string): Promise<void> {
  const db = createClient();
  try {
    const [type] = await db.execute<{ id: string }>(sql`
      insert into public.job_type (organization_id, name, code, capacity_model, revenue_class, production_unit)
      select id, ${`Sod install ${run}`}, ${`sod-${run}`}, 'crew_production', 'install', 'square feet'
        from public.organization where slug = 'ridgeline' returning id`);
    await db.execute(sql`update public.job set job_type_id = ${type!.id} where id = ${jobId}`);
  } finally {
    await db.$close();
  }
}

test("the crew clocks in to get a job ready on /my-day, and the office records how much work it is", async ({ tech, owner }) => {
  test.setTimeout(240_000);
  const customer = `Sam Sod ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0163",
    address: { street: "21 Turf Court", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "21 Turf Court, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Front yard sod ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(companyToday());
  await owner.getByLabel("Arrives from").fill("22:00");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();
  await asInstall(jobUrl.split("/").pop()!);

  await tech.goto("/my-day");
  /** The clock is shared with other tests: start from off it. */
  const out = tech.getByRole("button", { name: "Clock out" });
  if (await out.isVisible()) {
    await out.click();
    await expect(tech.getByRole("button", { name: "Clock in" })).toBeVisible();
  }
  await tech.getByText("Getting a job ready first? Clock in for it").click();
  await tech.getByLabel("Which job you are getting ready").selectOption({ label: `${customer}, Front yard sod ${run}` });
  await tech.getByRole("button", { name: "Clock in to get ready" }).click();
  await expect(tech.getByRole("button", { name: "Clock out" })).toBeVisible();
  await expect(tech.getByText("Getting a job ready", { exact: true })).toBeVisible();
  await tech.getByRole("button", { name: "Clock out" }).click();
  await expect(tech.getByRole("button", { name: "Clock in" })).toBeVisible();

  // The office records how much work the job is, beside the hours.
  await expect(async () => {
    await owner.goto(jobUrl);
    await expect(owner.getByRole("region", { name: "Amount of work" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const work = owner.getByRole("region", { name: "Amount of work" });
  await expect(work).toContainText("No amount recorded yet, in square feet.");
  await work.getByLabel("How much work, in square feet").fill("a lot");
  await work.getByRole("button", { name: "Save the amount" }).click();
  await expect(work.getByRole("alert").filter({ hasText: "as a number" })).toBeVisible();
  await work.getByLabel("How much work, in square feet").fill("1200");
  await work.getByRole("button", { name: "Save the amount" }).click();
  await expect(work).toContainText("1200 square feet.");
});
