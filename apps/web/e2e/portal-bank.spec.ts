import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";

/**
 * A CONTACT SIGNS IN AS THE CUSTOMER AND PAYS FROM A BANK ACCOUNT
 *
 * The office turns bank payments on, lets the customer's partner sign in
 * as them, and invoices a job. The partner, holding nothing but their own
 * phone, signs in, sees the customer's account with their own name on it,
 * saves a bank account through Stripe's window and pays from it. The money
 * is on its way rather than arrived: the account and the office's invoice
 * both say so, and nobody is offered the bill again. Stripe's signed
 * webhook settles it, and the office signs the partner out.
 *
 * Stripe is faked at its edges as everywhere else (e2e/stripe.ts), now
 * including the setup a bank account is saved through and a debit that
 * comes back processing.
 */

async function textTo(e164: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.select({ body: schema.message.body }).from(schema.message)
      .where(and(eq(schema.message.toAddress, e164), eq(schema.message.direction, "outbound")))
      .orderBy(desc(schema.message.createdAt)).limit(1);
    return row?.body ?? "";
  } finally {
    await db.$close();
  }
}

test("a contact signs in as the customer and pays an invoice from a bank account", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Harlow Pruitt ${run}`;
  const partner = `Quinn Pruitt ${run}`;

  try {
    await owner.goto("/settings/portal");
    const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
    await owner.getByLabel("Let customers pay from a bank account").check();
    await owner.getByRole("button", { name: "Save bank payments" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

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

    // The customer, and their partner on the account, who the office lets sign in.
    await newCustomer(owner, {
      name, address: { street: "9 Larkspur Bend", city: "Austin", state: "TX", zip: "78745" },
    });
    const customerUrl = owner.url();
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Quinn sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

    // A job with Ray on it, and its invoice.
    await owner.getByRole("link", { name: "9 Larkspur Bend, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Drain clearing ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("10:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Main line cleared");
    await owner.getByLabel("Line 1 unit price").fill("200.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();
    const invoiceNumber = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

    // The partner signs in with their own phone, and lands on the customer's account as themselves.
    await stranger.goto(signInUrl);
    await stranger.getByLabel("Email or mobile number").fill(phone);
    await stranger.getByRole("button", { name: "Send me a code" }).click();
    await expect(stranger.getByLabel("Code")).toBeVisible();
    let code: string | undefined;
    await expect.poll(async () => {
      code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
      return code;
    }, { message: "a code was texted to the contact's own number" }).toMatch(/^\d{6}$/);
    await stranger.getByLabel("Code").fill(code!);
    await stranger.getByRole("button", { name: "Sign in" }).click();
    await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);
    await expect(stranger.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(stranger.getByText(`Signed in as ${partner}`)).toBeVisible();

    // A bank account, saved through Stripe's own window.
    await fakeStripeJs(stranger);
    await stranger.getByRole("button", { name: "Save a bank account" }).click();
    await expect(stranger.getByRole("group", { name: "Stripe Payment Element" })).toBeVisible();
    await stranger.getByRole("button", { name: "Save this bank account" }).click();
    await expect(stranger).toHaveURL(/setup_intent=seti_e2e_/);
    await expect(stranger.getByRole("status").filter({ hasText: "Frost Bank account ending 6789 is saved" })).toBeVisible();

    // Paying from it: on its way, not arrived.
    await stranger.getByRole("button", { name: "Pay $200.00 with Frost Bank account ending 6789" }).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Your bank payment of $200.00 is on its way" })).toBeVisible();
    const intent = stripe.intents.at(-1)!;
    expect(intent.amount).toBe(20000);
    await stranger.goto(stranger.url().split("?")[0]!);
    await expect(stranger.getByRole("status").filter({ hasText: "Your bank payment is on its way" })).toBeVisible();
    await expect(stranger.getByRole("button", { name: /Pay \$200\.00/ })).toHaveCount(0);

    // The office sees it pending on the invoice, which is still open.
    await owner.goto(invoiceUrl);
    await expect(owner.getByRole("region", { name: "Bank payments" })).toContainText("$200.00 from the customer is on its way");

    // Stripe says the money arrived.
    const event = succeeded(intent);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);
    await owner.reload();
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();
    await expect(owner.getByRole("region", { name: "Bank payments" })).toHaveCount(0);
    await stranger.reload();
    await expect(stranger.getByText(`Invoice #${invoiceNumber}`).first()).toBeVisible();
    await expect(stranger.getByText("Your bank payment is on its way")).toHaveCount(0);

    // The office sees who is signed in, and signs them out.
    await owner.goto(customerUrl);
    const signIns = owner.getByRole("region", { name: "Portal sign ins" });
    await expect(signIns).toContainText(partner);
    await signIns.getByRole("button", { name: "Sign them out" }).click();
    await expect(signIns).toContainText("Nobody is signed in to their account.");
    await expect(signIns).toContainText("signed out by the office");
    await stranger.reload();
    await expect(stranger.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  } finally {
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await owner.goto("/settings/portal");
    await owner.getByLabel("Let customers pay from a bank account").uncheck();
    await owner.getByRole("button", { name: "Save bank payments" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await stripe.close();
  }
});
