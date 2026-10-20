import { test, expect } from "./fixtures";

/**
 * THE DAILY EMAIL OF UNREAD NOTICES, AND HOW LONG READ ONES ARE KEPT
 *
 * The owner turns their own daily email on from their page, sees when it
 * comes, and turns it off again. On Settings they keep read notices thirty
 * days, see it kept, and go back to keeping
 * them for good, which is where every company starts.
 */
test("a person turns their daily email on and off, and the owner sets how long read notices are kept", async ({ owner }) => {
  await owner.goto("/me");
  const told = owner.locator("#notices");
  await expect(told.getByText(/^Off\. Turn it on to get one email each morning at 8 in the morning/)).toBeVisible();
  await told.getByRole("button", { name: "Turn the daily email on" }).click();
  await expect(told.getByText("The daily email is on. It comes each morning when something is unread.")).toBeVisible();
  await owner.reload();
  await expect(told.getByText(/^On\. Each morning at 8 in the morning/)).toBeVisible();
  await told.getByRole("button", { name: "Turn the daily email off" }).click();
  await expect(told.getByText("The daily email is off.")).toBeVisible();

  await owner.goto("/settings");
  const region = owner.getByRole("region", { name: "Read notices" });
  const days = region.getByLabel("Days to keep read notices");
  await days.fill("30");
  await region.getByRole("button", { name: "Save" }).click();
  await expect(region.getByText("Saved. Read notices are removed 30 days after they were read.")).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Read notices" }).getByLabel("Days to keep read notices")).toHaveValue("30");

  // Back to keeping them for good, so no other test's notices go.
  await owner.getByRole("region", { name: "Read notices" }).getByLabel("Days to keep read notices").fill("");
  await owner.getByRole("region", { name: "Read notices" }).getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("region", { name: "Read notices" }).getByText("Saved. Read notices are kept for good.")).toBeVisible();
});
