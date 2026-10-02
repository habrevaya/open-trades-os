import { test, expect, run, newCustomer } from "./fixtures";

/**
 * AN INVOICE'S LIFE IN THE OFFICE
 *
 * Written as a draft, edited, issued, and voided when it turns out it
 * should never have been raised: each through the invoice screens, with the
 * numbers read back off them. Nothing here calls the HTTP API.
 */

test("an invoice is saved as a draft, edited, issued and voided from the invoice screens", async ({ owner }) => {
  const customer = { id: await newCustomer(owner, { name: `Oona Verhoeven ${run}`, email: `oona+${run}@example.test` }) };

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

test("money that arrives before the invoice is held, applied to it later, and the rest given back", async ({ owner }) => {
  const customer = { id: await newCustomer(owner, { name: `Priya Ramanathan ${run}` }) };

  // A deposit by bank transfer, with nothing owed yet: all of it held.
  await owner.goto(`/customers/${customer.id}`);
  await owner.getByRole("link", { name: "Record a payment" }).click();
  await owner.getByLabel("How it was paid").selectOption("ach");
  await owner.getByLabel("Amount received").fill("500.00");
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner).toHaveURL(new RegExp(`/customers/${customer.id}$`));
  const payments = owner.getByRole("region", { name: "Payments" });
  await expect(payments.getByRole("row").filter({ hasText: "Bank transfer" })).toContainText("$500.00");

  // The work is invoiced, and the held money applied to it.
  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Water heater flush");
  await owner.getByLabel("Line 1 unit price").fill("320.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoice = {
    id: owner.url().split("/").pop()!,
    number: (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, ""),
  };
  await owner.goto(`/customers/${customer.id}`);
  await payments.getByText(/^Apply \$500\.00 held/).click();
  await payments.getByLabel(`Apply held money to invoice ${invoice.number}`).fill("320.00");
  await payments.getByRole("button", { name: "Apply held money" }).click();
  await expect(payments.getByRole("row").filter({ hasText: "Bank transfer" })).toContainText(`#${invoice.number}`);
  await expect(payments.getByRole("row").filter({ hasText: "Bank transfer" })).toContainText("$180.00");

  // What is left goes back by cheque.
  await payments.getByText(/^Refund the .* payment of \$500\.00/).click();
  await payments.getByLabel("Amount refunded").fill("180.00");
  await payments.getByLabel("How it went back").selectOption("check");
  await payments.getByLabel("Why").fill("Came in under the deposit");
  await payments.getByRole("button", { name: "Record refund" }).click();
  await expect(payments.getByRole("row").filter({ hasText: "Bank transfer" })).toContainText("Refunded $180.00");

  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid")).toBeVisible();
});

test("a payment the service refuses keeps everything that was typed, so only the wrong box needs changing", async ({ owner }) => {
  await newCustomer(owner, { name: `Wendell Achterberg ${run}` });
  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Thermostat replaced");
  await owner.getByLabel("Line 1 unit price").fill("149.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const number = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

  // More applied to the invoice than came in: refused by the service.
  await owner.getByRole("link", { name: "Record a payment" }).click();
  await owner.getByLabel("How it was paid").selectOption("check");
  await owner.getByLabel("Amount received").fill("50.00");
  await owner.getByLabel(`Apply to invoice ${number}`).fill("80.00");
  await owner.getByLabel("Cheque number").fill("2210");
  await owner.getByLabel("Notes").fill(`Left in the mailbox ${run}`);
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner.getByRole("alert")).toBeVisible();

  // Nothing typed was lost under the refusal.
  await expect(owner.getByLabel("How it was paid")).toHaveValue("check");
  await expect(owner.getByLabel("Amount received")).toHaveValue("50.00");
  await expect(owner.getByLabel(`Apply to invoice ${number}`)).toHaveValue("80.00");
  await expect(owner.getByLabel("Cheque number")).toHaveValue("2210");
  await expect(owner.getByLabel("Notes")).toHaveValue(`Left in the mailbox ${run}`);

  // So fixing the one box is enough.
  await owner.getByLabel(`Apply to invoice ${number}`).fill("50.00");
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$99.00");
});

test("an invoice that asked for too much is credited, and a goodwill credit is used on it from the customer", async ({ owner }) => {
  const customer = { id: await newCustomer(owner, { name: `Cormac Lindqvist ${run}` }) };

  await owner.goto(`/customers/${customer.id}`);
  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Condenser fan motor");
  await owner.getByLabel("Line 1 unit price").fill("400.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoice = {
    id: owner.url().split("/").pop()!,
    number: (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, ""),
  };
  const total = Number((await owner.locator('dt:text-is("Total") + dd').first().textContent())!.replace(/[$,]/g, ""));

  // Fifty dollars off the line, because the bill asked for too much.
  await owner.getByText("Credit this invoice").click();
  await owner.getByLabel("Credit on Condenser fan motor").fill("50.00");
  await owner.getByRole("combobox", { name: "Why", exact: true }).selectOption("billing_error");
  await owner.getByRole("button", { name: "Issue credit note" }).click();
  await expect(owner).toHaveURL(/\/invoices\/credit-notes\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Used", { exact: true }).first()).toBeVisible();
  await expect(owner.getByRole("table", { name: "Where it went" })).toContainText(invoice.number);
  const credit = Number((await owner.locator('dt:text-is("Credit") + dd').first().textContent())!.replace(/[$,]/g, ""));
  expect(credit).toBeGreaterThanOrEqual(50);

  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.locator('dt:text-is("Credited") + dd').first()).toHaveText(`$${credit.toFixed(2)}`);
  await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText(`$${(total - credit).toFixed(2)}`);
  // Nothing was paid: a credit is never counted as money arriving.
  await expect(owner.locator('dt:text-is("Paid")')).toHaveCount(0);

  // Goodwill, from the customer. Refused without words beside it, then given.
  await owner.goto(`/customers/${customer.id}`);
  await owner.getByRole("region", { name: "Credit" }).getByRole("link", { name: "Give a credit" }).click();
  await owner.getByLabel("What it is for").fill("Second visit on us");
  await owner.getByLabel("Amount").fill("25.00");
  await owner.getByRole("button", { name: "Give credit" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Goodwill" })).toContainText("Say why the credit was given");
  await owner.getByLabel("Note").fill("Took two visits to find the leak");
  await owner.getByRole("button", { name: "Give credit" }).click();
  await expect(owner).toHaveURL(/\/invoices\/credit-notes\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Not yet used", { exact: true }).first()).toBeVisible();

  const use = owner.getByRole("region", { name: "Use this credit" });
  await use.getByLabel("Invoice").selectOption({ label: `Invoice ${invoice.number}, owes $${(total - credit).toFixed(2)}` });
  await expect(use.getByLabel("Amount")).toHaveValue("25.00");
  await use.getByRole("button", { name: "Use credit" }).click();
  await expect(owner.getByText("Used", { exact: true }).first()).toBeVisible();

  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText(`$${(total - credit - 25).toFixed(2)}`);
  await owner.goto("/invoices/credit-notes");
  await expect(owner.getByRole("table", { name: "Credit notes" }).getByRole("row").filter({ hasText: `Cormac Lindqvist ${run}` })).toHaveCount(2);
});
