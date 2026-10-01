import {
  registerAiProvider, fetchTransport, withoutSecret, retryableStatus,
  asArray, asObject, num, str, rateFromSettings,
  type AiContent, type AiProvider, type CompletionOutcome, type CompletionRequest,
  type HttpTransport, type ModelListOutcome, type ModelRate, type StopReason,
} from "./provider";

/**
 * ANTHROPIC, THE MESSAGES API
 *
 * Written against the HTTP API directly rather than the SDK, for the reasons
 * the seam gives. Nothing else in the codebase imports this file: it
 * registers itself, and a deployment using a different vendor never loads it.
 *
 * THE KEY IS THE OPERATOR'S OWN, and it is a workspace key rather than an
 * admin key. The setup note for this connector asks for one scoped to a
 * workspace the operator made for this product, which costs them a minute in
 * a console and means a key taken off a self hosted box can spend that
 * workspace's budget and cannot read the rest of their organization or mint
 * further keys.
 *
 * WHAT THIS ADAPTER DELIBERATELY DOES NOT SEND.
 *
 * It does not send a `thinking` configuration. On the current models thinking
 * is on by default and cannot be switched off, and on the ones where it can
 * be, disabling it is a known way to get a tool call written into the visible
 * text where nothing will ever run it. Leaving the field out is both the
 * documented default and the safe answer.
 *
 * It does not send `tool_choice`. Forcing a tool returns a 400 on the current
 * models, and the one thing this product wants from a tool call is that the
 * model decided it was needed.
 *
 * It does not stream. See the seam.
 */

interface AnthropicSettings {
  /** Override for testing, and for a deployment behind its own gateway. */
  baseUrl?: string;
  /** Used when the operator has not named a model on the connection. */
  defaultModel?: string;
  rates?: Record<string, unknown>;
}

const API = "https://api.anthropic.com";

/**
 * The API version header, pinned.
 *
 * Anthropic versions by date and keeps old versions working. Pinning means a
 * change on their side is something this file opts into on a day somebody
 * reads the changelog, rather than something that arrives in a deployment
 * nobody touched.
 */
const VERSION = "2023-06-01";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * What Anthropic charges, in millionths of a dollar per token.
 *
 * A dollar per million tokens is one micro-dollar per token, so these numbers
 * are the published per-million-token prices unchanged.
 *
 * `RATES_AS_OF` is not decoration. Published prices move, this table is a copy
 * of them, and a copy with no date on it is a number a reader has no way to
 * judge. An operator whose invoice disagrees with the estimate puts their own
 * rate on the connection, which wins over everything here.
 *
 * A model missing from this table prices as null rather than as something
 * plausible from the same family. The families do not share a price: two
 * models here are five times the cost of two others.
 */
export const RATES_AS_OF = "2026-09-25";

const RATES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Anthropic's stop reasons, mapped.
 *
 * Anything unrecognised becomes `other` rather than being guessed at.
 * `pause_turn` is the live example: it means a server side tool is still
 * working and the turn should be continued, which is neither an ending nor a
 * tool call this product can run, and calling it `end` would show a user a
 * half finished answer as the final one.
 */
function stopFrom(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "maxTokens";
  if (reason === "refusal") return "refused";
  return "other";
}

/**
 * Our content, as Anthropic's blocks.
 *
 * `vendorState` blocks are sent back unchanged when they came from here, and
 * dropped when they came from somebody else. The reasoning blocks the current
 * models return have to be echoed back for a tool loop to continue correctly,
 * and an OpenAI block in this array would be a 400 with a vendor's own
 * wording on it.
 */
function blocksFor(content: AiContent[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      /**
       * An empty text block is dropped rather than sent. The API refuses one,
       * and they turn up honestly: a turn where the model only called a tool
       * has no text in it.
       */
      if (part.text === "") continue;
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "toolCall") {
      blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input });
    } else if (part.type === "toolResult") {
      blocks.push({
        type: "tool_result",
        tool_use_id: part.callId,
        content: part.result,
        is_error: part.isError,
      });
    } else if (part.vendor === "anthropic") {
      blocks.push(part.block);
    }
  }
  return blocks;
}

/** Anthropic's blocks, as ours. */
function contentFrom(blocks: unknown[]): AiContent[] {
  const content: AiContent[] = [];
  for (const raw of blocks) {
    const block = asObject(raw);
    if (!block) continue;
    const type = str(block["type"]);
    if (type === "text") {
      content.push({ type: "text", text: str(block["text"]) ?? "" });
    } else if (type === "tool_use") {
      const id = str(block["id"]);
      const name = str(block["name"]);
      if (!id || !name) continue;
      content.push({
        type: "toolCall", callId: id, name,
        input: asObject(block["input"]) ?? {},
      });
    } else if (type === "thinking" || type === "redacted_thinking") {
      /**
       * Carried, not read.
       *
       * These are the blocks the model needs back on the next turn of a tool
       * loop. Dropping them loses the reasoning that produced the tool call,
       * and on the newest models an assistant turn that arrives without them
       * is an edited turn, which is refused.
       */
      content.push({ type: "vendorState", vendor: "anthropic", block });
    }
  }
  return content;
}

export function anthropicProvider(
  settings: AnthropicSettings,
  apiKey: string,
  transport: HttpTransport = fetchTransport,
): AiProvider {
  const base = settings.baseUrl ?? API;
  const clean = (text: string): string => withoutSecret(text, apiKey);

  async function call(
    path: string, method: "GET" | "POST", body?: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await transport(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": VERSION,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = asObject(JSON.parse(text)) ?? {};
    } catch {
      /** Not JSON. A gateway's HTML error page, usually. Truncated and scrubbed. */
      json = { error: { message: clean(text).slice(0, 500) } };
    }
    return { status: response.status, json };
  }

  const failure = (status: number, json: Record<string, unknown>) => {
    const error = asObject(json["error"]);
    return {
      ok: false as const,
      code: str(error?.["type"]) ?? `http_${status}`,
      /**
       * The vendor's own sentence, scrubbed. It says the useful thing: which
       * field was wrong, that the key is revoked, that the account has no
       * credit. Replacing it with "the call failed" throws away the only part
       * an operator can act on.
       */
      message: clean(str(error?.["message"]) ?? `Anthropic answered ${status}.`),
      retryable: retryableStatus(status),
    };
  };

  return {
    name: "anthropic",
    toolCallIdentity: { kind: "vendor" },
    defaultModel: settings.defaultModel ?? ANTHROPIC_DEFAULT_MODEL,

    rateFor(model: string): ModelRate | null {
      const operator = rateFromSettings(settings as Record<string, unknown>, model);
      if (operator) return operator;
      const published = RATES[model];
      if (!published) return null;
      return {
        inputMicrosPerToken: published.input,
        outputMicrosPerToken: published.output,
        source: "adapter",
        asOf: RATES_AS_OF,
      };
    },

    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      const { status, json } = await call("/v1/messages", "POST", {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: blocksFor(message.content),
        })),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      });

      if (status < 200 || status >= 300) return failure(status, json);

      /**
       * USAGE IS REQUIRED, and a response without it is a failure rather than
       * a success reporting nothing.
       *
       * Reporting zero would be a claim that the call was free. An operator
       * whose ceiling is built on these numbers would watch it stay still
       * while the vendor's meter moved, which is the exact surprise this
       * whole module exists to prevent. Not retryable: the call was made and
       * billed, and asking again spends twice to learn the same thing.
       */
      const usage = asObject(json["usage"]);
      const inputTokens = num(usage?.["input_tokens"]);
      const outputTokens = num(usage?.["output_tokens"]);
      if (inputTokens === null || outputTokens === null) {
        return {
          ok: false,
          code: "no_usage",
          message: "Anthropic answered without reporting token usage, so this call cannot be costed.",
          retryable: false,
        };
      }

      return {
        ok: true,
        completion: {
          model: str(json["model"]) ?? request.model,
          content: contentFrom(asArray(json["content"])),
          stop: stopFrom(str(json["stop_reason"])),
          usage: {
            inputTokens,
            outputTokens,
            /**
             * Null when absent rather than zero. Anthropic reports a cache
             * read only on a request that used the cache, and zero is the
             * different, stronger claim that it was asked and missed.
             */
            cachedInputTokens: num(usage?.["cache_read_input_tokens"]),
          },
        },
      };
    },

    async models(): Promise<ModelListOutcome> {
      const { status, json } = await call("/v1/models", "GET");
      if (status < 200 || status >= 300) return failure(status, json);

      const models = asArray(json["data"]).flatMap((raw) => {
        const row = asObject(raw);
        const id = str(row?.["id"]);
        if (!id) return [];
        return [{ id, label: str(row?.["display_name"]) ?? id }];
      });
      return { ok: true, models };
    },
  };
}

registerAiProvider("anthropic", (settings, secret) =>
  anthropicProvider(settings as AnthropicSettings, secret));
