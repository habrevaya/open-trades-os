import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * CREW HOURS AGAINST THE BUDGET
 *
 * The budgeted hour variance compares a job's crew hours with what it was
 * budgeted, less the hours of change orders the customer approved. The office
 * sets the budget on the job's page before the work, the page fixes it once an
 * hour is punched, and a change order on the project says how many crew hours
 * it adds and to which job.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** An hour punched on the job, as the crew's phone would leave it. */
async function punchOn(jobId: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes)
      select j.organization_id, (select t.id from public.technician t where t.organization_id = j.organization_id limit 1),
             j.id, 'on_site', now() - interval '1 hour', now(), 60
      from public.job j where j.id = ${jobId}`);
  } finally {
    await db.$close();
  }
}

test("a job's crew hours are budgeted before the work, fixed after, and a change order adds its own", async ({ owner }) => {
  test.setTimeout(120_000);
  const customerId = await newCustomer(owner, {
    name: `Budget Garden ${run}`, address: { street: `${run.slice(-4)} Fern St`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string; number: number }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Stone patio ${run}`,
  });

  await owner.goto(`/jobs/${job.id}`);
  await owner.locator("summary", { hasText: "Budget the crew hours" }).click();
  await owner.getByLabel("Crew hours budgeted (people times hours, with the drive)").fill("32");
  await owner.getByRole("button", { name: "Save the budget" }).click();
  const crew = owner.getByRole("region", { name: "Crew hours" });
  await expect(crew).toContainText("Budgeted 32 crew hours. Nothing punched yet.");

  /** Once an hour is punched the budget is fixed, and the page says where more hours go. */
  await punchOn(job.id);
  await owner.reload();
  await expect(crew).toContainText("Punched so far: 1 crew hour.");
  await expect(crew.getByRole("button", { name: "Save the budget" })).toHaveCount(0);
  await expect(crew).toContainText("put the hours on a change order");

  /** A project with the job on it, and a change order adding crew hours to that job. */
  const project = await api<{ id: string }>(owner, "post", "/v1/projects", {
    customerId, propertyId: data[0]!.id, name: `Garden build ${run}`,
  });
  await api(owner, "post", `/v1/projects/${project.id}/jobs`, { jobId: job.id });
  await owner.goto(`/projects/${project.id}/change-orders`);
  await owner.getByLabel("What is the change").fill("A second seating wall");
  await owner.getByLabel("Crew hours it adds").fill("6");
  await owner.getByLabel("On which job").selectOption({ label: `Job ${job.number}, Stone patio ${run}` });
  await owner.getByRole("button", { name: "Log change" }).click();
  await expect(owner).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Adds 6 on")).toBeVisible();
  await expect(owner.getByRole("link", { name: `job ${job.number}` })).toBeVisible();

  /** Changed while it can still be edited. */
  const hours = owner.getByRole("region", { name: "Crew hours it adds" });
  await hours.getByLabel("Crew hours").fill("8");
  await hours.getByRole("button", { name: "Save crew hours" }).click();
  await expect(owner.getByText("Adds 8 on")).toBeVisible();
});
