import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt, succeeded } from "./stripe";

/**
 * A CUSTOMER SIGNS IN AND PAYS WITH A TIP
 *
 * The office turns tipping on, books a job with a technician on it and
 * invoices it. The customer, holding nothing but the company's sign in
 * address and their own phone, asks for a code, types it, lands on their
 * account, adds a tip for the technician and pays by card. The invoice is
 * paid when Stripe's signed webhook says the money moved, and the office
 * sees the tip held for the technician by name.
 *
 * The code is read off the outbox, which is where the company's text sender
 * queued it: the seeded company has a registered number and no carrier
 * connected, so the message is the record of what the customer's phone
 * would have shown. Stripe is faked at its edges as everywhere else
 * (e2e/stripe.ts).
 */

/** The newest text queued to a number: what the customer's phone shows. */
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

test("a customer signs in with a code sent to their phone and pays their invoice with a tip for the technician", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Ines Calloway ${run}`;

  try {
    // Tipping, which every company starts with off.
    await owner.goto("/settings/portal");
    await expect(owner.getByLabel("The sign in address")).toContainText("/portal/");
    const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
    await owner.getByLabel("Offer customers a tip when they pay online").check();
    await owner.getByLabel("Suggested tips, in percent").fill("10, 15, 20");
    await owner.getByRole("button", { name: "Save tips" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

    // Card payments, connected the way a company connects them, pointed at the fake.
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

    // The customer, a job with Ray on it, and an invoice for it.
    await newCustomer(owner, {
      name, phone, address: { street: "27 Juniper Hollow", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByRole("link", { name: "27 Juniper Hollow, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Water heater flush ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("09:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Flush and anode check");
    await owner.getByLabel("Line 1 unit price").fill("200.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();
    const invoiceNumber = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

    // The customer signs in with nothing but the address and their phone.
    await stranger.goto(signInUrl);
    await expect(stranger.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
    await stranger.getByLabel("Email or mobile number").fill(phone);
    await stranger.getByRole("button", { name: "Send me a code" }).click();
    await expect(stranger.getByLabel("Code")).toBeVisible();
    let code: string | undefined;
    await expect.poll(async () => {
      code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
      return code;
    }, { message: "a code was texted to the number on the customer's record" }).toMatch(/^\d{6}$/);

    // A wrong code first, which says so and lets them try again.
    await stranger.getByLabel("Code").fill(code === "000000" ? "111111" : "000000");
    await stranger.getByRole("button", { name: "Sign in" }).click();
    await expect(stranger.getByRole("alert").filter({ hasText: "That code is not right" })).toBeVisible();

    await stranger.getByLabel("Code").fill(code!);
    await stranger.getByRole("button", { name: "Sign in" }).click();
    await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);
    await expect(stranger.getByRole("heading", { level: 1, name })).toBeVisible();
    // The session is a cookie the page cannot read, not something in the address.
    expect(stranger.url()).not.toMatch(/token|[A-Za-z0-9_-]{40}/);
    const cookies = await stranger.context().cookies();
    expect(cookies.find((c) => c.name === "ots_portal")?.httpOnly).toBe(true);

    // A tip for Ray, then the card.
    await fakeStripeJs(stranger);
    await expect(stranger.getByText("Add a tip for Ray?")).toBeVisible();
    await stranger.getByText("15% ($30.00)").click();
    await stranger.getByRole("button", { name: `Pay $230.00 for invoice #${invoiceNumber} now` }).click();
    const element = stranger.getByRole("group", { name: "Stripe Payment Element" });
    await expect(element).toBeVisible();
    const intent = stripe.intents.at(-1)!;
    expect(intent.amount).toBe(23000);
    await stranger.getByRole("button", { name: "Pay $230.00" }).click();
    await expect(stranger).toHaveURL(/redirect_status=succeeded/);
    await expect(stranger.getByRole("status").filter({ hasText: "Your payment went through" })).toBeVisible();

    // Stripe says the money moved, signed, to the address settings showed.
    const event = succeeded(intent);
    const delivered = await owner.request.post(webhookPath, {
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      data: event.body,
    });
    expect(delivered.status()).toBe(200);

    // The customer's account shows it paid, and nothing left to pay.
    await stranger.goto(stranger.url().split("?")[0]!);
    await expect(stranger.getByRole("button", { name: /Pay \$/ })).toHaveCount(0);
    await expect(stranger.getByText(`Invoice #${invoiceNumber}`).first()).toBeVisible();

    // The office sees the invoice paid at its own total, and the tip held for Ray.
    await owner.goto(invoiceUrl);
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();
    const tips = owner.getByRole("region", { name: "Tips" });
    await expect(tips).toContainText("Ray Ortiz");
    await expect(tips).toContainText("$30.00");

    // Signing out ends it.
    await stranger.getByRole("button", { name: "Sign out" }).click();
    await expect(stranger.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  } finally {
    // Leave the company as the seed made it: no processor, no tips.
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
    }
    await owner.goto("/settings/portal");
    await owner.getByLabel("Offer customers a tip when they pay online").uncheck();
    await owner.getByRole("button", { name: "Save tips" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await stripe.close();
  }
});
