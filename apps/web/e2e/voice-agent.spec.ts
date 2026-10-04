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
import type { Page } from "@playwright/test";
import { E2E_TWILIO_ENV } from "./twilio-env";
import { E2E_AI_ENV } from "./ai-env";
import { E2E_RELAY_PORT, E2E_VOICE_RELAY_ENV } from "./voice-relay-env";

/**
 * THE PHONE ASSISTANT, FROM THE SETTINGS SCREENS TO THE CALL LOG
 *
 * The owner turns the phone assistant on in AI agents, builds a phone menu
 * whose first option is the assistant, and puts the menu on a number. A call
 * presses 1 and is handed to the voice relay; the caller asks for a booking
 * and then for a person. The owner finds the call on the call log, marked as
 * the assistant's, with what it heard, said and did.
 *
 * Three things are faked, each at its edge only: Twilio's REST API and the
 * model are local HTTP servers the connections point at, as in the voice and
 * agents specs, and the carrier's side of the call is this spec, signing its
 * webhooks and its WebSocket handshake the way Twilio signs them. The relay
 * itself is the product's own, started here on the port the web app was told.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const NUMBER = "+15125550146";
const CALLER = `+1737${String(Date.now()).slice(-7)}`;
const WINDOW = /"bookableServiceId": "([^"]+)",\s*"date": "([^"]+)",\s*"arrivalWindowId": "([^"]+)"/g;

interface Fakes { baseUrl: string; placed: URLSearchParams[]; close(): Promise<void> }

/** Twilio's REST API for placing calls, and Anthropic's Messages API, on localhost. */
async function fakes(): Promise<Fakes> {
  const placed: URLSearchParams[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "POST" && request.url?.endsWith("/Calls.json")) {
        placed.push(new URLSearchParams(body));
        return json(201, { sid: `CAleg${placed.length}` });
      }
      if (request.method === "POST" && request.url === "/v1/messages") {
        const sent = JSON.parse(body) as { model: string; messages: { content: { text?: string }[] }[] };
        const prompt = sent.messages.flatMap((m) => m.content).map((c) => c.text ?? "").join("\n");
        const windows = [...prompt.matchAll(WINDOW)];
        const last = windows.at(-1);
        const call = last
          ? {
              name: "create_booking_request",
              input: {
                bookableServiceId: last[1], date: last[2], arrivalWindowId: last[3], contactName: `Dana Caller ${run}`,
                address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" },
                notes: "Water heater leaking.", text: "Thank you. The office will confirm that time with you.",
              },
            }
          : { name: "reply", input: { text: "We can help with that. When would suit you?" } };
        return json(200, {
          id: "msg_voice", model: sent.model, role: "assistant", type: "message",
          content: [{ type: "tool_use", id: "toolu_voice", name: call.name, input: call.input }],
          stop_reason: "tool_use", usage: { input_tokens: 400, output_tokens: 60 },
        });
      }
      json(404, { message: `The fake has no ${request.method} ${request.url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, placed, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

/** Twilio and the model, pointed at the fakes, and a number answered here. Returns the voice webhook token. */
async function connect(baseUrl: string): Promise<string> {
  const org = await organizationId();
  const token = randomBytes(32).toString("base64url");
  const db = createClient();
  try {
    const twilio = { accountSid: "ACe2e", webhookToken: token, baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings: twilio,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio },
    });
    const model = { defaultModel: "claude-haiku-4-5", baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "ai_model", provider: "anthropic", status: "connected",
      credentialRef: "E2E_AI_KEY", settings: model,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_AI_KEY", settings: model },
    });
    const [held] = await db.select({ id: schema.phoneNumber.id }).from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, org), eq(schema.phoneNumber.e164, NUMBER))).limit(1);
    if (!held) {
      await db.insert(schema.phoneNumber).values({
        organizationId: org, e164: NUMBER, label: "Assistant line", purpose: "main", providerNumberId: `PNassistant${run}`,
      });
    }
    return token;
  } finally {
    await db.$close();
  }
}

/** Everything off again, so later specs see the company as the seed left it. */
async function disconnect(): Promise<void> {
  const org = await organizationId();
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

/** A request exactly as Twilio makes it: form encoded, signed over the public URL with its query. */
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

/** The carrier's side of ConversationRelay: a signed WebSocket that says the caller's words and hears the answers. */
async function relayCall(address: string, callSid: string) {
  const signature = createHmac("sha1", AUTH).update(Buffer.from(address, "utf8")).digest("base64");
  const ws = new WebSocket(address, { headers: { "x-twilio-signature": signature } });
  const heard: { type: string; token?: string }[] = [];
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.on("message", (data) => heard.push(JSON.parse(String(data)) as { type: string; token?: string }));
  ws.send(JSON.stringify({ type: "setup", sessionId: "VXe2e", callSid, from: CALLER, to: NUMBER, customParameters: {} }));
  const say = async (text: string) => {
    const before = heard.length;
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true }));
    await expect.poll(() => heard.length, { timeout: 15_000 }).toBeGreaterThan(before);
    return heard.at(-1)!;
  };
  return { say, close: () => ws.close() };
}

async function turnOnAssistant(owner: Page): Promise<void> {
  await owner.goto("/settings/agents");
  const card = owner.getByRole("region", { name: "Phone assistant", exact: true });
  await card.getByLabel("On", { exact: true }).check();
  const options = await card.getByLabel("Acts as").locator("option").allTextContents();
  const me = options.find((text) => text.includes("(Owner)"));
  expect(me, "the owner is somebody the assistant can act as").toBeTruthy();
  await card.getByLabel("Acts as").selectOption({ label: me! });
  await card.getByLabel("What it says after saying it is automated").fill("How can we help today?");
  await card.getByRole("button", { name: "Save phone assistant" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

test("a menu option sends callers to the phone assistant, and its call is on the call log with what it did", async ({ owner }) => {
  const fake = await fakes();
  const token = await connect(fake.baseUrl);
  const db = createClient();
  let relay: RelayServer | null = null;
  try {
    relay = await startVoiceRelay({
      db, publicBase: E2E_VOICE_RELAY_ENV.VOICE_RELAY_URL, port: E2E_RELAY_PORT, host: "127.0.0.1",
      voiceDeps: { readSecret: async () => AUTH },
      aiDeps: { readSecret: async () => E2E_AI_ENV.E2E_AI_KEY },
      log: () => {},
    });

    await turnOnAssistant(owner);

    // The menu: 1 for the assistant.
    await owner.goto("/settings/phone");
    await expect(owner.getByRole("heading", { name: "The phone assistant" })).toBeVisible();
    const build = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Build a menu" }) }).last();
    await build.getByLabel("Name").fill(`Assistant ${run}`);
    await build.getByLabel("What callers hear first").fill("Thanks for calling Ridgeline.");
    await build.getByLabel("Option 1 key").selectOption("1");
    await build.getByLabel("Option 1 is for").fill("Our assistant");
    await build.locator('select[name="optionTo"]').nth(0).selectOption({ label: "The phone assistant" });
    await build.getByRole("button", { name: "Build menu" }).click();
    await expect(owner.getByText(`"Thanks for calling Ridgeline. For Our assistant, press 1."`)).toBeVisible();

    // On the number.
    const number = owner.locator("li").filter({ hasText: /555.?0146/ }).first();
    await number.getByLabel("Answered by").selectOption({ label: `The Assistant ${run} menu` });
    await number.getByRole("button", { name: "Save" }).click();
    await expect(number.getByText(`Assistant ${run} menu`, { exact: true })).toBeVisible();

    // A call: it presses 1 and is handed to the relay.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: CALLER, To: NUMBER });
    const menu = attribute(answered, "Gather", "action");
    const pressed = await carrier(token, "menu", { CallSid: sid, Digits: "1" }, menu.slice(menu.indexOf("?")));
    expect(pressed).toContain("automated assistant, not a person");
    const relayAddress = attribute(pressed, "ConversationRelay", "url");
    expect(relayAddress.startsWith(`${E2E_VOICE_RELAY_ENV.VOICE_RELAY_URL}/voice-relay/`)).toBe(true);

    // The conversation: a booking, then a person.
    const call = await relayCall(relayAddress, sid);
    const booked = await call.say(`I need my water heater looked at, I'm Dana Caller ${run} at 12 Elm St Austin 78701, any time is fine.`);
    expect(booked).toEqual({ type: "text", token: "Thank you. The office will confirm that time with you.", last: true });
    const ended = await call.say("Can I talk to a real person please?");
    expect(ended.type).toBe("end");
    call.close();
    const next = await carrier(token, "agent-done", { CallSid: sid }, "");
    expect(next).toContain("Putting you through to someone now.");

    // The call log, marked as the assistant's, and what it did on the call screen.
    await owner.goto("/marketing/calls");
    const row = owner.getByRole("row").filter({ hasText: /737/ }).filter({ hasText: "Phone assistant" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("link").first().click();
    const section = owner.getByRole("region", { name: "The phone assistant" });
    await expect(section.getByText(`Took a booking request from Dana Caller ${run}`)).toBeVisible();
    await expect(section.getByText("Put the caller through: The caller asked for a person.")).toBeVisible();
    await expect(section.getByText("Can I talk to a real person please?")).toBeVisible();
    await expect(owner.getByText("The phone assistant answered.")).toBeVisible();

    // And the agents' log says the same.
    await owner.goto("/settings/agents?agent=voice");
    await expect(owner.getByRole("listitem").filter({ hasText: `Answered a call from ${CALLER}` }).first()).toBeVisible();
  } finally {
    await relay?.close();
    await db.$close();
    await disconnect();
    await fake.close();
  }
});

test("a waiting line made on the settings screen holds a caller with their place and rings the group", async ({ owner }) => {
  const fake = await fakes();
  const token = await connect(fake.baseUrl);
  const ownerPhone = `+1737${String(Date.now() + 7).slice(-7)}`;
  try {
    await owner.goto("/settings/phone");

    // The owner answers on their phone, in a group of one.
    const me = owner.locator("li").filter({ has: owner.getByRole("textbox", { name: /'s number$/ }) }).first();
    await me.getByRole("textbox").fill(ownerPhone);
    await me.getByRole("button", { name: "Save" }).click();
    await expect(me.getByRole("status")).toHaveText("Saved.");
    const ownerName = (await me.locator("span").first().textContent())!.trim();
    const group = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Make a ring group" }) }).last();
    await group.getByLabel("Name", { exact: true }).fill(`Line team ${run}`);
    await group.getByLabel("Member 1", { exact: true }).selectOption({ label: ownerName });
    await group.getByRole("button", { name: "Make group" }).click();
    await expect(owner.getByRole("heading", { name: `Line team ${run}` })).toBeVisible();

    // The line, answered by that group, keeping callers two minutes at most.
    const line = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Make a waiting line" }) }).last();
    await line.getByLabel("Name", { exact: true }).fill(`Service ${run}`);
    await line.getByLabel("Answered by the ring group").selectOption({ label: `Line team ${run}` });
    await line.getByLabel("Longest a caller waits").selectOption({ label: "2 minutes" });
    await line.getByRole("button", { name: "Make line" }).click();
    await expect(owner.getByText(`Answered by the Line team ${run} ring group. Callers wait up to 2 minutes, told their place in line.`)).toBeVisible();

    // A menu whose first option is the line, on the number.
    const build = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Build a menu" }) }).last();
    await build.getByLabel("Name").fill(`Lines ${run}`);
    await build.getByLabel("What callers hear first").fill("Thanks for calling Ridgeline.");
    await build.getByLabel("Option 1 key").selectOption("1");
    await build.getByLabel("Option 1 is for").fill("Service");
    await build.locator('select[name="optionTo"]').nth(0).selectOption({ label: `Service ${run}` });
    await build.getByRole("button", { name: "Build menu" }).click();
    await expect(owner.getByRole("heading", { name: `Lines ${run}` })).toBeVisible();
    const number = owner.locator("li").filter({ hasText: /555.?0146/ }).first();
    await number.getByLabel("Answered by").selectOption({ label: `The Lines ${run} menu` });
    await number.getByRole("button", { name: "Save" }).click();
    await expect(number.getByText(`Lines ${run} menu`, { exact: true })).toBeVisible();

    // A caller presses 1, is held with their place, and the owner's phone is rung.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: CALLER, To: NUMBER });
    const menu = attribute(answered, "Gather", "action");
    const pressed = await carrier(token, "menu", { CallSid: sid, Digits: "1" }, menu.slice(menu.indexOf("?")));
    const wait = attribute(pressed, "Enqueue", "waitUrl");
    const held = await carrier(token, "queue-wait", { CallSid: sid, QueuePosition: "1", QueueTime: "0" }, wait.slice(wait.indexOf("?")));
    expect(held).toContain("<Say>You are next in line. Thanks for waiting.</Say>");
    expect(held).toContain("<Play>");
    expect(fake.placed.map((p) => p.get("To"))).toEqual([ownerPhone]);
    expect(fake.placed[0]!.get("From")).toBe(NUMBER);
  } finally {
    await disconnect();
    await fake.close();
  }
});
