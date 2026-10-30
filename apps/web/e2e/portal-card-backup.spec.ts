import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt } from "./stripe";

/**
 * A CUSTOMER KEEPS A BACKUP FOR PAYING AUTOMATICALLY
 *
 * The customer's partner, signed in as them, saves a card and a bank
 * account, lets the company charge both, pays bills automatically with the
 * card, and keeps the bank account as a backup in its own words. The page
 * says the bank account is tried once, the same day, only when the card does
 * not go through; the office sees which is the backup on the customer's page.
 * Stopping the backup leaves the card paying automatically. What happens when
 * the card is declined is tested against the processor fake in the API suite
 * (card-on-file-backup), because this fake always says yes.
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

test("a customer keeps a bank account as a backup for paying automatically, in its own words", async ({ owner, stranger }) => {
  test.setTimeout(180_000);
  const stripe = await fakeStripeApi();
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Rowan Hale ${run}`;
  const partner = `Tess Hale ${run}`;

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

    await newCustomer(owner, {
      name, address: { street: "4 Heron Ct", city: "Austin", state: "TX", zip: "78745" },
    });
    const customerUrl = owner.url();
    await owner.getByRole("button", { name: "Add somebody" }).click();
    await owner.locator("#c-name").fill(partner);
    await owner.locator("#c-phone").fill(phone);
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    const person = owner.getByRole("listitem").filter({ hasText: partner });
    await person.getByRole("button", { name: "Let Tess sign in" }).click();
    await expect(person.getByText("Can sign in as the customer")).toBeVisible();

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

    // A card and a bank account, each saved through Stripe's own window.
    await fakeStripeJs(stranger);
    await stranger.getByRole("button", { name: "Save a card" }).click();
    await stranger.getByRole("button", { name: "Save this card" }).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Visa ending 4242 is saved" })).toBeVisible();
    await stranger.goto(stranger.url().split("?")[0]!);
    await fakeStripeJs(stranger);
    await stranger.getByRole("button", { name: "Save a bank account" }).click();
    await stranger.getByRole("button", { name: "Save this bank account" }).click();
    await expect(stranger.getByRole("status").filter({ hasText: "Frost Bank account ending 6789 is saved" })).toBeVisible();

    const cards = stranger.getByRole("region", { name: /Saved cards/ });
    const agree = async (label: string) => {
      await cards.getByRole("button", { name: new RegExp(`Let .* charge ${label} for my bills`) }).click();
      await cards.getByLabel("I have read this and I agree.").check();
      await cards.getByRole("button", { name: "Agree" }).click();
      await expect(cards.getByText(new RegExp(`may charge ${label} for your bills`))).toBeVisible();
    };
    await agree("Visa ending 4242");
    await agree("Frost Bank account ending 6789");

    // No backup is offered until a card pays automatically.
    await expect(cards.getByRole("button", { name: /as a backup/ })).toHaveCount(0);
    await cards.getByRole("button", { name: "Pay my bills automatically with Visa ending 4242" }).click();
    await cards.getByLabel("I have read this and I agree.").check();
    await cards.getByRole("button", { name: "Turn on automatic payments" }).click();
    await expect(cards.getByText("Your bills are paid with it automatically when they are issued.")).toBeVisible();

    // The backup, in its own words.
    await cards.getByRole("button", { name: "Use Frost Bank account ending 6789 as a backup if Visa ending 4242 does not go through" }).click();
    await expect(cards.getByText(/^Use my Frost Bank account ending 6789 as a backup for paying my bills automatically/)).toBeVisible();
    await expect(cards.getByRole("button", { name: "Keep it as a backup" })).toBeDisabled();
    await cards.getByLabel("I have read this and I agree.").check();
    await cards.getByRole("button", { name: "Keep it as a backup" }).click();
    await expect(cards.getByText("If it does not go through, we try Frost Bank account ending 6789, once each, the same day.")).toBeVisible();
    await expect(cards.getByText(/It is a backup for paying automatically: we try it once, the same day, only when Visa ending 4242/)).toBeVisible();

    // The office sees which card is the backup.
    await owner.goto(customerUrl);
    const onFile = owner.getByRole("region", { name: "Cards on file" });
    await expect(onFile.getByRole("listitem", { name: "Visa ending 4242" })).toContainText("Their bills are paid with it automatically.");
    await expect(onFile.getByRole("listitem", { name: "Frost Bank account ending 6789" })).toContainText("A backup for paying automatically");

    // Stopping the backup leaves the card paying automatically.
    await cards.getByRole("button", { name: "Stop using Frost Bank account ending 6789 as a backup" }).click();
    await expect(cards.getByText(/It is a backup for paying automatically/)).toHaveCount(0);
    await expect(cards.getByText("Your bills are paid with it automatically when they are issued.")).toBeVisible();
    await expect(cards.getByRole("button", { name: /Use Frost Bank account ending 6789 as a backup/ })).toBeVisible();
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
