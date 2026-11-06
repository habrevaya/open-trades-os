import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { deposits } from "@opentradesos/api/services";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { eq } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A HELD DEPOSIT, APPLIED, GIVEN BACK OR KEPT FROM THE OFFICE
 *
 * The deposit is asked for through the API and paid the way a card payment
 * lands, through the processor's path (run here as the webhook runs it),
 * because neither is what is being tested. What is tested is the office:
 * the customer page puts part of it against an invoice and keeps the rest,
 * the invoice page applies one to itself, and the estimate page gives one
 * back. Each says what it does to the money before the button.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The money arriving, as the processor's webhook records it. */
async function paid(depositId: string, amount: string) {
  const db = createClient();
  try {
    const [row] = await db.select({ organizationId: schema.deposit.organizationId })
      .from(schema.deposit).where(eq(schema.deposit.id, depositId)).limit(1);
    if (!row) throw new Error(`No deposit ${depositId}`);
    await deposits.record({ actor: { userId: SYSTEM_USER_ID, organizationId: row.organizationId, roles: ["owner"] }, db }, {
      depositId, amount,
    });
  } finally {
    await db.$close();
  }
}

async function invoice(owner: Page, customerId: string, amount: string) {
  return api<{ id: string; number: number }>(owner, "post", "/v1/invoices", {
    customerId, lines: [{ name: `Install ${run}`, quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
}

test("the customer page puts part of a deposit on an invoice and keeps the rest", async ({ owner }) => {
  const customerId = await newCustomer(owner, { name: `Dee Posit ${run}` });
  const held = await api<{ id: string }>(owner, "post", "/v1/deposits", { customerId, amount: "2000.00" });
  await paid(held.id, "2000.00");
  const bill = await invoice(owner, customerId, "1400.00");

  await owner.goto(`/customers/${customerId}`);
  const panel = owner.getByRole("region", { name: "Deposits held" });
  await expect(panel.getByTestId("deposit")).toContainText("Held.");
  await expect(panel.getByTestId("deposit")).toContainText("Still held: $2,000.00");

  await panel.getByText("Apply to an invoice").click();
  await expect(panel).toContainText("No new money comes in.");
  await panel.getByLabel("Invoice").selectOption(bill.id);
  await panel.getByRole("button", { name: "Apply deposit" }).click();
  // The invoice is paid now, so there is nothing left to apply to, and the form goes with it.
  await expect(panel.getByTestId("deposit")).toContainText("Partly applied, the rest is held.");
  await expect(panel.getByTestId("deposit")).toContainText("Still held: $600.00");

  await owner.goto(`/invoices/${bill.id}`);
  await expect(owner.getByText("Paid", { exact: true }).first()).toBeVisible();

  await owner.goto(`/customers/${customerId}`);
  await panel.getByText("Refund or forfeit").click();
  await expect(panel).toContainText("does not send any money and does not refund a card");
  await panel.getByLabel("Why you are keeping it").fill("Cancelled the second stage the day before. Their terms keep it.");
  await panel.getByRole("button", { name: "Keep the deposit" }).click();
  await expect(panel.getByTestId("deposit")).toContainText("Kept.");
  await expect(panel.getByTestId("deposit")).toContainText("$600.00 kept");
  await expect(panel.getByTestId("deposit")).toContainText("Nothing is held now.");
  await expect(panel.getByText("Refund or forfeit")).toHaveCount(0);
});

test("an invoice applies a held deposit to itself, and an estimate gives one back", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Ira Held ${run}`, address: { street: `${run.slice(-4)} Deposit Row`, city: "Austin", state: "TX", zip: "78704" },
  });
  const held = await api<{ id: string }>(owner, "post", "/v1/deposits", { customerId, amount: "300.00" });
  await paid(held.id, "300.00");
  const bill = await invoice(owner, customerId, "1000.00");

  await owner.goto(`/invoices/${bill.id}`);
  const panel = owner.getByRole("region", { name: "Deposits held" });
  await panel.getByText("Apply to an invoice").click();
  await expect(panel).toContainText(`Invoice ${bill.number}, owing $1,000.00`);
  await panel.getByRole("button", { name: "Apply to this invoice" }).click();
  await expect(panel.getByTestId("deposit")).toContainText("Applied to an invoice.");
  await expect(owner.getByText("$700.00").first()).toBeVisible();

  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
  const estimate = await api<{ id: string }>(owner, "post", "/v1/estimates", {
    customerId, propertyId, title: `Furnace ${run}`,
    options: [{ name: "Standard", isRecommended: true, lines: [
      { name: "Furnace", quantity: "1", unitPrice: "4000.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false },
    ] }],
  });
  const onEstimate = await api<{ id: string }>(owner, "post", "/v1/deposits", { customerId, estimateId: estimate.id, amount: "400.00" });
  await paid(onEstimate.id, "400.00");

  await owner.goto(`/estimates/${estimate.id}`);
  const estimatePanel = owner.getByRole("region", { name: "Deposits held" });
  await expect(estimatePanel.getByTestId("deposit")).toHaveCount(1);
  await expect(estimatePanel.getByTestId("deposit")).toContainText("Still held: $400.00");
  await estimatePanel.getByText("Refund or forfeit").click();
  await estimatePanel.getByRole("button", { name: "Record the refund" }).click();
  // A reason is asked for: the browser stops the empty box before it is sent.
  await expect(estimatePanel.getByTestId("deposit")).toContainText("Held.");
  await estimatePanel.getByLabel("Why it is going back").fill("They chose another company.");
  await estimatePanel.getByRole("button", { name: "Record the refund" }).click();
  await expect(estimatePanel.getByTestId("deposit")).toContainText("Given back.");
  await expect(estimatePanel.getByTestId("deposit")).toContainText("$400.00 given back");
});
