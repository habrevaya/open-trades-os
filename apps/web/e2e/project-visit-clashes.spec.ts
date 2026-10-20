import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * M12: SOMEBODY ON TWO VISITS AT ONCE, ON THE PROJECT'S SCHEDULE.
 *
 * A person held by two of the project's visits in overlapping hours is named
 * under the timeline with the hours and what could be done instead, and the
 * phase is marked. Suggestions only: nothing is moved.
 */

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function startProject(owner: Page, name: string, customer: string): Promise<string> {
  const customerId = await newCustomer(owner, {
    name: customer, address: { street: "9 Elm St", city: "Austin", state: "TX", zip: "78701" },
  });
  await owner.goto("/projects");
  await owner.getByRole("link", { name: "Start a project" }).click();
  await owner.getByLabel("Customer").selectOption(customerId);
  await owner.getByRole("button", { name: "Next" }).click();
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Contract value").fill("30000.00");
  await owner.getByRole("button", { name: "Start project" }).click();
  await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  return owner.url().split("/").pop()!;
}

async function addPhase(owner: Page, phase: { name: string; startsOn: string; endsOn: string }) {
  await owner.getByPlaceholder("Rough-in", { exact: true }).fill(phase.name);
  await owner.getByPlaceholder("Billing value").fill("15000.00");
  await owner.getByLabel("Starts").fill(phase.startsOn);
  await owner.getByLabel("Ends").fill(phase.endsOn);
  await owner.getByRole("button", { name: "Add phase" }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: phase.name }).first()).toBeVisible();
}

test("The schedule names somebody on two visits at once, with what could be done, and moves nobody", async ({ owner }) => {
  const start = addDays(companyToday(), 10);
  const projectId = await startProject(owner, `Elm refit ${run}`, `Elm Clinic ${run}`);
  await addPhase(owner, { name: "Framing", startsOn: start, endsOn: addDays(start, 6) });
  await addPhase(owner, { name: "Wiring", startsOn: addDays(start, 2), endsOn: addDays(start, 9) });
  await owner.getByRole("button", { name: "Create a job for each phase without one" }).click();
  await expect(owner.getByRole("link", { name: "Job 1" })).toHaveCount(2);

  const person = `Sam Ortiz ${run}`;
  const day = addDays(start, 3);
  const db = createClient();
  try {
    /** Framing from one to three in the afternoon, wiring from two to four, the same day, both Sam's. */
    await db.execute(sql`
      with tech as (
        insert into public.technician (organization_id, membership_id, display_name)
        select organization_id, id, ${person} from public.membership
         where organization_id = (select organization_id from public.project where id = ${projectId}) limit 1
        returning id, organization_id),
      visits as (
        insert into public.visit (organization_id, job_id, status, window_start, window_end)
        select (select organization_id from tech), pj.job_id, 'scheduled',
               (${day}::date + case when ph.name = 'Framing' then time '13:00' else time '14:00' end) at time zone 'America/Chicago',
               (${day}::date + case when ph.name = 'Framing' then time '15:00' else time '16:00' end) at time zone 'America/Chicago'
          from public.project_job pj join public.project_phase ph on ph.id = pj.project_phase_id
         where pj.project_id = ${projectId}
        returning id)
      insert into public.visit_assignment (organization_id, visit_id, technician_id)
      select (select organization_id from tech), visits.id, (select id from tech) from visits`);

    await owner.goto(`/projects/${projectId}/schedule`);
    const section = owner.getByRole("region", { name: "On two visits at once" });
    await expect(section).toContainText(`${person} is booked on`);
    await expect(section).toContainText("2:00 PM to 3:00 PM");
    await expect(section).toContainText(`${person} is free at the same time on`);
    await expect(section).toContainText("Nobody has been moved");
    await expect(owner.getByRole("listitem").filter({ hasText: "Framing" }).getByText("Two visits at once")).toBeVisible();

    /** Looking moved nobody: both visits keep their hours and their person. */
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from public.visit_assignment va
        join public.technician t on t.id = va.technician_id where t.display_name = ${person}`);
    expect(rows[0]!.n).toBe(2);
  } finally {
    await db.$close();
  }
});
