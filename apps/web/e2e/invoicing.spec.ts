import { test, expect, run, api } from "./fixtures";

/**
 * AN INVOICE'S LIFE IN THE OFFICE
 *
 * Written as a draft, edited, issued, and voided when it turns out it
 * should never have been raised: each through the invoice screens, with the
 * numbers read back off them.
 */
test("an invoice is saved as a draft, edited, issued and voided from the invoice screens", async ({ owner }) => {
  const customer = await api<{ id: string }>(owner.request, "POST", "/v1/customers", {
    type: "residential", name: `Oona Verhoeven ${run}`, email: `oona+${run}@example.test`,
  });

  await owner.goto(`/customers/${customer.id}`);
  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Furnace tune up");
  await owner.getByLabel("Line 1 quantity").fill("1");
  await owner.getByLabel("Line 1 unit price").fill("149.00");
  await owner.getByLabel("Adjustment amount (negative takes money off)").fill("-20.00");
  await owner.getByLabel("Save as a draft to finish later").check();
  await owner.getByRole("button", { name: "Create invoice" }).click();

  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Draft", { exact: true }).first()).toBeVisible();
  await expect(owner.locator('dt:text-is("Total") + dd').first()).toHaveText("$129.00");

  // Edited: a second unit, the discount kept.
  await owner.getByRole("link", { name: "Edit draft" }).click();
  await expect(owner.getByLabel("Adjustment amount (negative takes money off)")).toHaveValue("-20.00");
  await owner.getByLabel("Line 1 quantity").fill("2");
  await owner.getByRole("button", { name: "Save draft" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.locator('dt:text-is("Total") + dd').first()).toHaveText("$278.00");

  // Issued, then voided with a reason.
  await owner.getByRole("button", { name: "Issue invoice" }).click();
  await expect(owner.getByText("Open", { exact: true }).first()).toBeVisible();
  await owner.getByText("Void this invoice").click();
  await owner.getByLabel("Why it is being voided").fill("Raised for the wrong customer");
  await owner.getByRole("button", { name: "Void invoice" }).click();
  await expect(owner.getByText("Void", { exact: true }).first()).toBeVisible();
  await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$0.00");
});
