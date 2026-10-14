import { describe, it, expect } from "vitest";
import { anthropicProvider } from "../src/ai/anthropic";
import { openAiProvider } from "../src/ai/openai";
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
