import { eq, desc, and, like, sql } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

test.afterAll(async () => { await quietHours(false); });

/**
 * A CHAT ANSWER AT NIGHT, FOR A CUSTOMER ONLY A TEXT REACHES
 *
 * The office answers a customer's account chat inside the company's quiet hours.
 * The customer has a mobile number and no email address, so nothing can be sent
 * until the hours end. The inbox says so in words, above the thread, instead of
 * the old line that made it look as if the customer had been told. (That the
 * worker sends the text once the hours end, and not to somebody who read the
 * chat meanwhile, is the integration test's: a browser has no clock to move.)
 */

/** The newest text queued to a number. */
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

async function chatOf(customerName: string): Promise<{ id: string } | null> {
  const db = createClient();
  try {
    const [row] = await db.select({ id: schema.conversation.id })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(and(eq(schema.customer.name, customerName), like(schema.conversation.externalAddress, "portal:%")))
      .limit(1);
    return row ?? null;
  } finally {
    await db.$close();
  }
}

/** As if the customer last had the chat open five minutes ago: they have left. */
async function leftTheChat(conversationId: string): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.aiChatSession)
      .set({ customerReadAt: new Date(Date.now() - 5 * 60_000), customerNotifiedAt: null })
      .where(eq(schema.aiChatSession.conversationId, conversationId));
  } finally {
    await db.$close();
  }
}

/** The company's quiet hours around the hour it is now (the hour and the next), or taken off again. */
async function quietHours(on: boolean): Promise<void> {
  const db = createClient();
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date())) % 24;
    const window = JSON.stringify({ quietHours: { startHour: hour, endHour: (hour + 2) % 24 } });
    await db.update(schema.organization).set({
      settings: on
        ? sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${window}::jsonb`
        : sql`coalesce(${schema.organization.settings}, '{}'::jsonb) - 'quietHours'`,
    }).where(eq(schema.organization.slug, "ridgeline"));
  } finally {
    await db.$close();
  }
}

test("an answer given in quiet hours to a customer only a text reaches is kept, and the inbox says so", async ({ owner, stranger }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Ines Waiting ${run}`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "9 Elm Court", city: "Austin", state: "TX", zip: "78745" } });

  await stranger.goto(signInUrl);
  await stranger.getByLabel("Email or mobile number").fill(phone);
  await stranger.getByRole("button", { name: "Send me a code" }).click();
  await expect(stranger.getByLabel("Code")).toBeVisible();
  let code: string | undefined;
  await expect.poll(async () => {
    code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
    return code;
  }, { message: "a code was texted to the number on the customer's record" }).toMatch(/^\d{6}$/);
  await stranger.getByLabel("Code").fill(code!);
  await stranger.getByRole("button", { name: "Sign in" }).click();
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);

  await stranger.getByRole("link", { name: "Chat with us" }).click();
  const chat = stranger.getByRole("region", { name: "Your chat" });
  const words = `Is anyone coming ${run}`;
  await chat.getByLabel("Your message").fill(words);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);

  let conversation: Awaited<ReturnType<typeof chatOf>> = null;
  await expect.poll(async () => (conversation = await chatOf(name))).not.toBeNull();
  await stranger.goto(signInUrl);
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);
  await leftTheChat(conversation!.id);

  await quietHours(true);
  const before = await textTo(e164);
  const answer = `We will be there at nine ${run}.`;
  await owner.goto(`/inbox/${conversation!.id}`);
  await owner.getByRole("textbox", { name: "Reply" }).fill(answer);
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText(answer)).toBeVisible();
  await owner.reload();
  await expect(owner.getByText(/^Waiting for your quiet hours to end\./)).toBeVisible();
  await expect(owner.getByText(/The text goes then, unless they read the chat first\./)).toBeVisible();
  /** Nothing went to their phone at night. */
  expect(await textTo(e164)).toBe(before);
});
