import { test, expect } from "./fixtures";

/**
 * HOW LONG WEBHOOK DELIVERY HISTORY IS KEPT, CHOSEN BY THE COMPANY
 *
 * The owner keeps ninety days and five hundred attempts per address, the page
 * says so in its own words, and then puts it back to thirty days and a
 * thousand, as it was.
 */
test("the owner chooses how long delivery history is kept, and puts it back", async ({ owner }) => {
  await owner.goto("/settings/webhooks");
  const keep = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "How long we keep what was sent" }) });
  await expect(keep).toContainText("Each address keeps thirty days of attempts");
  try {
    await keep.getByLabel("Days to keep").fill("90");
    await keep.getByLabel("Attempts to keep for each address").fill("500");
    await keep.getByRole("button", { name: "Save how long" }).click();
    await expect(keep.getByRole("status")).toHaveText("Saved. Each address keeps 90 days of history, and no more than 500 attempts.");
    await owner.reload();
    await expect(owner.getByText("is kept for 90 days, and no", { exact: false })).toBeVisible();
  } finally {
    await owner.goto("/settings/webhooks");
    await keep.getByLabel("Days to keep").fill("30");
    await keep.getByLabel("Attempts to keep for each address").fill("1000");
    await keep.getByRole("button", { name: "Save how long" }).click();
    await expect(keep.getByRole("status")).toContainText("30 days");
  }
});
