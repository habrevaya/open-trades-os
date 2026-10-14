import { test, expect } from "./fixtures";

/**
 * WHO KEEPS THE RENEWALS LIST (M24)
 *
 * Off until the company names somebody: the owner names a person who can read
 * the list, the screen says they will be told, and nobody again after, so the
 * specs that follow see the company as seeded.
 */
test("the owner names who keeps the renewals list on Certifications, and takes it back", async ({ owner }) => {
  await owner.goto("/certifications");
  const keeper = owner.getByRole("region", { name: "Who keeps this list" });
  await expect(keeper).toContainText("each type's own number of days, or the skill's");
  await expect(keeper).toContainText("Nobody else is told.");

  const choice = keeper.getByLabel("Also tell");
  const first = await choice.locator("option").nth(1).textContent();
  expect(first).toBeTruthy();
  await choice.selectOption({ label: first! });
  await keeper.getByRole("button", { name: "Save" }).click();
  await expect(keeper.getByRole("status").filter({ hasText: `Saved. ${first} will be told` })).toBeVisible();
  await expect(keeper).toContainText(`${first} is told as well, because they keep this list.`);
  const read = await owner.request.get("/api/v1/certification-renewals/keeper");
  expect(((await read.json()) as { active: boolean }).active).toBe(true);

  await choice.selectOption({ label: "Nobody else" });
  await keeper.getByRole("button", { name: "Save" }).click();
  await expect(keeper).toContainText("Nobody else is told.");
});
