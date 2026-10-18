import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { jobHolds } from "@opentradesos/api/services";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A JOB LEFT ON HOLD, THE OFFICE TOLD, AND THE BOARD SAYING WHY
 *
 * The owner asks on Settings to be nudged after two days. A job is put on hold
 * for the customer and, with the hold made three days old, the worker's pass
 * (run here as the worker runs it) raises one task in the office queue naming
 * the job, the reason and the days. The dispatch board's card says why the job
 * is waiting. Taking the job off hold closes the task.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The worker's pass over every company, once. */
async function workerPass() {
  const db = createClient();
  try {
    return await jobHolds.nudgePass(db, { force: true });
  } finally {
    await db.$close();
  }
}

/** The nudge tasks about a job, as the database has them. */
async function tasksAbout(jobId: string) {
  const db = createClient();
  try {
    return await db.execute<{ id: string; title: string; status: string }>(sql`
      select id, title, status::text from public.task where entity_type = 'job' and entity_id = ${jobId}::uuid order by created_at`);
  } finally {
    await db.$close();
  }
}

/** The hold made `days` company days old, as if it had been placed then. */
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

test("a job left on hold raises one task for the office, the board says why, and taking it off hold closes the task", async ({ owner }) => {
  test.setTimeout(120_000);
  const settings = async (days: string) => {
    await owner.goto("/settings");
    const region = owner.getByRole("region", { name: "Jobs on hold" });
    await region.getByLabel("Days on hold before a nudge").fill(days);
    await region.getByRole("button", { name: "Save" }).click();
    return region;
  };

  const customerName = `Waiting Wanda ${run}`;
  const customerId = await newCustomer(owner, {
    name: customerName, address: { street: `${run.slice(-4)} Patience Pl`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const start = new Date(`${companyToday()}T15:00:00Z`);
  const job = await api<{ id: string; number: number }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Clear the attic ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
  });

  /** On hold for the customer, in the office's words. */
  await owner.goto(`/jobs/${job.id}`);
  await owner.locator("summary", { hasText: "Put on hold" }).click();
  await owner.getByLabel("Why is the job waiting?").selectOption("customer");
  await owner.getByLabel("What it is waiting for (which part, which inspection)").fill("Attic cleared out");
  await owner.getByRole("button", { name: "Put on hold" }).click();
  await expect(owner.getByRole("region", { name: "On hold" })).toContainText("Waiting on the customer");

  try {
    /** Off until the company turns it on. */
    await ageHold(job.id, 3);
    await workerPass();
    expect(await tasksAbout(job.id)).toHaveLength(0);

    const region = await settings("2");
    await expect(region.getByText("The office gets a task when a job has been on hold 2 days.")).toBeVisible();

    await workerPass();
    await workerPass();
    const title = `Job ${job.number} has been on hold 3 days: waiting on the customer`;
    const raised = await tasksAbout(job.id);
    expect(raised.map((t) => t.title)).toEqual([title]);
    await owner.goto(`/tasks/${raised[0]!.id}`);
    await expect(owner.getByRole("heading", { name: title })).toBeVisible();
    await expect(owner.getByText(`${customerName}: Clear the attic ${run}.`)).toBeVisible();

    /** The board's card says why, in words. */
    await owner.goto(`/schedule?date=${companyToday()}`);
    const card = owner.locator("article").filter({ hasText: customerName });
    await expect(card.getByTestId("board-hold")).toHaveText("On hold 3 days. Waiting on the customer: Attic cleared out");

    /** Off hold, the task goes from the queue and the card stops saying it. */
    await owner.goto(`/jobs/${job.id}`);
    await owner.getByRole("region", { name: "On hold" }).getByRole("button", { name: "Take off hold" }).click();
    await expect(owner.getByRole("region", { name: "On hold" })).toHaveCount(0);
    await owner.goto(`/tasks/${raised[0]!.id}`);
    await expect(owner.getByText("Done", { exact: true })).toBeVisible();
    expect((await tasksAbout(job.id)).map((t) => t.status)).toEqual(["done"]);
    await owner.goto(`/schedule?date=${companyToday()}`);
    await expect(owner.locator("article").filter({ hasText: customerName }).getByTestId("board-hold")).toHaveCount(0);
  } finally {
    /** Switched off again, so no other spec is nudged. */
    const region = await settings("");
    await expect(region.getByText("Nobody is nudged about a job on hold.")).toBeVisible();
  }
});
