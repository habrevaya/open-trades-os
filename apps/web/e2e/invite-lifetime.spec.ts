import { test, expect, run } from "./fixtures";

/**
 * HOW LONG AN INVITE'S LINK WORKS
 *
 * The invite screen says how many days the link works and lets an owner change
 * it, from one to thirty. An invite sent afterwards says the new number where
 * the link is handed over; one sent before keeps its day. A number outside the
 * range is refused in words, and the setting is put back for the specs after
 * this one.
 */
test("the owner sets how many days an invite works, and the invite screen and the invite say so", async ({ owner }) => {
  test.setTimeout(90_000);
  const region = owner.getByRole("region", { name: "Invite somebody" });
  const days = region.getByLabel("Days an invite link works");
  const save = async (value: string) => {
    await days.fill(value);
    await region.getByRole("button", { name: "Save", exact: true }).click();
  };

  await owner.goto("/settings/team");
  try {
    /** Out of range is refused, and the page still says what it said. */
    await save("45");
    await expect(region.getByRole("alert").filter({ hasText: "whole number from 1 to 30" })).toBeVisible();

    await save("3");
    await expect(region.getByText("Invites you send from now on work for 3 days.")).toBeVisible();
    await owner.reload();
    await expect(region).toContainText("Both work for 3 days.");
    await expect(days).toHaveValue("3");

    await owner.getByLabel("Their name").fill(`Lena Lifetime ${run}`);
    await owner.getByLabel("Their email").fill(`lena+${run}@ridge.example`);
    await owner.getByRole("button", { name: "Invite", exact: true }).click();
    const secret = owner.getByLabel("The token, which is not shown again");
    await expect(secret).toContainText("/welcome?token=");
    await expect(owner.getByText(/choose a password, once, in the next 3 days/)).toBeVisible();

    /** One day reads in the singular. */
    await save("1");
    await owner.reload();
    await expect(region).toContainText("Both work for 1 day.");
  } finally {
    await owner.goto("/settings/team");
    await save("7");
    await expect(region.getByText("Invites you send from now on work for 7 days.")).toBeVisible();
  }
});
