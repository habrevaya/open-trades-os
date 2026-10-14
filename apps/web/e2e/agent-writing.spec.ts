import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * ANSWERS SHOWN AS THEY ARE WRITTEN
 *
 * The website chat shows the visitor its reply while the model is still
 * writing it, and the field assistant on `/my-day` does the same for a
 * technician: whole sentences first, then the whole answer in their place.
 *
 * The model is a local server speaking Anthropic's streamed Messages API,
 * which writes the first sentence and then waits for the test to let it
 * finish, so the screen can be looked at in between. Everything between the
 * screen and that server is the product.
 */

interface FakeModel { baseUrl: string; release(): void; waiting(): boolean; close(): Promise<void> }

/** Anthropic's streamed answer: a tool call whose arguments arrive in two parts, the second when released. */
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
      const sent = JSON.parse(body) as { model: string; stream?: boolean; tools?: { name: string }[]; messages: { content: { text?: string }[] }[] };
      const tools = (sent.tools ?? []).map((t) => t.name);
      const prompt = sent.messages.flatMap((m) => m.content).map((c) => c.text ?? "").join("\n");
      const source = /howto-\d+/.exec(prompt)?.[0] ?? "howto-1";
      const [name, first, rest] = tools.includes("answer")
        ? ["answer", '{"answer":"Shut off the gas at the valve first. ', `Then drain the tank for ten minutes.","sources":["${source}"]}`]
        : ["reply", '{"text":"We do tune ups all year round. ', 'A visit takes about an hour."}'];
      const event = (out: ServerResponse, data: Record<string, unknown>) => out.write(`event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      event(response, { type: "message_start", message: { model: sent.model, usage: { input_tokens: 420, output_tokens: 1 } } });
      event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } });
      event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: first } });
      held = () => {
        event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: rest } });
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

/** An agent on, from its own card on Settings, AI agents. */
async function turnOn(owner: Page, label: string, actsAsOwner: boolean): Promise<void> {
  await owner.goto("/settings/agents");
  const card = owner.getByRole("region", { name: label, exact: true });
  await card.getByLabel("On", { exact: true }).check();
  if (actsAsOwner) {
    const options = await card.getByLabel("Acts as").locator("option").allTextContents();
    await card.getByLabel("Acts as").selectOption({ label: options.find((text) => text.includes("(Owner)"))! });
  }
  await card.getByRole("button", { name: `Save ${label.toLowerCase()}` }).click();
  await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

test.describe("answers shown as they are written", () => {
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

  test("the website chat shows its reply as it writes, then the whole reply", async ({ owner }) => {
    await turnOn(owner, "Website and text chat", true);
    await owner.goto("/settings/website/test");
    await owner.locator('[data-ot-chat="button"]').click();
    const messages = owner.locator('[data-ot-chat="messages"]');
    await expect(messages.locator('[data-ot-chat="message"]').first()).toContainText("automated assistant");

    await owner.locator('[data-ot-chat="input"]').fill(`Do you do tune ups? ${run}`);
    await owner.locator('[data-ot-chat="send"]').click();
    const writing = messages.locator('[data-ot-chat="writing"]');
    await expect(writing).toContainText("We do tune ups all year round.");
    await expect(writing).not.toContainText("an hour");
    await expect(messages.locator('[data-ot-chat="message"]').filter({ hasText: "tune ups all year" })).toHaveCount(0);

    model.release();
    await expect(messages.locator('[data-ot-chat="message"]').filter({ hasText: "We do tune ups all year round. A visit takes about an hour." }))
      .toHaveCount(1);
    await expect(writing).toHaveCount(0);
  });

  test("the field assistant shows a technician its answer as it writes, then the whole answer and where it came from", async ({ owner, tech }) => {
    await turnOn(owner, "Field assistant", false);
    const db = createClient();
    try {
      await db.insert(schema.knowledgeNote).values({
        organizationId: await organizationId(), title: `Flushing a tank heater ${run}`,
        body: "Shut off the gas. Drain the tank for ten minutes.", tags: ["flush"],
      });
    } finally {
      await db.$close();
    }
    const customer = `Fay Flush ${run}`;
    await newCustomer(owner, { name: customer, phone: "(512) 555-0161", address: { street: "9 Drain Rd", city: "Austin", state: "TX", zip: "78704" } });
    await owner.getByRole("link", { name: "9 Drain Rd, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Flush the heater ${run}`);
    await owner.getByLabel("Day", { exact: true }).fill(companyToday());
    await owner.getByLabel("Arrives from").fill("21:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

    await tech.goto("/my-day");
    await tech.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);
    const visit = tech.getByRole("article").filter({ hasText: customer });
    await visit.getByRole("button").first().click();
    const ask = visit.getByRole("region", { name: "Ask about this job" });
    await ask.getByLabel("Your question").fill("How do we flush the tank heater?");
    await ask.getByRole("button", { name: "Ask" }).click();

    const said = ask.getByRole("status");
    await expect(said).toContainText("Shut off the gas at the valve first.");
    await expect(said).toContainText("Still writing...");
    await expect(said).not.toContainText("ten minutes");

    model.release();
    await expect(said).toContainText("Shut off the gas at the valve first. Then drain the tank for ten minutes.");
    await expect(said).toContainText(`From: Flushing a tank heater ${run}`);
    await expect(said).not.toContainText("Still writing...");
  });
});
