import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { startVoiceRelay, type RelayServer } from "@opentradesos/api/voice-relay";
import "@opentradesos/api/voice";
import "@opentradesos/api/ai";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";
import { E2E_AI_ENV } from "./ai-env";
import { E2E_RELAY_PORT, E2E_VOICE_RELAY_ENV } from "./voice-relay-env";

/**
 * THE PHONE ASSISTANT SPEAKS AS IT WRITES, AND SENDS A CALLER TO A LINE
 *
 * The owner lets the phone assistant send callers to a billing waiting line,
 * on AI agents, saying what it is for. On a call the model streams its
 * answer (a fake of Anthropic's Messages API answering in server sent
 * events, through the real adapter), and the caller hears it a sentence at a
 * time with the answer closed at the end; asked about a bill, the assistant
 * sends the caller to the billing line, which holds them in its queue.
 *
 * Twilio's side of the call is this spec, signing its webhooks and its
 * WebSocket the way Twilio does; the model is a local server the connection
 * points at; the relay is the product's own.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const NUMBER = "+15125550147";
const CALLER = `+1737${String(Date.now() + 9).slice(-7)}`;

/** Anthropic's Messages API, streaming: a reply in two sentences, or a transfer to the line named in the prompt. */
async function fakeModel(lineId: () => string): Promise<{ baseUrl: string; streamed: number; close(): Promise<void> }> {
  const state = { streamed: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/messages") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: `The fake has no ${request.method} ${request.url}` }));
        return;
      }
      const sent = JSON.parse(body) as { stream?: boolean; messages: { content: { text?: string }[] }[] };
      const prompt = sent.messages.flatMap((m) => m.content).map((c) => c.text ?? "").join("\n");
      const asked = /bill/i.test(prompt.split("The call so far").at(-1) ?? "");
      const input = asked
        ? JSON.stringify({ reason: "A question about a bill.", place: prompt.includes(lineId()) ? lineId() : "none" })
        : JSON.stringify({ text: "We fix water heaters every day. Would you like a visit?" });
      const name = asked ? "transfer" : "reply";
      if (sent.stream) state.streamed += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { model: "claude-haiku-4-5", usage: { input_tokens: 400, output_tokens: 1 } } });
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_e2e", name, input: {} } });
      for (let i = 0; i < input.length; i += 9) {
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: input.slice(i, i + 9) } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } });
      event("message_stop", {});
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get streamed() { return state.streamed; },
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

/** Twilio and the model pointed at the fakes, a number answered here, and a billing line. */
async function setUp(baseUrl: string) {
  const org = await organizationId();
  const token = randomBytes(32).toString("base64url");
  const db = createClient();
  try {
    const twilio = { accountSid: "ACe2e", webhookToken: token, baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "messaging", provider: "twilio", status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio },
    });
    const model = { defaultModel: "claude-haiku-4-5", baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "ai_model", provider: "anthropic", status: "connected", credentialRef: "E2E_AI_KEY", settings: model,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_AI_KEY", settings: model },
    });
    const [held] = await db.select({ id: schema.phoneNumber.id }).from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, org), eq(schema.phoneNumber.e164, NUMBER))).limit(1);
    if (!held) {
      await db.insert(schema.phoneNumber).values({ organizationId: org, e164: NUMBER, label: "Places line", purpose: "main", providerNumberId: `PNplaces${run}` });
    }
    const [group] = await db.insert(schema.ringGroup).values({
      organizationId: org, name: `Billing team ${run}`, strategy: "all_at_once", ringSeconds: 20,
      members: [{ e164: "+15125550189", label: "Billing desk" }], noAnswerTo: { kind: "voicemail", box: "main" },
    }).returning({ id: schema.ringGroup.id });
    const [line] = await db.insert(schema.callQueue).values({
      organizationId: org, name: `Billing ${run}`, ringGroupId: group!.id, overflowTo: { kind: "voicemail", box: "main" },
    }).returning({ id: schema.callQueue.id });
    return { org, token, lineId: line!.id };
  } finally {
    await db.$close();
  }
}

async function tearDown(org: string): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.phoneNumber).set({ menuId: null })
      .where(and(eq(schema.phoneNumber.organizationId, org), eq(schema.phoneNumber.e164, NUMBER)));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "messaging")));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "ai_model")));
    await db.delete(schema.aiAgentSetting).where(eq(schema.aiAgentSetting.organizationId, org));
  } finally {
    await db.$close();
  }
}

async function carrier(token: string, step: string | null, form: Record<string, string>, query = ""): Promise<string> {
  const url = `${BASE}/api/webhooks/voice/${token}${step ? `/${step}` : ""}${query}`;
  const data = Object.keys(form).sort().reduce((acc, key) => acc + key + form[key], url);
  const signature = createHmac("sha1", AUTH).update(Buffer.from(data, "utf8")).digest("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(form).toString(),
  });
  expect(response.status).toBe(200);
  return response.text();
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};

/** A call through a menu to the assistant, and the carrier's side of the conversation. */
async function assistantCall(token: string, menuGather: string) {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await carrier(token, null, { CallSid: sid, From: CALLER, To: NUMBER });
  const gather = attribute(answered, menuGather, "action");
  const pressed = await carrier(token, "menu", { CallSid: sid, Digits: "1" }, gather.slice(gather.indexOf("?")));
  const address = attribute(pressed, "ConversationRelay", "url");
  const signature = createHmac("sha1", AUTH).update(Buffer.from(address, "utf8")).digest("base64");
  const ws = new WebSocket(address, { headers: { "x-twilio-signature": signature } });
  const heard: { type: string; token?: string; last?: boolean }[] = [];
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.on("message", (data) => heard.push(JSON.parse(String(data)) as { type: string; token?: string; last?: boolean }));
  ws.send(JSON.stringify({ type: "setup", sessionId: "VXplaces", callSid: sid, from: CALLER, to: NUMBER, customParameters: {} }));
  return {
    sid, heard,
    say: (text: string) => ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true })),
    close: () => ws.close(),
  };
}

test("the phone assistant speaks a sentence at a time and sends a caller to the line it was allowed", async ({ owner }) => {
  let lineId = "";
  const model = await fakeModel(() => lineId);
  const setup = await setUp(model.baseUrl);
  lineId = setup.lineId;
  const db = createClient();
  let relay: RelayServer | null = null;
  try {
    process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
    relay = await startVoiceRelay({
      db, publicBase: E2E_VOICE_RELAY_ENV.VOICE_RELAY_URL, port: E2E_RELAY_PORT, host: "127.0.0.1",
      voiceDeps: { readSecret: async () => AUTH },
      aiDeps: { readSecret: async () => E2E_AI_ENV.E2E_AI_KEY },
      log: () => {},
    });

    // The assistant on, acting as the owner, allowed to send callers to the billing line.
    await owner.goto("/settings/agents");
    const card = owner.getByRole("region", { name: "Phone assistant", exact: true });
    await card.getByLabel("On", { exact: true }).check();
    const options = await card.getByLabel("Acts as").locator("option").allTextContents();
    await card.getByLabel("Acts as").selectOption({ label: options.find((text) => text.includes("(Owner)"))! });
    await card.getByLabel(`The Billing ${run} waiting line`, { exact: true }).check();
    await card.getByLabel(`What the billing ${run} waiting line is for`).fill("Questions about a bill or a payment");
    await card.getByRole("button", { name: "Save phone assistant" }).click();
    await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(card.getByLabel(`What the billing ${run} waiting line is for`)).toHaveValue("Questions about a bill or a payment");

    // A menu whose first option is the assistant, on the number.
    const menuDb = createClient();
    try {
      const [menu] = await menuDb.insert(schema.phoneMenu).values({
        organizationId: setup.org, name: `Places ${run}`, greeting: "Thanks for calling.",
        options: [{ key: "1", label: "Our assistant", to: { kind: "agent" } }], noInputTo: { kind: "voicemail", box: "main" },
      }).returning({ id: schema.phoneMenu.id });
      await menuDb.update(schema.phoneNumber).set({ menuId: menu!.id })
        .where(and(eq(schema.phoneNumber.organizationId, setup.org), eq(schema.phoneNumber.e164, NUMBER)));
    } finally {
      await menuDb.$close();
    }

    // A question: the answer arrives a sentence at a time, and is closed at the end.
    const call = await assistantCall(setup.token, "Gather");
    call.say("Do you fix water heaters?");
    await expect.poll(() => call.heard.some((m) => m.last === true), { timeout: 15_000 }).toBe(true);
    expect(call.heard.filter((m) => m.type === "text")).toEqual([
      { type: "text", token: "We fix water heaters every day.", last: false },
      { type: "text", token: "Would you like a visit?", last: true },
    ]);
    expect(model.streamed).toBeGreaterThan(0);

    // A bill: sent to the billing line, which holds them in its queue.
    call.say("Actually I have a question about my bill.");
    await expect.poll(() => call.heard.some((m) => m.type === "end"), { timeout: 15_000 }).toBe(true);
    call.close();
    const next = await carrier(setup.token, "agent-done", { CallSid: call.sid });
    expect(next).toContain(`>ots-${setup.lineId}</Enqueue>`);

    // The call screen says where it went.
    await owner.goto("/marketing/calls");
    await owner.getByRole("row").filter({ hasText: CALLER.slice(-4) }).first().getByRole("link").first().click();
    await expect(owner.getByText(new RegExp(`The phone assistant sent the caller to the Billing ${run} waiting line`))).toBeVisible();
  } finally {
    await relay?.close();
    await db.$close();
    await tearDown(setup.org);
    await model.close();
  }
});
