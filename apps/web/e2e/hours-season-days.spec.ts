import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * A SEASON FOR SATURDAYS ONLY, AND ONE FROM MEMORIAL DAY TO LABOR DAY
 *
 * The office gives a new branch Saturday mornings for a summer far ahead, on
 * Online booking, Branch hours, ticking "Keep the normal hours" on every
 * other day: the list says the season changes Saturday and every other day
 * keeps the normal hours. Then a season from the last Monday of May to the
 * first Monday of September, every year, which the list says in those words.
 * The board on a Saturday under a company season that changes only
 * Saturdays names it, and on the Monday after does not. Everything is taken
 * off at the end, so no other test plans around it.
 */

async function api<T>(page: Page, method: "get" | "post" | "delete", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The first Saturday of June 2041, and the Monday after it. */
const SAT = (() => {
  const d = new Date("2041-06-01T12:00:00Z");
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const MON = (() => {
  const d = new Date(`${SAT}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
})();

test("a season that changes only Saturdays, and one from the last Monday of May to the first Monday of September", async ({ owner }) => {
  const name = `Saturday shop ${run}`;
  await api<{ id: string }>(owner, "post", "/v1/business-units", { name });
  const companySeason = await api<{ id: string }>(owner, "post", "/v1/booking/seasons", {
    name: `Saturday opening ${run}`, startsOn: "2041-06-01", endsOn: "2041-06-30", onlySomeDays: true,
    days: [{ dayOfWeek: 6, opensAt: "08:00", closesAt: "12:00", closed: false }],
  });

  try {
    await owner.goto("/booking/branches");
    const section = owner.locator("section").filter({ has: owner.getByRole("heading", { name: new RegExp(name) }) });
    const seasons = section.getByRole("group", { name: `Seasons for ${name}` });
    const label = `a new season for ${name}`;

    await seasons.getByText(`Add a season for ${name}`).click();
    await seasons.getByLabel(`Name of ${label}`).fill(`Saturday mornings ${run}`);
    await seasons.getByLabel(`First day of ${label}`).fill("2032-06-01");
    await seasons.getByLabel(`Last day of ${label}`).fill("2032-06-30");
    await seasons.getByLabel(`${label} comes back every year`).uncheck();
    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await seasons.getByLabel(`${day} keeps the normal hours in ${label}`).check();
    }
    await seasons.getByLabel(`Saturday closed in ${label}`).uncheck();
    await seasons.getByLabel(`Saturday opens in ${label}`).fill("08:00");
    await seasons.getByLabel(`Saturday closes in ${label}`).fill("12:00");
    await seasons.getByRole("button", { name: `Add the season for ${name}` }).click();
    const saturdays = seasons.getByRole("listitem").filter({ hasText: `Saturday mornings ${run}` });
    await expect(saturdays).toContainText("Sat 08:00 to 12:00. Every other day keeps the normal hours.");

    await saturdays.getByRole("button", { name: `Take off Saturday mornings ${run}` }).click();
    await expect(saturdays).toHaveCount(0);

    /** A season that moves with the calendar, said in words. */
    await owner.goto("/booking/branches");
    await seasons.getByText(`Add a season for ${name}`).click();
    await seasons.getByLabel(`Name of ${label}`).fill(`Summer ${run}`);
    await seasons.getByLabel(`Starts on which week, ${label}`).selectOption("last");
    await seasons.getByLabel(`Starts on which day, ${label}`).selectOption("1");
    await seasons.getByLabel(`Starts in which month, ${label}`).selectOption("5");
    await seasons.getByLabel(`Ends on which week, ${label}`).selectOption("1");
    await seasons.getByLabel(`Ends on which day, ${label}`).selectOption("1");
    await seasons.getByLabel(`Ends in which month, ${label}`).selectOption("9");
    await seasons.getByRole("button", { name: `Add the season for ${name}` }).click();
    await expect(seasons.getByRole("listitem").filter({ hasText: `Summer ${run}` }))
      .toContainText("Last Monday of May to the first Monday of September, every year");

    /** The board on the company's Saturday names the season; the Monday after keeps the normal week. */
    await owner.goto(`/schedule?date=${SAT}`);
    await expect(owner.getByLabel("Hours this day")).toHaveText(`Open 8:00 AM to 12:00 PM, Saturday opening ${run}.`);
    await owner.goto(`/schedule?date=${MON}`);
    await expect(owner.getByLabel("Hours this day")).not.toContainText(`Saturday opening ${run}`);

    await owner.goto("/booking/branches");
    await seasons.getByRole("listitem").filter({ hasText: `Summer ${run}` }).getByRole("button", { name: `Take off Summer ${run}` }).click();
    await expect(seasons).toContainText("No seasons. The hours above apply all year.");
  } finally {
    await api(owner, "delete", `/v1/booking/seasons/${companySeason.id}`);
  }
});
