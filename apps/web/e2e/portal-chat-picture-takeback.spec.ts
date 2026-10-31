import { eq, desc, and, like } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CUSTOMER TAKES BACK A PICTURE THEY SENT IN THEIR CHAT, UNTIL THE OFFICE OPENS IT
 *
 * The customer sends a photo with their words and sees "Take it back". Pressing it
 * lets the photo go and leaves the words. A second photo, once the office has opened
 * the thread (the inbox fetching it), can no longer be taken back: the button goes from
 * their page, and the office sees what happened to the first.
 */

/** A one pixel PNG, which is what the bytes say it is. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const OTHER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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

test("a customer takes back a photo nobody opened, and cannot once the office has", async ({ owner, stranger }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Wren Takeback ${run}`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "8 Cedar Way", city: "Austin", state: "TX", zip: "78745" } });

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
  const messages = chat.getByRole("list", { name: "Messages" });

  // The first photo is taken back: the picture goes, the words stay.
  const first = `The wrong photo ${run}`;
  await chat.getByLabel("Your message").fill(first);
  await chat.getByLabel("Add photos (up to 3)").setInputFiles({ name: "wrong.png", mimeType: "image/png", buffer: PNG });
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(messages).toContainText(first);
  await expect(chat.getByRole("img", { name: "Picture you sent" })).toBeVisible();
  await chat.getByRole("button", { name: /^Take back the picture you sent/ }).click();
  await expect(chat.getByRole("img", { name: "Picture you sent" })).toHaveCount(0);
  await expect(messages).toContainText(first);

  // A second photo, which the office then opens.
  const second = `The right photo ${run}`;
  await chat.getByLabel("Your message").fill(second);
  await chat.getByLabel("Add photos (up to 3)").setInputFiles({ name: "right.png", mimeType: "image/png", buffer: OTHER_PNG });
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(messages).toContainText(second);
  await expect(chat.getByRole("button", { name: /^Take back the picture you sent/ })).toBeVisible();

  let conversation: Awaited<ReturnType<typeof chatOf>> = null;
  await expect.poll(async () => (conversation = await chatOf(name))).not.toBeNull();
  await owner.goto(`/inbox/${conversation!.id}`);
  await expect(owner.getByText("The customer took this picture back before anyone opened it.")).toBeVisible();
  await expect(owner.getByRole("img", { name: "right.png" })).toBeVisible();
  await expect.poll(() => owner.getByRole("img", { name: "right.png" }).evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
  ), { message: "the inbox fetched the picture, which is what opens it" }).toBe(true);

  // The customer's page asks every few seconds; the button goes once it has been opened.
  await expect(chat.getByRole("button", { name: /^Take back the picture you sent/ })).toHaveCount(0, { timeout: 15_000 });
  await expect(chat.getByRole("img", { name: "Picture you sent" })).toBeVisible();
});
