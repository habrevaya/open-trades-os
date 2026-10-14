import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * A BRANCH WITH HOURS OF ITS OWN
 *
 * The office adds a branch that opens Saturday mornings. On Online booking,
 * Branch hours, the branch starts on the company's hours; the office gives it
 * its own, opening Saturday from seven until noon, and the page says so.
 * Then it puts the branch back on the company's hours.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

type Week = { branches: { businessUnitId: string; source: "branch" | "company"; days: { dayOfWeek: number; opensAt: string | null; closed: boolean }[] }[] };

test("a branch given its own week, and put back on the company's", async ({ owner }) => {
  const name = `Bayou ${run}`;
  const branch = await api<{ id: string }>(owner, "post", "/v1/business-units", { name });

  await owner.goto("/booking");
  await owner.getByRole("link", { name: "Set a branch's own hours" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Branch hours" })).toBeVisible();
  const section = owner.locator("section").filter({ has: owner.getByRole("heading", { name: new RegExp(name) }) });
  await expect(section).toContainText("The company's hours");

  await section.getByText(`Give ${name} its own hours`).click();
  await section.getByLabel(`Saturday closed in ${name}`).uncheck();
  await section.getByLabel(`Saturday opens in ${name}`).fill("07:00");
  await section.getByLabel(`Saturday closes in ${name}`).fill("12:00");
  await section.getByLabel(`Monday closed in ${name}`).check();
  await section.getByRole("button", { name: `Save ${name}'s hours` }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  await owner.reload();
  await expect(section).toContainText("Its own hours");
  await expect(section).toContainText("Sat 07:00 to 12:00");
  await expect(section).toContainText("Mon closed");
  const own = (await api<Week>(owner, "get", "/v1/booking/hours")).branches.find((b) => b.businessUnitId === branch.id)!;
  expect(own.source).toBe("branch");
  expect(own.days.find((d) => d.dayOfWeek === 6)).toMatchObject({ opensAt: "07:00", closed: false });

  await section.getByRole("button", { name: `Use the company's hours for ${name}` }).click();
  await expect(section).toContainText("The company's hours");
  const back = (await api<Week>(owner, "get", "/v1/booking/hours")).branches.find((b) => b.businessUnitId === branch.id)!;
  expect(back.source).toBe("company");
});
