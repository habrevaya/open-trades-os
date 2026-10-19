import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A ROUTE'S FIT READS THE REAL DAY
 *
 * The office asks whether a Tuesday fits a route, with a new customer's stop
 * on it. The person who drives it is on leave all that day, so the screen
 * says the day does not fit and why, in words, rather than measuring a day
 * nobody is working.
 */

async function api<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api${path}`, { data });
  expect(response.ok(), `POST ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A Tuesday far enough ahead, and different per run, that nothing else is on it. */
function farTuesday(): string {
  const start = new Date(Date.UTC(2046, 0, 2 + 7 * (Number(run.replace(/\D/g, "").slice(-3)) || 0)));
  while (start.getUTCDay() !== 2) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString().slice(0, 10);
}

test("a route's fit on a date reads the driver's leave and says why the day is refused", async ({ owner }) => {
  const tuesday = farTuesday();
  const person = `Dana Leave ${run}`;
  const db = createClient();
  try {
    /** A person of their own, on leave all of that Tuesday, approved. */
    const [tech] = await db.execute<{ id: string }>(sql`
      insert into public.technician (organization_id, membership_id, display_name)
      select organization_id, id, ${person} from public.membership
       where organization_id = (select id from public.organization where slug = 'ridgeline') and role = 'owner' limit 1
      returning id`);
    await db.execute(sql`
      insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved, reason)
      select organization_id, ${tech!.id}, (${tuesday}::date)::timestamp at time zone o.timezone,
             (${tuesday}::date + 1)::timestamp at time zone o.timezone, true, 'Away'
        from public.technician t join public.organization o on o.id = t.organization_id where t.id = ${tech!.id}`);

    const route = await api<{ id: string }>(owner, "/v1/service-routes", {
      name: `Tuesday leave ${run}`, dayOfWeek: 2, technicianId: tech!.id, travelMinutesBetweenStops: 10,
    });
    await owner.goto(`/schedule/routes?route=${route.id}`);
    await owner.getByLabel("Check a date").fill(tuesday);
    await owner.getByLabel("Minutes for a new stop").fill("30");
    await owner.getByRole("button", { name: "Check this date" }).click();

    await expect(owner.getByText(`${tuesday}: Does not fit ${person}'s day`)).toBeVisible();
    await expect(owner.getByRole("alert").filter({ hasText: "is on leave all of" }))
      .toContainText(`${person} is on leave all of ${tuesday}, so nothing on this route fits that day.`);
    await expect(owner.getByText("1 stops, 30 minutes of work", { exact: false })).toBeVisible();
  } finally {
    await db.execute(sql`delete from public.time_off where reason = 'Away' and technician_id in
      (select id from public.technician where display_name = ${person})`);
    await db.$close();
  }
});
