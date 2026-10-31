import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";
import { fakeStripeApi, fakeStripeJs, pointStripeAt } from "./stripe";

/**
 * A CUSTOMER PUTS THEIR BACKUP CARDS IN A NEW ORDER (M13)
 *
 * Signed in, the customer pays automatically with a Visa and keeps a
 * Mastercard and then an American Express as backups. One press puts the
 * American Express first: nothing is stopped and no words are asked again, the
 * page says the new order, and the office sees it on the customer's page.
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

test("a customer moves a backup card up in one step, keeping every backup as agreed", async ({ owner, stranger }) => {
  test.setTimeout(180_000);
  const stripe = await fakeStripeApi({
    cards: [{ brand: "visa", last4: "4242" }, { brand: "mastercard", last4: "5555" }, { brand: "amex", last4: "0005" }],
  });
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Quinn Ordway ${run}`;

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
      name, phone, address: { street: "9 Kestrel Way", city: "Austin", state: "TX", zip: "78745" },
    });
    const customerUrl = owner.url();

    await stranger.goto(signInUrl);
    await stranger.getByLabel("Email or mobile number").fill(phone);
    await stranger.getByRole("button", { name: "Send me a code" }).click();
    await expect(stranger.getByLabel("Code")).toBeVisible();
    let code: string | undefined;
    await expect.poll(async () => {
      code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
      return code;
    }, { message: "a code was texted to the customer's own number" }).toMatch(/^\d{6}$/);
    await stranger.getByLabel("Code").fill(code!);
    await stranger.getByRole("button", { name: "Sign in" }).click();
    await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);

    // Three cards, each saved through Stripe's own window.
    for (const label of ["Visa ending 4242", "Mastercard ending 5555", "American Express ending 0005"]) {
      await stranger.goto(stranger.url().split("?")[0]!);
      await fakeStripeJs(stranger);
      await stranger.getByRole("button", { name: "Save a card" }).click();
      await stranger.getByRole("button", { name: "Save this card" }).click();
      await expect(stranger.getByRole("status").filter({ hasText: `${label} is saved` })).toBeVisible();
    }

    const cards = stranger.getByRole("region", { name: /Saved cards/ });
    const agreeTo = async (button: RegExp | string, submit: string) => {
      await cards.getByRole("button", { name: button }).click();
      await cards.getByLabel("I have read this and I agree.").check();
      await cards.getByRole("button", { name: submit }).click();
    };
    for (const label of ["Visa ending 4242", "Mastercard ending 5555", "American Express ending 0005"]) {
      await agreeTo(new RegExp(`Let .* charge ${label} for my bills`), "Agree");
      await expect(cards.getByText(new RegExp(`may charge ${label} for your bills`))).toBeVisible();
    }
    await agreeTo("Pay my bills automatically with Visa ending 4242", "Turn on automatic payments");
    await expect(cards.getByText("Your bills are paid with it automatically when they are issued.")).toBeVisible();
    await agreeTo("Use Mastercard ending 5555 as a backup if Visa ending 4242 does not go through", "Keep it as a backup");
    await expect(cards.getByText("If it does not go through, we try Mastercard ending 5555, once each, the same day.")).toBeVisible();
    await agreeTo("Use American Express ending 0005 as a backup if Visa ending 4242 does not go through", "Keep it as a backup");
    await expect(cards.getByText("If it does not go through, we try Mastercard ending 5555, then American Express ending 0005, once each, the same day."))
      .toBeVisible();

    // One press, and the American Express is tried first.
    const order = cards.getByRole("group", { name: "Order of backups" });
    await expect(order.getByRole("listitem")).toHaveText([/1\. Mastercard ending 5555/, /2\. American Express ending 0005/]);
    await order.getByRole("button", { name: "Try American Express ending 0005 before Mastercard ending 5555" }).click();
    await expect(order.getByRole("status")).toHaveText("Saved. American Express ending 0005 is now tried before Mastercard ending 5555.");
    await expect(order.getByRole("listitem")).toHaveText([/1\. American Express ending 0005/, /2\. Mastercard ending 5555/]);
    await expect(cards.getByText("If it does not go through, we try American Express ending 0005, then Mastercard ending 5555, once each, the same day."))
      .toBeVisible();
    // Both are still backups, with nothing to agree to again.
    await expect(cards.getByRole("button", { name: "Stop using Mastercard ending 5555 as a backup" })).toBeVisible();
    await expect(cards.getByRole("button", { name: "Stop using American Express ending 0005 as a backup" })).toBeVisible();

    // The office sees the new order.
    await owner.goto(customerUrl);
    const onFile = owner.getByRole("region", { name: "Cards on file" });
    await expect(onFile.getByRole("listitem", { name: "American Express ending 0005" })).toContainText("A backup for paying automatically");
    await expect(onFile.getByRole("listitem", { name: "Mastercard ending 5555" })).toContainText("A backup for paying automatically");
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
