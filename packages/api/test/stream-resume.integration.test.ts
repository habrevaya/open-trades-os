import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { agents as coreAgents, connectors, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as knowledge from "../src/services/knowledge";
import "../src/ai/index";
import { dispatch } from "../src/http/dispatch";
import type { ServiceContext } from "../src/services/context";
import * as chat from "../src/services/agent-chat";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M26. A STREAM THAT DROPS AND IS ASKED AGAIN
 *
 * The answer stream routes carry event ids (how long the answer so far is,
 * and `answer` on the whole answer) and honour `Last-Event-ID`. A request
 * with the same idempotency key while the first answer is still being
 * written joins it: it is sent only what the client does not have yet, then
 * the same whole answer, and the model is asked once. Through the
 * dispatcher, the session, the field assistant and the website chat, and a
 * local server playing Anthropic's streamed Messages API that can hold its
 * answer after any piece.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("stream-resume:org");
const OWNER = fixtureId("stream-resume:owner");
const SLUG = "stream-resume-co";
const SECRET = `${connectors.environmentVariablePrefix(ORG)}RESUME_TEST_AI_KEY`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

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

const deps = (roles: Actor["roles"] | null) => ({
  db: db(),
  basePath: "/api",
  resolveSession: async (): Promise<ServiceContext | null> =>
    roles === null ? null : { actor: { userId: OWNER, organizationId: ORG, roles }, db: db() },
});
const STREAM = { accept: "text/event-stream" };
const ask = (headers: Record<string, string>) =>
  new Request("http://localhost/api/v1/ai/field-assistant", {
    method: "POST",
    headers: { "content-type": "application/json", ...STREAM, ...headers },
    body: JSON.stringify({ question: "How do we flush a water heater?" }),
  });

interface Event { event: string; id: string | null; data: unknown }

/** The events of a response with their ids, as the format writes them, one at a time. */
function eventsOf(response: Response): AsyncIterator<Event> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return (async function* () {
    for (;;) {
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let event = "message";
        let id: string | null = null;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length > 0) yield { event, id, data: JSON.parse(data.join("\n")) as unknown };
        at = buffer.indexOf("\n\n");
      }
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
    }
  })();
}

async function rest(events: AsyncIterator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for (let next = await events.next(); !next.done; next = await events.next()) out.push(next.value);
  return out;
}

/** Until the fake has been asked and is holding its answer. */
async function held(): Promise<void> {
  for (let i = 0; i < 400 && release === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(release).not.toBeNull();
}

const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  process.env[SECRET] = "sk-test-not-a-key";
  if (!url) return;
  await fakeAnthropic();
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Resume Heating", slug: SLUG });
  await ai.connect(owner(), {
    provider: "anthropic", credentialRef: "RESUME_TEST_AI_KEY",
    settings: { defaultModel: "fake-model", baseUrl: base, rates: { "fake-model": { inputMicrosPerToken: 1, outputMicrosPerToken: 5 } } },
  });
  for (const agent of ["field", "chat"] as const) {
    await agents.configure(owner(), { agent, settings: { ...coreAgents.defaultSettings(agent), enabled: true, runAsUserId: OWNER } });
  }
  const [jt] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name) values (${ORG}, 'Water heater repair') returning id`;
  await raw`insert into public.bookable_service (organization_id, job_type_id, public_name, display_price, min_notice_hours, max_advance_days, max_per_window)
            values (${ORG}, ${jt!.id}, 'Water heater repair', 149.0000, 0, 30, 5)`;
  await knowledge.create(owner(), {
    title: "Flushing a water heater", body: "Shut off the gas. Drain the tank for ten minutes. A flush is $95 on the price list.", tags: ["heater"],
  });
});

afterAll(async () => {
  release?.();
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
  delete process.env[SECRET];
  if (server) await new Promise((resolve) => server.close(resolve));
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw.end();
});

const ANSWER = { answer: "Shut off the gas first. Then drain the tank for ten minutes. A flush is $95.", sources: ["howto-1"] };

run("a field assistant answer asked again while it is written", () => {
  it("carries ids, joins the answer for a resume with the same key, sends only what the client lacks, and asks the model once", async () => {
    script = { tool: "answer", input: ANSWER, holdAfter: pieceAfter(pieces(ANSWER), "Shut off the gas first.") };
    release = null;
    const before = asked;
    const first = await dispatch(ask({ "idempotency-key": "resume-flush" }), deps(["owner"]));
    const firstEvents = eventsOf(first);
    const sentence = (await firstEvents.next()).value as Event;
    expect(sentence).toEqual({ event: "writing", id: String("Shut off the gas first.".length), data: { text: "Shut off the gas first." } });
    await held();

    /** The connection drops; the client asks again with the same key and the id it last had. */
    /** The answer so far is written onto the key's record a moment after it is sent. */
    let mark: { status: string; response_payload: { writing: string | null } } | undefined;
    for (let i = 0; i < 200; i += 1) {
      [mark] = await raw<{ status: string; response_payload: { writing: string | null } }[]>`
        select status, response_payload from public.integration_event
         where organization_id = ${ORG} and provider = 'ai-field' and idempotency_key = 'resume-flush'`;
      if (mark?.response_payload.writing) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(mark).toMatchObject({ status: "in_flight", response_payload: { writing: "Shut off the gas first." } });
    const resumed = dispatch(ask({ "idempotency-key": "resume-flush", "last-event-id": sentence.id! }), deps(["owner"]));
    await new Promise((resolve) => setTimeout(resolve, 900));
    release!();

    const joined = await rest(eventsOf(await resumed));
    /** Nothing the client already had: every sentence sent is longer than the id it gave, and the first is never sent again. */
    expect(joined.filter((e) => e.event === "writing").every((e) => Number(e.id) > Number(sentence.id))).toBe(true);
    expect(JSON.stringify(joined)).not.toContain('"text":"Shut off the gas first."}');
    expect(joined.at(-1)).toEqual({
      event: "answer", id: "answer",
      data: { answered: true, text: ANSWER.answer, sources: [{ kind: "procedure", title: "Flushing a water heater" }] },
    });
    const finished = await rest(firstEvents);
    expect(finished.at(-1)).toEqual(joined.at(-1));
    expect(asked).toBe(before + 1);
    const [done] = await raw<{ status: string }[]>`
      select status from public.integration_event where organization_id = ${ORG} and provider = 'ai-field' and idempotency_key = 'resume-flush'`;
    expect(done!.status).toBe("succeeded");
  });

  it("answers a resume after the answer from the record, as one event with its id", async () => {
    const before = asked;
    const again = await rest(eventsOf(await dispatch(ask({ "idempotency-key": "resume-flush", "last-event-id": "answer" }), deps(["owner"]))));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ event: "answer", id: "answer" });
    expect(asked).toBe(before);
  });

  it("takes over a mark nobody has written to for two minutes, and asks again", async () => {
    script = { tool: "answer", input: ANSWER };
    await raw`insert into public.integration_event (organization_id, direction, provider, event_type, idempotency_key, status, response_payload, updated_at)
              values (${ORG}, 'inbound', 'ai-field', 'answer.writing', 'resume-stale', 'in_flight', '{"writing":"Shut off"}'::jsonb, now() - interval '5 minutes')`;
    const before = asked;
    const events = await rest(eventsOf(await dispatch(ask({ "idempotency-key": "resume-stale" }), deps(["owner"]))));
    expect(events.at(-1)).toMatchObject({ event: "answer", data: { answered: true } });
    expect(asked).toBe(before + 1);
  });

  it("asks again on a retry after a first request that failed, rather than joining nothing", async () => {
    await agents.configure(owner(), { agent: "field", settings: { ...coreAgents.defaultSettings("field"), enabled: false, runAsUserId: OWNER } });
    const off = await dispatch(ask({ "idempotency-key": "resume-failed" }), deps(["owner"]));
    expect(off.status).toBe(409);
    const [failed] = await raw<{ status: string }[]>`
      select status from public.integration_event where organization_id = ${ORG} and provider = 'ai-field' and idempotency_key = 'resume-failed'`;
    expect(failed!.status).toBe("failed");
    await agents.configure(owner(), { agent: "field", settings: { ...coreAgents.defaultSettings("field"), enabled: true, runAsUserId: OWNER } });
    script = { tool: "answer", input: ANSWER };
    const events = await rest(eventsOf(await dispatch(ask({ "idempotency-key": "resume-failed" }), deps(["owner"]))));
    expect(events.at(-1)).toMatchObject({ event: "answer", data: { answered: true } });
  });
});

const VISITOR = "198.51.100.171";
const say = (token: string, text: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/public/chat/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": VISITOR, ...STREAM, ...headers },
    body: JSON.stringify({ companyKey: SLUG, token, text }),
  });

run("a website chat reply asked again while it is written", () => {
  it("joins the reply for the same message again, and the visitor's words and the reply are each kept once", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG }, { ip: VISITOR });
    const input = { text: "A water heater repair visit is $149. We can come tomorrow morning. Shall I book it?" };
    script = { tool: "reply", input, holdAfter: pieceAfter(pieces(input), "A water heater repair visit is $149.") };
    release = null;
    const before = asked;
    const first = await dispatch(say(opened.token, "how much for a water heater?", { "idempotency-key": "resume-chat-1" }), deps(null));
    const firstEvents = eventsOf(first);
    const sentence = (await firstEvents.next()).value as Event;
    expect(sentence).toMatchObject({ event: "writing", id: String("A water heater repair visit is $149.".length) });
    await held();

    const resumed = dispatch(say(opened.token, "how much for a water heater?", {
      "idempotency-key": "resume-chat-1", "last-event-id": sentence.id!,
    }), deps(null));
    await new Promise((resolve) => setTimeout(resolve, 900));
    release!();
    const joined = await rest(eventsOf(await resumed));
    expect(joined.filter((e) => e.event === "writing").every((e) => Number(e.id) > Number(sentence.id))).toBe(true);
    const transcript = joined.at(-1)!;
    expect(transcript).toMatchObject({ event: "answer", id: "answer" });
    const messages = (transcript.data as { messages: Array<{ from: string; text: string }> }).messages;
    expect(messages.filter((m) => m.text === "how much for a water heater?")).toHaveLength(1);
    expect(messages.filter((m) => m.from === "assistant" && m.text.includes("Shall I book it?"))).toHaveLength(1);
    await rest(firstEvents);
    expect(asked).toBe(before + 1);
  });
});
