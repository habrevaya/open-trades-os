import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A RATE WRITTEN DOWN AS ITS STATE, COUNTY AND CITY PARTS, ON THE SCREENS
 *
 * A new company of its own, so its rates tax nothing in any other spec. The
 * rate is entered as three parts with no whole percent, charged as their sum
 * on an invoice, and the books show the tax again split by part.
 */
test("a rate entered in parts is charged as their sum and filed by part", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Pat Parts");
  await page.getByLabel("Company name").fill(`Rate Parts Plumbing ${run}`);
  await page.getByLabel("Work email").fill(`pat+${run}@rateparts.example`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByRole("button", { name: "Skip for now and go to the app" }).click();
  await expect(page).not.toHaveURL(/\/setup/);

  await page.goto("/settings/tax");
  const add = page.getByRole("region", { name: "Add a rate" });
  await add.getByLabel("Name").fill("Austin");
  await add.getByLabel("Charged from").fill("2020-01-01");
  await add.getByLabel("Part 1", { exact: true }).fill("Texas");
  await add.getByLabel("Part 1 %", { exact: true }).fill("6.25");
  await add.getByLabel("Part 2", { exact: true }).fill("Travis County");
  await add.getByLabel("Part 2 %", { exact: true }).fill("1");

  // A third part that does not add up to the whole rate typed is refused, in words.
  await add.getByLabel("Part 3", { exact: true }).fill("City of Austin");
  await add.getByLabel("Part 3 %", { exact: true }).fill("1");
  await add.getByLabel("Percent").fill("8.5");
  await add.getByRole("button", { name: "Add rate" }).click();
  await expect(add.getByRole("alert").filter({ hasText: "The parts add up to 8.25%" })).toBeVisible();

  // Left empty, the whole rate is the sum.
  await add.getByLabel("Percent").fill("");
  await add.getByRole("button", { name: "Add rate" }).click();
  await expect(add.getByRole("status")).toHaveText("Rate added.");
  const row = page.getByRole("row").filter({ hasText: "Austin" }).first();
  await expect(row.getByRole("cell").nth(1)).toHaveText("8.25%");
  await expect(row.getByText("Texas 6.25% + Travis County 1% + City of Austin 1%")).toBeVisible();

  // The customer pays 8.25%, exactly as for a rate typed as one number.
  const customerId = await newCustomer(page, {
    name: `Paula Parts ${run}`,
    address: { street: "4 Oak St", city: "Austin", state: "TX", zip: "78701" },
  });
  await page.goto(`/invoices/new?customer=${customerId}`);
  await page.getByLabel("Line 1 description").fill("Water heater");
  await page.getByLabel("Line 1 unit price").fill("1000.10");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.locator('dt:text-is("Total") + dd').first()).toHaveText("$1,082.61");

  // The books: by rate, and the same tax by part, adding up to the cent.
  await page.goto("/books/sales-tax");
  const byRate = page.getByRole("table", { name: "Sales tax collected by rate" });
  await expect(byRate.getByRole("row").filter({ hasText: "Austin" }).getByRole("cell").nth(3)).toHaveText("$82.51");
  const byPart = page.getByRole("table", { name: "Sales tax collected by part" });
  const cell = (name: string) => byPart.getByRole("row").filter({ hasText: name }).getByRole("cell");
  await expect(cell("Texas").nth(1)).toHaveText("6.25%");
  await expect(cell("Texas").nth(2)).toHaveText("$1,000.10");
  await expect(cell("Texas").nth(3)).toHaveText("$62.51");
  await expect(cell("Travis County").nth(3)).toHaveText("$10.00");
  await expect(cell("City of Austin").nth(3)).toHaveText("$10.00");
});
