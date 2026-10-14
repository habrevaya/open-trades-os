import { test, expect, run } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * AN APPROVAL STEP FOR PART OF AN ORDER
 *
 * "Over $500 of refrigerant" is about the refrigerant on an order, not its
 * total. Through the forms: a step that counts only a category's lines, an
 * order whose total is far over it but whose refrigerant is under (no step),
 * and one whose refrigerant is over it (the approver is shown which lines).
 */

async function newPart(owner: Page, code: string, name: string, price: string, category?: string) {
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(code);
  if (category) await owner.getByLabel("Category").selectOption({ label: category });
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Price").fill(price);
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
}

test("Purchasing: a step that counts only the refrigerant on an order, and the lines that tripped it", async ({ owner }) => {
  const shelf = `Refrigerant ${run}`;
  const gasCode = `GAS${run.slice(-6).toUpperCase()}`;
  const gas = `R-410A cylinder ${run}`;
  const motorCode = `MTR${run.slice(-6).toUpperCase()}`;
  const motor = `Fan motor ${run}`;
  const vendor = `Gas Supply ${run}`;

  await owner.goto("/pricebook/categories");
  const add = owner.getByRole("region", { name: "Add a category" });
  await add.getByLabel("Name").fill(shelf);
  await add.getByRole("button", { name: "Add category" }).click();
  await expect(owner.getByRole("table", { name: "Categories" })).toContainText(shelf);
  await newPart(owner, gasCode, gas, "400.00", shelf);
  await newPart(owner, motorCode, motor, "3000.00");

  // A step for $500 of that category's lines, not of the order.
  await owner.goto("/purchasing/approvals");
  await owner.getByLabel("Orders at or over").fill("500");
  await owner.getByLabel("Approved by").selectOption({ label: "Owner" });
  await owner.getByLabel("Only with a line from").selectOption({ label: shelf });
  await owner.getByLabel("Count the amount on").selectOption({ label: "Only the lines from that category or for that place" });
  await owner.getByRole("button", { name: "Add step" }).click();
  const step = owner.getByRole("table", { name: "Approval steps" }).getByRole("row").filter({ hasText: shelf });
  await expect(step).toContainText("Only those lines");
  await expect(step).toContainText(`the ${shelf} lines`);

  try {
    await owner.goto("/purchasing");
    await owner.getByLabel("Name", { exact: true }).fill(vendor);
    await owner.getByLabel("Orders email").fill(`orders+${run}@johnstone.test`);
    await owner.getByRole("button", { name: "Add vendor" }).click();
    await expect(owner.getByRole("row").filter({ hasText: vendor })).toBeVisible();

    const draft = async (gasQuantity: string) => {
      await owner.goto("/purchasing");
      const form = owner.locator("form").filter({ has: owner.getByLabel("Part, line 1") });
      await form.getByLabel("Vendor").selectOption({ label: vendor });
      await form.getByLabel("Deliver to").selectOption({ label: "Shop" });
      await form.getByLabel("Part, line 1").fill(gasCode);
      await form.getByLabel("Quantity, line 1").fill(gasQuantity);
      await form.getByLabel("Price, line 1").fill("400");
      await form.getByLabel("Part, line 2").fill(motorCode);
      await form.getByLabel("Quantity, line 2").fill("1");
      await form.getByLabel("Price, line 2").fill("3000");
      await form.getByRole("button", { name: "Create a draft order" }).click();
      await expect(form.getByRole("status")).toContainText("Saved.");
      await owner.reload();
      await owner.getByRole("row").filter({ hasText: vendor }).getByRole("link").first().click();
      await expect(owner.getByRole("heading", { level: 1 })).toContainText(vendor);
    };

    // $3,400 in all, $400 of it refrigerant: under the step, so nobody has to approve it.
    await draft("1");
    await expect(owner.getByRole("region", { name: "Approval" })).toContainText("No approval step applies");

    // $3,800 in all, $800 of it refrigerant: the step waits, and says which lines brought it in.
    await draft("2");
    const approval = owner.getByRole("region", { name: "Approval" });
    await expect(approval).toContainText(`because the ${shelf} lines come to $800.00`);
    const lines = approval.getByRole("list", { name: "Lines that brought in step 1" });
    await expect(lines).toContainText(gas);
    await expect(lines).toContainText("$800.00");
    await expect(lines).not.toContainText(motor);
  } finally {
    await owner.goto("/purchasing/approvals");
    await owner.getByRole("table", { name: "Approval steps" }).getByRole("row").filter({ hasText: shelf })
      .getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByText("No steps")).toBeVisible();
  }
});
