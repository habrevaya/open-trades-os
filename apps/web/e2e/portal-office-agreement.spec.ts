import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt } from "./stripe";

/**
 * THE OFFICE RECORDS A CARD AUTHORIZATION, AND THE CUSTOMER SEES AND WITHDRAWS IT
 *
 * A customer saves a card in their own account and does not tick the box. The
 * office, on the customer's page, records that they agreed on the phone by
 * reading the product's script, and the customer sees it in their account,
 * taken by a named person, and stops it there. The office then records a
 * signed form, which needs its scan, and the invoice offers the card to charge
 * under it. The office records that the customer asked to stop, and the card
 * can no longer be charged.
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

test("the office records a phone agreement and a signed form for a saved card, and the customer can stop it", async ({ owner, stranger }) => {
  const stripe = await fakeStripeApi();
  const digits = String(Date.now() + 17).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Odessa Lyle ${run}`;
  const partner = `Wren Lyle ${run}`;

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
      name, address: { street: "40 Larkspur Court", city: "Austin", state: "TX", zip: "78745" },
    });
    const customerUrl = owner.url();
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Wren sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

    // Nothing saved yet: the office is told why there is nothing to record against.
    const onFile = owner.getByRole("region", { name: "Cards on file" });
    await expect(onFile).toContainText("They have not saved a card");

    // The customer signs in and saves a card, and does not agree to anything.
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
    await expect(cards.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ })).toBeVisible();

    // The office reads the script out and records the yes.
    await owner.goto(customerUrl);
    const visa = owner.getByRole("region", { name: "Cards on file" }).getByRole("listitem", { name: "Visa ending 4242" });
    await expect(visa).toContainText("Not agreed");
    await visa.getByText("Record an agreement taken by phone").click();
    await expect(visa.getByText(/would like to charge your Visa ending 4242 for bills you owe them/)).toBeVisible();
    await expect(visa.getByText(/Do you agree\?/)).toBeVisible();
    await visa.getByLabel("I read them these words and they said yes.").check();
    await visa.getByRole("button", { name: "Record the agreement" }).first().click();
    await expect(visa.getByText(/We may charge it for their bills\. Agreed by phone on .*, taken by /)).toBeVisible();
    await expect(visa.getByRole("link", { name: /The signed form/ })).toHaveCount(0);

    // The customer sees it as the office's, taken by somebody, and withdraws it.
    await stranger.reload();
    await expect(cards.getByText(/may charge Visa ending 4242 for your bills/)).toBeVisible();
    await expect(cards.getByText(/Agreed by phone on .*, taken by .*You can stop this at any time/)).toBeVisible();
    await cards.getByRole("button", { name: /Stop .* charging Visa ending 4242/ }).click();
    await expect(cards.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ })).toBeVisible();

    // Back at the office: not agreed again. Paper, with its scan.
    await owner.reload();
    const again = owner.getByRole("region", { name: "Cards on file" }).getByRole("listitem", { name: "Visa ending 4242" });
    await expect(again).toContainText("Not agreed");
    await again.getByText("Record an agreement on a signed form").click();
    await expect(again.getByText(/I let .* charge my Visa ending 4242 for bills I owe them/)).toBeVisible();
    await again.getByLabel("The day they signed").last().fill(await owner.evaluate(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })));
    await again.getByLabel("Scan of the signed form (PDF or photo)").setInputFiles({
      name: "card-form.pdf", mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% a signed card authorization form\n%%EOF\n"),
    });
    await again.getByLabel("The form they signed carries these words.").check();
    await again.getByRole("button", { name: "Record the agreement" }).last().click();
    await expect(again.getByText(/Agreed on a signed form on .*, taken by /)).toBeVisible();
    const form = again.getByRole("link", { name: /The signed form \(card-form\.pdf\)/ });
    await expect(form).toBeVisible();
    const opened = await owner.request.get((await form.getAttribute("href"))!);
    expect(opened.status()).toBe(200);
    expect(opened.headers()["content-type"]).toContain("application/pdf");

    // The customer's page says so, and still carries nothing of the scan.
    await stranger.reload();
    await expect(cards.getByText(/Agreed on a signed form on .*, taken by /)).toBeVisible();
    expect(await stranger.content()).not.toContain("card-form.pdf");

    // The office records that the customer rang to stop; the card is no longer one to charge.
    await again.getByRole("button", { name: "They asked us to stop" }).click();
    await expect(again.getByText("Not agreed. We cannot charge this card without them pressing Pay.")).toBeVisible();
    await stranger.reload();
    await expect(cards.getByRole("button", { name: /Let .* charge Visa ending 4242 for my bills/ })).toBeVisible();
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
