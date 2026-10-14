import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { time, agents as coreAgents, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as voice from "../src/services/voice";
import * as phoneMenus from "../src/services/phone-menus";
import * as callQueues from "../src/services/call-queues";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { startVoiceRelay, type RelayServer } from "../src/voice/relay-server";
import "../src/ai/index";
import type {
  AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate, StreamListener,
} from "../src/ai/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE PHONE ASSISTANT SPEAKS AS IT THINKS, AND SENDS A CALLER ON
 *
 * The model here streams: it writes a reply a few characters at a time, and
 * stops after its first sentence until the carrier's side of the call has
 * heard that sentence, which is the whole point (a caller hears the start of
 * the answer while the rest is still being written). The rest follows, and
 * the answer closes with `last`. A sentence naming a price nobody published
 * is never said, and the caller is put through. And the assistant sends a
 * caller to a waiting line the company allowed it, but not to one it did not.
 *
 * No test here reaches Twilio or a model vendor.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("voicestream:org");
const OWNER = fixtureId("voicestream:owner");
const SAM = fixtureId("voicestream:sam");
const ZONE = "America/Chicago";
const AUTH = "a-twilio-auth-token-for-streaming";
const TOKEN = "w".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125557500";
const SAM_PHONE = "+15125557502";
const CALLER = "+15125557577";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

/* ---------------------------------------------------- a model that streams */

/** What the model writes next: a tool, and its arguments in pieces, with a wait after any piece that names one. */
let script: { tool: string; pieces: string[]; waitAfter?: number } = { tool: "reply", pieces: ['{"text":"Hello."}'] };
let release: (() => void) | null = null;
const streams: number[] = [];
const provider: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(): Promise<CompletionOutcome> {
    throw new Error("The phone assistant should have asked for a stream.");
  },
  async stream(_request: CompletionRequest, listen: StreamListener): Promise<CompletionOutcome> {
    streams.push(Date.now());
    const { tool, pieces, waitAfter } = script;
    listen({ type: "toolStart", index: 0, name: tool });
    for (const [i, piece] of pieces.entries()) {
      listen({ type: "toolInput", index: 0, partialJson: piece });
      if (i === waitAfter) await new Promise<void>((resolve) => { release = resolve; });
    }
    return {
      ok: true,
      completion: {
        model: "fake-model", stop: "toolUse",
        content: [{ type: "toolCall", callId: "call_1", name: tool, input: JSON.parse(pieces.join("")) as Record<string, unknown> }],
        usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: null },
      },
    };
  },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};

const NOW = () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE);
const aiDeps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider, now: NOW });

/* ------------------------------------------------------------ the carrier */

const transport = async (): Promise<Response> => Response.json({ message: "unexpected" }, { status: 400 });
const twilio = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
let relay: RelayServer;
let relayBase = "";
const voiceDeps = (): voice.VoiceDeps => ({ readSecret: async () => AUTH, provider: twilio, publicBase: BASE, relayBase });

let clock = Date.now();
const later = () => new Date((clock += 60_000));

async function webhook(step: voice.Step, form: Record<string, string>, query = "", now = new Date(clock)) {
  const connection = await voice.resolveWebhook(db(), TOKEN, voiceDeps());
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  }, voiceDeps(), now);
}

type Heard = { type: string; token?: string; last?: boolean };

/** The carrier's side of ConversationRelay, signed, saying words and keeping everything it is sent. */
async function carrierConnects(address: string, callSid: string) {
  const ws = new WebSocket(address, { headers: { "x-twilio-signature": twilioSignature(AUTH, address, {}) } });
  const heard: Heard[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data) => {
    heard.push(JSON.parse(String(data)) as Heard);
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "setup", sessionId: "VX1", callSid, from: CALLER, to: MAIN, direction: "inbound", customParameters: {} }));
  const until = async (done: () => boolean) => {
    while (!done()) await new Promise<void>((resolve) => { waiters.push(resolve); });
  };
  return {
    heard, until,
    say(text: string) { ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true })); },
    close() { ws.close(); },
  };
}

async function callToAssistant() {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await webhook("incoming", { CallSid: sid, From: CALLER, To: MAIN }, "", later());
  const gather = /<Gather action="([^"]+)"/.exec(answered.twiml!)![1]!.replace(/&amp;/g, "&");
  const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, gather.slice(gather.indexOf("?")));
  const address = /<ConversationRelay url="([^"]+)"/.exec(pressed.twiml!)![1]!.replace(/&amp;/g, "&");
  return { sid, address };
}

let groupId = "";
let billingLine = "";
let otherLine = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Streaming Plumbing", slug: "voice-streaming-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public."user" where id = ${SAM}`;
  await raw`insert into public."user" (id, email, name) values (${SAM}, 'voicestream-sam@test.local', 'Sam Office')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${SAM}, 'csr')`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id) values (${ORG}, ${MAIN}, 'main', 'PNmain')`;
  const [jt] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name) values (${ORG}, 'Water heater repair') returning id`;
  await raw`insert into public.bookable_service (organization_id, job_type_id, public_name, display_price, min_notice_hours, max_advance_days, max_per_window)
            values (${ORG}, ${jt!.id}, 'Water heater repair', 149.0000, 0, 30, 5)`;

  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  await phoneMenus.setAnsweringPhone(owner(), { userId: SAM, e164: SAM_PHONE });
  groupId = (await phoneMenus.saveRingGroup(owner(), {
    name: "Office", strategy: "all_at_once", members: [{ userId: SAM }], noAnswerTo: { kind: "voicemail", box: "main" },
  })).id;
  billingLine = (await callQueues.saveQueue(owner(), { name: "Billing line", ringGroupId: groupId, overflowTo: { kind: "voicemail", box: "main" } })).id;
  otherLine = (await callQueues.saveQueue(owner(), { name: "Sales line", ringGroupId: groupId, overflowTo: { kind: "voicemail", box: "main" } })).id;

  const base = coreAgents.defaultSettings("voice");
  await agents.configure(owner(), {
    agent: "voice",
    settings: {
      ...base, enabled: true, runAsUserId: OWNER,
      voice: { transferRingGroupId: groupId, places: [{ kind: "queue", id: billingLine, label: "Billing questions" }] },
    },
  });
  const menu = await phoneMenus.saveMenu(owner(), {
    name: "Main", greeting: "Thanks for calling.",
    options: [{ key: "1", label: "Our assistant", to: { kind: "agent" } }],
    noInputTo: { kind: "voicemail", box: "main" },
  });
  await raw`update public.phone_number set menu_id = ${menu.id} where organization_id = ${ORG}`;

  relay = await startVoiceRelay({
    db: db(), publicBase: "ws://127.0.0.1:0", port: 0, host: "127.0.0.1",
    voiceDeps: { readSecret: async () => AUTH, provider: twilio }, aiDeps: aiDeps(), log: () => {},
  });
  await relay.close();
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

run("speaking as it thinks", () => {
  it("says the first sentence while the rest of the answer is still being written, then closes it", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.address, call.sid);
    script = {
      tool: "reply",
      pieces: ['{"te', 'xt": "A water heater', " visit is $149. ", "We can come Tuesday", ' afternoon. Shall I book it?"}'],
      waitAfter: 2,
    };
    fake.say("How much to look at my water heater?");
    /** The model is still writing, held after its first sentence, and the caller has already heard it. */
    await fake.until(() => fake.heard.some((m) => m.type === "text"));
    expect(fake.heard).toEqual([{ type: "text", token: "A water heater visit is $149.", last: false }]);
    release!();
    await fake.until(() => fake.heard.some((m) => m.last === true));
    expect(fake.heard).toEqual([
      { type: "text", token: "A water heater visit is $149.", last: false },
      { type: "text", token: "We can come Tuesday afternoon.", last: false },
      { type: "text", token: "Shall I book it?", last: true },
    ]);
    fake.close();
    const [session] = await raw<{ turns: { from: string; text: string }[] }[]>`
      select s.turns from public.voice_agent_session s join public.call c on c.id = s.call_id where c.provider_call_id = ${`twilio:${call.sid}`}`;
    expect(session!.turns.at(-1)).toMatchObject({
      from: "assistant", text: "A water heater visit is $149. We can come Tuesday afternoon. Shall I book it?",
    });
  });

  it("never says a sentence with a price nobody published, nor anything after it, and puts the caller through", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.address, call.sid);
    script = { tool: "reply", pieces: ['{"text":"We can help with that. ', "A new one is $1,400. ", 'It takes a day."}'] };
    fake.say("What does a new water heater cost?");
    await fake.until(() => fake.heard.some((m) => m.type === "end"));
    const said = fake.heard.filter((m) => m.type === "text").map((m) => m.token);
    expect(said).toEqual(["We can help with that."]);
    fake.close();
    const next = await webhook("agent-done", { CallSid: call.sid });
    expect(next.twiml).toContain(`<Number>${SAM_PHONE}</Number>`);
    const [refused] = await raw<{ detail: string }[]>`
      select detail from public.ai_agent_activity where organization_id = ${ORG} and agent = 'voice' and kind = 'refused'
      order by created_at desc limit 1`;
    expect(refused!.detail).toContain("$1,400.00");
  });
});

run("sending a caller on", () => {
  it("sends a caller to the waiting line the company allowed it, for what it is for", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.address, call.sid);
    script = { tool: "transfer", pieces: [JSON.stringify({ reason: "A question about a bill.", place: billingLine })] };
    fake.say("I have a question about my bill.");
    await fake.until(() => fake.heard.some((m) => m.type === "end"));
    fake.close();
    const next = await webhook("agent-done", { CallSid: call.sid });
    expect(next.twiml).toContain("Let me send you to the right place.");
    expect(next.twiml).toContain(`>ots-${billingLine}</Enqueue>`);
    const [row] = await raw<{ routed_because: string }[]>`select routed_because from public.call where provider_call_id = ${`twilio:${call.sid}`}`;
    expect(row!.routed_because).toContain("The phone assistant sent the caller to the Billing line waiting line: A question about a bill.");
  });

  it("puts the caller through to a person when it names a line it was not given", async () => {
    const call = await callToAssistant();
    const fake = await carrierConnects(call.address, call.sid);
    script = { tool: "transfer", pieces: [JSON.stringify({ reason: "Sales.", place: otherLine })] };
    fake.say("I want to buy something.");
    await fake.until(() => fake.heard.some((m) => m.type === "end"));
    fake.close();
    const next = await webhook("agent-done", { CallSid: call.sid });
    expect(next.twiml).toContain(`<Number>${SAM_PHONE}</Number>`);
    expect(next.twiml).not.toContain(otherLine);
  });

  it("will not delete a line the assistant may send callers to, nor take one that does not exist", async () => {
    await expect(callQueues.deleteQueue(owner(), billingLine)).rejects.toThrow(/the phone assistant/);
    const base = coreAgents.defaultSettings("voice");
    await expect(agents.configure(owner(), {
      agent: "voice",
      settings: {
        ...base, enabled: true, runAsUserId: OWNER,
        voice: { transferRingGroupId: groupId, places: [{ kind: "menu", id: fixtureId("voicestream:nomenu"), label: "Gone" }] },
      },
    })).rejects.toThrow(/no longer exists/);
  });
});
