import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, pointStripeAt, refundSucceeded, succeeded } from "./stripe";

/**
 * A CREDIT PAID BACK TO THE CARD IT CAME FROM
 *
 * The customer paid an invoice by card, the bill turned out to have asked for
 * too much, and there is no later invoice to use the credit on. The office
 * pays it back to their card from the credit note's page, the card processor
 * is asked for the refund, and only when the processor's signed event says
 * the money moved does the credit read as paid back.
 *
 * Stripe is faked at its edges as everywhere else (e2e/stripe.ts): the
 * server's calls to it and the signed webhook. The card payment is taken
 * through the HTTP API and settled by the same signed webhook the card
 * screens wait for, because the card screens have their own spec
 * (booked-to-paid); everything about the credit goes through the screens.
 */
test("a credit on a paid card invoice is paid back to the card, and reads as paid back only once the processor says so", async ({ owner }) => {
  const name = `Wren Okafor ${run}`;
  const customerId = await newCustomer(owner, { name, email: `wren+${run}@example.test` });

  // An invoice, paid in full by card.
  const raised = await owner.request.post("/api/v1/invoices", {
    data: {
      customerId,
      lines: [{ name: "Condensate pump", quantity: "1", unitPrice: "240.00", discountAmount: "0", taxable: false }],
    },
  });
  expect(raised.ok()).toBe(true);
  const invoice = await raised.json() as { id: string; number: number };

  const stripe = await fakeStripeApi();
  try {
    await owner.goto("/settings/integrations");
    let card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await card.getByRole("button", { name: "Connect Stripe" }).click();
    await card.getByPlaceholder("STRIPE_SECRET_KEY").fill("STRIPE_SECRET_KEY");
    await card.getByLabel("Publishable key").fill("pk_test_e2e");
    await card.getByLabel(/Webhook signing secret/).fill("STRIPE_WEBHOOK_SECRET");
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("Saved.");
    await owner.reload();
    card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    const webhookPath = (await card.locator("code").filter({ hasText: "/api/webhooks/payments/" }).textContent())!.trim();
    await pointStripeAt(webhookPath.split("/").pop()!, stripe.baseUrl);

    const intent = await owner.request.post("/api/v1/payments/intents", {
      data: { customerId, invoiceIds: [invoice.id] },
    });
    expect(intent.ok()).toBe(true);
    const charged = stripe.intents.at(-1)!;
    expect(charged.amount).toBe(24000);
    const paid = succeeded(charged);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": paid.signature },
      data: paid.body,
    });
    expect(delivered.status()).toBe(200);
    await owner.goto(`/invoices/${invoice.id}`);
    await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$0.00");

    // Forty dollars off the pump: the invoice is paid, so the credit sits on the account.
    await owner.getByText("Credit this invoice").click();
    await owner.getByLabel("Credit on Condensate pump").fill("40.00");
    await owner.getByRole("combobox", { name: "Why", exact: true }).selectOption("price_adjustment");
    await owner.getByRole("button", { name: "Issue credit note" }).click();
    await expect(owner).toHaveURL(/\/invoices\/credit-notes\/[0-9a-f-]{36}$/);
    const creditNoteUrl = owner.url();
    await expect(owner.getByText("Not yet used", { exact: true }).first()).toBeVisible();

    // Back to their card, through the processor.
    await owner.getByText(`Pay it back to ${name}`).click();
    await owner.getByLabel("How").selectOption("card");
    await expect(owner.getByLabel("Amount")).toHaveValue("40.00");
    await expect(owner.getByLabel("Card payment it goes back through")).toContainText("up to $240.00 back");
    await owner.getByRole("button", { name: "Pay it back" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Asked the card processor" })).toBeVisible();

    // The processor was asked for exactly the credit, against the card payment.
    expect(stripe.refunds).toHaveLength(1);
    const [refund] = stripe.refunds;
    expect(refund).toMatchObject({ paymentIntent: charged.id, amount: 4000 });

    await owner.reload();
    const paidBack = owner.getByRole("table", { name: "Paid back" });
    await expect(paidBack.getByRole("row").filter({ hasText: "Back to their card" })).toContainText("With the card processor");
    // Set aside: nothing is left to use while it is on its way.
    await expect(owner.getByText("Used", { exact: true }).first()).toBeVisible();

    // The processor says the money moved.
    const moved = refundSucceeded(refund!);
    const reported = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": moved.signature },
      data: moved.body,
    });
    expect(reported.status()).toBe(200);

    await owner.goto(creditNoteUrl);
    await expect(paidBack.getByRole("row").filter({ hasText: "Back to their card" })).toContainText("Paid back");
    await expect(owner.locator('dt:text-is("Paid back") + dd').first()).toHaveText("$40.00");

    // The invoice the card paid is still paid; nothing was reopened.
    await owner.goto(`/invoices/${invoice.id}`);
    await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$0.00");

    // And the customer's statement says where the credit went.
    await owner.goto(`/customers/${customerId}/statement`);
    await expect(owner.getByRole("row").filter({ hasText: "paid back to your card" })).toContainText("$40.00");
  } finally {
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await stripe.close();
  }
});
