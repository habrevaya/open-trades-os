import { createClient, schema } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * CLOSING AND REOPENING A TEXT THREAD, AN EMAIL THREAD AND A WEBSITE CHAT
 *
 * The office closes a text thread from the inbox and the list says who closed
 * it; the same thread is reopened with every message still in it. An email
 * thread closes the same way. A website chat that is closed cannot be answered
 * until it is reopened.
 */

async function thread(channel: "sms" | "email" | "webchat", address: string, body: string): Promise<string> {
  const db = createClient();
  try {
    const [conversation] = await db.insert(schema.conversation).values({
      organizationId: E2E_ORGANIZATION_ID, channel, externalAddress: address, status: "open",
      internalAddress: channel === "webchat" ? "website" : null,
      lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 200), unreadCount: 1,
    }).returning({ id: schema.conversation.id });
    await db.insert(schema.message).values({
      organizationId: E2E_ORGANIZATION_ID, conversationId: conversation!.id, direction: "inbound", channel,
      fromAddress: address, toAddress: channel === "webchat" ? "website" : "us", body, status: "received",
    });
    if (channel === "webchat") {
      await db.insert(schema.aiChatSession).values({
        organizationId: E2E_ORGANIZATION_ID, conversationId: conversation!.id, channel: "web", status: "handed_off",
        handedOffAt: new Date(),
      });
    }
    return conversation!.id;
  } finally {
    await db.$close();
  }
}

test("the office closes a text thread, sees who closed it, and reopens the same thread", async ({ owner }) => {
  const words = `Can you come Friday ${run}?`;
  const id = await thread("sms", `+1512555${String(Date.now() % 10000).padStart(4, "0")}`, words);

  await owner.goto(`/inbox/${id}`);
  await expect(owner.getByText(words)).toBeVisible();
  await owner.getByRole("button", { name: "Close this conversation" }).click();
  await expect(owner.getByText(/ closed this conversation on /)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Close this conversation" })).toHaveCount(0);

  // The list says it was closed by the office, and by whom.
  await owner.goto("/inbox");
  const row = owner.getByRole("link").filter({ hasText: words });
  await expect(row.filter({ hasText: "Closed by the office" })).toBeVisible();

  // Reopened: the same thread, every message still in it, and nobody is told.
  await row.click();
  await owner.getByRole("button", { name: "Reopen this conversation" }).click();
  await expect(owner.getByRole("button", { name: "Close this conversation" })).toBeVisible();
  await expect(owner.getByText(/ reopened this conversation on /)).toBeVisible();
  await expect(owner.getByText(words)).toBeVisible();
  expect(owner.url()).toContain(`/inbox/${id}`);
  await owner.goto("/inbox");
  await expect(owner.getByRole("link").filter({ hasText: words }).filter({ hasText: "Closed by" })).toHaveCount(0);
});

test("the office closes an email thread and a website chat, and a closed chat takes no reply until it is reopened", async ({ owner }) => {
  const mailWords = `Quote for the deck ${run}`;
  const mail = await thread("email", `pat+${run}@example.test`, mailWords);
  await owner.goto(`/inbox/${mail}`);
  await owner.getByRole("button", { name: "Close this conversation" }).click();
  await expect(owner.getByText(/ closed this conversation on /)).toBeVisible();
  await owner.getByRole("button", { name: "Reopen this conversation" }).click();
  await expect(owner.getByRole("button", { name: "Close this conversation" })).toBeVisible();

  const chatWords = `Do you do gutters ${run}?`;
  const chat = await thread("webchat", `visitor-${run}`, chatWords);
  await owner.goto(`/inbox/${chat}`);
  await expect(owner.getByRole("textbox")).toBeVisible();
  await owner.getByRole("button", { name: "Close this conversation" }).click();
  await expect(owner.getByText(/ closed this chat on /)).toBeVisible();
  await expect(owner.getByText(/website chat has ended/)).toBeVisible();
  await expect(owner.getByRole("textbox")).toHaveCount(0);
  await owner.getByRole("button", { name: "Reopen this conversation" }).click();
  await expect(owner.getByRole("textbox")).toBeVisible();
});
