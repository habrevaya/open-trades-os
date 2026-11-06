import { test, expect, run } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * A MIXED LINE, A STEP ON A LINE'S QUANTITY, AND FREIGHT ON STOCK WITH NO ORDER
 *
 * Through the forms: a part a vendor sells by the each and by the box is
 * ordered as 2 boxes and 3 each on one line; an approval step is saved for a
 * line of so many or more; and stock received with no order gets a freight
 * bill that came later.
 */

async function newPart(owner: Page, code: string, name: string, price: string) {
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Price").fill(price);
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
}

test("Purchasing: 2 boxes and 3 each on one line, priced and shown as both", async ({ owner }) => {
  const vendor = `Mixed Supply ${run}`;
  const sku = `MX${run.slice(-6).toUpperCase()}`;
  const csv = [
    "sku,description,cost,vendor,pack qty,uom",
    `${sku},Wire nut ${run},0.55,${vendor},1,`,
    `${sku},Wire nut ${run},10.00,${vendor},25,box`,
  ].join("\n");
  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/Or paste it/).fill(csv);
  await owner.getByLabel(/Price new parts at a margin of/).fill("40");
  await owner.getByLabel(/Add the vendors this file names/).check();
  await owner.getByRole("button", { name: "Preview" }).click();
  const preview = owner.getByRole("form", { name: "Preview" });
  await preview.getByRole("button", { name: "Apply the ticked rows" }).click();
  await expect(preview.getByRole("status")).toContainText("1 vendor added");

  await owner.goto("/purchasing");
  const byPart = owner.locator("form").filter({ has: owner.getByLabel("Part, line 1") });
  await byPart.getByLabel("Vendor").selectOption({ label: vendor });
  await byPart.getByLabel("Deliver to").selectOption({ label: "Shop" });
  await byPart.getByLabel("Part, line 1").fill(sku);
  await byPart.getByLabel("Quantity, line 1").fill("53");
  await byPart.getByLabel("Bought by the each, line 1").fill("3");
  await byPart.getByRole("button", { name: "Create a draft order" }).click();
  await expect(byPart.getByRole("status")).toContainText("Saved.");

  await owner.reload();
  await owner.getByRole("row").filter({ hasText: vendor }).getByRole("link").first().click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(vendor);
  const row = owner.getByRole("row").filter({ hasText: sku });
  await expect(row).toContainText("2 box of 25");
  await expect(row).toContainText("and 3 each");
  await expect(row).toContainText("$21.65");

  // Boxes that do not come out whole are refused in words.
  await owner.goto("/purchasing");
  await byPart.getByLabel("Vendor").selectOption({ label: vendor });
  await byPart.getByLabel("Part, line 1").fill(sku);
  await byPart.getByLabel("Quantity, line 1").fill("50");
  await byPart.getByLabel("Bought by the each, line 1").fill("3");
  await byPart.getByRole("button", { name: "Create a draft order" }).click();
  await expect(byPart.getByRole("alert")).toContainText("a whole number of packs of 25");
});

test("Purchasing: an approval step for a line of 20 or more", async ({ owner }) => {
  await owner.goto("/purchasing/approvals");
  await owner.getByLabel("Orders at or over").fill("0");
  await owner.getByLabel("Approved by").selectOption({ label: "Owner" });
  await owner.getByLabel("Only with a line of this many or more").fill("20");
  await owner.getByRole("button", { name: "Add step" }).click();
  const step = owner.getByRole("table", { name: "Approval steps" }).getByRole("row").filter({ hasText: "a line of 20 or more" });
  try {
    await expect(step).toContainText("The whole order");
  } finally {
    await step.getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByText("No steps")).toBeVisible();
  }
});

test("Inventory: a freight bill that came after stock with no order, spread onto the shelf", async ({ owner }) => {
  const code = `BLT${run.slice(-6).toUpperCase()}`;
  const part = `Anchor bolt ${run}`;
  await newPart(owner, code, part, "5.00");

  await owner.goto("/inventory");
  const receive = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Receive", exact: true }) });
  await receive.getByLabel("Part").selectOption({ label: `${part} (${code})` });
  await receive.getByLabel("Into").selectOption({ label: "Shop (warehouse)" });
  await receive.getByLabel("Quantity").fill("10");
  await receive.getByLabel("What it all cost").fill("100.00");
  await receive.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(receive.getByRole("status")).toContainText("Received");

  await owner.goto("/inventory/receipts");
  const list = owner.getByRole("table", { name: "Stock received without an order" });
  await expect(list.getByRole("row").filter({ hasText: part })).toContainText("$100.00");

  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Spread the bill" }) });
  const delivery = await form.getByLabel("Delivery").locator("option", { hasText: part }).first().getAttribute("value");
  await form.getByLabel("Delivery").selectOption(delivery!);
  await form.getByLabel("Their bill number").fill(`PRO-${run.slice(-4)}`);
  await form.getByLabel("Charge", { exact: true }).first().fill("Freight");
  await form.getByLabel("Amount").first().fill("20.00");
  await form.getByRole("button", { name: "Spread the bill" }).click();
  await expect(form.getByRole("status")).toContainText("Spread 20.00: 20.00 onto parts on a shelf");
  await owner.reload();
  await expect(list.getByRole("row").filter({ hasText: part })).toContainText("$20.00");
});
