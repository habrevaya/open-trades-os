import { eq, desc, and, like, sql } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { portalChat } from "@opentradesos/api/services";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE OFFICE CLOSES A CHAT, AND A QUIET CHAT CLOSES ITSELF
 *
 * A customer signs in and writes; the office answers in the inbox and presses
 * "Close this chat". The inbox says who closed it and offers no reply box, and
 * the customer's page says in words that the company closed it and still shows
 * what was said. Their next message opens a new conversation. Then the owner
 * chooses a number of quiet days on Settings, a chat the office answered last
 * goes quiet for that long, the worker's pass closes it, and the customer's
 * page says it went quiet.
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

/** The chat's messages made `days` days older, as if nobody had written since. */
async function ageChat(conversationId: string, days: number) {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.message set created_at = created_at - (${days}::int * interval '1 day')
       where conversation_id = ${conversationId}::uuid`);
  } finally {
    await db.$close();
  }
}

async function runIdlePass() {
  const db = createClient();
  try {
    return await portalChat.idleClosePass(db, { force: true });
  } finally {
    await db.$close();
  }
}

test("the office closes a chat and the customer is told on the page, and a quiet chat is closed by the company's rule", async ({ owner, stranger }) => {
  test.setTimeout(180_000);
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Olive Office ${run}`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "8 Elm Row", city: "Austin", state: "TX", zip: "78745" } });

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
  const words = `The pilot light is out ${run}`;
  await chat.getByLabel("Your message").fill(words);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);

  /** The office answers, then closes it. */
  let first: { id: string; status: string } | undefined;
  await expect.poll(async () => (first = (await chatsOf(name))[0])).toBeTruthy();
  await owner.goto(`/inbox/${first!.id}`);
  const answer = `Relight it with the red button ${run}`;
  await owner.getByRole("textbox", { name: "Reply" }).fill(answer);
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText(answer)).toBeVisible();
  await owner.getByRole("button", { name: "Close this chat" }).click();
  await expect(owner.getByText(/ closed this chat on /)).toBeVisible();
  await expect(owner.getByText("The customer can see it was closed. If they write again, it opens a new one.")).toBeVisible();
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Close this chat" })).toHaveCount(0);

  await owner.goto("/inbox");
  await expect(owner.getByRole("link").filter({ hasText: name }).filter({ hasText: "Closed by the office" })).toBeVisible();

  /** The customer's page, which asks again every few seconds, says so and keeps the thread. */
  await expect(chat.getByText(/closed this chat\. You can still read it below\. Write below to start a new one\./)).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(answer);
  await expect(chat.getByRole("button", { name: "Close this chat" })).toHaveCount(0);

  /** Writing again opens a new conversation. */
  const again = `Thank you, it is lit ${run}`;
  await chat.getByLabel("Your message").fill(again);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(again);
  await expect(chat.getByRole("list", { name: "Messages" })).not.toContainText(words);
  await expect.poll(async () => (await chatsOf(name)).length).toBe(2);

  /** The company's rule: three quiet days after the office answered last. */
  const settingsRegion = owner.getByRole("region", { name: "Quiet chats" });
  try {
    await owner.goto("/settings/portal");
    await settingsRegion.getByLabel("Days of quiet before a chat is closed").fill("3");
    await settingsRegion.getByRole("button", { name: "Save quiet chats" }).click();
    await expect(settingsRegion.getByText("A chat you answered last is closed after 3 days of quiet.")).toBeVisible();

    const [second] = await chatsOf(name);
    await owner.goto(`/inbox/${second!.id}`);
    const reply = `Glad it helped ${run}`;
    await owner.getByRole("textbox", { name: "Reply" }).fill(reply);
    await owner.getByRole("button", { name: "Send" }).click();
    await expect(owner.getByText(reply)).toBeVisible();

    /** Too soon: nothing closes. Then the chat goes quiet for four days and it does. */
    await runIdlePass();
    expect((await chatsOf(name))[0]!.status).not.toBe("closed");
    await ageChat(second!.id, 4);
    await runIdlePass();
    await expect.poll(async () => (await chatsOf(name))[0]!.status).toBe("closed");

    await owner.goto(`/inbox/${second!.id}`);
    await expect(owner.getByText(/This chat was closed on .* because it went quiet\./)).toBeVisible();
    await expect(chat.getByText(/closed this chat because it had been quiet for a while\./)).toBeVisible({ timeout: 20_000 });
    await expect(chat.getByRole("list", { name: "Messages" })).toContainText(reply);
  } finally {
    /** Switched off again, so no other spec's chat is closed. */
    await owner.goto("/settings/portal");
    await settingsRegion.getByLabel("Days of quiet before a chat is closed").fill("");
    await settingsRegion.getByRole("button", { name: "Save quiet chats" }).click();
    await expect(settingsRegion.getByText("Chats stay open until the customer or you close them.")).toBeVisible();
  }
});
