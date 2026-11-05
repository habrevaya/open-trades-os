import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A TIP RULE ON THE JOB'S PAGE, FOR A KIND OF WORK, AND A PERSON'S WITH DATES
 *
 * The owner gives a job its own tip rule from the job's page and sees which
 * rule a tip today would be shared by and where it comes from; gives a kind
 * of work of its own (made for this run, so no other spec's tips move) a rule
 * on Pay rules and sees the job pick it up; and gives a person a rule with
 * days long past, so no tip in any other spec is shared by it. Everything is
 * taken off again so a rerun starts from the same place.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A kind of work only this run uses, in the job's own company, and the job set to it. */
async function kindOfWorkFor(jobId: string, name: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      with made as (
        insert into public.job_type (organization_id, name)
        select organization_id, ${name} from public.job where id = ${jobId}
        returning id
      )
      update public.job set job_type_id = (select id from made) where id = ${jobId}`);
  } finally {
    await db.$close();
  }
}

test("a job is given its own tip rule from its page, and a kind of work's rule shows there", async ({ owner }) => {
  test.setTimeout(120_000);
  const customerId = await newCustomer(owner, {
    name: `Tip Rule House ${run}`, address: { street: `${run.slice(-4)} Cedar St`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string; number: number }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Water heater ${run}`,
  });
  const kind = `Tank swap ${run}`;
  await kindOfWorkFor(job.id, kind);

  await owner.goto(`/jobs/${job.id}`);
  const panel = owner.getByRole("region", { name: "How a tip on this job is shared" });
  await expect(panel).toContainText("This job has no rule of its own.");
  await expect(panel).toContainText("Nobody is on the job's visits yet");

  await panel.getByLabel("Share tips on this job").selectOption({ label: "All to the lead on the job" });
  await panel.getByLabel("Why (optional)").fill("The lead sold it");
  await panel.getByRole("button", { name: "Give this job its own rule" }).click();
  await expect(panel.getByRole("status")).toContainText("Tips on this job are shared this way from the next one.");
  await owner.reload();
  await expect(panel).toContainText("This job has its own rule: All to the lead on the job. Why: The lead sold it");
  await expect(panel).toContainText("That is this job's own rule.");

  /** The kind of work's rule, set on Pay rules, is next in line once the job's own comes off. */
  await owner.goto("/payroll/pay-rules");
  const byKind = owner.getByRole("region", { name: "Tips by kind of work, or by crew" });
  await byKind.getByLabel("For this kind of work").selectOption({ label: kind });
  await byKind.getByLabel("Share the tips").selectOption({ label: "By the hours each person worked on the job" });
  await byKind.getByRole("button", { name: "Set the rule" }).click();
  await expect(byKind.getByRole("status")).toContainText(`Tips on ${kind} work are shared this way from the next one.`);

  await owner.goto(`/jobs/${job.id}`);
  await panel.getByRole("button", { name: "Take this job's rule off" }).click();
  /** The page itself says it: the button goes with the rule. */
  await expect(panel).toContainText("This job has no rule of its own.");
  await owner.reload();
  await expect(panel).toContainText("This job has no rule of its own.");
  await expect(panel).toContainText("A tip that arrived today: By the hours each person worked on the job.");
  await expect(panel).toContainText("That is the rule for this kind of work.");

  await owner.goto("/payroll/pay-rules");
  const row = byKind.getByRole("table", { name: "Tip rules by kind of work or crew" }).getByRole("row").filter({ hasText: kind });
  await row.getByRole("button", { name: "Take off" }).click();
  await expect(byKind.getByRole("row").filter({ hasText: kind })).toHaveCount(0);
});

test("a person's own tip rule can have a first and a last day", async ({ owner }) => {
  await owner.goto("/payroll/pay-rules");
  const section = owner.getByRole("region", { name: "Tips on one job, or for one person" });
  const person = section.getByLabel("For this person");
  const options = await person.locator("option").allTextContents();
  const name = options.filter((o) => o !== "Nobody, a job instead").at(-1)!;
  await person.selectOption({ label: name });
  await section.getByLabel("Share their tips").selectOption({ label: "By the hours each person worked on the job" });
  await section.getByLabel("A person's first day (optional)").fill("2020-01-01");
  await section.getByLabel("A person's last day (optional)").fill("2020-01-31");
  await section.getByLabel("Why (optional)").fill(`Apprentice term ${run}`);
  await section.getByRole("button", { name: "Set the rule" }).click();
  await expect(section.getByRole("status")).toContainText(`Tips for ${name} are shared this way from the next one.`);

  const row = section.getByRole("table", { name: "Tip rules of their own" }).getByRole("row").filter({ hasText: `Apprentice term ${run}` });
  await expect(row).toContainText("From Jan 1, 2020 until Jan 31, 2020");

  /** A second rule whose days overlap is refused in words. */
  await person.selectOption({ label: name });
  await section.getByLabel("A person's first day (optional)").fill("2020-01-15");
  await section.getByRole("button", { name: "Set the rule" }).click();
  await expect(section.getByText(/They already have a rule of their own from 2020-01-01 until 2020-01-31/)).toBeVisible();

  await row.getByRole("button", { name: "Take off" }).click();
  await expect(section.getByRole("row").filter({ hasText: `Apprentice term ${run}` })).toHaveCount(0);
});
