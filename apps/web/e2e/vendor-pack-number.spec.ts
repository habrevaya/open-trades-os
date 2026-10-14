import { test, expect, run } from "./fixtures";

/**
 * A PART SOLD BY THE BOX UNDER A DIFFERENT PART NUMBER
 *
 * Through the forms: a vendor's number for a part by the each and another for
 * the box of 25, kept on the item's page, and an order that types the box's
 * number and gets a line for boxes carrying it.
 */
test("Purchasing: a box with its own part number is kept on the item and ordered by that number", async ({ owner }) => {
  const code = `WNT${run.slice(-6).toUpperCase()}`;
  const vendor = `Box Supply ${run}`;
  const each = `EA-${run}`;
  const box = `BX-${run}`;

  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(`Wire nuts ${run}`);
  await owner.getByLabel("Price").fill("2.00");
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
  const itemPage = owner.url();

  await owner.goto("/purchasing");
  await owner.getByLabel("Name", { exact: true }).fill(vendor);
  await owner.getByRole("button", { name: "Add vendor" }).click();
  await expect(owner.getByRole("row").filter({ hasText: vendor })).toBeVisible();

  // The each's number, and the box of 25 under another.
  await owner.goto(itemPage);
  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save vendor number" }) });
  await form.getByLabel("Vendor").selectOption({ label: vendor });
  await form.getByLabel("Their part number").fill(each);
  await form.getByLabel("Their price for one", { exact: true }).fill("0.50");
  await form.getByLabel("How many in one, the second way").fill("25");
  await form.getByLabel("What they call that").fill("box");
  await form.getByLabel("Their price for one of those").fill("10.00");
  await form.getByLabel("Their number for that, if it is different").fill(box);
  await form.getByRole("button", { name: "Save vendor number" }).click();
  await expect(form.getByRole("status")).toContainText("Saved.");
  await expect(owner.getByTestId("second-pack")).toContainText(`their number ${box}`);

  // Another part may not take the box's number.
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(`${code}X`);
  await owner.getByLabel("Name").fill(`Strap ${run}`);
  await owner.getByLabel("Price").fill("1.00");
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
  const other = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save vendor number" }) });
  await other.getByLabel("Vendor").selectOption({ label: vendor });
  await other.getByLabel("Their part number").fill(box);
  await other.getByRole("button", { name: "Save vendor number" }).click();
  await expect(other.getByRole("alert").filter({ hasText: "already this vendor's number" })).toBeVisible();

  // Typing the box's number on an order means the box.
  await owner.goto("/purchasing");
  const byPart = owner.locator("form").filter({ has: owner.getByLabel("Part, line 1") });
  await byPart.getByLabel("Vendor").selectOption({ label: vendor });
  await byPart.getByLabel("Deliver to").selectOption({ label: "Shop" });
  await byPart.getByLabel("Part, line 1").fill(box);
  await byPart.getByLabel("Quantity, line 1").fill("50");
  await byPart.getByRole("button", { name: "Create a draft order" }).click();
  await expect(byPart.getByRole("status")).toContainText("Saved.");
  await owner.reload();
  await owner.getByRole("row").filter({ hasText: vendor }).getByRole("link").first().click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(vendor);
  const line = owner.getByRole("row").filter({ hasText: code });
  await expect(line).toContainText(box);
  await expect(line).toContainText("2 box of 25");
});
