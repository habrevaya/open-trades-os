import { test, expect, run } from "./fixtures";

/**
 * A SUPPLIER'S CATALOGUE THAT NAMES A NEW VENDOR AND SELLS A PART TWO WAYS
 *
 * The owner pastes a file from a supplier nobody has set up, which sells a
 * wire nut by the each and by the box of 25. Left alone the new vendor's rows
 * are skipped; ticked, the preview says the vendor will be added and that the
 * box is a second way to buy the same part. Then an order by part number
 * offers the box first, as the cheaper per nut, and fifty nuts go as two
 * boxes.
 */
test("a catalogue adds the vendor it names when asked, and a part sold by the each and the box is ordered the cheaper way", async ({ owner }) => {
  const vendor = `Graybar ${run}`;
  const sku = `WN${run.slice(-6).toUpperCase()}`;
  const csv = [
    "sku,description,cost,vendor,pack qty,uom",
    `${sku},Wire nut ${run},0.55,${vendor},1,`,
    `${sku},Wire nut ${run},10.00,${vendor},25,box`,
  ].join("\n");

  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/Or paste it/).fill(csv);
  await owner.getByLabel(/Price new parts at a margin of/).fill("40");
  await owner.getByRole("button", { name: "Preview" }).click();
  const preview = owner.getByRole("form", { name: "Preview" });
  // Off by default: a vendor nobody set up is not invented.
  await expect(preview).toContainText(`There is no vendor called "${vendor}"`);

  // The options are set again for the second preview, as a person would after reading the first.
  await owner.getByLabel(/Price new parts at a margin of/).fill("40");
  await owner.getByLabel(/Add the vendors this file names/).check();
  await owner.getByRole("button", { name: "Preview" }).click();
  await expect(owner.getByTestId("new-vendors")).toContainText(vendor);
  await expect(preview.getByRole("row").filter({ hasText: "Second way to buy it" })).toContainText("(with line 2)");
  await preview.getByRole("button", { name: "Apply the ticked rows" }).click();
  await expect(preview.getByRole("status")).toContainText("1 vendor added");

  await owner.goto("/purchasing");
  const byPart = owner.locator("form").filter({ has: owner.getByLabel("Part, line 1") });
  await byPart.getByLabel("Vendor").selectOption({ label: vendor });
  await byPart.getByLabel("Deliver to").selectOption({ label: "Shop" });
  await byPart.getByLabel("Part, line 1").fill(sku);
  await byPart.getByLabel("Quantity, line 1").fill("50");
  // The box is offered first: 0.40 a nut against 0.55.
  const how = byPart.getByLabel("Buy it, line 1");
  await expect(how.locator("option").first()).toContainText("by the box of 25, 0.40 each");
  await byPart.getByRole("button", { name: "Create a draft order" }).click();
  await expect(byPart.getByRole("status")).toContainText("Saved.");

  await owner.reload();
  await owner.getByRole("row").filter({ hasText: vendor }).getByRole("link").first().click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(vendor);
  await expect(owner.getByRole("row").filter({ hasText: sku })).toContainText("box");
  await expect(owner.getByText("$20.00").first()).toBeVisible();
});
