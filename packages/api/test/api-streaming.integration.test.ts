import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { agents as coreAgents, connectors, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as knowledge from "../src/services/knowledge";
import "../src/ai/index";
import { serverSentEvents } from "../src/ai/provider";
import { dispatch } from "../src/http/dispatch";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE FIELD ASSISTANT ANSWERING AS IT WRITES, OVER THE API
 *
 * The whole path: a request into the dispatcher, the session and the route's
 * permission, the field assistant's service, the Anthropic adapter, and a
 * local server playing Anthropic's streamed Messages API, which can hold its
 * answer after any piece. So the test reads the first sentence off the
 * response while the model is still writing the rest, and that is what makes
 * this a stream rather than a JSON answer with a different content type.
 *
 * The adapter reaches the fake through the connection's own `baseUrl`, which
 * only a test may set (docs/self-hosting/secrets.md), and its key is read
 * from this company's own secret store.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("apistreaming:org");
const OWNER = fixtureId("apistreaming:owner");
const SLUG = "api-streaming-co";
const SECRET = `${connectors.environmentVariablePrefix(ORG)}STREAM_TEST_AI_KEY`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

/* ------------------------------------------------- Anthropic, played locally */

/** What the model writes next, in pieces of a few characters, held after piece `holdAfter` until released. */
let script: { tool: string; input: Record<string, unknown>; holdAfter?: number } = {
  tool: "answer", input: { answer: "Hello.", sources: ["howto-1"] },
};
let release: (() => void) | null = null;
let asked = 0;
let server: Server;
let base = "";

const pieces = (value: Record<string, unknown>, size = 7): string[] => {
  const text = JSON.stringify(value);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
};
const pieceAfter = (all: string[], sentence: string): number => {
  let written = "";
  for (const [i, piece] of all.entries()) {
    written += piece;
    if (written.includes(`${sentence} `)) return i;
  }
  throw new Error(`"${sentence}" is never followed by a space`);
};

function fakeAnthropic(): Promise<void> {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      void (async () => {
        asked += 1;
        const sent = JSON.parse(body) as { stream?: boolean };
        if (request.url !== "/v1/messages" || request.headers["x-api-key"] !== "sk-test-not-a-key") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Not what this fake expects." } }));
          return;
        }
        /** Asked whole, as the JSON route asks: the same answer in one body. */
        if (sent.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            model: "fake-model", stop_reason: "tool_use", usage: { input_tokens: 200, output_tokens: 40 },
            content: [{ type: "tool_use", id: "toolu_1", name: script.tool, input: script.input }],
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (name: string, data: Record<string, unknown>) =>
          response.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
        const { tool, input, holdAfter } = script;
        event("message_start", { message: { model: "fake-model", usage: { input_tokens: 200, output_tokens: 1 } } });
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: tool, input: {} } });
        for (const [i, piece] of pieces(input).entries()) {
          event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: piece } });
          if (i === holdAfter) await new Promise<void>((resolve) => { release = resolve; });
        }
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } });
        event("message_stop", {});
        response.end();
      })();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

/* ------------------------------------------------------------ the requests */

const deps = (roles: Actor["roles"] | null) => ({
  db: db(),
  basePath: "/api",
  resolveSession: async (): Promise<ServiceContext | null> =>
    roles === null ? null : { actor: { userId: OWNER, organizationId: ORG, roles }, db: db() },
});

const ask = (question: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/ai/field-assistant", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ question }),
  });
const STREAM = { accept: "text/event-stream" };

/** The events of a response, as they arrive. */
function eventsOf(response: Response): AsyncIterator<{ event: string | null; data: string }> {
  const body = response.body!;
  const chunks = (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  })();
  return serverSentEvents(chunks)[Symbol.asyncIterator]();
}

async function rest(events: AsyncIterator<{ event: string | null; data: string }>) {
  const out: Array<{ event: string | null; data: unknown }> = [];
  for (let next = await events.next(); !next.done; next = await events.next()) {
    out.push({ event: next.value.event, data: JSON.parse(next.value.data) as unknown });
  }
  return out;
}

const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  process.env[SECRET] = "sk-test-not-a-key";
  if (!url) return;
  await fakeAnthropic();
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Streaming Heating", slug: SLUG });
  await ai.connect(owner(), {
    provider: "anthropic", credentialRef: "STREAM_TEST_AI_KEY",
    settings: { defaultModel: "fake-model", baseUrl: base, rates: { "fake-model": { inputMicrosPerToken: 1, outputMicrosPerToken: 5 } } },
  });
  await agents.configure(owner(), {
    agent: "field", settings: { ...coreAgents.defaultSettings("field"), enabled: true, runAsUserId: OWNER },
  });
  await knowledge.create(owner(), {
    title: "Flushing a water heater", body: "Shut off the gas. Drain the tank for ten minutes. A flush is $95 on the price list.", tags: ["heater"],
  });
});

afterAll(async () => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
  delete process.env[SECRET];
  if (server) await new Promise((resolve) => server.close(resolve));
  if (!raw) return;
  /** Switched off, so a worker pass in another file never visits the fake's address. */
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw.end();
});

run("the field assistant over the API, as it writes", () => {
  it("answers JSON, as it always has, when nobody asks for events", async () => {
    script = { tool: "answer", input: { answer: "Shut off the gas first. Then drain it.", sources: ["howto-1"] } };
    const response = await dispatch(ask("How do we flush a water heater?"), deps(["owner"]));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ answered: true, text: "Shut off the gas first. Then drain it." });
  });

  it("sends the first sentence while the model is still writing, then the whole checked answer", async () => {
    const input = { answer: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.", sources: ["howto-1"] };
    const all = pieces(input);
    script = { tool: "answer", input, holdAfter: pieceAfter(all, "Shut off the gas first.") };
    release = null;
    const response = await dispatch(ask("How do we flush a water heater?", { ...STREAM, "idempotency-key": "api-streaming-flush" }), deps(["owner"]));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const events = eventsOf(response);
    const first = await events.next();
    /** The model is held: this sentence came before the rest of the answer was written. */
    expect(release).not.toBeNull();
    expect(first.value).toEqual({ event: "writing", data: JSON.stringify({ text: "Shut off the gas first." }) });
    release!();

    const after = await rest(events);
    expect(after.filter((e) => e.event === "writing").map((e) => e.data)).toEqual([
      { text: "Shut off the gas first. Then drain the tank for ten minutes." },
    ]);
    expect(after.at(-1)).toEqual({
      event: "answer",
      data: {
        answered: true, text: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.",
        sources: [{ kind: "procedure", title: "Flushing a water heater" }],
      },
    });
  });

  it("answers a retry with the same key from the record, as one event, without asking the model again", async () => {
    const before = asked;
    const response = await dispatch(ask("How do we flush a water heater?", { ...STREAM, "idempotency-key": "api-streaming-flush" }), deps(["owner"]));
    expect(response.status).toBe(201);
    const events = await rest(eventsOf(response));
    expect(events).toEqual([{
      event: "answer",
      data: {
        answered: true, text: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.",
        sources: [{ kind: "procedure", title: "Flushing a water heater" }],
      },
    }]);
    expect(asked).toBe(before);
  });

  it("never sends a sentence naming an amount not in the records, and the whole answer says it was not shown", async () => {
    script = { tool: "answer", input: { answer: "Shut off the gas first. The kit costs $40. Drain it for ten minutes. ", sources: ["howto-1"] } };
    const response = await dispatch(ask("How do we flush a water heater?", STREAM), deps(["owner"]));
    const events = await rest(eventsOf(response));
    const written = events.filter((e) => e.event === "writing").map((e) => (e.data as { text: string }).text);
    expect(written).toEqual(["Shut off the gas first."]);
    expect(JSON.stringify(events)).not.toContain("$40");
    expect(events.at(-1)!.event).toBe("answer");
    expect(events.at(-1)!.data).toMatchObject({ answered: false });
    expect((events.at(-1)!.data as { text: string }).text).toMatch(/not in your records, so it was not shown/);
  });

  it("refuses with the JSON route's own status before any event: signed out, and without field:sync", async () => {
    const before = asked;
    const signedOut = await dispatch(ask("How do we flush a water heater?", STREAM), deps(null));
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("content-type")).toContain("application/json");

    const bookkeeper = await dispatch(ask("How do we flush a water heater?", STREAM), deps(["accountant"]));
    expect(bookkeeper.status).toBe(403);
    expect(bookkeeper.headers.get("content-type")).toContain("application/json");
    expect(await bookkeeper.json()).toMatchObject({ status: 403 });

    const bad = await dispatch(ask("Hi", STREAM), deps(["owner"]));
    expect(bad.status).toBe(422);
    expect(asked).toBe(before);
  });

  it("is held to the assistant's runs a day exactly as the JSON route is", async () => {
    const used = await raw<{ n: number }[]>`
      select count(*)::int as n from public.ai_usage
      where organization_id = ${ORG} and agent_id = ${agents.agentId("field")} and outcome <> 'refused'`;
    await agents.configure(owner(), {
      agent: "field",
      settings: {
        ...coreAgents.defaultSettings("field"), enabled: true, runAsUserId: OWNER,
        limits: { ...coreAgents.defaultSettings("field").limits, runsPerDay: Math.max(1, used[0]!.n) },
      },
    });
    const before = asked;
    const streamed = await dispatch(ask("How do we flush a water heater?", STREAM), deps(["owner"]));
    const whole = await dispatch(ask("How do we flush a water heater?"), deps(["owner"]));
    expect(streamed.status).toBe(whole.status);
    expect(streamed.status).toBe(409);
    expect(streamed.headers.get("content-type")).toContain("application/json");
    const said = await streamed.json() as { error: string };
    expect(said.error).toMatch(/today's \d+ runs/);
    expect(said.error).toBe((await whole.json() as { error: string }).error);
    expect(asked).toBe(before);
  });
});
