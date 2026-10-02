import { test, expect, run } from "./fixtures";

/**
 * PHASE 0'S DEFINITION OF DONE, IN A BROWSER
 *
 * "Sign up, create a company through the wizard, land in an app shell with a
 * seeded price book." Every step is a real form submit, so this fails if the
 * signup action, the session cookie, the trade pack or the redirect into the
 * shell stops working.
 */
test("a stranger signs up, runs the setup wizard and lands in the app shell with a price book", async ({ page }) => {
  const company = `Northwind Heating ${run}`;

  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Avery Quinn");
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("Work email").fill(`avery+${run}@northwind.example`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create company" }).click();

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: `Set up ${company}` })).toBeVisible();

  // Step two: the trade, which loads the price book.
  await page.getByRole("link", { name: /Your trade/ }).click();
  await expect(page).toHaveURL(/\/setup\/trade$/);
  await page.getByRole("button", { name: /^HVAC/ }).click();
  await expect(page).toHaveURL(/\/setup\?applied=hvac$/);

  await page.getByRole("button", { name: "Skip for now and go to the app" }).click();
  await expect(page).not.toHaveURL(/\/setup/);

  // The shell: the navigation is there and it is this company's.
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expect(page.getByText(company).first()).toBeVisible();

  await page.goto("/pricebook");
  await expect(page).toHaveURL(/\/pricebook$/);
  await expect(page.locator("main table tbody tr").first()).toBeVisible();

  // And back in, with the password, the next morning.
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Work email").fill(`avery+${run}@northwind.example`);
  await page.getByLabel("Password").fill("correct horse battery stapler");
  await page.getByRole("button", { name: /Sign in/ }).click();
  await expect(page.getByText("That email and password do not match")).toBeVisible();
  // The address they typed is still there; only the password needs typing again.
  await expect(page.getByLabel("Work email")).toHaveValue(`avery+${run}@northwind.example`);

  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: /Sign in/ }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(company).first()).toBeVisible();
});

test("a signup refused for a taken email keeps the name and company that were typed", async ({ page }) => {
  const email = `blake+${run}@northwind.example`;
  const fill = async (company: string) => {
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Blake Moreno");
    await page.getByLabel("Company name").fill(company);
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create company" }).click();
  };

  await fill(`Moreno Electric ${run}`);
  await expect(page).toHaveURL(/\/setup$/);
  await page.context().clearCookies();

  await fill(`Moreno Electric Two ${run}`);
  await expect(page.getByText("An account with that email already exists")).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Blake Moreno");
  await expect(page.getByLabel("Company name")).toHaveValue(`Moreno Electric Two ${run}`);
  await expect(page.getByLabel("Work email")).toHaveValue(email);
  await expect(page.getByLabel("Password")).toHaveValue("");
});
