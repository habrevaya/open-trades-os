import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * CHANGING A RECURRING TASK
 *
 * The recurring screen changes an existing task's words, schedule and
 * checklist and says the change starts from the next one.
 */

test("a recurring task's title, schedule and checklist are changed on its own page", async ({ owner }) => {
  const title = `Check the vans ${run}`;
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(title);
  await owner.getByLabel("How often").selectOption("weekly");
  await owner.getByLabel(/^Day of the week/).selectOption("1");
  await owner.getByLabel("Checklist, one item a line").fill("Tyres\nOil");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  const row = owner.getByRole("row", { name: new RegExp(title) });
  await expect(row).toContainText("Every Monday");
  await expect(row).toContainText("2 checklist items");

  await row.getByRole("link", { name: `Change ${title}` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // Said before the button, not after it.
  await expect(owner.getByText("A change applies from the next time this comes round.")).toBeVisible();
  await expect(owner.getByLabel("What needs doing")).toHaveValue(title);
  await expect(owner.getByLabel("Checklist, one item a line")).toHaveValue("Tyres\nOil");

  const renamed = `Check the vans and trailers ${run}`;
  await owner.getByLabel("What needs doing").fill(renamed);
  await owner.getByLabel("How often").selectOption("every_n_weeks");
  await owner.getByLabel(/^Day of the week/).selectOption("3");
  await owner.getByLabel(/^How many weeks apart/).fill("2");
  await owner.getByLabel("Checklist, one item a line").fill("Tyres\nOil\nLights");
  await ready(owner);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "It applies from the next time it comes round" })).toBeVisible();
  // The boxes show what is now held, not what was there before.
  await expect(owner.getByLabel("What needs doing")).toHaveValue(renamed);
  await expect(owner.getByLabel("Checklist, one item a line")).toHaveValue("Tyres\nOil\nLights");

  await owner.goto("/tasks/recurring");
  const changed = owner.getByRole("row", { name: new RegExp(renamed) });
  await expect(changed).toContainText("Every 2 weeks on Wednesday");
  await expect(changed).toContainText("3 checklist items");
  await expect(owner.getByRole("row", { name: new RegExp(`^${title}`) })).toHaveCount(0);

  // Refused in the words adding one is refused in, and nothing is half saved.
  await changed.getByRole("link", { name: `Change ${renamed}` }).click();
  await owner.getByLabel("How often").selectOption("chosen_weekdays");
  await ready(owner);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Tick at least one day of the week it comes round on." })).toBeVisible();
  await owner.goto("/tasks/recurring");
  await expect(owner.getByRole("row", { name: new RegExp(renamed) })).toContainText("Every 2 weeks on Wednesday");
});
