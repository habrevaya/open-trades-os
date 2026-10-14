import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as chat from "../src/services/agent-chat";
import * as agentField from "../src/services/agent-field";
import * as knowledge from "../src/services/knowledge";
import "../src/ai/index";
import type {
  AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate, StreamListener,
} from "../src/ai/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE WEBSITE CHAT AND THE FIELD ASSISTANT ANSWER AS THEY WRITE
 *
 * The model here streams its answer a few characters at a time and can be
 * held after any piece, so the test can look at what the visitor or the
 * technician is shown while the rest is still being written: whole sentences,
 * and never one naming an amount nobody published. The whole answer is then
 * checked as it always was, and only it is kept: a reply that fails its
 * check is never a message, and a field answer that fails is not shown.
 *
 * No test here reaches a vendor.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("agentwriting:org");
const OWNER = fixtureId("agentwriting:owner");
const ZONE = "America/Chicago";
const SLUG = "agent-writing-co";
/**
 * An address of this file's own: the public chat's limits are per address,
 * and every file that leaves it unset shares "unknown".
 */
const HERE = { ip: "203.0.113.177" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

/* ---------------------------------------------------- a model that streams */

/** What the model writes next: a tool and its arguments in pieces, held after the piece `holdAfter` until released. */
let script: { tool: string; pieces: string[]; holdAfter?: number } = { tool: "reply", pieces: ['{"text":"Hello."}'] };
let release: (() => void) | null = null;
let streamed = 0;
const provider: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(): Promise<CompletionOutcome> {
    throw new Error("A website chat and the field assistant should ask for a stream.");
  },
  async stream(_request: CompletionRequest, listen: StreamListener): Promise<CompletionOutcome> {
    streamed += 1;
    const { tool, pieces, holdAfter } = script;
    listen({ type: "toolStart", index: 0, name: tool });
    for (const [i, piece] of pieces.entries()) {
      listen({ type: "toolInput", index: 0, partialJson: piece });
      if (i === holdAfter) await new Promise<void>((resolve) => { release = resolve; });
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
const deps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider, now: NOW });

/** JSON text cut into pieces of a few characters, as a vendor streams it. */
const pieces = (value: Record<string, unknown>, size = 7): string[] => {
  const text = JSON.stringify(value);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
};
/** The piece after which `sentence` has been written in full, with the space after it. */
const pieceAfter = (all: string[], sentence: string): number => {
  let written = "";
  for (const [i, piece] of all.entries()) {
    written += piece;
    if (written.includes(`${sentence} `)) return i;
  }
  throw new Error(`"${sentence}" is never followed by a space`);
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("It never happened.");
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Writing Plumbing", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [jt] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name) values (${ORG}, 'Water heater repair') returning id`;
  await raw`insert into public.bookable_service (organization_id, job_type_id, public_name, display_price, min_notice_hours, max_advance_days, max_per_window)
            values (${ORG}, ${jt!.id}, 'Water heater repair', 149.0000, 0, 30, 5)`;
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  for (const agent of ["chat", "field"] as const) {
    await agents.configure(owner(), { agent, settings: { ...coreAgents.defaultSettings(agent), enabled: true, runAsUserId: OWNER } });
  }
  await knowledge.create(owner(), {
    title: "Flushing a water heater", body: "Shut off the gas. Drain the tank for ten minutes. A flush is $95 on the price list.", tags: ["heater"],
  });
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw.end();
});

run("the website chat, as it writes", () => {
  it("shows the visitor each finished sentence while the rest is written, then the whole reply in its place", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG }, HERE);
    const all = pieces({ text: "A water heater repair visit is $149. We can come tomorrow morning. Shall I book it?" });
    script = { tool: "reply", pieces: all, holdAfter: pieceAfter(all, "We can come tomorrow morning.") };
    const asked = streamed;
    release = null;
    const answering = chat.say(db(), { companyKey: SLUG, token: opened.token, text: "how much for a water heater?" }, HERE, deps());

    const midway = await until(() => chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE), (t) => t.writing?.includes("tomorrow") ?? false);
    expect(midway.writing).toBe("A water heater repair visit is $149. We can come tomorrow morning.");
    expect(midway.messages.some((m) => m.text.includes("tomorrow"))).toBe(false);
    release!();

    const after = await answering;
    expect(streamed).toBe(asked + 1);
    expect(after.writing).toBeNull();
    expect(after.messages.at(-1)).toMatchObject({
      from: "assistant", text: "A water heater repair visit is $149. We can come tomorrow morning. Shall I book it?",
    });
    expect((await chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE)).writing).toBeNull();
  });

  it("never shows a sentence with a price nobody published, and hands the chat to a person when the reply is whole", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG }, HERE);
    const all = pieces({ text: "Sure, we fit new heaters. A new one installed is about $1,800. It takes a day. " });
    script = { tool: "reply", pieces: all, holdAfter: all.length - 1 };
    release = null;
    const answering = chat.say(db(), { companyKey: SLUG, token: opened.token, text: "price for a new heater installed?" }, HERE, deps());

    const midway = await until(() => chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE), () => release !== null);
    await until(async () => (await chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE)).writing, (w) => w !== null);
    const shown = await chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE);
    expect(shown.writing).toBe("Sure, we fit new heaters.");
    expect(midway.writing ?? "").not.toContain("1,800");
    release!();

    const after = await answering;
    expect(after.status).toBe("handed_off");
    expect(after.writing).toBeNull();
    expect(after.messages.some((m) => m.text.includes("1,800"))).toBe(false);
    const kept = await raw`select 1 from public.message m join public.ai_chat_session s on s.conversation_id = m.conversation_id
                          where s.organization_id = ${ORG} and m.body like ${"%1,800%"}`;
    expect(kept).toHaveLength(0);
  });

  it("shows nothing of a hand over while it is written: it is said once it is done", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG }, HERE);
    script = { tool: "hand_off", pieces: pieces({ reason: "They want a quote.", text: "Someone will call you. Thanks for waiting." }), holdAfter: 3 };
    release = null;
    const answering = chat.say(db(), { companyKey: SLUG, token: opened.token, text: "can you quote a boiler?" }, HERE, deps());
    await until(async () => release, (r) => r !== null);
    expect((await chat.read(db(), { companyKey: SLUG, token: opened.token }, HERE)).writing).toBeNull();
    release!();
    const after = await answering;
    expect(after.status).toBe("handed_off");
  });
});

run("the field assistant, as it writes", () => {
  it("hands the technician each finished sentence, then the whole answer, last sentence and sources too", async () => {
    const all = pieces({ answer: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.", sources: ["howto-1"] });
    script = { tool: "answer", pieces: all };
    const shown: string[] = [];
    const answer = await agentField.ask(owner(), { question: "How do we flush a water heater?" }, deps(), (text) => shown.push(text));
    /** The last sentence is never followed by a space, so it arrives with the whole answer. */
    expect(shown).toEqual([
      "Shut off the gas first.",
      "Shut off the gas first. Then drain the tank for ten minutes.",
    ]);
    expect(answer).toMatchObject({
      answered: true, text: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.",
      sources: [{ kind: "procedure", title: "Flushing a water heater" }],
    });
  });

  it("stops showing at an amount not in the records, and the whole answer is refused, not kept", async () => {
    const all = pieces({ answer: "Shut off the gas first. The kit costs $40. Drain it for ten minutes. ", sources: ["howto-1"] });
    script = { tool: "answer", pieces: all };
    const shown: string[] = [];
    const answer = await agentField.ask(owner(), { question: "How do we flush a water heater?" }, deps(), (text) => shown.push(text));
    expect(shown).toEqual(["Shut off the gas first."]);
    expect(answer.answered).toBe(false);
    expect(answer.text).toMatch(/not in your records, so it was not shown/);
    const [kept] = await raw<{ draft: { text: string } }[]>`
      select draft from public.ai_agent_proposal where organization_id = ${ORG} and agent = 'field' order by created_at desc limit 1`;
    expect(kept!.draft.text).not.toContain("$40");
  });
});
