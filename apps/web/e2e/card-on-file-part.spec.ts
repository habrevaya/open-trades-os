import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";

/**
 * THE OFFICE CHARGES PART OF A BILL TO A CARD THE CUSTOMER AGREED MAY BE CHARGED
 *
 * The customer signs in, saves a card and agrees to let the company charge it.
 * The office charges part of a $150.00 invoice to it from the invoice's page:
 * more than is owed is refused in words, $60.00 goes to the processor, and
 * once Stripe's signed webhook says the money moved the invoice still owes
 * $90.00.
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

test("the office charges part of an invoice to a saved card the customer agreed may be charged", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now() + 29).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Petra Part ${run}`;
  const partner = `Quinn Part ${run}`;

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

    const customerId = await newCustomer(owner, {
      name, address: { street: "7 Juniper Lane", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Quinn sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

    await owner.goto(`/invoices/new?customer=${customerId}`);
    await owner.getByLabel("Line 1 description").fill("Furnace repair");
    await owner.getByLabel("Line 1 unit price").fill("150.00");
    await owner.getByLabel("Line 1 taxable").uncheck();
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();

    // The customer signs in, saves a card and agrees.
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
    const cards = stranger.getByRole("region", { name: /Saved cards/ });
    await cards.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ }).click();
    await cards.getByLabel("I have read this and I agree.").check();
    await cards.getByRole("button", { name: "Agree" }).click();
    await expect(cards.getByText(/may charge Visa ending 4242 for your bills/)).toBeVisible();

    // The office charges part of it. More than is owed is refused in words.
    await owner.goto(invoiceUrl);
    const onFile = owner.getByRole("region", { name: "Saved cards" });
    await onFile.getByText("Charge part of it to Visa ending 4242").click();
    await onFile.getByLabel("Amount to charge to Visa ending 4242").fill("200.00");
    await onFile.getByRole("button", { name: "Charge this amount to Visa ending 4242" }).click();
    await expect(onFile.getByRole("alert").filter({ hasText: "no more than that can be charged" })).toBeVisible();
    expect(stripe.intents).toHaveLength(0);

    await onFile.getByLabel("Amount to charge to Visa ending 4242").fill("60.00");
    await onFile.getByRole("button", { name: "Charge this amount to Visa ending 4242" }).click();
    await expect(onFile.getByRole("table", { name: "Charges to saved cards" })).toContainText("Sent to the card processor");
    await expect(onFile.getByRole("table", { name: "Charges to saved cards" })).toContainText("$60.00");
    const intent = stripe.intents.at(-1)!;
    expect(intent).toMatchObject({ amount: 6000, offSession: true });

    const event = succeeded(intent);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);
    await owner.reload();
    await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$90.00");
    // The rest can be charged the same way: the whole balance is offered again.
    await expect(owner.getByRole("region", { name: "Saved cards" })
      .getByRole("button", { name: "Charge $90.00 to Visa ending 4242" })).toBeVisible();
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
