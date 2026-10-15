import { describe, it, expect } from "vitest";
import { anthropicProvider } from "../src/ai/anthropic";
import { openAiProvider } from "../src/ai/openai";
import { googleProvider } from "../src/ai/google";
import type { CompletionRequest, HttpResponse, HttpTransport, StreamDelta } from "../src/ai/provider";

/**
 * A MODEL'S ANSWER, STREAMED
 *
 * Anthropic's and OpenAI's streamed answers, read from server sent events
 * arriving in pieces that do not line up with the events, put back together
 * into the same answer the whole request would have had and held to the same
 * checks: usage required, a tool's arguments parsed rather than trusted. Each
 * piece is handed on as it arrives. A vendor or gateway that answers a
 * streamed request in one piece is read as one piece.
 *
 * NO TEST HERE REACHES A VENDOR. The transport is a fake that hands the body
 * back a few characters at a time.
 */

const SECRET = "sk-not-a-real-key-for-streaming";
const request: CompletionRequest = {
  model: "test-model",
  system: "Answer.",
  messages: [{ role: "user", content: [{ type: "text", text: "How much?" }] }],
  tools: [{ name: "reply", description: "Say something.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
  maxOutputTokens: 200,
};

/** A transport answering with this body, split into pieces of `size` characters. */
function streaming(body: string, size = 7, contentType = "text/event-stream") {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const transport: HttpTransport = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
    const response: HttpResponse = {
      status: 200,
      text: async () => body,
      contentType,
      chunks: async function* () {
        for (let i = 0; i < body.length; i += size) yield body.slice(i, i + size);
      },
    };
    return response;
  };
  return { transport, sent };
}

const sse = (events: [string | null, unknown][]) =>
  events.map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("");

describe("Anthropic, streamed", () => {
  const body = sse([
    ["message_start", { type: "message_start", message: { model: "test-model-1", usage: { input_tokens: 120, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "reply", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text": "It is ' } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '$149. Shall I book?"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }],
    ["message_stop", { type: "message_stop" }],
  ]);

  it("hands on the tool call as it is written, and answers with the whole of it", async () => {
    const { transport, sent } = streaming(body);
    const deltas: StreamDelta[] = [];
    const outcome = await anthropicProvider({ baseUrl: "https://claude.test" }, SECRET, transport).stream!(request, (d) => deltas.push(d));
    expect(sent[0]!.body["stream"]).toBe(true);
    expect(deltas[0]).toEqual({ type: "toolStart", index: 0, name: "reply" });
    expect(deltas.filter((d) => d.type === "toolInput").map((d) => (d as { partialJson: string }).partialJson).join(""))
      .toBe('{"text": "It is $149. Shall I book?"}');
    expect(outcome).toEqual({
      ok: true,
      completion: {
        model: "test-model-1", stop: "toolUse",
        content: [{ type: "toolCall", callId: "toolu_1", name: "reply", input: { text: "It is $149. Shall I book?" } }],
        usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: null },
      },
    });
  });

  it("fails an answer whose usage never came, as a whole one would", async () => {
    const cut = body.replace(/"usage":\{[^}]*\}/g, '"usage":{}');
    const outcome = await anthropicProvider({}, SECRET, streaming(cut).transport).stream!(request, () => {});
    expect(outcome).toMatchObject({ ok: false, code: "no_usage" });
  });

  it("fails an answer whose tool arguments are not JSON, rather than running it with none", async () => {
    const broken = body.replace("Shall I book?\\\"}", "Shall I");
    const outcome = await anthropicProvider({}, SECRET, streaming(broken).transport).stream!(request, () => {});
    expect(outcome).toMatchObject({ ok: false, code: "unreadable_tool_arguments" });
  });

  it("reads an answer that came back whole as a whole answer", async () => {
    const whole = JSON.stringify({
      model: "test-model", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 },
      content: [{ type: "text", text: "Hello." }],
    });
    const outcome = await anthropicProvider({}, SECRET, streaming(whole, 7, "application/json").transport).stream!(request, () => {});
    expect(outcome).toMatchObject({ ok: true, completion: { content: [{ type: "text", text: "Hello." }] } });
  });
});

describe("OpenAI, streamed", () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    [null, { model: "gpt-test", choices: [{ index: 0, delta, finish_reason: null }], ...extra }] as [null, unknown];
  const body = sse([
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "reply", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":"We open ' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'at seven."}' } }] }),
    [null, { model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
    [null, { model: "gpt-test", choices: [], usage: { prompt_tokens: 80, completion_tokens: 12 } }],
    [null, "[DONE]"],
  ]);

  it("asks for usage on the last chunk, hands on the arguments as they come, and answers whole", async () => {
    const { transport, sent } = streaming(body, 11);
    const deltas: StreamDelta[] = [];
    const outcome = await openAiProvider({ baseUrl: "https://openai.test" }, SECRET, transport).stream!(request, (d) => deltas.push(d));
    expect(sent[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas[0]).toEqual({ type: "toolStart", index: 0, name: "reply" });
    expect(outcome).toEqual({
      ok: true,
      completion: {
        model: "gpt-test", stop: "toolUse",
        content: [{ type: "toolCall", callId: "call_1", name: "reply", input: { text: "We open at seven." } }],
        usage: { inputTokens: 80, outputTokens: 12, cachedInputTokens: null },
      },
    });
  });
});

/**
 * Google's `streamGenerateContent?alt=sse`: every event a
 * `GenerateContentResponse` with the next parts, usage reported as it grows.
 * Text arrives in pieces; Google documents a function call only whole, so it
 * is handed on in one piece when its event comes.
 */
describe("Google, streamed", () => {
  const event = (parts: unknown[], extra: Record<string, unknown> = {}) =>
    [null, { candidates: [{ content: { role: "model", parts }, index: 0 }], modelVersion: "gemini-test-001", ...extra }] as [null, unknown];

  it("asks the streaming method with the key in a header, hands on text as it comes, and answers whole", async () => {
    const body = sse([
      event([{ text: "We open " }], { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2 } }),
      event([{ text: "at seven." }]),
      [null, { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } }],
    ]);
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const { transport } = streaming(body, 13);
    const watching: HttpTransport = async (url, init) => { sent.push({ url, headers: init.headers }); return transport(url, init); };
    const deltas: StreamDelta[] = [];
    const outcome = await googleProvider({ baseUrl: "https://gemini.test/v1beta" }, SECRET, watching).stream!(request, (d) => deltas.push(d));
    expect(sent[0]!.url).toBe("https://gemini.test/v1beta/models/test-model:streamGenerateContent?alt=sse");
    expect(sent[0]!.url).not.toContain(SECRET);
    expect(sent[0]!.headers["x-goog-api-key"]).toBe(SECRET);
    expect(deltas).toEqual([{ type: "text", text: "We open " }, { type: "text", text: "at seven." }]);
    expect(outcome).toEqual({
      ok: true,
      completion: {
        model: "gemini-test-001", stop: "end",
        content: [{ type: "text", text: "We open at seven." }],
        usage: { inputTokens: 40, outputTokens: 9, cachedInputTokens: null },
      },
    });
  });

  it("hands on a function call in one piece when it arrives, and answers with it as a tool call", async () => {
    const body = sse([
      event([{ functionCall: { name: "reply", args: { text: "It is $149. Shall I book?" } } }], { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 } }),
      [null, { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 } }],
    ]);
    const deltas: StreamDelta[] = [];
    const outcome = await googleProvider({}, SECRET, streaming(body).transport).stream!(request, (d) => deltas.push(d));
    expect(deltas).toEqual([
      { type: "toolStart", index: 0, name: "reply" },
      { type: "toolInput", index: 0, partialJson: '{"text":"It is $149. Shall I book?"}' },
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      completion: {
        stop: "toolUse",
        content: [{ type: "toolCall", callId: "gemini-0-reply", name: "reply", input: { text: "It is $149. Shall I book?" } }],
      },
    });
  });

  it("fails an answer whose usage never came, and a blocked prompt, as whole ones would", async () => {
    const noUsage = sse([event([{ text: "Hello." }], { candidates: [{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" }] })]);
    expect(await googleProvider({}, SECRET, streaming(noUsage).transport).stream!(request, () => {}))
      .toMatchObject({ ok: false, code: "no_usage" });
    const blocked = sse([[null, { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 9 } }]]);
    expect(await googleProvider({}, SECRET, streaming(blocked).transport).stream!(request, () => {}))
      .toMatchObject({ ok: false, code: "blocked_safety" });
  });

  it("fails on an error sent in the middle of the stream, without the key in what it says", async () => {
    const body = sse([
      event([{ text: "We open " }], { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2 } }),
      [null, { error: { code: 503, status: "UNAVAILABLE", message: `The model is overloaded for ${SECRET}.` } }],
    ]);
    const outcome = await googleProvider({}, SECRET, streaming(body).transport).stream!(request, () => {});
    expect(outcome).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("reads an answer that came back whole, or an error status, the ordinary way", async () => {
    const whole = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    expect(await googleProvider({}, SECRET, streaming(whole, 7, "application/json").transport).stream!(request, () => {}))
      .toMatchObject({ ok: true, completion: { content: [{ type: "text", text: "Hello." }] } });
    const refused: HttpTransport = async () => ({
      status: 429, contentType: "application/json",
      text: async () => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Slow down." } }),
    });
    expect(await googleProvider({}, SECRET, refused).stream!(request, () => {}))
      .toMatchObject({ ok: false, code: "RESOURCE_EXHAUSTED", retryable: true });
  });
});
