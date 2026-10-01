import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import "../src/ai/index";
import { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "../src/ai/anthropic";
import { openAiProvider } from "../src/ai/openai";
import { googleProvider } from "../src/ai/google";
import {
  createAiProvider, AiProviderNotConfiguredError,
  type AiProvider, type CompletionOutcome, type CompletionRequest,
  type HttpTransport, type ModelListOutcome, type ModelRate,
} from "../src/ai/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * BRING YOUR OWN MODEL
 *
 * `ai_model` was in the capability enum from the first migration with nothing
 * behind it, and `agent:configure` was a permission a company could grant or
 * withhold with no effect either way. This file is about the three properties
 * that make connecting a model key something an owner can actually turn on.
 *
 * NOTHING THIS MODULE RETURNS, RECORDS OR THROWS CONTAINS THE KEY. A model
 * key is bearer authority over an account with a spending limit, usable from
 * anywhere, with no second factor and no per-request signature. All three
 * vendors can echo a request back in an error, and an error message is the
 * most widely copied string in any system.
 *
 * A MODEL IS TOLD ABOUT NOTHING ITS OPERATOR COULD NOT DO. The tool list
 * offered to a model is the MCP catalogue filtered by the permissions of the
 * caller, and this service does not run the calls it gets back.
 *
 * THE CEILING REFUSES, AND REFUSES VISIBLY. A connected key and a loop that
 * does not terminate is a bill, and the first anybody normally hears of it is
 * the bill.
 *
 * NO TEST HERE REACHES A VENDOR AND NONE NEEDS A REAL KEY. The transport is
 * injected, the way the accounting adapter's is, because a test that monkey
 * patched `fetch` would pass against an adapter whose shape had drifted and
 * the shape is the whole contract.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ai27:org");
const USER = fixtureId("ai27:user");
const KEY_REF = "TEST_AI_KEY";
/** Never a real key, and deliberately distinctive so a sweep cannot miss it. */
const SECRET = "sk-test-THE-MODEL-KEY-0000";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
  ...extra,
});

/** An actor who may read the settings screen and may not spend the company's money. */
const technician = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] },
  db: db(),
  ...extra,
});

/**
 * Somebody allowed to run an agent and allowed to read jobs, and nothing
 * else. The narrow authority an agent is actually worth giving.
 */
const agentOperator = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: [] as Actor["roles"],
    grants: ["agent:configure", "job:read"],
  },
  db: db(),
  ...extra,
});

/* --------------------------------------------------------- the transport */

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function transportFor(
  script: ((call: Call) => { status: number; body: unknown })[],
  calls: Call[],
): HttpTransport {
  let index = 0;
  return async (target, init) => {
    calls.push({
      url: target, method: init.method, headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    const result = step!(calls[calls.length - 1]!);
    return {
      status: result.status,
      text: async () =>
        typeof result.body === "string" ? result.body : JSON.stringify(result.body),
    };
  };
}

const bodyOf = (call: Call): Record<string, unknown> =>
  JSON.parse(call.body ?? "{}") as Record<string, unknown>;

/* ------------------------------------------------------------ a fake vendor */

interface Recorder {
  requests: CompletionRequest[];
}

function fakeProvider(
  recorder: Recorder,
  over: Partial<AiProvider> = {},
): AiProvider {
  return {
    name: "anthropic",
    toolCallIdentity: { kind: "vendor" },
    defaultModel: "fake-model",
    rateFor: (): ModelRate | null =>
      ({ inputMicrosPerToken: 5, outputMicrosPerToken: 25, source: "adapter", asOf: "2026-09-25" }),
    async complete(request): Promise<CompletionOutcome> {
      recorder.requests.push(request);
      return {
        ok: true,
        completion: {
          model: request.model,
          content: [{ type: "text", text: "the answer" }],
          stop: "end",
          usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: null },
        },
      };
    },
    async models(): Promise<ModelListOutcome> {
      return { ok: true, models: [{ id: "fake-model", label: "Fake" }] };
    },
    ...over,
  };
}

const deps = (provider: AiProvider, now?: Date): ai.AiDeps => ({
  readSecret: async () => SECRET,
  provider,
  ...(now ? { now: () => now } : {}),
});

async function connect(provider = "anthropic", settings: Record<string, unknown> = {}) {
  return ai.connect(ctx(), {
    provider, credentialRef: KEY_REF, settings: { defaultModel: "fake-model", ...settings },
  });
}

const usageRows = () => raw<{
  provider: string; model: string; outcome: string; purpose: string;
  input_tokens: number; output_tokens: number;
  cached_input_tokens: number | null; estimated_cost_micros: string | null;
  detail: string | null;
}[]>`select * from public.ai_usage where organization_id = ${ORG} order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Model Co", slug: "model-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

/* =========================================================== the seam ==== */

describe("the provider seam", () => {
  it("has all three vendors registered by importing the barrel", async () => {
    /**
     * Loaded into a fresh module registry, and the freshness is the point.
     * This file imports each adapter directly to test it, so asserting on the
     * registry as it stands would pass even with the barrel importing none of
     * them: the check would be proving its own imports. A deployment that
     * imports `../src/ai` and nothing else is what the barrel promises.
     */
    vi.resetModules();
    const seam = await import("../src/ai/provider");
    expect(seam.registeredAiProviders()).toEqual([]);
    await import("../src/ai/index");
    expect(seam.registeredAiProviders().sort()).toEqual(["anthropic", "google", "openai"]);
    vi.resetModules();
  });

  it("refuses a vendor nobody wrote an adapter for", () => {
    /**
     * Fail closed. A connection naming a vendor with no adapter gets a named
     * error rather than a settings screen that says connected beside a
     * feature that fails on every call.
     */
    expect(() => createAiProvider("mistral", {}, SECRET)).toThrow(AiProviderNotConfiguredError);
  });

  it("makes every adapter answer how a tool call is identified", () => {
    /**
     * The field is required and discriminated for the same reason `delivery`
     * is required on the email seam: a new adapter cannot be written without
     * answering, and the honest `synthetic` carries a sentence an operator
     * can read rather than a boolean they would have to interpret.
     */
    expect(createAiProvider("anthropic", {}, SECRET).toolCallIdentity.kind).toBe("vendor");
    expect(createAiProvider("openai", {}, SECRET).toolCallIdentity.kind).toBe("vendor");

    const google = createAiProvider("google", {}, SECRET).toolCallIdentity;
    expect(google.kind).toBe("synthetic");
    if (google.kind === "synthetic") expect(google.because.length).toBeGreaterThan(40);
  });

  it("will not guess a model for a vendor whose names it does not hold", () => {
    /**
     * This repository holds a dated reference for one vendor's model names
     * and prices and none for the other two. A default written from memory is
     * either a name the vendor withdrew, which reads as a broken integration,
     * or a real model that is not the one the operator chose to be billed for.
     */
    expect(createAiProvider("anthropic", {}, SECRET).defaultModel).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(createAiProvider("openai", {}, SECRET).defaultModel).toBeNull();
    expect(createAiProvider("google", {}, SECRET).defaultModel).toBeNull();
  });
});

/* ====================================================== the Anthropic one = */

const anthropicOk = {
  status: 200,
  body: {
    id: "msg_1", model: "claude-opus-5-5", role: "assistant",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 7 },
  },
};

describe("the Anthropic adapter", () => {
  it("sends the key as a header and pins the API version", async () => {
    const calls: Call[] = [];
    const provider = anthropicProvider(
      { baseUrl: "https://claude.test" }, SECRET,
      transportFor([() => anthropicOk], calls),
    );
    await provider.complete({
      model: "claude-opus-5-5", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100,
    });

    expect(calls[0]!.url).toBe("https://claude.test/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe(SECRET);
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(bodyOf(calls[0]!)["max_tokens"]).toBe(100);
  });

  it("reads a tool call and the tokens it cost", async () => {
    const calls: Call[] = [];
    const provider = anthropicProvider({ baseUrl: "https://claude.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          model: "claude-opus-5-5",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "tool_use", id: "toolu_9", name: "otos_list_jobs", input: { limit: 5 } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900 },
        },
      }),
    ], calls));

    const outcome = await provider.complete({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "what is open" }] }],
      tools: [{ name: "otos_list_jobs", description: "List jobs", inputSchema: { type: "object" } }],
      maxOutputTokens: 1000,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.completion.stop).toBe("toolUse");
    expect(outcome.completion.usage).toEqual({
      inputTokens: 1200, outputTokens: 80, cachedInputTokens: 900,
    });
    expect(outcome.completion.content).toContainEqual({
      type: "toolCall", callId: "toolu_9", name: "otos_list_jobs", input: { limit: 5 },
    });
  });

  it("keeps the model's own reasoning blocks and hands them back next turn", async () => {
    /**
     * These have to be echoed back for a tool loop to continue: dropping them
     * loses the reasoning behind the tool call, and on the newest models an
     * assistant turn that arrives without them is an edited turn.
     */
    const calls: Call[] = [];
    const provider = anthropicProvider({ baseUrl: "https://claude.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          model: "claude-opus-5-5",
          content: [{ type: "thinking", thinking: "", signature: "abc" }, { type: "text", text: "yes" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      () => anthropicOk,
    ], calls));

    const first = await provider.complete({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 50,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.completion.content[0]).toEqual({
      type: "vendorState", vendor: "anthropic",
      block: { type: "thinking", thinking: "", signature: "abc" },
    });

    await provider.complete({
      model: "claude-opus-5-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: first.completion.content },
      ],
      maxOutputTokens: 50,
    });

    const messages = bodyOf(calls[1]!)["messages"] as { content: unknown[] }[];
    expect(messages[1]!.content[0]).toEqual({ type: "thinking", thinking: "", signature: "abc" });
  });

  it("never sends another vendor's state to this vendor", async () => {
    /**
     * The point of tagging the block. A conversation that started on one
     * vendor and moved to another would otherwise arrive carrying a block the
     * second vendor has never heard of, which is a 400 in the vendor's own
     * wording on a request that looks correct.
     */
    const calls: Call[] = [];
    const provider = anthropicProvider(
      { baseUrl: "https://claude.test" }, SECRET, transportFor([() => anthropicOk], calls));

    await provider.complete({
      model: "claude-opus-5-5",
      messages: [{
        role: "assistant",
        content: [
          { type: "vendorState", vendor: "openai", block: { reasoning: "theirs" } },
          { type: "text", text: "ours" },
        ],
      }],
      maxOutputTokens: 50,
    });

    expect(calls[0]!.body).not.toContain("theirs");
    expect(calls[0]!.body).toContain("ours");
  });

  it("treats a 200 with no usage as a failure rather than a free call", async () => {
    /**
     * Reporting zero would be a claim that the call was free. An operator
     * whose ceiling is built on these numbers would watch it stand still
     * while the vendor's meter moved.
     */
    const calls: Call[] = [];
    const provider = anthropicProvider({ baseUrl: "https://claude.test" }, SECRET, transportFor([
      () => ({ status: 200, body: { model: "m", content: [], stop_reason: "end_turn" } }),
    ], calls));

    const outcome = await provider.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 10,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_usage");
    expect(outcome.retryable).toBe(false);
  });

  it("knows a rate limit from a revoked key", async () => {
    /**
     * Treating them the same means either abandoning a request that would
     * have worked thirty seconds later, which is the commonest failure a
     * model API has, or hammering a key that will never work again.
     */
    const limited = anthropicProvider({ baseUrl: "https://c.test" }, SECRET, transportFor([
      () => ({ status: 429, body: { error: { type: "rate_limit_error", message: "slow down" } } }),
    ], []));
    const revoked = anthropicProvider({ baseUrl: "https://c.test" }, SECRET, transportFor([
      () => ({ status: 401, body: { error: { type: "authentication_error", message: "bad key" } } }),
    ], []));

    const a = await limited.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 1,
    });
    const b = await revoked.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 1,
    });

    expect(a.ok === false && a.retryable).toBe(true);
    expect(b.ok === false && b.retryable).toBe(false);
  });

  it("prices the models it holds a rate for and says null for the rest", () => {
    const provider = anthropicProvider({}, SECRET);
    const opus = provider.rateFor("claude-opus-5-5");
    expect(opus).toEqual({
      inputMicrosPerToken: 4, outputMicrosPerToken: 20, source: "adapter", asOf: "2026-09-25",
    });
    /**
     * Null rather than a plausible number from the same family. The families
     * do not share a price: some models here cost five times others.
     */
    expect(provider.rateFor("claude-something-nobody-published")).toBeNull();
  });

  it("lets the operator's own rate win over the table in this file", () => {
    /**
     * The operator is the one holding the invoice, and a published price
     * copied into this repository is only as current as the day somebody
     * checked it.
     */
    const provider = anthropicProvider(
      { rates: { "claude-opus-5-5": { inputMicrosPerToken: 9, outputMicrosPerToken: 11 } } },
      SECRET,
    );
    expect(provider.rateFor("claude-opus-5-5")).toEqual({
      inputMicrosPerToken: 9, outputMicrosPerToken: 11, source: "settings", asOf: null,
    });
  });

  it("ignores a half filled operator rate rather than pricing half a call", () => {
    /**
     * Output costs several times input on every one of these vendors, so a
     * rate with only the input side would produce an estimate wrong by most
     * of the bill while looking like a number somebody chose.
     */
    const provider = anthropicProvider(
      { rates: { "m": { inputMicrosPerToken: 9 } } }, SECRET);
    expect(provider.rateFor("m")).toBeNull();
  });
});

/* ========================================================= the OpenAI one = */

const openAiOk = {
  status: 200,
  body: {
    model: "gpt-test", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  },
};

describe("the OpenAI adapter", () => {
  it("sends max_completion_tokens, because the current models reject max_tokens", async () => {
    const calls: Call[] = [];
    const provider = openAiProvider(
      { baseUrl: "https://oai.test" }, SECRET, transportFor([() => openAiOk], calls));
    await provider.complete({
      model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 256,
    });

    const body = bodyOf(calls[0]!);
    expect(body["max_completion_tokens"]).toBe(256);
    expect(body["max_tokens"]).toBeUndefined();
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("puts the system prompt in the message list, where this vendor wants it", async () => {
    const calls: Call[] = [];
    const provider = openAiProvider(
      { baseUrl: "https://oai.test" }, SECRET, transportFor([() => openAiOk], calls));
    await provider.complete({
      model: "gpt-test", system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 10,
    });
    expect(bodyOf(calls[0]!)["messages"]).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("marks a failed tool result in the text, because this vendor has no flag for it", async () => {
    /**
     * Only one of the three vendors can say a tool result was an error on the
     * wire. Without the marker a failed tool reads to the model as a tool that
     * returned that sentence as its answer.
     */
    const calls: Call[] = [];
    const provider = openAiProvider(
      { baseUrl: "https://oai.test" }, SECRET, transportFor([() => openAiOk], calls));

    await provider.complete({
      model: "gpt-test",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", callId: "c1", name: "t", input: {} }] },
        {
          role: "user",
          content: [{ type: "toolResult", callId: "c1", name: "t", result: "forbidden", isError: true }],
        },
      ],
      maxOutputTokens: 10,
    });

    const messages = bodyOf(calls[0]!)["messages"] as Record<string, unknown>[];
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ERROR: forbidden" });
  });

  it("refuses a tool call whose arguments are not a JSON object", async () => {
    /**
     * The arguments are a string a model wrote. Handing an unreadable one up
     * as an empty input would be a tool invoked with none of the arguments
     * the model intended, which for a tool with an optional filter means it
     * runs against everything.
     */
    const provider = openAiProvider({ baseUrl: "https://oai.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          model: "gpt-test",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant", content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{oops" } }],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    ], []));

    const outcome = await provider.complete({
      model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      maxOutputTokens: 10,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("unreadable_tool_arguments");
  });

  it("reports a cache hit as a number and its absence as null", async () => {
    const withCache = openAiProvider({ baseUrl: "https://oai.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          model: "gpt-test", choices: [{ finish_reason: "stop", message: { content: "hi" } }],
          usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 40 } },
        },
      }),
    ], []));
    const without = openAiProvider(
      { baseUrl: "https://oai.test" }, SECRET, transportFor([() => openAiOk], []));

    const a = await withCache.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 5,
    });
    const b = await without.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 5,
    });

    expect(a.ok && a.completion.usage.cachedInputTokens).toBe(40);
    /** Null and zero are different answers: zero means asked and missed. */
    expect(b.ok && b.completion.usage.cachedInputTokens).toBeNull();
  });

  it("holds no price list for this vendor and says so rather than guessing", () => {
    expect(openAiProvider({}, SECRET).rateFor("gpt-test")).toBeNull();
    expect(openAiProvider(
      { rates: { "gpt-test": { inputMicrosPerToken: 1, outputMicrosPerToken: 2 } } },
      SECRET,
    ).rateFor("gpt-test")?.source).toBe("settings");
  });
});

/* ========================================================= the Google one = */

const geminiOk = {
  status: 200,
  body: {
    modelVersion: "gemini-test",
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "hi" }] } }],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
  },
};

describe("the Google adapter", () => {
  it("puts the key in a header and never in the URL", async () => {
    /**
     * The vendor's own documentation puts it in the query string. A URL is
     * logged by a forward proxy, a reverse proxy, the vendor, and anything
     * between a self hosted box and the internet, and no amount of scrubbing
     * on this side reaches any of those.
     */
    const calls: Call[] = [];
    const provider = googleProvider(
      { baseUrl: "https://gem.test" }, SECRET, transportFor([() => geminiOk], calls));
    await provider.complete({
      model: "gemini-test", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 20,
    });

    expect(calls[0]!.url).toBe("https://gem.test/models/gemini-test:generateContent");
    expect(calls[0]!.url).not.toContain(SECRET);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(SECRET);
  });

  it("mints a tool call id this vendor does not issue, and matches results by name", async () => {
    const calls: Call[] = [];
    const provider = googleProvider({ baseUrl: "https://gem.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          modelVersion: "gemini-test",
          candidates: [{
            finishReason: "STOP",
            content: { role: "model", parts: [{ functionCall: { name: "otos_list_jobs", args: { limit: 2 } } }] },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        },
      }),
      () => geminiOk,
    ], calls));

    const first = await provider.complete({
      model: "gemini-test", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      maxOutputTokens: 20,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const call = first.completion.content[0];
    expect(call).toEqual({
      type: "toolCall", callId: "gemini-0-otos_list_jobs", name: "otos_list_jobs", input: { limit: 2 },
    });

    /**
     * The turn after. The minted id has nowhere to go on this vendor, so the
     * result is matched on the name, which is what the vendor matches on.
     */
    await provider.complete({
      model: "gemini-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: first.completion.content },
        {
          role: "user",
          content: [{
            type: "toolResult", callId: "gemini-0-otos_list_jobs",
            name: "otos_list_jobs", result: "[]", isError: false,
          }],
        },
      ],
      maxOutputTokens: 20,
    });

    const contents = bodyOf(calls[1]!)["contents"] as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[2]!.parts[0]).toEqual({
      functionResponse: { name: "otos_list_jobs", response: { result: "[]" } },
    });
    expect(calls[1]!.body).not.toContain("gemini-0-otos_list_jobs");
  });

  it("says a tool was asked for even though this vendor reports STOP", async () => {
    /**
     * Gemini reports `STOP` on a turn that asked for a function call, so the
     * finish reason alone would say the answer is complete while a tool call
     * sits in it unrun.
     */
    const provider = googleProvider({ baseUrl: "https://gem.test" }, SECRET, transportFor([
      () => ({
        status: 200,
        body: {
          candidates: [{
            finishReason: "STOP",
            content: { parts: [{ functionCall: { name: "t", args: {} } }] },
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      }),
    ], []));

    const outcome = await provider.complete({
      model: "gemini-test", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      maxOutputTokens: 10,
    });
    expect(outcome.ok && outcome.completion.stop).toBe("toolUse");
  });

  it("reads a blocked prompt as a refusal rather than an empty answer", async () => {
    /**
     * This vendor answers a blocked prompt with 200, no candidates and a
     * block reason. Returning that as an empty success would show a user a
     * blank answer and tell them nothing.
     */
    const provider = googleProvider({ baseUrl: "https://gem.test" }, SECRET, transportFor([
      () => ({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } }),
    ], []));

    const outcome = await provider.complete({
      model: "gemini-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      maxOutputTokens: 10,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("blocked_safety");
  });

  it("strips the models/ prefix so a listed id can be called straight back", async () => {
    const calls: Call[] = [];
    const provider = googleProvider({ baseUrl: "https://gem.test" }, SECRET, transportFor([
      () => ({ status: 200, body: { models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] } }),
      () => geminiOk,
    ], calls));

    const listed = await provider.models();
    expect(listed.ok && listed.models[0]).toEqual({ id: "gemini-test", label: "Gemini Test" });

    await provider.complete({
      model: "gemini-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      maxOutputTokens: 5,
    });
    /** Not `models/models/...`, which is a 404 that reads like a withdrawn model. */
    expect(calls[1]!.url).toBe("https://gem.test/models/gemini-test:generateContent");
  });
});

/* ============================================ the key reaches nothing ==== */

describe("a credential never reaches anything an adapter returns", () => {
  /**
   * The sweep. Every one of these vendors can echo part of a request back in
   * an error, and an error message reaches a log, a support ticket, a
   * screenshot and an issue tracker, usually within the hour.
   */
  const echo = (status: number) => () => ({
    status,
    body: {
      error: {
        type: "invalid_request_error", status: "INVALID_ARGUMENT", code: "bad",
        message: `the key ${SECRET} is not valid`,
      },
      /** Some vendors echo the whole failing request. */
      request: { headers: { authorization: `Bearer ${SECRET}` } },
    },
  });

  it("scrubs it out of a failure from every adapter", async () => {
    const built: AiProvider[] = [
      anthropicProvider({ baseUrl: "https://a.test" }, SECRET, transportFor([echo(400)], [])),
      openAiProvider({ baseUrl: "https://o.test" }, SECRET, transportFor([echo(400)], [])),
      googleProvider({ baseUrl: "https://g.test" }, SECRET, transportFor([echo(400)], [])),
    ];

    const results: unknown[] = [];
    for (const provider of built) {
      results.push(await provider.complete({
        model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        maxOutputTokens: 5,
      }));
      results.push(await provider.models());
    }

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(SECRET);
    /** And the scrub is visible rather than silent, so a reader knows why. */
    expect(serialized).toContain("[redacted]");
  });

  it("scrubs it out of a response body that is not JSON at all", async () => {
    /**
     * A gateway in front of a vendor answers with an HTML error page that
     * sometimes quotes the request. That path does not go through the
     * vendor's error shape, so it needs its own scrub and its own test.
     */
    const provider = anthropicProvider({ baseUrl: "https://a.test" }, SECRET, transportFor([
      () => ({ status: 502, body: `<html>upstream rejected key ${SECRET}</html>` }),
    ], []));

    const outcome = await provider.complete({
      model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      maxOutputTokens: 5,
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});

/* ====================================================== the service ====== */

run("connecting a model account", () => {
  beforeEach(async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.ai_budget where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await raw`delete from public.audit_log where organization_id = ${ORG}`;
  });

  it("refuses a vendor this deployment cannot call", async () => {
    await expect(ai.connect(ctx(), { provider: "mistral", credentialRef: KEY_REF }))
      .rejects.toThrow(/No adapter for "mistral"/);
  });

  it("refuses a connection with no secret named", async () => {
    /**
     * The key itself never reaches this API. A connection with no reference
     * is one whose every call fails with the vendor's own 401, which reads to
     * an operator as a rejected key rather than as a key nobody supplied.
     */
    await expect(ai.connect(ctx(), { provider: "anthropic", credentialRef: "  " }))
      .rejects.toThrow(/name of the secret/);
  });

  it("stores the reference and never puts it in the audit log", async () => {
    await connect();
    const [row] = await raw<{ credential_ref: string }[]>`
      select credential_ref from public.integration_connection
      where organization_id = ${ORG} and capability = 'ai_model'`;
    expect(row!.credential_ref).toBe(KEY_REF);

    const audits = await raw<{ after: Record<string, unknown> }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'ai.connected'`;
    expect(JSON.stringify(audits)).not.toContain(KEY_REF);
  });

  it("shows every connected provider, because a company runs more than one", async () => {
    await connect("anthropic");
    await connect("openai");
    const state = await ai.status(ctx());
    expect(state.connections.map((c) => c.provider).sort()).toEqual(["anthropic", "openai"]);
  });

  it("will not choose between two connected vendors", async () => {
    /**
     * Choosing would mean this product deciding, silently and forever, which
     * account a company is billed by. The spread across models an operator
     * might reasonably connect is more than tenfold.
     */
    await connect("anthropic");
    await connect("openai");
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(/2 model providers connected/);
  });

  it("stops calling a vendor when it is disconnected, and keeps the spend record", async () => {
    await connect();
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));

    await ai.disconnect(ctx(), { provider: "anthropic" });

    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(AiProviderNotConfiguredError);

    /** The bill arrives after the key is removed. The record has to outlive it. */
    expect((await usageRows()).length).toBe(1);
  });

  it("proves a key works without spending anything on finding out", async () => {
    await connect();
    const recorder: Recorder = { requests: [] };
    const result = await ai.verify(ctx(), {}, deps(fakeProvider(recorder)));
    expect(result.models).toEqual([{ id: "fake-model", label: "Fake" }]);
    /** A test that sent a greeting would charge for pressing a button. */
    expect(recorder.requests).toEqual([]);
    expect((await usageRows()).length).toBe(0);
  });
});

run("what a model is told it can do", () => {
  beforeEach(async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.ai_budget where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await connect();
  });

  it("offers nothing at all unless the caller asks for tools", async () => {
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));
    expect(recorder.requests[0]!.tools).toBeUndefined();
  });

  it("offers only tools the caller could use by hand", async () => {
    /**
     * THE SAFETY PROPERTY OF THE WHOLE MODULE. The list is the MCP catalogue
     * filtered by the permissions this caller holds, reused rather than
     * reimplemented: a second copy of "which tools may this actor see" would
     * disagree with the first eventually, and silently, in the direction
     * where a model is told about a tool its operator cannot use.
     */
    const forOwner: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test", offerTools: true,
    }, deps(fakeProvider(forOwner)));

    const owned = (forOwner.requests[0]!.tools ?? []).map((tool) => tool.name);
    expect(owned.length).toBeGreaterThan(20);
    expect(owned).toContain("otos_refund_payment");

    /**
     * The same call as somebody who may run an agent and may read jobs and
     * nothing else. An agent is worth turning on precisely because it can be
     * given a narrow authority, and this is the test that the narrowing is
     * real rather than a sentence in a settings screen.
     */
    const narrow: Recorder = { requests: [] };
    await ai.runCompletion(agentOperator(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test", offerTools: true,
    }, deps(fakeProvider(narrow)));

    const offered = (narrow.requests[0]!.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("otos_list_jobs");
    /** They cannot refund a payment, so no model acting as them is told it can. */
    expect(offered).not.toContain("otos_refund_payment");
    expect(offered.length).toBeLessThan(owned.length);

    /** And the catalogue surface agrees with what was actually sent. */
    const visible = await ai.tools(agentOperator());
    expect(visible.tools.map((tool) => tool.name).sort()).toEqual([...offered].sort());
  });

  it("never tells a model it can run a model", async () => {
    /**
     * A tool that starts a completion would let a model drive itself, and a
     * loop whose every turn starts another turn is the failure the ceiling
     * exists for, running at machine speed with a credit card attached. The
     * routes stay reachable for a person or an application; what is prevented
     * is the recursion.
     *
     * Asserted against a catalogue handed in, because these routes are not in
     * the registry until a deployment wires them: a check against the live
     * catalogue would pass today by having nothing to exclude, and would go
     * on passing on the day somebody wired them.
     */
    const catalogue = [
      {
        name: "otos_run_ai_completion", title: "Ask the connected model", description: "",
        inputSchema: { type: "object" }, routeName: "runAiCompletion",
        permissions: ["agent:configure"],
        route: { method: "post", path: "/v1/ai/completions" },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      {
        name: "otos_list_jobs", title: "List jobs", description: "",
        inputSchema: { type: "object" }, routeName: "listJobs",
        permissions: ["job:read"],
        route: { method: "get", path: "/v1/jobs" },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
    ] as unknown as Parameters<typeof ai.offeredTools>[1];

    expect(ai.offeredTools(ctx(), catalogue).map((tool) => tool.name))
      .toEqual(["otos_list_jobs"]);
  });

  it("refuses to show the catalogue to somebody who may not run an agent", async () => {
    await expect(ai.tools(technician())).rejects.toThrow(/agent:configure/);
  });

  it("returns the tool calls and does not run them", async () => {
    /**
     * The boundary, and it is deliberate. A tool call goes through the same
     * dispatcher an HTTP client reaches, which is the one place a permission
     * is checked. A service that executed one would be a second gate, and it
     * would have to invent a credential, because a ServiceContext holds an
     * actor and not a token.
     */
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "cancel everything" }] }],
      maxOutputTokens: 100, purpose: "test", offerTools: true,
    }, deps(fakeProvider(recorder, {
      async complete(request) {
        recorder.requests.push(request);
        return {
          ok: true,
          completion: {
            model: request.model,
            content: [{ type: "toolCall", callId: "c1", name: "otos_list_jobs", input: { limit: 1 } }],
            stop: "toolUse",
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null },
          },
        };
      },
    })));

    expect(result.toolCalls).toEqual([{ callId: "c1", name: "otos_list_jobs", input: { limit: 1 } }]);
    expect(result.stop).toBe("toolUse");
  });

  it("refuses a caller who may read the settings and may not spend the money", async () => {
    /**
     * `agent:configure` is the only AI permission in the catalogue and it is
     * what guards running a model, because the catalogue has nothing narrower
     * and running one spends the company's money against their own key.
     * Reading the settings screen is a different question and a different
     * permission.
     */
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(technician(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(/agent:configure/);
    expect(recorder.requests).toEqual([]);
  });
});

run("what a call cost", () => {
  beforeEach(async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.ai_budget where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await raw`delete from public.audit_log where organization_id = ${ORG}`;
    await connect();
  });

  it("records the tokens and an estimate of what they cost", async () => {
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "nightly summary",
    }, deps(fakeProvider(recorder)));

    /** 100 input at 5, 50 output at 25: 500 + 1250 micro-dollars. */
    expect(result.estimatedCostMicros).toBe(1750);

    const [row] = await usageRows();
    expect(row!.outcome).toBe("ok");
    expect(row!.purpose).toBe("nightly summary");
    expect(row!.input_tokens).toBe(100);
    expect(Number(row!.estimated_cost_micros)).toBe(1750);
  });

  it("stores no word of the conversation anywhere", async () => {
    /**
     * A prompt in this product routinely carries a customer's address, a
     * technician's notes and an invoice. The usage table is read by people
     * investigating a bill, who are not necessarily entitled to that, and the
     * audit log is the most widely read table in the database.
     */
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "14 Mallow Lane, Mrs Aziz" }] }],
      maxOutputTokens: 100, purpose: "triage",
    }, deps(fakeProvider(recorder)));

    const rows = await usageRows();
    const audits = await raw`select * from public.audit_log where organization_id = ${ORG}`;
    expect(JSON.stringify(rows)).not.toContain("Mallow");
    expect(JSON.stringify(audits)).not.toContain("Mallow");
  });

  it("records a cost of null, never zero, when no rate is known", async () => {
    /**
     * Zero would be a claim that the call was free, and it is a claim that
     * sums: a month of unpriced calls would total nothing and an operator
     * would read it as a month they did not use the feature.
     */
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, { rateFor: () => null })));

    expect(result.estimatedCostMicros).toBeNull();
    const [row] = await usageRows();
    expect(row!.estimated_cost_micros).toBeNull();

    const state = await ai.status(ctx());
    /** And it is counted and shown, because it is the number that makes a ceiling meaningless. */
    expect(state.unpricedCallsThisMonth).toBe(1);
  });

  it("records a failure with no tokens and an unknown cost", async () => {
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, {
      async complete() {
        return { ok: false, code: "overloaded_error", message: "try later", retryable: true };
      },
    })))).rejects.toThrow(ConflictError);

    const [row] = await usageRows();
    expect(row!.outcome).toBe("failed");
    expect(row!.detail).toContain("overloaded_error");
    expect(row!.estimated_cost_micros).toBeNull();
  });

  it("breaks the month down by model, and says how much of it is priced", async () => {
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      model: "model-a", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));
    await ai.runCompletion(ctx(), {
      model: "model-b", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, { rateFor: () => null })));

    const report = await ai.usage(ctx());
    const a = report.models.find((row) => row.model === "model-a")!;
    const b = report.models.find((row) => row.model === "model-b")!;
    expect(a.estimatedCostMicros).toBe(1750);
    expect(a.pricedCalls).toBe(1);
    expect(b.estimatedCostMicros).toBeNull();
    expect(b.pricedCalls).toBe(0);
  });

  it("counts only this month's spend", async () => {
    /**
     * The window is the calendar month in the COMPANY'S timezone, because
     * that is what an operator means by "a hundred dollars a month". A
     * ceiling that rolled over at six in the evening on the last of the month
     * would be reported as a bug by the one person who noticed.
     */
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));

    const nextMonth = new Date(Date.now() + 1000 * 60 * 60 * 24 * 62);
    const later = await ai.status(ctx(), { readSecret: async () => SECRET, now: () => nextMonth });
    expect(later.spentThisMonthMicros).toBe(0);

    const thisMonth = await ai.status(ctx());
    expect(thisMonth.spentThisMonthMicros).toBe(1750);
  });
});

run("the spending ceiling", () => {
  beforeEach(async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.ai_budget where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await raw`delete from public.audit_log where organization_id = ${ORG}`;
    await connect();
  });

  it("lets a call through while there is room for it", async () => {
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 1_000_000 });
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));
    expect(result.estimatedCostMicros).toBe(1750);
    expect(result.monthlyLimitMicros).toBe(1_000_000);
  });

  it("refuses once the month's spend has reached the ceiling", async () => {
    /**
     * Spend first, then lower the ceiling under it, which is how an operator
     * reacts to a bill. It is also the only way to reach this branch rather
     * than the reserve one below, and the two say different things: this one
     * tells them to raise the ceiling or wait for the month, where the
     * reserve one tells them to ask for a shorter answer. Reaching the wrong
     * branch would give somebody already over their limit advice that cannot
     * help them, and would print a negative amount remaining.
     */
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));

    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 1000 });

    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(
      /has spent \$0\.0018 on AI this month and its ceiling is \$0\.0010/);

    /** Nothing more was sent, which is the point of refusing before the call. */
    expect(recorder.requests.length).toBe(1);
  });

  it("refuses a call whose worst case output would carry the month past the ceiling", async () => {
    /**
     * The honest bound. Input tokens are not knowable before a call, so the
     * ceiling reserves `maxOutputTokens` at the output rate: the most a month
     * can exceed its ceiling is one call's input cost. Claiming "spend never
     * exceeds the limit" would be a claim nothing checking beforehand can
     * support.
     */
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 2600 });
    const recorder: Recorder = { requests: [] };

    /** 100 output tokens at 25 is 2500, which fits under 2600. */
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));

    /** 1750 already spent plus a reserve of 2500 does not fit, so this one stops. */
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(/is left under this month's ceiling/);
    expect(recorder.requests.length).toBe(1);
  });

  it("records the refusal rather than leaving a support conversation with nothing behind it", async () => {
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 100 });
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "nightly summary",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(ConflictError);

    const [row] = await usageRows();
    expect(row!.outcome).toBe("refused");
    expect(row!.purpose).toBe("nightly summary");
    expect(row!.input_tokens).toBe(0);
    expect(row!.detail).toContain("ceiling");

    const audits = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'ai.refused'`;
    expect(audits.length).toBe(1);
  });

  it("keeps refused and failed calls out of the month's spend and its breakdown", async () => {
    /**
     * The `outcome = 'ok'` filter on both spend queries, asserted as a
     * property of the QUERIES rather than of who happens to write the rows.
     * The service never records a cost against a call that did not run, so a
     * row like the one below can only arrive from a backfill, a later change
     * or a second writer, and the filter is what makes the total mean money
     * actually spent rather than money a vendor was nearly asked for.
     */
    await raw`
      insert into public.ai_usage
        (organization_id, connection_id, provider, model, purpose,
         input_tokens, output_tokens, estimated_cost_micros, outcome)
      select ${ORG}, id, 'anthropic', 'ghost-model', 'never ran', 10, 10, 999999, 'failed'
      from public.integration_connection
      where organization_id = ${ORG} and capability = 'ai_model' limit 1`;

    expect((await ai.status(ctx())).spentThisMonthMicros).toBe(0);
    const report = await ai.usage(ctx());
    expect(report.models.map((row) => row.model)).not.toContain("ghost-model");
  });

  it("does not let a refusal count against the month it refused", async () => {
    /**
     * A refused call spent nothing. Counting it would make a ceiling that
     * refuses once refuse everything after it for the rest of the month.
     */
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 100 });
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)))).rejects.toThrow(ConflictError);

    expect((await ai.status(ctx())).spentThisMonthMicros).toBe(0);
  });

  it("refuses a model it cannot price while a ceiling is set", async () => {
    /**
     * A rate nobody knows means every call costs null, every month sums to
     * zero, and the ceiling is a setting that does nothing while an operator
     * believes it is protecting them. Refusing is rude and visible; the
     * alternative is quiet and expensive.
     */
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 1_000_000 });
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, { rateFor: () => null }))))
      .rejects.toThrow(/no price is known/);
    expect(recorder.requests).toEqual([]);
  });

  it("lets an unpriced model run when nobody set a ceiling", async () => {
    /**
     * The refusal is a consequence of the ceiling, not a general rule. A
     * company that has not set one has not asked to be protected and should
     * not be stopped from using a model this deployment has no price list for.
     */
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, { rateFor: () => null })));
    expect(result.estimatedCostMicros).toBeNull();
  });

  it("clears to no ceiling, which is a position rather than an absence", async () => {
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: 100 });
    await ai.setSpendLimit(ctx(), { monthlyLimitMicros: null });
    const recorder: Recorder = { requests: [] };
    const result = await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));
    expect(result.monthlyLimitMicros).toBeNull();
  });

  it("refuses to set a ceiling below nothing", async () => {
    await expect(ai.setSpendLimit(ctx(), { monthlyLimitMicros: -1 }))
      .rejects.toThrow(ConflictError);
  });

  it("will not guess a model when nobody named one", async () => {
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await ai.connect(ctx(), { provider: "openai", credentialRef: KEY_REF });
    const recorder: Recorder = { requests: [] };
    await expect(ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder, { defaultModel: null }))))
      .rejects.toThrow(/No model named/);
  });
});

run("the key, end to end", () => {
  beforeEach(async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.ai_budget where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await raw`delete from public.audit_log where organization_id = ${ORG}`;
    await connect();
  });

  it("never reaches a thrown message, a usage row or the audit log", async () => {
    /**
     * The adapters scrub, and this is the check that the scrub survives the
     * whole path: a vendor's 401 quoting the key, through the service, into
     * the row an operator reads and the log everybody reads.
     */
    const provider = anthropicProvider({ baseUrl: "https://a.test" }, SECRET, transportFor([
      () => ({ status: 401, body: { error: { type: "authentication_error", message: `key ${SECRET} revoked` } } }),
    ], []));

    let thrown = "";
    try {
      await ai.runCompletion(ctx(), {
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 100, purpose: "test",
      }, { readSecret: async () => SECRET, provider });
    } catch (error) {
      thrown = (error as Error).message;
    }

    expect(thrown).toContain("revoked");
    expect(thrown).not.toContain(SECRET);

    const rows = await usageRows();
    const audits = await raw`select * from public.audit_log where organization_id = ${ORG}`;
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });
});

run("tenant isolation", () => {
  const OTHER = fixtureId("ai27:other-org");
  const OTHER_USER = fixtureId("ai27:other-user");

  beforeAll(async () => {
    if (!url) return;
    await seedOrg(raw, {
      organizationId: OTHER, userId: OTHER_USER, name: "Other Co", slug: "other-model-co",
    });
  });

  afterAll(async () => { if (url) await resetOrg(raw, OTHER); });

  it("does not let one company read another's spend", async () => {
    await raw`delete from public.ai_usage where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await connect();
    const recorder: Recorder = { requests: [] };
    await ai.runCompletion(ctx(), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));

    const theirs = await ai.status({
      actor: { userId: OTHER_USER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] },
      db: db(),
    });
    expect(theirs.connections).toEqual([]);
    expect(theirs.spentThisMonthMicros).toBe(0);
  });
});

run("a retry does not spend the money twice", () => {
  const ask = (extra: Partial<ServiceContext> = {}) => {
    const recorder: Recorder = { requests: [] };
    return ai.runCompletion(ctx(extra), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100, purpose: "test",
    }, deps(fakeProvider(recorder)));
  };

  it("refuses a second completion under the same idempotency key", async () => {
    /**
     * EVERY OTHER POST HERE CARRIES A KEY BECAUSE A CLIENT ON BAD SIGNAL
     * RETRIES, and for this one the duplicate is not a stray record, it is a
     * second bill. The route was declared non idempotent at first, reasoning
     * that honouring a retry would mean storing the conversation. The answer
     * to that is to refuse the retry rather than drop the protection, and
     * this is the assertion that says so.
     */
    await connect();
    const key = `retry-${Math.random().toString(36).slice(2)}`;

    await expect(ask({ idempotencyKey: key })).resolves.toBeDefined();
    await expect(ask({ idempotencyKey: key }))
      .rejects.toThrow(/already run under that idempotency key/i);

    const rows = await raw`
      select count(*)::int as n from public.ai_usage
      where organization_id = ${ORG} and idempotency_key = ${key}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("lets a caller who sends no key ask twice, which is what no key means", async () => {
    await connect();
    await expect(ask()).resolves.toBeDefined();
    await expect(ask()).resolves.toBeDefined();
  });
});
