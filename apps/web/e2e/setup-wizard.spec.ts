import { test, expect, run } from "./fixtures";

/**
 * A NEW COMPANY SETS ITSELF UP, START TO FINISH, WITHOUT THE API
 *
 * Every one of the ten steps is a real screen with a real form on it, and the
 * wizard remembers what is done: the list ticks each step off, "carry on"
 * goes to the next one outstanding after a reload, and the list is still
 * there after leaving for the app. Each step submits its own form here (a
 * name, a trade, a territory, opening hours, a teammate, a price change, a
 * tax class, a 10DLC brand) before it is marked done, so a step page that
 * draws a form that does not save fails this, not just one that does not
 * draw.
 */
test("a new company runs every setup step and the wizard remembers each one", async ({ page }) => {
  const company = `Ridge Mechanical ${run}`;
  const email = `rowan+${run}@ridge.example`;

  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Rowan Ridge");
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText("0 of 10 total")).toBeVisible();

  // 1. Company details.
  await page.getByRole("link", { name: "Start with Company details" }).click();
  await expect(page).toHaveURL(/\/setup\/company$/);
  await page.getByLabel("Legal name, if different (optional)").fill(`${company} LLC`);
  await page.getByLabel("Phone customers call").fill("(512) 555-0143");
  await page.getByLabel("Street address").fill("1200 Industrial Blvd");
  await page.getByLabel("Town or city").fill("Austin");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByText(`legally ${company} LLC`)).toBeVisible();
  // What every proposal, invoice and statement will now print under the name.
  await expect(page.getByText("Documents print 1200 Industrial Blvd, Austin, (512) 555-0143.")).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 2. The trade, which loads the price book and marks itself done.
  await expect(page).toHaveURL(/\/setup\/trade$/);
  await page.getByRole("button", { name: /^HVAC/ }).click();
  await expect(page).toHaveURL(/\/setup\?applied=hvac$/);
  await expect(page.getByText("2 of 10 total")).toBeVisible();

  // Resuming: a reload lands the same list, and carrying on goes to step three.
  await page.reload();
  await page.getByRole("link", { name: "Carry on: Service area" }).click();

  // 3. Service area.
  await expect(page).toHaveURL(/\/setup\/service-area$/);
  await page.getByLabel("Name", { exact: true }).fill("Downtown");
  await page.getByLabel("Postal codes for the new territory").fill("78701, 78702");
  await page.getByRole("button", { name: "Add territory" }).click();
  await expect(page.getByText("1 territory declared.")).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 4. Hours.
  await expect(page).toHaveURL(/\/setup\/hours$/);
  await page.getByRole("button", { name: "Save hours" }).click();
  await expect(page.getByText(/Open \d+ days a week\./)).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 5. The team: a technician invited, with a link to hand them.
  await expect(page).toHaveURL(/\/setup\/team$/);
  await page.getByLabel("Their name").fill("Tess Tech");
  await page.getByLabel("Their email").fill(`tess+${run}@ridge.example`);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByLabel("The token, which is not shown again")).toContainText("/welcome?token=");
  await expect(page.getByRole("cell", { name: /Tess Tech/ })).toContainText("Has not signed in yet");
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 6. The price book, moved to the company's market.
  await expect(page).toHaveURL(/\/setup\/pricebook$/);
  await page.getByLabel("Up or down by percent").fill("5");
  await page.getByRole("button", { name: "Show the new prices" }).click();
  await page.getByRole("button", { name: /^Apply to \d+ items$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "prices changed" })).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 7. Tax: a whole shelf marked not taxable, as labour often is.
  await expect(page).toHaveURL(/\/setup\/tax$/);
  const shelf = page.getByRole("listitem").filter({ hasText: "Service (" }).first();
  await shelf.getByLabel("Taxable").selectOption("no");
  await shelf.getByLabel("Class").selectOption("labor");
  await shelf.getByRole("button", { name: /^Set every item in Service/ }).click();
  await expect(shelf.getByRole("status")).toContainText("changed");
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 8. Payments: the connect form is there; this company connects later.
  await expect(page).toHaveURL(/\/setup\/payments$/);
  await expect(page.getByRole("heading", { name: "Card payments" })).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 9. Phone and email: the 10DLC brand written down.
  await expect(page).toHaveURL(/\/setup\/communications$/);
  await page.getByLabel("Legal name, as registered").fill(`${company} LLC`);
  await page.getByLabel("Name customers know you by").fill(company);
  await page.getByRole("button", { name: "Record a brand" }).click();
  await expect(page.getByText("10DLC brand not started.")).toBeVisible();
  await page.getByRole("button", { name: "This step is done, next step" }).click();

  // 10. Accounting.
  await expect(page).toHaveURL(/\/setup\/integrations$/);
  await page.getByRole("button", { name: "This step is done, back to the list" }).click();

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText("10 of 10 total")).toBeVisible();
  await expect(page.getByText("Every step is done.")).toBeVisible();

  // Into the app, and the list is still there afterwards with every tick.
  await page.getByRole("button", { name: "Go to the app" }).click();
  await expect(page).not.toHaveURL(/\/setup/);
  await expect(page.getByText(company).first()).toBeVisible();
  await page.goto("/setup");
  await expect(page.getByText("10 of 10 total")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to the app" })).toBeVisible();

  // A step reopened is outstanding again, and carrying on goes to it.
  await page.goto("/setup/payments");
  await page.getByRole("button", { name: "Not done after all" }).click();
  // Leaving before the step is saved would cancel the save.
  await expect(page.getByRole("button", { name: /^This step is done/ })).toBeVisible();
  await page.goto("/setup");
  await expect(page.getByText("9 of 10 total")).toBeVisible();
  await expect(page.getByRole("link", { name: "Carry on: Payments" })).toBeVisible();
});
