import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * A TASK GIVEN TO WHOEVER IS ON THE OFFICE ROTA TODAY
 *
 * A hold nudge rule, a recurring task and a task typed in by hand each offer
 * "Whoever is on the office rota today" beside the names of people. The rota
 * itself belongs to another spec, so these say what the screen shows whoever
 * happens to be on call.
 */
const ROTA_LINE = /Given to .+, who is on the office rota today\.|Sent to whoever is on the office rota today: .+\.|nobody is on it today|nobody on it today can open tasks/;

test("a hold nudge rule can give the task to whoever is on the office rota, and is taken away again", async ({ owner }) => {
  const region = owner.getByRole("region", { name: "Hold nudges by reason and branch" });
  await owner.goto("/settings");
  try {
    await region.getByLabel("Why the job is waiting").selectOption("inspection");
    await region.getByLabel("Days on hold before a nudge").fill("6");
    await region.getByLabel("Who gets the task").selectOption("on_call");
    await ready(owner);
    await region.getByRole("button", { name: "Add rule" }).click();
    await expect(region.getByText(/nudge after 6 days, give it to whoever is on the office rota today\./)).toBeVisible();
  } finally {
    await owner.goto("/settings");
    while (await region.getByRole("button", { name: "Take away" }).count() > 0) {
      await region.getByRole("button", { name: "Take away" }).first().click();
      await owner.waitForTimeout(500);
    }
  }
});

test("a recurring task and a task typed in by hand can be for whoever is on the office rota", async ({ owner }) => {
  const recurring = `Open the post ${run}`;
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(recurring);
  await owner.getByLabel("How often").selectOption("weekly");
  await owner.getByLabel(/^Day of the week/).selectOption("1");
  await owner.getByLabel("For", { exact: true }).selectOption("on_call");
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  const row = owner.getByRole("row", { name: new RegExp(recurring) });
  await expect(row).toContainText("Whoever is on the office rota today");

  await row.getByRole("link", { name: `Change ${recurring}` }).click();
  await expect(owner.getByLabel("For", { exact: true })).toHaveValue("on_call");

  const once = `Ring the roofer ${run}`;
  await owner.goto("/tasks");
  await owner.getByText("Add a task").click();
  await owner.getByLabel("What needs doing").fill(once);
  await owner.getByLabel("For", { exact: true }).selectOption("on_call");
  await ready(owner);
  await owner.getByRole("button", { name: "Add task" }).click();
  await owner.getByRole("link", { name: once }).first().click();
  await expect(owner.getByText(ROTA_LINE)).toBeVisible();
});
