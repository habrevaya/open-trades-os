import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { jobHolds } from "@opentradesos/api/services";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * THE HOLD NUDGE THAT DIFFERS BY WHY THE JOB IS WAITING
 *
 * The company's nudge is off. The owner adds a rule on Settings for jobs
 * waiting on the weather: nudge after one day, give it to the manager of the
 * job's branch. A job waiting on the weather is nudged, a job waiting on the
 * customer is not, and taking the rule away on the screen stops it.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function workerPass() {
  const db = createClient();
  try {
    return await jobHolds.nudgePass(db, { force: true });
  } finally {
    await db.$close();
  }
}

async function tasksAbout(jobId: string) {
  const db = createClient();
  try {
    return await db.execute<{ id: string; title: string; body: string; status: string }>(sql`
      select id, title, body, status::text from public.task where entity_type = 'job' and entity_id = ${jobId}::uuid order by created_at`);
  } finally {
    await db.$close();
  }
}

async function ageHold(jobId: string, days: number) {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.job_hold
         set placed_at = (${`${companyToday("America/Chicago")}`}::date - ${days}::int + time '13:00') at time zone 'America/Chicago'
       where job_id = ${jobId}::uuid and released_at is null`);
  } finally {
    await db.$close();
  }
}

async function jobFor(owner: Page, name: string) {
  const customerId = await newCustomer(owner, {
    name, address: { street: `${run.slice(-4)} Patience Pl`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const start = new Date(`${companyToday()}T15:00:00Z`);
  return api<{ id: string; number: number }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Roof job ${name}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
  });
}

async function putOnHold(owner: Page, jobId: string, reason: "weather" | "customer", note?: string) {
  await owner.goto(`/jobs/${jobId}`);
  await owner.locator("summary", { hasText: "Put on hold" }).click();
  await owner.getByLabel("Why is the job waiting?").selectOption(reason);
  if (note) await owner.getByLabel("What it is waiting for (which part, which inspection)").fill(note);
  await owner.getByRole("button", { name: "Put on hold" }).click();
  await expect(owner.getByRole("region", { name: "On hold" })).toBeVisible();
}

test("a rule for jobs waiting on the weather nudges them and not the others, and taking it away stops it", async ({ owner }) => {
  test.setTimeout(150_000);
  const wet = await jobFor(owner, `Rainy Rita ${run}`);
  const slow = await jobFor(owner, `Slow Sam ${run}`);
  await putOnHold(owner, wet.id, "weather");
  await putOnHold(owner, slow.id, "customer", "Gate code");
  await ageHold(wet.id, 2);
  await ageHold(slow.id, 2);

  const region = owner.getByRole("region", { name: "Hold nudges by reason and branch" });
  try {
    /** The company's nudge is off, so nothing is raised. */
    await workerPass();
    expect(await tasksAbout(wet.id)).toHaveLength(0);

    await owner.goto("/settings");
    await region.getByLabel("Why the job is waiting").selectOption("weather");
    await region.getByLabel("Days on hold before a nudge").fill("1");
    await region.getByLabel("Who gets the task").selectOption("branch_manager");
    await region.getByRole("button", { name: "Add rule" }).click();
    await expect(region.getByText(
      "Jobs waiting on the weather: nudge after 1 day, give it to the manager of the job's branch.",
    )).toBeVisible();

    /** The same reason and branch twice is refused in words. */
    await region.getByLabel("Why the job is waiting").selectOption("weather");
    await region.getByLabel("Days on hold before a nudge").fill("4");
    await region.getByRole("button", { name: "Add rule" }).click();
    await expect(region.getByRole("alert")).toContainText("There is already a rule for that reason and branch");

    await workerPass();
    await workerPass();
    const raised = await tasksAbout(wet.id);
    expect(raised.map((t) => t.title)).toEqual([`Job ${wet.number} has been on hold 2 days: waiting on the weather`]);
    expect(raised[0]!.body).toContain("so it stays in the office queue");
    expect(await tasksAbout(slow.id)).toHaveLength(0);

    /** Taken away, the company's off setting is all that is left. */
    await region.getByRole("button", { name: "Take away" }).click();
    await expect(region.getByText("No rules yet.")).toBeVisible();
    await ageHold(slow.id, 9);
    await workerPass();
    expect(await tasksAbout(slow.id)).toHaveLength(0);
  } finally {
    /** Leave no rule behind for the specs that follow. */
    await owner.goto("/settings");
    while (await region.getByRole("button", { name: "Take away" }).count() > 0) {
      await region.getByRole("button", { name: "Take away" }).first().click();
      await owner.waitForTimeout(500);
    }
    for (const id of [wet.id, slow.id]) {
      await owner.goto(`/jobs/${id}`);
      const hold = owner.getByRole("region", { name: "On hold" });
      if (await hold.count() > 0) await hold.getByRole("button", { name: "Take off hold" }).click();
    }
  }
});
