import type { Page } from "@playwright/test";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * A CREW'S DAYS OFF AND ITS HOURS ON ONE DATE
 *
 * The office marks Sundays as a day the new crew never works, and gives it a
 * day off on one Tuesday and a short day on the Wednesday after, on Crews and
 * on call. The board says on the crew's lane that it is off on the Tuesday
 * and on a Sunday, and draws the Wednesday in its hours for that date. The
 * crew is retired at the end, so no other test plans around it.
 */

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The first day of a weekday at least a month out, in the company's calendar. */
function dayAhead(weekday: number, from = 30): string {
  const d = new Date(`${companyToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + from);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("a crew's Sundays off, a day off on one date and a short day on another, said on the board", async ({ owner }) => {
  test.setTimeout(120_000);
  const name = `Days off crew ${run}`;
  const crew = await api<{ id: string }>(owner, "post", "/v1/crews", { name });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const member = technicians.find((t) => t.displayName !== "Sam Reyes")!;
  await api(owner, "put", `/v1/crews/${crew.id}/members`, { members: [{ technicianId: member.id, isLead: true }] });
  const tuesday = dayAhead(2);
  const wednesday = new Date(`${tuesday}T12:00:00Z`);
  wednesday.setUTCDate(wednesday.getUTCDate() + 1);
  const wed = wednesday.toISOString().slice(0, 10);
  const sunday = dayAhead(0);

  try {
    await owner.goto("/schedule/crews");
    const row = owner.getByRole("row").filter({ hasText: name });
    await row.getByText(`Days off and dates for ${name}`).click();
    await row.getByLabel(`${name} does not work on Sunday`).check();
    await row.getByRole("button", { name: "Save days off" }).click();
    await expect(row).toContainText("Does not work Sun");

    await row.getByLabel(`Date for ${name}`).fill(tuesday);
    await row.getByLabel(`${name} is off that day`).check();
    await row.getByRole("button", { name: "Save the date" }).click();
    await expect(row.getByRole("list", { name: `Dates for ${name}` })).toContainText(`${tuesday}: Off`);

    await row.getByLabel(`Date for ${name}`).fill(wed);
    await row.getByLabel(`${name} is off that day`).uncheck();
    await row.getByLabel(`${name} starts that day`).fill("06:00");
    await row.getByRole("button", { name: "Save the date" }).click();
    /** Half a day is refused in words. */
    await expect(row.getByRole("alert")).toContainText("Give the time the crew starts and finishes that day");
    await row.getByLabel(`${name} finishes that day`).fill("11:00");
    await row.getByRole("button", { name: "Save the date" }).click();
    await expect(row.getByRole("list", { name: `Dates for ${name}` })).toContainText(`${wed}: 06:00 to 11:00`);

    await owner.setViewportSize({ width: 2400, height: 1000 });
    await owner.goto(`/schedule?date=${tuesday}`);
    await expect(owner.getByRole("region", { name: `Crew ${name}` }).getByLabel(`${name} is off`)).toHaveText(`${name} is off on ${tuesday}.`);
    await owner.goto(`/schedule?date=${sunday}`);
    await expect(owner.getByRole("region", { name: `Crew ${name}` }).getByLabel(`${name} is off`)).toHaveText(`${name} does not work on Sundays.`);
    await owner.goto(`/schedule?date=${wed}`);
    await expect(owner.getByRole("region", { name: `Crew ${name}` }).getByLabel(`${name} works`)).toHaveText("Works 6:00 AM to 11:00 AM today");

    /** Clearing the date puts the crew back on its usual day. */
    await owner.goto("/schedule/crews");
    const again = owner.getByRole("row").filter({ hasText: name });
    await again.getByText(`Days off and dates for ${name}`).click();
    await again.getByRole("list", { name: `Dates for ${name}` }).getByRole("listitem").filter({ hasText: tuesday })
      .getByRole("button", { name: "Clear" }).click();
    await expect(again.getByRole("list", { name: `Dates for ${name}` })).not.toContainText(tuesday);
  } finally {
    await api(owner, "patch", `/v1/crews/${crew.id}`, { active: false });
  }
});
