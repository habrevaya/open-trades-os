import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * A TASK ONCE A YEAR, ON A MONTH AND A DAY
 *
 * Renew the licence every March 1, and a task on February 29 says what happens
 * in a year without one.
 */
test("a yearly task is added with a month and a day, says so in words, and is changed", async ({ owner }) => {
  const licence = `Renew the licence ${run}`;
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(licence);
  await owner.getByLabel("How often").selectOption("yearly");
  await owner.getByLabel(/^Month \(every year\)/).selectOption("3");
  await owner.getByLabel(/^Date of the month/).fill("1");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(licence) })).toContainText("Every year on March 1");

  const leap = `Leap day check ${run}`;
  await owner.getByLabel("What needs doing").fill(leap);
  await owner.getByLabel("How often").selectOption("yearly");
  await owner.getByLabel(/^Month \(every year\)/).selectOption("2");
  await owner.getByLabel(/^Date of the month/).fill("29");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(leap) }))
    .toContainText("Every year on February 29, or on February 28 in a year without a February 29");

  await owner.getByRole("row", { name: new RegExp(licence) }).getByRole("link", { name: `Change ${licence}` }).click();
  await expect(owner.getByLabel("How often")).toHaveValue("yearly");
  await expect(owner.getByLabel(/^Month \(every year\)/)).toHaveValue("3");
  await owner.getByLabel(/^Month \(every year\)/).selectOption("9");
  await owner.getByLabel(/^Date of the month/).fill("30");
  await ready(owner);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "It applies from the next time it comes round" })).toBeVisible();
  await owner.goto("/tasks/recurring");
  await expect(owner.getByRole("row", { name: new RegExp(licence) })).toContainText("Every year on September 30");
});

test("a yearly task on a day the month does not have is refused in words", async ({ owner }) => {
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(`Bad date ${run}`);
  await owner.getByLabel("How often").selectOption("yearly");
  await owner.getByLabel(/^Month \(every year\)/).selectOption("4");
  await owner.getByLabel(/^Date of the month/).fill("31");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "April has no day 31. Choose a day that is in the month." })).toBeVisible();
});
