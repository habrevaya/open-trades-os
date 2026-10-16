import { eq, desc, and, like } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE CUSTOMER CLOSES THEIR CHAT
 *
 * A customer signs in, writes to the company and closes the chat. Their page says
 * so and starts empty. The office finds the conversation in the inbox marked as
 * closed by the customer, with what the customer wrote still there, and is not
 * offered a reply box. The customer writes again and the office gets a new
 * conversation, which it can answer.
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

/** The customer's account chats, newest first. */
async function chatsOf(customerName: string): Promise<{ id: string; status: string }[]> {
  const db = createClient();
  try {
    return await db.select({ id: schema.conversation.id, status: schema.conversation.status })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(and(eq(schema.customer.name, customerName), like(schema.conversation.externalAddress, "portal:%")))
      .orderBy(desc(schema.conversation.createdAt));
  } finally {
    await db.$close();
  }
}

test("a customer closes their chat, the office sees it closed by them, and their next message opens a new one", async ({ owner, stranger }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Cleo Closer ${run}`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "5 Pine Row", city: "Austin", state: "TX", zip: "78745" } });

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
  /** Nothing to close before anything is written. */
  await expect(chat.getByRole("button", { name: "Close this chat" })).toHaveCount(0);
  const words = `The furnace is out ${run}`;
  await chat.getByLabel("Your message").fill(words);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);

  await chat.getByRole("button", { name: "Close this chat" }).click();
  await expect(chat.getByText("You closed your last chat. Write below to start a new one.")).toBeVisible();
  await expect(chat.getByRole("list", { name: "Messages" })).not.toContainText(words);
  await expect(chat.getByRole("button", { name: "Close this chat" })).toHaveCount(0);

  /** The office finds it closed by the customer, with what they wrote, and no reply box. */
  let first: { id: string; status: string } | undefined;
  await expect.poll(async () => (first = (await chatsOf(name))[0])).toBeTruthy();
  expect(first!.status).toBe("closed");
  await owner.goto(`/inbox/${first!.id}`);
  await expect(owner.getByText(words)).toBeVisible();
  await expect(owner.getByText(/^The customer closed this chat on /)).toBeVisible();
  await expect(owner.getByText("The customer closed this chat, so a reply has nowhere to go. If they write again, it opens a new one.")).toBeVisible();
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveCount(0);

  await owner.goto("/inbox");
  await expect(owner.getByRole("link").filter({ hasText: name }).filter({ hasText: "Closed by the customer" })).toBeVisible();

  /** Writing again opens a new conversation the office can answer. */
  const again = `It is working again ${run}`;
  await chat.getByLabel("Your message").fill(again);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(again);
  await expect(chat.getByRole("list", { name: "Messages" })).not.toContainText(words);
  await expect(chat.getByText("You closed your last chat.")).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Close this chat" })).toBeVisible();

  await expect.poll(async () => (await chatsOf(name)).length).toBe(2);
  const [second, older] = await chatsOf(name);
  expect(second!.id).not.toBe(first!.id);
  expect(older!.status).toBe("closed");
  await owner.goto(`/inbox/${second!.id}`);
  await expect(owner.getByText(again)).toBeVisible();
  await expect(owner.getByText(/^The customer closed this chat on /)).toHaveCount(0);
  const answer = `Glad to hear it ${run}`;
  await owner.getByRole("textbox", { name: "Reply" }).fill(answer);
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText(answer)).toBeVisible();
});
