import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * THE FIFTH GIVEN WEEKDAY OF A MONTH, AND A GAP OF MORE THAN A YEAR
 *
 * A task on the fifth Monday says in words that a month without one is
 * skipped, and an every few weeks task can be set to 104 weeks.
 */
test("a task on the fifth Monday says which months are skipped, and one every 104 weeks is kept", async ({ owner }) => {
  const fifth = `Quarter stock count ${run}`;
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(fifth);
  await owner.getByLabel("How often").selectOption("nth_weekday_of_month");
  await owner.getByLabel(/^Day of the week/).selectOption("1");
  await owner.getByLabel(/^Which one in the month/).selectOption("5");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(fifth) }))
    .toContainText("On the fifth Monday of the month, and a month without a fifth Monday is skipped");

  const slow = `Two yearly service ${run}`;
  await owner.getByLabel("What needs doing").fill(slow);
  await owner.getByLabel("How often").selectOption("every_n_weeks");
  await owner.getByLabel(/^Day of the week/).selectOption("1");
  await owner.getByLabel(/^How many weeks apart/).fill("104");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(slow) })).toContainText("Every 104 weeks on Monday");
});
