import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as voice from "../src/services/voice";
import * as voiceAgent from "../src/services/voice-agent";
import * as phoneMenus from "../src/services/phone-menus";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { startVoiceRelay, type RelayServer } from "../src/voice/relay-server";
import "../src/ai/index";
import type {
  AiContent, AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate,
} from "../src/ai/provider";
import type { ServiceContext } from "../src/services/context";
import { agents as coreAgents } from "@opentradesos/core";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE PHONE ASSISTANT, ON A CALL, AGAINST A FAKE CARRIER AND A FAKE MODEL
 *
 * A caller rings the company's number, presses 1 in the menu for the
 * assistant, and the carrier opens a WebSocket to the voice relay: here a
 * real WebSocket client playing the carrier's part (ConversationRelay),
 * signing its handshake as Twilio does, sending the caller's words as text
 * and reading back what the assistant says. The model is scripted. What is
 * tested is everything around both: who may connect, what the caller hears
 * first, the booking it takes through online booking's own service, the
 * person it puts them through to, what is written down, and the bounds it
 * runs under (its person's permissions, the spend ceiling).
 *
 * No test here reaches Twilio or a model vendor.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("voiceagent:org");
const OWNER = fixtureId("voiceagent:owner");
const SAM = fixtureId("voiceagent:sam");
const ZONE = "America/Chicago";
const SLUG = "voice-agent-co";
const AUTH = "a-twilio-auth-token-for-the-assistant";
const TOKEN = "v".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125557000";
const SAM_PHONE = "+15125557102";
const CALLER = "+15125557177";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

/* ------------------------------------------------------------- the model */

type Script = (request: CompletionRequest) => AiContent[];
const requests: CompletionRequest[] = [];
let script: Script = () => [{ type: "text", text: "nothing scripted" }];
const provider: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(request): Promise<CompletionOutcome> {
    requests.push(request);
    const content = script(request);
    return {
      ok: true,
      completion: {
        model: request.model, content, stop: content.some((c) => c.type === "toolCall") ? "toolUse" : "end",
        usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: null },
      },
    };
  },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};
const tool = (name: string, input: Record<string, unknown>): AiContent[] => [{ type: "toolCall", callId: `call_${name}`, name, input }];
const promptOf = (request: CompletionRequest): string =>
  request.messages.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("\n");
/** The last open window the assistant was shown, the furthest from now and so the safest to book. */
function lastWindow(request: CompletionRequest) {
  const all = [...promptOf(request).matchAll(/"bookableServiceId": "([^"]+)",\s*"date": "([^"]+)",\s*"arrivalWindowId": "([^"]+)"/g)];
  const match = all.at(-1);
  if (!match) throw new Error("The prompt had no open window in it.");
  return { bookableServiceId: match[1]!, date: match[2]!, arrivalWindowId: match[3]! };
}

const NOW = () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE);
const aiDeps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider, now: NOW });

/* ------------------------------------------------------------ the carrier */

const carrierCalls: { method: string; url: string; body: string }[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  carrierCalls.push({ method: init?.method ?? "GET", url: to, body: init?.body ? String(init.body) : "" });
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const twilio = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
let relay: RelayServer;
let relayBase = "";
const voiceDeps = (): voice.VoiceDeps => ({ readSecret: async () => AUTH, provider: twilio, publicBase: BASE, relayBase });

/**
 * Each call a little later than the one before: two calls from one number in
 * the same second are one call to the call log, which is right for a carrier
 * that sends one call twice and wrong for a test that makes eight.
 */
let clock = Date.now();
const later = () => new Date((clock += 60_000));

async function webhook(step: voice.Step, form: Record<string, string>, query = "", signedWith = AUTH, now = new Date(clock)) {
  const connection = await voice.resolveWebhook(db(), TOKEN, voiceDeps());
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(signedWith, to, form) },
  }, voiceDeps(), now);
}

const queryOf = (twiml: string, attribute: "action" | "url", verb: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${attribute}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${attribute} in ${twiml}`);
  const value = match[1]!.replace(/&amp;/g, "&");
  return value;
};

/** The carrier's side of ConversationRelay: a signed WebSocket, the setup message, and words. */
interface FakeRelay {
  heard: { type: string; token?: string; handoffData?: string }[];
  say(text: string): Promise<void>;
  press(digit: string): void;
  closed: Promise<number>;
  close(): void;
}

async function carrierConnects(address: string, callSid: string, signedWith = AUTH): Promise<FakeRelay> {
  const ws = new WebSocket(address, { headers: { "x-twilio-signature": twilioSignature(signedWith, address, {}) } });
  const heard: FakeRelay["heard"] = [];
  let waiting: (() => void) | null = null;
  ws.on("message", (data) => {
    heard.push(JSON.parse(String(data)) as FakeRelay["heard"][number]);
    waiting?.();
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "setup", sessionId: "VX1", callSid, from: CALLER, to: MAIN, direction: "inbound", customParameters: {} }));
  return {
    heard, closed,
    async say(text: string) {
      const before = heard.length;
      const answered = new Promise<void>((resolve) => { waiting = () => { if (heard.length > before) resolve(); }; });
      ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true }));
      await answered;
      /** A moment for anything sent straight after, such as the answer following "one moment". */
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    press(digit: string) { ws.send(JSON.stringify({ type: "dtmf", digit })); },
    close() { ws.close(); },
  };
}

/** A call through the menu to the assistant, up to the carrier being told to open the relay. */
async function callToAssistant(): Promise<{ sid: string; relayAddress: string; twiml: string }> {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await webhook("incoming", { CallSid: sid, From: CALLER, To: MAIN }, "", AUTH, later());
  const gather = queryOf(answered.twiml!, "action", "Gather");
  const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, gather.slice(gather.indexOf("?")));
  const address = /<ConversationRelay url="([^"]+)"/.exec(pressed.twiml!)?.[1]?.replace(/&amp;/g, "&");
  return { sid, relayAddress: address ?? "", twiml: pressed.twiml! };
}

let groupId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Voice Agent Plumbing", slug: SLUG });
  await raw`update public."user" set name = 'Dana Owner' where id = ${OWNER}`;
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public."user" where id = ${SAM}`;
  await raw`insert into public."user" (id, email, name) values (${SAM}, 'voiceagent-sam@test.local', 'Sam Office')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${SAM}, 'csr')`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id)
            values (${ORG}, ${MAIN}, 'main', 'PNmain')`;
  const [jt] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Water heater repair') returning id`;
  await raw`
    insert into public.bookable_service (organization_id, job_type_id, public_name, display_price,
      min_notice_hours, max_advance_days, max_per_window)
    values (${ORG}, ${jt!.id}, 'Water heater repair', 149.0000, 0, 30, 5)`;
  await raw`
    insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Afternoon', '13:00', '17:00', ${[0, 1, 2, 3, 4, 5, 6]})`;
  await raw`insert into public.customer (organization_id, name, phone) values (${ORG}, 'Robin Caller', ${CALLER})`;
  for (let d = 0; d < 7; d += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${d}, '07:00', '18:00')`;
  }

  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  await phoneMenus.setAnsweringPhone(owner(), { userId: SAM, e164: SAM_PHONE });
  groupId = (await phoneMenus.saveRingGroup(owner(), {
    name: "Office", strategy: "all_at_once", members: [{ userId: SAM }], noAnswerTo: { kind: "voicemail", box: "main" },
  })).id;

  relay = await startVoiceRelay({
    db: db(), publicBase: "ws://127.0.0.1:0", port: 0, host: "127.0.0.1",
    voiceDeps: { readSecret: async () => AUTH, provider: twilio }, aiDeps: aiDeps(), log: () => {},
  });
  await relay.close();
  /**
   * Started again on the port it was given, now that the address the carrier
   * signs over is known: the signature covers the host and port.
   */
  relayBase = `ws://127.0.0.1:${relay.port}`;
  relay = await startVoiceRelay({
    db: db(), publicBase: relayBase, port: relay.port, host: "127.0.0.1",
    voiceDeps: { readSecret: async () => AUTH, provider: twilio }, aiDeps: aiDeps(), log: () => {},
  });
});

afterAll(async () => {
  if (!raw) return;
  await relay?.close();
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw.end();
});

run("sending callers to the assistant", () => {
  it("refuses a menu option to the assistant while it is switched off", async () => {
    await expect(phoneMenus.saveMenu(owner(), {
      name: "Main", greeting: "Thanks for calling.",
      options: [{ key: "1", label: "Our assistant", to: { kind: "agent" } }],
      noInputTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow(/phone assistant, which is switched off/);
  });

  it("refuses a person to act as who could not answer the phone, then takes one who can", async () => {
    const narrow = { ...coreAgents.defaultSettings("voice"), enabled: true, runAsUserId: SAM };
    await raw`update public.membership set revocations = ${raw.json(["message:send"] as never)} where user_id = ${SAM} and organization_id = ${ORG}`;
    await expect(agents.configure(owner(), { agent: "voice", settings: narrow })).rejects.toThrow(/cannot read what this agent reads/);
    await raw`update public.membership set revocations = '[]'::jsonb where user_id = ${SAM} and organization_id = ${ORG}`;

    await agents.configure(owner(), {
      agent: "voice",
      settings: {
        ...coreAgents.defaultSettings("voice"), enabled: true, runAsUserId: OWNER,
        chat: { ...coreAgents.defaultSettings("voice").chat, greeting: "How can we help today?" },
        voice: { transferRingGroupId: groupId },
      },
    });
    const menu = await phoneMenus.saveMenu(owner(), {
      name: "Main", greeting: "Thanks for calling Voice Agent Plumbing.",
      options: [
        { key: "1", label: "Our assistant", to: { kind: "agent" } },
        { key: "2", label: "The office", to: { kind: "ring_group", id: groupId } },
      ],
      noInputTo: { kind: "voicemail", box: "main" },
    });
    expect(menu.prompt).toContain("For Our assistant, press 1.");
    await raw`update public.phone_number set menu_id = ${menu.id} where organization_id = ${ORG} and e164 = ${MAIN}`;
  });

  it("refuses a carrier request that is not signed with the account's token", async () => {
    const forged = await webhook("incoming", { CallSid: "CAforged", From: CALLER, To: MAIN }, "", "not-the-token");
    expect(forged.status).toBe(403);
  });

  it("hands the call to the relay with the disclosure said first and not to be talked over", async () => {
    const { twiml, relayAddress } = await callToAssistant();
    expect(twiml).toContain(`<Connect action="${BASE}/api/webhooks/voice/${TOKEN}/agent-done`);
    expect(relayAddress.startsWith(`${relayBase}/voice-relay/${TOKEN}?s=`)).toBe(true);
    expect(twiml).toContain('welcomeGreetingInterruptible="none"');
    const greeting = /welcomeGreeting="([^"]+)"/.exec(twiml)![1]!.replace(/&apos;/g, "'");
    expect(greeting).toMatch(/^Thanks for calling Voice Agent Plumbing\. You are speaking with an automated assistant, not a person, and this call is written down/);
    expect(greeting).toMatch(/How can we help today\?$/);
  });
});

run("the relay's handshake", () => {
  it("refuses a WebSocket not signed by the carrier", async () => {
    const { sid, relayAddress } = await callToAssistant();
    await expect(carrierConnects(relayAddress, sid, "not-the-token")).rejects.toThrow(/403/);
  });

  it("refuses a WebSocket to an address with no call behind it", async () => {
    const address = `${relayBase}/voice-relay/${TOKEN}?s=${"x".repeat(43)}`;
    const fake = await carrierConnects(address, "CAnobody");
    expect(await fake.closed).toBe(1008);
  });

  it("closes a conversation whose setup names a different call than the one it was made for", async () => {
    const { relayAddress } = await callToAssistant();
    const fake = await carrierConnects(relayAddress, "CAsomebodyelse");
    expect(await fake.closed).toBe(1008);
  });
});

run("a call the assistant answers", () => {
  let sid = "";
  let fake: FakeRelay;

  it("answers from the company's facts as its person, with the caller found by their number", async () => {
    const call = await callToAssistant();
    sid = call.sid;
    fake = await carrierConnects(call.relayAddress, sid);
    script = () => tool("reply", { text: "A water heater visit is $149. Would you like to book one?" });
    await fake.say("How much is it to look at a water heater?");
    expect(fake.heard.at(-1)).toEqual({ type: "text", token: "A water heater visit is $149. Would you like to book one?", last: true });
    const prompt = promptOf(requests.at(-1)!);
    expect(prompt).toContain(`calling from ${CALLER}`);
    expect(prompt).toContain("Robin Caller");
    expect(requests.at(-1)!.tools?.map((t) => t.name)).toEqual(
      ["reply", "look_up_customer", "create_booking_request", "take_message", "transfer", "end_call"],
    );
  });

  it("takes a booking request in a real window, through online booking's own service", async () => {
    script = (request) => tool("create_booking_request", {
      ...lastWindow(request), contactName: "Robin Caller",
      address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" },
      notes: "Water heater leaking.", text: "Thank you, Robin. The office will confirm that time with you.",
    });
    await fake.say("Yes please, the afternoon, at 12 Elm St Austin 78701. My card is 4111 1111 1111 1111.");
    expect(fake.heard.at(-1)!.token).toBe("Thank you, Robin. The office will confirm that time with you.");
    const [request] = await raw<{ status: string; contact_phone: string }[]>`
      select status, contact_phone from public.booking_request where organization_id = ${ORG} and contact_name = 'Robin Caller'`;
    expect(request).toEqual({ status: "pending", contact_phone: CALLER });
    /** The card number the caller read out never reached the model. */
    expect(promptOf(requests.at(-1)!)).not.toContain("4111 1111 1111 1111");
  });

  it("puts the caller through when they ask for a person, without asking the model", async () => {
    const before = requests.length;
    await fake.say("Can I speak to a real person please?");
    expect(requests.length).toBe(before);
    expect(fake.heard.at(-1)!.type).toBe("end");
    /** The carrier closes the conversation once it is told to end. */
    fake.close();

    const next = await webhook("agent-done", { CallSid: sid, SessionStatus: "ended" }, "");
    expect(next.twiml).toContain("<Say>Of course. Putting you through to someone now. Please hold.</Say>");
    expect(next.twiml).toContain(`<Number>${SAM_PHONE}</Number>`);
  });

  it("writes down what was said and what it did, with the card number gone", async () => {
    const [call] = await raw<{ id: string; routed_because: string; transcript_source: string; transcript_text: string; transcript_redaction_counts: Record<string, number> }[]>`
      select id, routed_because, transcript_source, transcript_text, transcript_redaction_counts
      from public.call where organization_id = ${ORG} and provider_call_id = ${`twilio:${sid}`}`;
    expect(call!.routed_because).toContain("The phone assistant answered.");
    expect(call!.routed_because).toContain("put the caller through: The caller asked for a person.");
    expect(call!.transcript_source).toBe("assistant");
    expect(call!.transcript_text).toContain("water heater");
    expect(call!.transcript_text).not.toContain("4111");
    expect(call!.transcript_redaction_counts).toMatchObject({ card_number: 1 });

    const view = await voiceAgent.forCall(owner(), call!.id);
    expect(view!.status).toBe("transferred");
    expect(view!.turns[0]!.text).toMatch(/automated assistant/);
    expect(view!.actions.map((a) => a.action)).toEqual(["booking_request", "transfer"]);
    expect(view!.redactions).toEqual({ card_number: 1 });

    const [logged] = await raw<{ kind: string; detail: string }[]>`
      select kind, detail from public.ai_agent_activity
      where organization_id = ${ORG} and agent = 'voice' and detail like 'Answered a call%' order by created_at desc limit 1`;
    expect(logged!.kind).toBe("handed_off");
    expect(logged!.detail).toContain("Took a booking request from Robin Caller");
  });
});

run("the bounds it runs under", () => {
  it("refuses to say a price the company never published, and puts the caller through", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.relayAddress, call.sid);
    script = () => tool("reply", { text: "That will be $400." });
    await fake.say("What does a new water heater cost?");
    expect(fake.heard.at(-1)!.type).toBe("end");
    expect(fake.heard.some((m) => m.token?.includes("$400"))).toBe(false);
    fake.close();
    const [refused] = await raw<{ detail: string }[]>`
      select detail from public.ai_agent_activity where organization_id = ${ORG} and agent = 'voice' and kind = 'refused'
      order by created_at desc limit 1`;
    expect(refused!.detail).toContain("$400.00");
  });

  it("takes a message for the office", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.relayAddress, call.sid);
    script = () => tool("take_message", { callerName: "Robin", message: "Please call me about my invoice.", text: "I have passed that on." });
    await fake.say("Please pass a message to the office about my bill.");
    expect(fake.heard.at(-1)!.token).toBe("I have passed that on.");
    const [task] = await raw<{ title: string; body: string; entity_type: string }[]>`
      select title, body, entity_type from public.task where organization_id = ${ORG} and title = 'Phone message from Robin'`;
    expect(task!.body).toContain(`Call back on ${CALLER}`);
    expect(task!.entity_type).toBe("customer");
    script = () => tool("end_call", { text: "Thanks for calling. Goodbye." });
    await fake.say("That's all, thanks, bye.");
    expect(fake.heard.at(-1)!.type).toBe("end");
    fake.close();
    const done = await webhook("agent-done", { CallSid: call.sid }, "");
    expect(done.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks for calling. Goodbye.</Say><Hangup/></Response>');
  });

  it("puts the caller through when its person can no longer do what it needs", async () => {
    await agents.configure(owner(), {
      agent: "voice",
      settings: { ...coreAgents.defaultSettings("voice"), enabled: true, runAsUserId: SAM, voice: { transferRingGroupId: groupId } },
    });
    const call = await callToAssistant();
    const fake = await carrierConnects(call.relayAddress, call.sid);
    await raw`update public.membership set revocations = ${raw.json(["message:send"] as never)} where user_id = ${SAM} and organization_id = ${ORG}`;
    try {
      const before = requests.length;
      await fake.say("Hello?");
      expect(requests.length).toBe(before);
      expect(fake.heard.at(-1)!.type).toBe("end");
    } finally {
      await raw`update public.membership set revocations = '[]'::jsonb where user_id = ${SAM} and organization_id = ${ORG}`;
      fake.close();
    }
  });

  it("stops at the company's spend ceiling and puts the caller through", async () => {
    await ai.setSpendLimit(owner(), { monthlyLimitMicros: 1 });
    try {
      const call = await callToAssistant();
      const fake = await carrierConnects(call.relayAddress, call.sid);
      const before = requests.length;
      await fake.say("Do you work on Saturdays?");
      expect(requests.length).toBe(before);
      expect(fake.heard.at(-1)!.type).toBe("end");
      fake.close();
      const done = await webhook("agent-done", { CallSid: call.sid }, "");
      expect(done.twiml).toContain("put you through to someone");
    } finally {
      await ai.setSpendLimit(owner(), { monthlyLimitMicros: null });
    }
  });

  it("puts the caller through when the relay never answers", async () => {
    const call = await callToAssistant();
    const next = await webhook("agent-done", { CallSid: call.sid, SessionStatus: "failed" }, "");
    expect(next.twiml).toContain("Sorry, our assistant is not available right now.");
    expect(next.twiml).toContain(`<Number>${SAM_PHONE}</Number>`);
    const [row] = await raw<{ routed_because: string }[]>`
      select routed_because from public.call where provider_call_id = ${`twilio:${call.sid}`}`;
    expect(row!.routed_because).toContain("could not be reached");
  });

  it("puts nobody through when the caller hung up mid conversation", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.relayAddress, call.sid);
    script = () => tool("reply", { text: "Sure, what is the address?" });
    await fake.say("I need a plumber.");
    fake.close();
    const next = await webhook("agent-done", { CallSid: call.sid, CallStatus: "completed" }, "");
    expect(next.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const [row] = await raw<{ id: string; routed_because: string }[]>`
      select id, routed_because from public.call where provider_call_id = ${`twilio:${call.sid}`}`;
    expect(row!.routed_because).not.toContain("put through");
    const view = await voiceAgent.forCall(owner(), row!.id);
    expect(view!.status).toBe("dropped");
    expect(view!.turns.map((t) => t.from)).toEqual(["assistant", "caller", "assistant"]);
  });

  it("sends calls where it puts callers through when it is switched off, and says why", async () => {
    await agents.configure(owner(), {
      agent: "voice", settings: { ...coreAgents.defaultSettings("voice"), enabled: false, runAsUserId: OWNER, voice: { transferRingGroupId: groupId } },
    });
    const call = await callToAssistant();
    expect(call.twiml).toContain(`<Number>${SAM_PHONE}</Number>`);
    expect(call.twiml).not.toContain("ConversationRelay");
  });
});
