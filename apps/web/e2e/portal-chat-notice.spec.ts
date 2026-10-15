import { eq, desc, and, like, sql } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

test.afterAll(async () => { await quietHoursAway(false); });

/**
 * THE OFFICE ANSWERS A CUSTOMER'S CHAT, WITH PICTURES, AND THE CUSTOMER IS TOLD
 *
 * The customer sends a photo with their words. The office sees it in the inbox,
 * answers with a photo of its own, and the customer, who has left the page, is
 * texted a link and none of the answer. Their account page marks the answer
 * waiting; opening the chat shows the office's photo and clears the mark. A
 * separate test turns the notice off on the portal settings screen and back on.
 */

/** A one pixel PNG, which is what the bytes say it is. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

/**
 * The company's quiet hours, moved to an hour twelve hours away (or taken off
 * again with `null`), so the clock cannot decide the test: by default a text
 * waits from nine at night to eight in the morning.
 */
async function quietHoursAway(on: boolean): Promise<void> {
  const db = createClient();
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date())) % 24;
    const window = JSON.stringify({ quietHours: { startHour: (hour + 12) % 24, endHour: (hour + 13) % 24 } });
    await db.update(schema.organization).set({
      settings: on
        ? sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${window}::jsonb`
        : sql`coalesce(${schema.organization.settings}, '{}'::jsonb) - 'quietHours'`,
    }).where(eq(schema.organization.slug, "ridgeline"));
  } finally {
    await db.$close();
  }
}

test("a customer sends a photo, the office answers with one, and the customer is texted and sees a mark", async ({ owner, stranger }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Juno Snapper ${run}`;
  await quietHoursAway(true);

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "3 Birch Way", city: "Austin", state: "TX", zip: "78745" } });

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

  /** The customer writes, with a photo. */
  await stranger.getByRole("link", { name: "Chat with us" }).click();
  const chat = stranger.getByRole("region", { name: "Your chat" });
  await expect(chat).toContainText("We will tell you by email or text when we answer");
  const words = `This is the unit ${run}`;
  await chat.getByLabel("Your message").fill(words);
  await chat.getByLabel("Add photos (up to 3)").setInputFiles({ name: "unit.png", mimeType: "image/png", buffer: PNG });
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);
  await expect(chat.getByRole("img", { name: "Picture you sent" })).toBeVisible();
  await expect.poll(() => chat.getByRole("img", { name: "Picture you sent" }).evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
  ), { message: "the picture loads from the customer's own route" }).toBe(true);

  /** The office sees the words and the photo, and answers with its own. */
  let conversation: Awaited<ReturnType<typeof chatOf>> = null;
  await expect.poll(async () => (conversation = await chatOf(name))).not.toBeNull();
  await owner.goto(`/inbox/${conversation!.id}`);
  await expect(owner.getByText("Chat from their account")).toBeVisible();
  await expect(owner.getByText(words)).toBeVisible();
  await expect(owner.getByRole("img", { name: "Picture from the customer" })).toBeVisible();

  /** The customer leaves the page, so they are owed a notice. */
  await stranger.goto(signInUrl);
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);
  await leftTheChat(conversation!.id);

  const answer = `Thanks, here is the part we will bring ${run}.`;
  await owner.getByRole("textbox", { name: "Reply" }).fill(answer);
  await owner.getByLabel("Add pictures").setInputFiles({ name: "part.png", mimeType: "image/png", buffer: PNG });
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText(answer)).toBeVisible();
  await expect(owner.getByRole("img", { name: "Picture sent" })).toBeVisible();
  await owner.reload();
  await expect(owner.getByText("Told by text.")).toBeVisible();

  /** The text names the company and links the chat; it does not carry the answer. */
  const told = await textTo(e164);
  expect(told).toContain("answered your message");
  expect(told).toMatch(/\/portal\/[^/]+\/account\/chat$/);
  expect(told).not.toContain(answer);

  /** The account page marks the answer; opening the chat shows the photo and clears the mark. */
  await stranger.reload();
  const mark = stranger.getByRole("link", { name: "Chat with us (1 new answer)" });
  await expect(mark).toBeVisible();
  await mark.click();
  const reopened = stranger.getByRole("region", { name: "Your chat" });
  await expect(reopened.getByRole("list", { name: "Messages" })).toContainText(answer);
  await expect(reopened.getByRole("img", { name: /^Picture from / })).toBeVisible();
  await stranger.getByRole("link", { name: "Back to your account" }).click();
  await expect(stranger.getByRole("link", { name: "Chat with us", exact: true })).toBeVisible();

  /**
   * The link in the text works for a customer who is signed out: the sign in
   * page remembers where they were going, and a code takes them to the chat.
   */
  const link = /(https?:\/\/\S+\/portal\/[^/\s]+\/account\/chat)$/.exec(told)![1]!;
  const before = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
  await stranger.getByRole("button", { name: "Sign out" }).click();
  await stranger.goto(new URL(link).pathname);
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\?next=chat$/);
  await stranger.getByLabel("Email or mobile number").fill(phone);
  await stranger.getByRole("button", { name: "Send me a code" }).click();
  await expect(stranger.getByLabel("Code")).toBeVisible();
  let again: string | undefined;
  await expect.poll(async () => {
    const found = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
    again = found !== before ? found : undefined;
    return again;
  }, { message: "a second code was texted" }).toMatch(/^\d{6}$/);
  await stranger.getByLabel("Code").fill(again!);
  await stranger.getByRole("button", { name: "Sign in" }).click();
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account\/chat$/);
  await expect(stranger.getByRole("heading", { level: 1, name: "Chat with us" })).toBeVisible();
});

test("the office turns the chat answer notice off and back on", async ({ owner }) => {
  await owner.goto("/settings/portal");
  const box = owner.getByLabel("Tell a customer when we answer their chat");
  await expect(box).toBeChecked();
  try {
    await box.uncheck();
    await owner.getByRole("button", { name: "Save chat answers" }).click();
    await expect(owner.getByText("Saved.").first()).toBeVisible();
    await owner.reload();
    await expect(owner.getByLabel("Tell a customer when we answer their chat")).not.toBeChecked();
  } finally {
    await owner.goto("/settings/portal");
    const again = owner.getByLabel("Tell a customer when we answer their chat");
    await again.check();
    await owner.getByRole("button", { name: "Save chat answers" }).click();
    await expect(owner.getByText("Saved.").first()).toBeVisible();
    await owner.reload();
    await expect(owner.getByLabel("Tell a customer when we answer their chat")).toBeChecked();
  }
});
