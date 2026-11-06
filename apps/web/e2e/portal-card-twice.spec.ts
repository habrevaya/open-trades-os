import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";

/**
 * PAYING WITH A SAVED CARD FROM TWO TABS CHARGES THE CARD ONCE
 *
 * The customer's partner, signed in as the customer, saves a card and has
 * their account open in two tabs. They pay the invoice with the card in the
 * first, then press the same Pay button in the second, which still shows the
 * balance because Stripe's webhook has not arrived. The second tab is told
 * the payment went through, the same as the first, and Stripe was asked for
 * one charge. The invoice is paid once when the webhook says so.
 *
 * Stripe is faked at its edges, as everywhere else (e2e/stripe.ts).
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

test("paying an invoice with a saved card from two tabs charges the card once", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Rowan Ashby ${run}`;
  const partner = `Tate Ashby ${run}`;

  try {
    await owner.goto("/settings/portal");
    const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();

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

    await newCustomer(owner, {
      name, address: { street: "31 Pecan Hollow", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Tate sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

    await owner.getByRole("link", { name: "31 Pecan Hollow, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Thermostat swap ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("10:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Thermostat replaced");
    await owner.getByLabel("Line 1 unit price").fill("173.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();

    // The partner signs in and saves a card.
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
    await fakeStripeJs(stranger);
    await stranger.getByRole("button", { name: "Save a card" }).click();
    await stranger.getByRole("button", { name: "Save this card" }).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Visa ending 4242 is saved" })).toBeVisible();

    // The account open in a second tab, before either pays.
    const accountUrl = stranger.url().split("?")[0]!;
    const second = await stranger.context().newPage();
    await second.goto(accountUrl);
    const pay = { name: "Pay $173.00 with Visa ending 4242" };
    await expect(second.getByRole("button", pay)).toBeVisible();

    await stranger.goto(accountUrl);
    await stranger.getByRole("button", pay).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Thank you. Your payment went through" })).toBeVisible();

    // The second tab still offers the balance, and pressing Pay there is the same payment, not another.
    await second.getByRole("button", pay).click();
    await expect(second.getByRole("status").filter({ hasText: "Thank you. Your payment went through" })).toBeVisible();
    const charged = stripe.intents.filter((intent) => intent.amount === 17300);
    expect(charged).toHaveLength(1);
    await second.close();

    // Stripe says the money moved, and the invoice is paid once.
    const event = succeeded(charged[0]!);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);
    await owner.goto(invoiceUrl);
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();
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
