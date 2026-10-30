import { test, expect } from "./fixtures";

/**
 * WHAT NEW PEOPLE ARE TOLD
 *
 * The owner opens Settings, takes a kind of notice off the phone app for
 * people added from now on, saves, sees it kept after a reload, and puts it
 * back so no other test starts people on a changed default. The page says
 * plainly that nobody already here is changed and that texts are not here.
 */
test("the owner sets what a new person's notices start as, and puts it back", async ({ owner }) => {
  await owner.goto("/settings");
  const region = owner.getByRole("region", { name: "What new people are told" });
  await expect(region.getByText("People already here keep what they have.")).toBeVisible();
  await expect(region.getByText(/Texts are not here/)).toBeVisible();

  const phone = region.getByLabel("A deadline about to be missed: on the phone app");
  await expect(phone).toBeChecked();
  await phone.uncheck();
  await region.getByRole("button", { name: "Save" }).click();
  await expect(region.getByText("Saved. People you add from now on start with these. Nobody already here is changed.")).toBeVisible();

  await owner.reload();
  const again = owner.getByRole("region", { name: "What new people are told" });
  await expect(again.getByLabel("A deadline about to be missed: on the phone app")).not.toBeChecked();
  await expect(again.getByLabel("A deadline about to be missed: in the app")).toBeChecked();
  /** The kinds the office queue raises are listed with the rest. */
  await expect(again.getByText("A customer asking to change a visit")).toBeVisible();
  await expect(again.getByText("An automatic payment that failed")).toBeVisible();

  // Back to where every company starts.
  await again.getByLabel("A deadline about to be missed: on the phone app").check();
  await again.getByRole("button", { name: "Save" }).click();
  await expect(again.getByText("Saved. People you add from now on start with these.")).toBeVisible();
});
