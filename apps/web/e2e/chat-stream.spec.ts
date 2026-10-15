import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import type { Page, Request } from "@playwright/test";

/**
 * THE WEBSITE CHAT READS ITS REPLY AS A STREAM
 *
 * The widget sends a message asking for Server-Sent Events and shows each
 * finished sentence as it arrives, instead of reading the chat once a second.
 * When the stream cannot be opened it sends the same message the old way and
 * reads the chat for the reply so far, so the visitor still sees it written.
 *
 * The model is a local server speaking Anthropic's streamed Messages API that
 * writes the first sentence and waits for the test to let it finish.
 */

interface FakeModel { baseUrl: string; release(): void; waiting(): boolean; close(): Promise<void> }

async function fakeModel(): Promise<FakeModel> {
  let held: (() => void) | null = null;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/messages") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "not_found", message: "nothing here" } }));
        return;
      }
      const sent = JSON.parse(body) as { model: string };
      const event = (out: ServerResponse, data: Record<string, unknown>) => out.write(`event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      event(response, { type: "message_start", message: { model: sent.model, usage: { input_tokens: 420, output_tokens: 1 } } });
      event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "reply", input: {} } });
      event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text":"We clean drains every day of the week. ' } });
      held = () => {
        event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'Most take under an hour."}' } });
        event(response, { type: "content_block_stop", index: 0 });
        event(response, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 60 } });
        event(response, { type: "message_stop" });
        response.end();
      };
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    waiting: () => held !== null,
    release: () => { const go = held; held = null; go?.(); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function organizationId(): Promise<string> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    return org!.id;
  } finally {
    await db.$close();
  }
}

async function connectModel(baseUrl: string): Promise<void> {
  const org = await organizationId();
  const db = createClient();
  try {
    const settings = { defaultModel: "claude-haiku-4-5", baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "ai_model", provider: "anthropic", status: "connected", credentialRef: "E2E_AI_KEY", settings,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_AI_KEY", settings },
    });
  } finally {
    await db.$close();
  }
}

async function disconnectModel(): Promise<void> {
  const org = await organizationId();
  const db = createClient();
  try {
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "ai_model")));
    await db.delete(schema.aiAgentSetting).where(eq(schema.aiAgentSetting.organizationId, org));
  } finally {
    await db.$close();
  }
}

async function chatOn(owner: Page): Promise<void> {
  await owner.goto("/settings/agents");
  const card = owner.getByRole("region", { name: "Website and text chat", exact: true });
  await card.getByLabel("On", { exact: true }).check();
  const options = await card.getByLabel("Acts as").locator("option").allTextContents();
  await card.getByLabel("Acts as").selectOption({ label: options.find((text) => text.includes("(Owner)"))! });
  await card.getByRole("button", { name: "Save website and text chat" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

/** The chat open on the page that loads the snippet as a website would, and every chat request it makes from now on. */
async function openChat(owner: Page): Promise<Request[]> {
  await owner.goto("/settings/website/test");
  await owner.locator('[data-ot-chat="button"]').click();
  await expect(owner.locator('[data-ot-chat="message"]').first()).toContainText("automated assistant");
  const requests: Request[] = [];
  owner.on("request", (request) => { if (request.url().includes("/v1/public/chat/")) requests.push(request); });
  return requests;
}

const REPLY = "We clean drains every day of the week. Most take under an hour.";

test.describe("the website chat, as a stream", () => {
  let model: FakeModel;

  test.beforeAll(async () => {
    model = await fakeModel();
    await connectModel(model.baseUrl);
  });
  test.afterAll(async () => {
    model.release();
    await disconnectModel();
    await model.close();
  });

  test("shows each sentence as it arrives in the stream, without reading the chat every second", async ({ owner }) => {
    await chatOn(owner);
    const requests = await openChat(owner);
    const messages = owner.locator('[data-ot-chat="messages"]');

    const streamed = owner.waitForResponse((response) => response.url().includes("/v1/public/chat/messages"));
    await owner.locator('[data-ot-chat="input"]').fill(`Do you clean drains? ${run}`);
    await owner.locator('[data-ot-chat="send"]').click();
    const response = await streamed;
    expect(response.request().headers()["accept"]).toBe("text/event-stream");
    expect(response.headers()["content-type"]).toContain("text/event-stream");

    const writing = messages.locator('[data-ot-chat="writing"]');
    await expect(writing).toContainText("We clean drains every day of the week.");
    await expect(writing).not.toContainText("an hour");
    /** Long enough for the old way to have read the chat three times. */
    await owner.waitForTimeout(3000);
    expect(requests.filter((request) => request.url().includes("/transcript")).length).toBeLessThanOrEqual(1);

    model.release();
    await expect(messages.locator('[data-ot-chat="message"]').filter({ hasText: REPLY })).toHaveCount(1);
    await expect(writing).toHaveCount(0);
    expect(requests.filter((request) => request.url().includes("/v1/public/chat/messages"))).toHaveLength(1);
  });

  test("falls back to reading the chat once a second when the stream cannot open, and still shows the reply as it is written", async ({ owner }) => {
    await chatOn(owner);
    /** Refused before it leaves the browser, as a network that will not carry it would. */
    await owner.route("**/v1/public/chat/messages", (route) =>
      (route.request().headers()["accept"] ?? "").includes("text/event-stream") ? route.abort() : route.continue());
    const requests = await openChat(owner);
    const messages = owner.locator('[data-ot-chat="messages"]');

    await owner.locator('[data-ot-chat="input"]').fill(`Do you clean drains on Sundays? ${run}`);
    await owner.locator('[data-ot-chat="send"]').click();
    const writing = messages.locator('[data-ot-chat="writing"]');
    await expect(writing).toContainText("We clean drains every day of the week.");
    await expect(writing).not.toContainText("an hour");
    await expect.poll(() => requests.filter((request) => request.url().includes("/transcript")).length).toBeGreaterThanOrEqual(2);

    model.release();
    await expect(messages.locator('[data-ot-chat="message"]').filter({ hasText: REPLY })).toHaveCount(1);
    await expect(writing).toHaveCount(0);
    /** One message, sent twice under one key: the stream that never left, and the one that did. */
    await expect(messages.locator('[data-ot-chat="message"]').filter({ hasText: "on Sundays" })).toHaveCount(1);
  });
});
