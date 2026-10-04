import { test, expect, run } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";
import { E2E_STRIPE_ENV } from "./stripe-env";

/**
 * PHASE 1'S DEFINITION OF DONE, IN A BROWSER
 *
 * "Create a customer, book a job, complete it, invoice it, take a card
 * payment, and see the money in a report that agrees with the ledger to the
 * cent."
 *
 * Every step goes through the screens a person would use, and nothing calls
 * the HTTP API: the customer and their address, booking the job, completing
 * its visit, raising the invoice and handing over its link, recording part of
 * it paid by cheque, connecting Stripe in settings and taking the rest by
 * card. Every result is read back off the screens a person would check,
 * which is where a wrong number would be seen.
 *
 * Stripe itself is the one thing faked, at its edges only (e2e/stripe.ts):
 * the server's request for a payment intent, the Payment Element the browser
 * loads from js.stripe.com, and the signed webhook that says the money
 * moved. Paying with a real card needs a real Stripe account, and nothing
 * between those edges is skipped.
 */

const money = (amount: string) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("the owner books a job from a new customer through to paid, and the report agrees with the invoice to the cent", async ({ owner, stranger }) => {
  const name = `Imogen Hartley ${run}`;

  // The customer and their address, through the form.
  await owner.goto("/customers/new");
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Phone").fill("512-555-0188");
  await owner.getByLabel("Email").fill(`imogen+${run}@example.test`);
  await owner.getByLabel("Street").fill("88 Bluebonnet Ln");
  await owner.getByLabel("City").fill("Austin");
  await owner.getByLabel("State").fill("TX");
  await owner.getByLabel("ZIP").fill("78704");
  await owner.getByRole("button", { name: "Save customer" }).click();

  await expect(owner).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  const customerId = owner.url().split("/").pop()!;
  const address = owner.getByRole("link", { name: "88 Bluebonnet Ln, Austin" });
  await expect(address).toBeVisible();
  const propertyId = (await address.getAttribute("href"))!.split("/").pop()!;
  expect(propertyId).toMatch(/^[0-9a-f-]{36}$/);

  // The property page opens for the address the form created.
  await address.click();
  await expect(owner).toHaveURL(new RegExp(`/properties/${propertyId}$`));
  await expect(owner.getByText("88 Bluebonnet Ln").first()).toBeVisible();

  // Booked, from the customer's address, with its first visit tomorrow morning.
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await expect(owner).toHaveURL(/\/jobs\/new\?customer=/);
  await owner.getByLabel("Summary").fill(`No cooling upstairs ${run}`);
  await owner.getByLabel("Customer said").fill("Clicking, then it stopped blowing cold");
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
  await owner.getByLabel("Arrives from").fill("10:00");
  await owner.getByLabel("Expected to take (minutes)").fill("90");
  await owner.getByRole("button", { name: "Book job" }).click();

  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = owner.url().split("/").pop()!;
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`No cooling upstairs ${run}`);
  await expect(owner.getByRole("table").last()).toContainText(/Unassigned|Scheduled/);

  // Completed, from the office, with what was done.
  await owner.getByText("Complete visit 1").first().click();
  await owner.getByLabel("What was done on visit 1").fill("Dual run capacitor failed. Replaced, verified cooling.");
  await owner.getByRole("button", { name: "Complete visit 1" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Completed")).toBeVisible();
  /** The note as written, not the box the office uses to share it with the customer. */
  await expect(owner.getByRole("paragraph").filter({ hasText: "Dual run capacitor failed." })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Reopen job" })).toBeVisible();

  // Invoiced from the job: two lines, one at an odd price, so a rounding slip shows.
  await owner.getByRole("link", { name: "Invoice this job" }).click();
  await expect(owner).toHaveURL(/\/invoices\/new\?job=/);
  await owner.getByLabel("Line 1 description").fill("Diagnostic fee");
  await owner.getByLabel("Line 1 quantity").fill("1");
  await owner.getByLabel("Line 1 unit price").fill("129.00");
  await owner.getByRole("button", { name: "Add a line" }).click();
  await owner.getByLabel("Line 2 description").fill("Dual run capacitor");
  await owner.getByLabel("Line 2 quantity").fill("3");
  await owner.getByLabel("Line 2 unit price").fill("43.37");
  await owner.getByRole("button", { name: "Create invoice" }).click();

  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoice = {
    id: owner.url().split("/").pop()!,
    number: (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, ""),
    total: "259.11",
  };
  // 129.00 + 3 x 43.37, and no tax on either line.
  await expect(factOf(owner, "Total")).toHaveText(money(invoice.total));

  /*
    Sent. The seeded company has connected no mail provider, so emailing is
    refused in words and the attempt is recorded rather than lost, which is
    what a company that has not set up email yet would see. The link is then
    handed over instead, and it opens the invoice for somebody holding
    nothing else.
  */
  await owner.getByRole("button", { name: "Email invoice" }).click();
  await expect(owner.getByRole("status")).toContainText("Not sent: No email provider is connected");
  await owner.getByRole("button", { name: "Get a link instead" }).click();
  const link = owner.getByRole("link", { name: /\/i\// });
  await expect(link).toBeVisible();
  const url = (await link.getAttribute("href"))!;
  await stranger.goto(url);
  await expect(stranger.getByRole("heading", { name: `Invoice #${invoice.number}` })).toBeVisible();
  await expect(stranger.getByText(money(invoice.total)).first()).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText(`emailed to imogen+${run}@example.test`);
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText("a link handed over");

  await owner.goto(`/customers/${customerId}`);
  await expect(balanceOf(owner)).toHaveText(money(invoice.total));

  // Part of it by cheque, recorded against the invoice.
  await owner.goto(`/invoices/${invoice.id}`);
  await owner.getByRole("link", { name: "Record a payment" }).click();
  await owner.getByLabel("How it was paid").selectOption("check");
  await expect(owner.getByLabel("Amount received")).toHaveValue("259.11");
  await expect(owner.getByLabel(`Apply to invoice ${invoice.number}`)).toHaveValue("259.11");
  await owner.getByLabel("Amount received").fill("100.00");
  await owner.getByLabel(`Apply to invoice ${invoice.number}`).fill("100.00");
  await owner.getByLabel("Cheque number").fill("1044");
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner).toHaveURL(new RegExp(`/invoices/${invoice.id}$`));
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Part paid")).toBeVisible();
  await expect(factOf(owner, "Balance")).toHaveText("$159.11");

  /*
    Card payments, connected in settings by the names of the two secrets,
    the way a company would. The connection is then pointed at the fake
    Stripe, which is the one setting no screen has.
  */
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

    // The rest by card, from the invoice, through the Payment Element.
    await fakeStripeJs(owner);
    await owner.goto(`/invoices/${invoice.id}`);
    await owner.getByRole("button", { name: "Take card payment of $159.11" }).click();
    const element = owner.getByRole("group", { name: "Stripe Payment Element" });
    await expect(element).toBeVisible();

    // The server asked for the balance, in cents, with the company's key,
    // and the browser was handed that intent and the publishable key.
    expect(stripe.intents).toHaveLength(1);
    const [intent] = stripe.intents;
    expect(intent!.amount).toBe(15911);
    expect(intent!.currency).toBe("usd");
    expect(intent!.authorization).toBe(`Bearer ${E2E_STRIPE_ENV.STRIPE_SECRET_KEY}`);
    await expect(element).toHaveAttribute("data-client-secret", intent!.clientSecret);
    await expect(element).toHaveAttribute("data-publishable-key", "pk_test_e2e");

    await owner.getByRole("button", { name: "Pay $159.11" }).click();
    await expect(owner).toHaveURL(new RegExp(`/invoices/${invoice.id}\\?payment_intent=${intent!.id}`));

    // Back from Stripe, nothing is marked paid on the browser's word.
    await expect(factOf(owner, "Balance")).toHaveText("$159.11");

    // Stripe says the money moved, signed, to the address settings showed.
    const event = succeeded(intent!);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);
    expect(await delivered.json()).toMatchObject({ handled: true, kind: "succeeded" });

    await owner.goto(`/invoices/${invoice.id}`);
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();
    await expect(factOf(owner, "Balance")).toHaveText("$0.00");

    await owner.goto(`/customers/${customerId}`);
    await expect(balanceOf(owner)).toHaveText("$0.00");
  } finally {
    // Leave the company as the seed made it, with no processor, for the specs after this one.
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await stripe.close();
  }

  /*
    The ledger. Revenue on the job and on the job costing report is read from
    ledger postings, not from the invoice, so these agreeing with the invoice
    total to the cent is the reconciliation the phase promised.
  */
  await owner.goto(`/jobs/${jobId}`);
  const costing = owner.getByRole("region", { name: "Job costing" });
  await expect(costing.getByRole("definition").first()).toHaveText(money(invoice.total));

  await owner.goto("/reports/built-in/job-costing");
  const row = owner.getByRole("row").filter({ hasText: `No cooling upstairs ${run}` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(money(invoice.total));
});

function balanceOf(page: import("@playwright/test").Page) {
  return factOf(page, "Balance");
}

/** The value next to a label in a definition list. */
function factOf(page: import("@playwright/test").Page, label: string) {
  return page.locator(`dt:text-is("${label}") + dd`).first();
}
