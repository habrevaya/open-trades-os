import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * A ROUTE'S FIT, ASKED FOR A DATE
 *
 * The office defines a Tuesday route and asks whether a particular Tuesday
 * fits. That Tuesday is on the holiday list, so the screen says the day is
 * closed rather than measuring it; a Wednesday is refused, because the route
 * runs on Tuesdays.
 */

async function api<T>(page: Page, method: "post" | "delete", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** A Tuesday far enough ahead, and different per run, that no other spec's holiday is on it. */
function farTuesday(): string {
  const start = new Date(Date.UTC(2045, 0, 3 + 7 * (Number(run.replace(/\D/g, "").slice(-3)) || 0)));
  while (start.getUTCDay() !== 2) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString().slice(0, 10);
}

test("a Tuesday route asked about a Tuesday that is a holiday, and about a Wednesday", async ({ owner }) => {
  const tuesday = farTuesday();
  const wednesday = new Date(Date.UTC(Number(tuesday.slice(0, 4)), Number(tuesday.slice(5, 7)) - 1, Number(tuesday.slice(8, 10)) + 1))
    .toISOString().slice(0, 10);
  const holiday = await api<{ id: string }>(owner, "post", "/v1/holidays", { name: `Pool day off ${run}`, date: tuesday, closed: true });
  try {
    await owner.goto("/schedule/routes");
    const name = `Tuesday south ${run}`;
    const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add" }) });
    await add.getByPlaceholder("Tuesday north").fill(name);
    await add.getByLabel("Which weekday").selectOption({ label: "Tuesday" });
    await add.getByLabel("Minutes driving between stops").fill("8");
    await add.getByRole("button", { name: "Add" }).click();
    const row = owner.getByRole("table", { name: "Routes" }).getByRole("row").filter({ hasText: name });
    await row.getByRole("link", { name: "Stops and fit" }).click();
    await expect(owner.getByRole("heading", { level: 2, name })).toBeVisible();

    await owner.getByLabel("Check a date").fill(tuesday);
    await owner.getByRole("button", { name: "Check this date" }).click();
    await expect(owner.getByText(`${tuesday}: Closed that day`)).toBeVisible();
    await expect(owner.getByText(`You are closed on ${tuesday} for Pool day off ${run}.`, { exact: false })).toBeVisible();

    await owner.getByLabel("Check a date").fill(wednesday);
    await owner.getByRole("button", { name: "Check this date" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "runs on Tuesday" })).toBeVisible();

    await owner.getByRole("link", { name: "Back to the usual week" }).click();
    await expect(owner.getByText("Closed that day")).toHaveCount(0);
  } finally {
    await api(owner, "delete", `/v1/holidays/${holiday.id}`);
  }
});
