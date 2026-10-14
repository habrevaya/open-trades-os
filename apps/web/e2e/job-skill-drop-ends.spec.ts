import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A SKILL DROPPED FOR ONE JOB, UNTIL A DAY
 *
 * The office drops a skill from a job with a last day, on the job's page. The page says when it
 * ends and that the skill is asked for again after it; the board says the same in words when
 * somebody is sent on a visit inside it; and once the last day has passed the job keeps the
 * drop as a record, with no button to put back what is already asked for, and can drop it again.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** As the company's pages write a day: "Oct 20, 2026". */
const said = (day: string) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function aJobTypeNeeding(skill: string, name: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.job_type (organization_id, name, code, required_skills)
      select id, ${name}, ${`DE${run.slice(-6).toUpperCase()}`}, ${JSON.stringify([skill])}::jsonb
        from public.organization where slug = 'ridgeline' returning id`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

test("a drop with a last day says so on the job and on the board, and is kept once it has ended", async ({ owner }) => {
  test.setTimeout(180_000);
  const DAY = plus(companyToday(), 6);
  const THROUGH = plus(DAY, 2);
  const typeName = `Coil swap ${run}`;
  const typeId = await aJobTypeNeeding("epa_608", typeName);
  const name = `Dropped Until ${run}`;
  const customerId = await newCustomer(owner, { name, address: { street: `${run.slice(-4)} Coil Ln`, city: "Austin", state: "TX", zip: "78702" } });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const start = new Date(`${DAY}T15:00:00Z`);
  const job = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, jobTypeId: typeId, summary: `Swap a coil ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
  });

  /** On the job's page, with a last day: said in words, with the reason. */
  await owner.goto(`/jobs/${job.id}`);
  const skills = owner.getByRole("region", { name: "Skills this work needs" });
  const drop = skills.getByRole("group", { name: "This job does not need one of them" });
  await drop.getByLabel("Skill").selectOption("epa_608");
  await drop.getByLabel("Why this job does not need it").fill("The refrigerant side was done last week");
  await drop.getByLabel("Last day it is not needed (leave empty for no end)").fill(THROUGH);
  await drop.getByRole("button", { name: "Drop it for this job" }).click();
  const dropped = skills.getByRole("list", { name: "Skills this job does not need" });
  await expect(dropped).toContainText(`Not needed on this job through ${said(THROUGH)}: epa_608. After that it is asked for again.`);
  await expect(dropped).toContainText("The refrigerant side was done last week");

  /** On the board, sending somebody inside the drop says it, with the end. */
  await owner.setViewportSize({ width: 2400, height: 1000 });
  await owner.goto(`/schedule?date=${DAY}`);
  const card = owner.getByRole("article").filter({ hasText: name });
  await expect(card).toBeVisible();
  const samColumn = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Sam Reyes", exact: true }) });
  await card.dragTo(samColumn);
  await expect(owner.getByRole("status").filter({
    hasText: `This job does not need epa_608 through ${said(THROUGH)}, and is asked for it again after that: The refrigerant side was done last week.`,
  })).toBeVisible();

  /** The last day passes (moved back, as it will be): the drop stays as a record, nothing to put back, and it can be dropped again. */
  const db = createClient();
  try {
    await db.execute(sql`
      update public.job set dropped_skills = jsonb_set(dropped_skills, '{0,through}', to_jsonb(${plus(companyToday(), -1)}::text))
      where id = ${job.id}`);
  } finally {
    await db.$close();
  }
  await owner.goto(`/jobs/${job.id}`);
  await expect(dropped).toContainText(`Was not needed on this job: epa_608. That ended on ${said(plus(companyToday(), -1))}, so it is asked for again.`);
  await expect(skills.getByRole("button", { name: "Ask for it again" })).toHaveCount(0);
  await expect(skills.getByRole("group", { name: "This job does not need one of them" }).getByLabel("Skill")).toContainText("epa_608");
});
