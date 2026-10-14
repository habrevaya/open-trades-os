import { test, expect, run } from "./fixtures";

/**
 * THE DAYS A DISPOSAL FACILITY IS CLOSED
 *
 * A transfer station keeps its own holidays, and a day plan skips a facility
 * that is shut. Through the form: closed days typed one to a line, one off and
 * yearly, shown on the facility, changed, and refused in words when a line is
 * not a date.
 */
test("Disposal facilities: the days a facility is closed are recorded, shown and changed", async ({ owner }) => {
  const name = `Holiday Pit ${run}`;
  await owner.goto("/fleet/containers/facilities");

  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add facility" }) });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Closed on these dates").fill("2026-11-26 Thanksgiving");
  await add.getByLabel("Closed every year on").fill("12-25 Christmas");
  await add.getByRole("button", { name: "Add facility" }).click();

  const card = owner.getByRole("listitem", { name });
  await expect(card).toContainText("Closed on 2026-11-26 (Thanksgiving), every 12-25 (Christmas).");

  const change = card.locator("form").filter({ has: owner.getByRole("button", { name: "Save changes" }) });
  await change.getByLabel("Closed on these dates").fill("26 November");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(change.getByRole("alert").filter({ hasText: "is not a date" })).toContainText("26 is not a date");

  await change.getByLabel("Closed on these dates").fill("2026-11-26 Thanksgiving\n2026-12-24 Christmas Eve");
  await change.getByLabel("Closed every year on").fill("");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(card).toContainText("Closed on 2026-11-26 (Thanksgiving), 2026-12-24 (Christmas Eve).");
});
