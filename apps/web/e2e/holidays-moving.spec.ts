import type { Page } from "@playwright/test";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * A HOLIDAY THAT MOVES, AND A BRANCH'S OWN DAY OFF
 *
 * The office adds Thanksgiving once, as the fourth Thursday of November, on
 * Settings, Holidays, and the list says when it next falls. Then it gives
 * one branch a day of its own: the list says whose it is, and the company's
 * booking page, which is in no branch, still offers that day.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The fourth Thursday of November on or after today, worked out here the long way round. */
function nextThanksgiving(today: string): string {
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const thursdays: string[] = [];
    for (let day = 1; day <= 30; day += 1) {
      const date = `${year}-11-${String(day).padStart(2, "0")}`;
      if (new Date(`${date}T12:00:00Z`).getUTCDay() === 4) thursdays.push(date);
    }
    if (thursdays[3]! >= today) return thursdays[3]!;
  }
  throw new Error("unreachable");
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

test("a holiday entered as the fourth Thursday of November, and a branch's own day off", async ({ owner, stranger }) => {
  await owner.goto("/settings/holidays");
  await owner.getByLabel("Name", { exact: true }).fill(`Thanksgiving ${run}`);
  await owner.getByLabel("It falls on").selectOption("rule");
  await owner.getByLabel(/^Which one/).selectOption("4");
  await owner.getByLabel(/^Day of the week/).selectOption({ label: "Thursday" });
  await owner.getByLabel(/^Month/).selectOption({ label: "November" });
  await owner.getByLabel("That day").selectOption("closed");
  await owner.getByRole("button", { name: "Add holiday" }).click();
  const row = owner.getByRole("row").filter({ hasText: `Thanksgiving ${run}` });
  await expect(row).toContainText("Fourth Thursday of November");
  await expect(row).toContainText("Every year");
  await expect(row).toContainText("Whole company");
  const next = nextThanksgiving(companyToday());
  await expect(row).toContainText(new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${next}T12:00:00Z`)));

  /** A branch of the company, and a day off of its own on the first day the booking page offers. */
  const branch = await api<{ id: string; name: string }>(owner, "post", "/v1/business-units", { name: `Gulf ${run}` });
  await stranger.goto("/book/ridgeline");
  await stranger.getByRole("button", { name: /Seasonal tune up/ }).click();
  const first = stranger.locator("p.uppercase").first();
  await expect(first).toBeVisible();
  const label = (await first.textContent())!.trim();
  const date = Array.from({ length: 60 }, (_, i) => {
    const [y, m, d] = companyToday().split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10);
  }).find((d) => dayLabel(d) === label)!;

  await owner.reload();
  await owner.getByLabel("Name", { exact: true }).fill(`Gulf picnic ${run}`);
  await owner.getByLabel("Date", { exact: true }).fill(date);
  await owner.getByLabel(/^For/).selectOption({ label: `Gulf ${run} only` });
  await owner.getByRole("button", { name: "Add holiday" }).click();
  const branchRow = owner.getByRole("row").filter({ hasText: `Gulf picnic ${run}` });
  await expect(branchRow).toContainText(`Gulf ${run}`);
  await expect(branchRow).toContainText("Closed");

  /** The company's booking page is in no branch, so the branch's day off is not its day off. */
  await stranger.reload();
  await stranger.getByRole("button", { name: /Seasonal tune up/ }).click();
  await expect(stranger.locator("p.uppercase").filter({ hasText: label })).toHaveCount(1);

  /** Off the list again, both of them. */
  await branchRow.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("row").filter({ hasText: `Gulf picnic ${run}` })).toHaveCount(0);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("row").filter({ hasText: `Thanksgiving ${run}` })).toHaveCount(0);
  expect(branch.name).toBe(`Gulf ${run}`);
});
