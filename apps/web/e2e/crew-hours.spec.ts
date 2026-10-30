import { test, expect, run } from "./fixtures";

/**
 * A CREW KEEPS HOURS OF ITS OWN
 *
 * The owner adds a crew, gives it a working day of six to eleven, sees it on the list, puts it back on the
 * company's day, and retires the crew so no other test plans around it.
 */
test("the owner gives a crew its own working day and takes it back", async ({ owner }) => {
  const name = `Early crew ${run}`;
  await owner.goto("/schedule/crews");
  await owner.getByPlaceholder("Tree crew").fill(name);
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  const row = owner.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Works the company's day");

  await row.getByLabel(`${name} starts at`).fill("06:00");
  await row.getByLabel(`${name} finishes at`).fill("11:00");
  await row.getByRole("button", { name: "Save hours" }).click();
  await expect(row).toContainText("Works 06:00 to 11:00");

  /** Backwards is refused in words. */
  await row.getByLabel(`${name} starts at`).fill("12:00");
  await row.getByRole("button", { name: "Save hours" }).click();
  await expect(row.getByRole("alert")).toContainText("A working day has to end after it starts.");

  await owner.reload();
  const again = owner.getByRole("row").filter({ hasText: name });
  await again.getByLabel(`${name} starts at`).fill("");
  await again.getByLabel(`${name} finishes at`).fill("");
  await again.getByRole("button", { name: "Save hours" }).click();
  await expect(again).toContainText("Works the company's day");
  await again.getByRole("button", { name: "Retire" }).click();
});
