import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * SUMMER HOURS
 *
 * The office gives a new branch summer hours on Online booking, Branch
 * hours: open Saturdays from six until two, for the summer of 2031. The page
 * lists the season with its dates and its week. A second season that shares
 * a day with it is refused in words. Then the board on a summer Sunday in a
 * far year, under a season the company keeps, says it is open and names the
 * season, and a Sunday after it says closed. Both seasons are taken off at the end, so no other test plans
 * around them.
 */

async function api<T>(page: Page, method: "get" | "post" | "delete", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

type Seasons = { seasons: { id: string; name: string; businessUnitId: string | null }[] };

test("a branch given summer hours, an overlap refused, and the board on a summer Saturday", async ({ owner }) => {
  const name = `Gulf ${run}`;
  const season = `Summer hours ${run}`;
  const branch = await api<{ id: string }>(owner, "post", "/v1/business-units", { name });
  /** The company's own season, far ahead, open Sundays too: 2040-06-17 is a Sunday. */
  const companySeason = await api<{ id: string }>(owner, "post", "/v1/booking/seasons", {
    name: `Long summer ${run}`, startsOn: "2040-06-01", endsOn: "2040-06-30", days: week([0, 1, 2, 3, 4, 5, 6], "07:00", "15:00"),
  });

  try {
    await owner.goto("/booking/branches");
    const section = owner.locator("section").filter({ has: owner.getByRole("heading", { name: new RegExp(name) }) });
    const seasons = section.getByRole("group", { name: `Seasons for ${name}` });
    await expect(seasons).toContainText("No seasons. The hours above apply all year.");

    const label = `a new season for ${name}`;
    await seasons.getByText(`Add a season for ${name}`).click();
    await seasons.getByLabel(`Name of ${label}`).fill(season);
    await seasons.getByLabel(`First day of ${label}`).fill("2031-06-01");
    await seasons.getByLabel(`Last day of ${label}`).fill("2031-08-31");
    await seasons.getByLabel(`${label} comes back every year`).uncheck();
    await seasons.getByLabel(`Saturday closed in ${label}`).uncheck();
    await seasons.getByLabel(`Saturday opens in ${label}`).fill("06:00");
    await seasons.getByLabel(`Saturday closes in ${label}`).fill("14:00");
    await seasons.getByRole("button", { name: `Add the season for ${name}` }).click();
    await expect(seasons.getByRole("listitem").filter({ hasText: season })).toContainText("June 1, 2031 to August 31, 2031");
    await expect(seasons.getByRole("listitem").filter({ hasText: season })).toContainText("Sat 06:00 to 14:00");

    /** A second one sharing August is refused in words. */
    await seasons.getByLabel(`Name of ${label}`).fill(`Heat wave ${run}`);
    await seasons.getByLabel(`First day of ${label}`).fill("2031-08-15");
    await seasons.getByLabel(`Last day of ${label}`).fill("2031-09-15");
    await seasons.getByRole("button", { name: `Add the season for ${name}` }).click();
    await expect(seasons.getByRole("alert")).toContainText(`overlaps "${season}"`);

    const listed = await api<Seasons>(owner, "get", "/v1/booking/seasons");
    expect(listed.seasons.filter((s) => s.businessUnitId === branch.id).map((s) => s.name)).toEqual([season]);

    /** The board on a summer Sunday says the company is open and names its season; a Sunday after it, closed. */
    await owner.goto("/schedule?date=2040-06-17");
    await expect(owner.getByLabel("Hours this day")).toHaveText(`Open 7:00 AM to 3:00 PM, Long summer ${run}.`);
    await owner.goto("/schedule?date=2040-07-08");
    await expect(owner.getByLabel("Hours this day")).toHaveText("Closed on Sundays.");

    await owner.goto("/booking/branches");
    const item = seasons.getByRole("listitem").filter({ hasText: season });
    await item.getByRole("button", { name: `Take off ${season}` }).click();
    await expect(seasons).toContainText("No seasons. The hours above apply all year.");
  } finally {
    await api(owner, "delete", `/v1/booking/seasons/${companySeason.id}`);
  }
});
