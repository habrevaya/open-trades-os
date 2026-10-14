import { eq, desc, and, like } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CUSTOMER CHATS WITH THE COMPANY FROM THEIR ACCOUNT
 *
 * The office adds a customer. The customer signs in with a code to their phone,
 * opens "Chat with us" and writes, with no name to give: the sign in is who
 * they are. The company has not turned the assistant on for accounts, so the
 * page says a person will answer. The office finds the conversation on the
 * customer, answers it in the inbox, and the answer appears on the customer's
 * open page without a reload.
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

/** The account chat on a customer's record, as the inbox lists it. */
async function chatOf(customerName: string): Promise<{ id: string; customerId: string | null } | null> {
  const db = createClient();
  try {
    const [row] = await db.select({ id: schema.conversation.id, customerId: schema.conversation.customerId })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(and(eq(schema.customer.name, customerName), like(schema.conversation.externalAddress, "portal:%")))
      .limit(1);
    return row ?? null;
  } finally {
    await db.$close();
  }
}

test("a signed in customer chats from their account and the office answers from the inbox", async ({ owner, stranger }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Wren Chatter ${run}`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();
  await newCustomer(owner, { name, phone, address: { street: "8 Willow Way", city: "Austin", state: "TX", zip: "78745" } });

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
  await expect(stranger.getByRole("heading", { level: 1, name: "Chat with us" })).toBeVisible();
  const chat = stranger.getByRole("region", { name: "Your chat" });
  await expect(chat).toContainText("will answer here");
  const words = `The furnace clicks but will not light ${run}`;
  await chat.getByLabel("Your message").fill(words);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(words);
  await expect(chat.getByLabel("Your message")).toHaveValue("");

  let conversation: Awaited<ReturnType<typeof chatOf>> = null;
  await expect.poll(async () => (conversation = await chatOf(name))).not.toBeNull();
  await owner.goto(`/inbox/${conversation!.id}`);
  await expect(owner.getByText(words)).toBeVisible();
  const answer = `Hi Wren, Jo here. We can come tomorrow morning ${run}.`;
  await owner.getByRole("textbox", { name: "Reply" }).fill(answer);
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText(answer)).toBeVisible();

  /** The customer's open page asks again every few seconds: no reload. */
  await expect(chat.getByRole("list", { name: "Messages" })).toContainText(answer, { timeout: 20_000 });
});
