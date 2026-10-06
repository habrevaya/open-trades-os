import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";

/**
 * A CUSTOMER LETS THE COMPANY CHARGE THEIR CARD, AND THE OFFICE DOES
 *
 * The office arranges the account page (a heading of its own on what is coming),
 * invoices a job, and the customer's partner, signed in as the customer,
 * sees the page as arranged, saves a card, reads the words and agrees to let
 * the company charge it. The office charges the invoice from its page with
 * nobody on the customer's side, off session, and the invoice is paid when
 * Stripe's signed webhook says so. The customer then withdraws, and the
 * office can no longer charge the card.
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

test("a customer agrees to be charged on file, and the office charges their card from the invoice", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Marlo Keene ${run}`;
  const partner = `Sasha Keene ${run}`;

  try {
    // The office gives what is coming a heading of its own.
    await owner.goto("/settings/portal");
    const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
    await owner.getByRole("link", { name: "Arrange what customers see on their account" }).click();
    await owner.getByLabel("Heading for Coming up").fill("Your next visit");
    await owner.getByRole("button", { name: "Save layout" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Customers see it this way" })).toBeVisible();

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
      name, address: { street: "12 Bluebonnet Way", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Sasha sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

    await owner.getByRole("link", { name: "12 Bluebonnet Way, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Water heater flush ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("10:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Tank flushed");
    await owner.getByLabel("Line 1 unit price").fill("150.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();
    // No agreement yet: nothing to charge on file.
    await expect(owner.getByRole("region", { name: "Saved cards" })).toHaveCount(0);

    // The partner signs in and sees the page as the office arranged it.
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
    await expect(stranger.getByRole("region", { name: "Your next visit" })).toBeVisible();
    await expect(stranger.getByRole("region", { name: "Coming up" })).toHaveCount(0);

    // A card, saved, and then the words read and agreed to.
    await fakeStripeJs(stranger);
    await stranger.getByRole("button", { name: "Save a card" }).click();
    await stranger.getByRole("button", { name: "Save this card" }).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Visa ending 4242 is saved" })).toBeVisible();
    const cards = stranger.getByRole("region", { name: /Saved cards/ });
    await cards.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ }).click();
    await expect(cards.getByText(/without me pressing Pay each time/)).toBeVisible();
    await expect(cards.getByRole("button", { name: "Agree" })).toBeDisabled();
    await cards.getByLabel("I have read this and I agree.").check();
    await cards.getByRole("button", { name: "Agree" }).click();
    await expect(cards.getByText(/may charge Visa ending 4242 for your bills \(agreed by Sasha/)).toBeVisible();

    // The office charges it from the invoice, with nobody on the customer's side.
    await owner.goto(invoiceUrl);
    const onFile = owner.getByRole("region", { name: "Saved cards" });
    await expect(onFile).toContainText(`by ${partner}`);
    await onFile.getByRole("button", { name: "Charge $150.00 to Visa ending 4242" }).click();
    // The charge is listed with who made it, and no second button while it is with the processor.
    await expect(onFile.getByRole("table", { name: "Charges to saved cards" })).toContainText("Sent to the card processor");
    await expect(onFile.getByRole("button", { name: /^Charge / })).toHaveCount(0);
    const intent = stripe.intents.at(-1)!;
    expect(intent).toMatchObject({ amount: 15000, offSession: true });

    const event = succeeded(intent);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);
    await owner.reload();
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();
    await expect(owner.getByRole("table", { name: "Charges to saved cards" })).toContainText("Paid");

    // The customer withdraws; the office can no longer charge the card.
    await stranger.reload();
    await stranger.getByRole("button", { name: /Stop .* charging Visa ending 4242/ }).click();
    await expect(stranger.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ })).toBeVisible();
    await owner.reload();
    await expect(owner.getByRole("region", { name: "Saved cards" })).toContainText("None now");
  } finally {
    await owner.goto("/settings/portal/layout");
    await owner.getByLabel("Heading for Coming up").fill("Coming up");
    await owner.getByRole("button", { name: "Save layout" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Customers see it this way" })).toBeVisible();
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await stripe.close();
  }
});
