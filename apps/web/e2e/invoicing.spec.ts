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

test("money that arrives before the invoice is held, applied to it later, and the rest given back", async ({ owner }) => {
  const customer = await api<{ id: string }>(owner.request, "POST", "/v1/customers", {
    type: "residential", name: `Priya Ramanathan ${run}`,
  });

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
  const invoice = await api<{ id: string; number: number }>(owner.request, "POST", "/v1/invoices", {
    customerId: customer.id,
    lines: [{ name: "Water heater flush", quantity: "1", unitPrice: "320.00", discountAmount: "0", taxable: false }],
  });
  await owner.reload();
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
