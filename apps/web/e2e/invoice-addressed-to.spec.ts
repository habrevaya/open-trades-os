import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A BILL ADDRESSED TO THE PERSON WHO HANDLES IT
 *
 * The office adds the customer's bookkeeper as a contact, raises an invoice,
 * and addresses it to her: the invoice says so, and the monthly statements
 * screen says statements go to the person bills are addressed to.
 */
test("the office addresses an invoice to one of the customer's people", async ({ owner: page }) => {
  const name = `Bea Books ${run}`;
  const customerId = await newCustomer(page, {
    name: `Orchard Dental ${run}`,
    address: { street: "21 Pecan St", city: "Austin", state: "TX", zip: "78702" },
  });
  await page.getByRole("button", { name: "Add somebody" }).click();
  await page.locator("#c-name").fill(name);
  await page.locator("#c-phone").fill("(512) 555-0188");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();

  await page.goto(`/invoices/new?customer=${customerId}`);
  await page.getByLabel("Line 1 description").fill("Compressor swap");
  await page.getByLabel("Line 1 unit price").fill("900.00");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);

  const addressed = page.getByRole("region", { name: "Addressed to" });
  await addressed.getByLabel("Addressed to").selectOption({ label: name });
  await addressed.getByRole("button", { name: "Save" }).click();
  await expect(addressed.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.locator('dt:text-is("Addressed to") + dd').first()).toHaveText(name);

  await page.goto("/invoices/statements");
  await expect(page.getByText("It goes to the person their bills are addressed to")).toBeVisible();
});
