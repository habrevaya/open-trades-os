import { test, expect, run, newCustomer } from "./fixtures";

/**
 * SALES TAX FROM THE COMPANY'S OWN RATES, ON THE SCREENS
 *
 * A new company of its own, so the rate it makes usual taxes nothing in any
 * other spec: the rate written down on Settings, a change dated ahead, an
 * invoice composed by hand with a part taxed and labour not, a customer made
 * exempt on a certificate, and the tax read back by rate from the books.
 */
test("a company sets up its rate, invoices are taxed by it, and the books say what each rate collected", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Tara Tax");
  await page.getByLabel("Company name").fill(`Tax Table Plumbing ${run}`);
  await page.getByLabel("Work email").fill(`tara+${run}@taxtable.example`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByRole("button", { name: "Skip for now and go to the app" }).click();
  await expect(page).not.toHaveURL(/\/setup/);

  // The rate, written down. The first one is the usual one.
  await page.goto("/settings/tax");
  await expect(page.getByText("No rates yet, so nothing is taxed.")).toBeVisible();
  const add = page.getByRole("region", { name: "Add a rate" });
  await add.getByLabel("Name").fill("Travis County");
  await add.getByLabel("Percent").fill("8.25");
  await add.getByLabel("Charged from").fill("2020-01-01");
  await add.getByRole("button", { name: "Add rate" }).click();
  await expect(add.getByRole("status")).toHaveText("Rate added.");
  await expect(page.getByText("Taxable lines are charged Travis County at 8.25% unless the customer or the address says otherwise.")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Travis County" });
  await expect(row.getByText("Usual")).toBeVisible();

  // The county raises it from a day ahead: the history says so, today's rate is unchanged.
  const ahead = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await row.getByLabel("New percent for Travis County").fill("8.5");
  await row.getByLabel("From").fill(ahead);
  await row.getByRole("button", { name: "Change from a day" }).click();
  await expect(page.getByText("New percentage saved.")).toBeVisible();
  await expect(page.getByText(/8\.5% from .* \(coming\)/)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Travis County" }).getByRole("cell").nth(1)).toHaveText("8.25%");

  // A customer, and what an invoice to them is charged today.
  const customerId = await newCustomer(page, {
    name: `Hana Homeowner ${run}`,
    address: { street: "12 Elm St", city: "Austin", state: "TX", zip: "78701" },
  });
  const tax = page.getByRole("region", { name: "Sales tax" });
  await expect(tax.getByText("Today: The company's usual rate: Travis County 8.25%.")).toBeVisible();

  // A part, taxed, and labour, not: 100.00 at 8.25% is 8.25 of tax.
  await page.goto(`/invoices/new?customer=${customerId}`);
  await page.getByLabel("Line 1 description").fill("Expansion tank");
  await page.getByLabel("Line 1 unit price").fill("100.00");
  await page.getByRole("button", { name: "Add labour" }).click();
  await page.getByLabel("Line 2 description").fill("Labour");
  await page.getByLabel("Line 2 unit price").fill("120.00");
  await expect(page.getByLabel("Line 2 taxable")).not.toBeChecked();
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByText("tax 8.25%:")).toBeVisible();
  await expect(page.locator('dt:text-is("Total") + dd').first()).toHaveText("$228.25");

  // Exempt on a certificate: nothing charged.
  await page.goto(`/customers/${customerId}`);
  const exempt = page.getByRole("region", { name: "Sales tax" });
  await exempt.getByLabel("Exempt from sales tax").selectOption("yes");
  await exempt.getByLabel("Certificate number").fill("TX-01-339");
  await exempt.getByLabel("Certificate good until").fill(ahead);
  await exempt.getByRole("button", { name: "Save sales tax" }).click();
  await expect(exempt.getByRole("status")).toContainText("Saved.");
  await page.reload();
  await expect(page.getByRole("region", { name: "Sales tax" }).getByText("Today: Tax exempt, certificate TX-01-339")).toBeVisible();

  await page.goto(`/invoices/new?customer=${customerId}`);
  await page.getByLabel("Line 1 description").fill("Valve");
  await page.getByLabel("Line 1 unit price").fill("50.00");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.locator('dt:text-is("Total") + dd').first()).toHaveText("$50.00");

  // What each rate collected, from the books.
  await page.goto("/books/sales-tax");
  const collected = page.getByRole("row").filter({ hasText: "Travis County" });
  await expect(collected.getByRole("cell").nth(1)).toHaveText("8.25%");
  await expect(collected.getByRole("cell").nth(2)).toHaveText("$100.00");
  await expect(collected.getByRole("cell").nth(3)).toHaveText("$8.25");
});
