import {
  registerAiProvider, fetchTransport, withoutSecret, retryableStatus,
  asArray, asObject, num, str, rateFromSettings,
  type AiContent, type AiProvider, type CompletionOutcome, type CompletionRequest,
  type HttpTransport, type ModelListOutcome, type ModelRate, type StopReason,
} from "./provider";

/**
 * OPENAI, THE CHAT COMPLETIONS API
 *
 * Written against the HTTP API directly rather than the SDK, for the reasons
 * the seam gives. Nothing else imports this file; it registers itself.
 *
 * WHY CHAT COMPLETIONS AND NOT RESPONSES.
 *
 * OpenAI now offers two shapes for the same thing. Responses is the newer
 * one and carries server side conversation state, which is the part that
 * makes it the wrong choice here: this product keeps the conversation, and a
 * shape that stores the company's prompts on a vendor's server by default is
 * a data residency decision that a self hoster did not get asked about.
 * Chat completions is stateless, is what every compatible gateway speaks, and
 * is what an operator pointing this at their own inference endpoint already
 * has.
 *
 * THREE PLACES THIS VENDOR DOES NOT LINE UP WITH THE SEAM, HANDLED HERE
 * RATHER THAN PAPERED OVER.
 *
 * A TOOL RESULT CANNOT BE MARKED AS AN ERROR. OpenAI's `tool` message has a
 * `tool_call_id` and a string, and nothing else. So a failed tool result is
 * prefixed in the text the model reads. The model is told; the wire format
 * carries no flag, which is why the seam keeps `isError` as a field of ours.
 *
 * TOOL ARGUMENTS ARRIVE AS A STRING, not an object, and the string is
 * produced by a model. It can be invalid JSON, and it can be a valid JSON
 * value that is not an object. Both are handled below as what they are: a
 * tool call this adapter could not read, reported rather than passed up as
 * an empty input that a tool would then run with its defaults.
 *
 * `max_tokens` IS NOT THE FIELD ANY MORE. The current models reject it and
 * take `max_completion_tokens`, and the difference matters because the
 * rejected field is a 400 on a request that looks correct.
 */

interface OpenAiSettings {
  /** Override for testing, and for a deployment pointing at a compatible gateway. */
  baseUrl?: string;
  /** Required in practice. See `defaultModel` below for why there is no fallback. */
  defaultModel?: string;
  /** The operator's own organization, where their account has several. */
  organization?: string;
  rates?: Record<string, unknown>;
}

const API = "https://api.openai.com/v1";

function stopFrom(reason: string | null): StopReason {
  if (reason === "stop") return "end";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "length") return "maxTokens";
  /** A content filter stop is the vendor declining, not a transport failure. */
  if (reason === "content_filter") return "refused";
  return "other";
}

/**
 * Our conversation, as OpenAI's message list.
 *
 * The shape is flatter than ours: a tool result is its own message with role
 * `tool` rather than a block inside a user turn, so one of our messages can
 * become several of theirs. That is why this returns a list and appends
 * rather than mapping one to one.
 */
function messagesFor(system: string | undefined, messages: readonly { role: string; content: AiContent[] }[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    const text: string[] = [];
    const toolCalls: unknown[] = [];

    for (const part of message.content) {
      if (part.type === "text") {
        text.push(part.text);
      } else if (part.type === "toolCall") {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part.type === "toolResult") {
        /**
         * Held back and emitted after this message's own turn, because a tool
         * message has to follow the assistant message that asked for it. Our
         * shape puts tool results in the user turn that answers the assistant
         * turn, so the ordering already holds; emitting them in place would
         * put a `tool` message before the assistant message in the same turn.
         */
        continue;
      }
      /** A vendorState block from another vendor is dropped. See the seam. */
    }

    /**
     * Tool results first, because they answer the assistant turn BEFORE this
     * one. An out of order tool message is a 400 from the vendor that reads
     * as a malformed conversation.
     */
    for (const part of message.content) {
      if (part.type !== "toolResult") continue;
      out.push({
        role: "tool",
        tool_call_id: part.callId,
        /**
         * The error marker lives in the text because the vendor has nowhere
         * else to put it. Without it a failed tool reads to the model as a
         * tool that returned that sentence as its answer.
         */
        content: part.isError ? `ERROR: ${part.result}` : part.result,
      });
    }

    const body = text.join("");
    if (message.role === "assistant") {
      if (body === "" && toolCalls.length === 0) continue;
      out.push({
        role: "assistant",
        content: body === "" ? null : body,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (body !== "") {
      out.push({ role: "user", content: body });
    }
  }

  return out;
}

export function openAiProvider(
  settings: OpenAiSettings,
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
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(settings.organization ? { "openai-organization": settings.organization } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = asObject(JSON.parse(text)) ?? {};
    } catch {
      json = { error: { message: clean(text).slice(0, 500) } };
    }
    return { status: response.status, json };
  }

  const failure = (status: number, json: Record<string, unknown>) => {
    const error = asObject(json["error"]);
    return {
      ok: false as const,
      code: str(error?.["code"]) ?? str(error?.["type"]) ?? `http_${status}`,
      message: clean(str(error?.["message"]) ?? `OpenAI answered ${status}.`),
      retryable: retryableStatus(status),
    };
  };

  return {
    name: "openai",
    toolCallIdentity: { kind: "vendor" },
    /**
     * NO FALLBACK MODEL, AND THAT IS THE HONEST ANSWER RATHER THAN A GAP.
     *
     * This repository holds a dated, checked reference for one vendor's
     * model names and prices and does not hold one for this vendor. A default
     * written from memory is either a name that no longer exists, which an
     * operator reads as a broken integration, or a real model that is not the
     * one they meant to be billed for. So the operator names the model, and
     * the service says so when they have not.
     */
    defaultModel: settings.defaultModel ?? null,

    /**
     * Operator rates only, for the same reason.
     *
     * A price table copied from memory would be a number with money on it
     * that nobody checked. The connection settings carry the operator's own
     * rates, and the spend ceiling refuses rather than running a call it
     * cannot price.
     */
    rateFor(model: string): ModelRate | null {
      return rateFromSettings(settings as Record<string, unknown>, model);
    },

    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      const { status, json } = await call("/chat/completions", "POST", {
        model: request.model,
        messages: messagesFor(request.system, request.messages),
        /** Not `max_tokens`: the current models reject that field outright. */
        max_completion_tokens: request.maxOutputTokens,
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      });

      if (status < 200 || status >= 300) return failure(status, json);

      const choice = asObject(asArray(json["choices"])[0]);
      const message = asObject(choice?.["message"]);
      if (!message) {
        return {
          ok: false,
          code: "no_choice",
          message: "OpenAI accepted the request and returned no answer to read.",
          retryable: false,
        };
      }

      const content: AiContent[] = [];
      const text = str(message["content"]);
      if (text) content.push({ type: "text", text });

      for (const raw of asArray(message["tool_calls"])) {
        const row = asObject(raw);
        const fn = asObject(row?.["function"]);
        const id = str(row?.["id"]);
        const name = str(fn?.["name"]);
        if (!id || !name) continue;

        /**
         * The arguments are a STRING a model wrote, so they are parsed rather
         * than trusted, and a failure is reported rather than smoothed over.
         *
         * An unparseable call handed up as an empty input would be a tool
         * invoked with none of the arguments the model intended, which for a
         * tool that takes an optional filter means it runs against everything.
         */
        let input: Record<string, unknown> | null = null;
        try {
          input = asObject(JSON.parse(str(fn?.["arguments"]) ?? "{}"));
        } catch {
          input = null;
        }
        if (!input) {
          return {
            ok: false,
            code: "unreadable_tool_arguments",
            message:
              `OpenAI asked to call ${name} with arguments that are not a JSON object. `
              + "The call was not run, because running it with no arguments is not the same request.",
            retryable: false,
          };
        }

        content.push({ type: "toolCall", callId: id, name, input });
      }

      const usage = asObject(json["usage"]);
      const inputTokens = num(usage?.["prompt_tokens"]);
      const outputTokens = num(usage?.["completion_tokens"]);
      if (inputTokens === null || outputTokens === null) {
        return {
          ok: false,
          code: "no_usage",
          message: "OpenAI answered without reporting token usage, so this call cannot be costed.",
          retryable: false,
        };
      }

      /**
       * A refusal is its own field on this vendor, separate from the finish
       * reason, and it is a stronger signal: the model declined rather than
       * being cut off by a filter after the fact.
       */
      const refused = str(message["refusal"]) !== null;

      return {
        ok: true,
        completion: {
          model: str(json["model"]) ?? request.model,
          content,
          stop: refused ? "refused" : stopFrom(str(choice?.["finish_reason"])),
          usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens: num(asObject(usage?.["prompt_tokens_details"])?.["cached_tokens"]),
          },
        },
      };
    },

    async models(): Promise<ModelListOutcome> {
      const { status, json } = await call("/models", "GET");
      if (status < 200 || status >= 300) return failure(status, json);

      const models = asArray(json["data"]).flatMap((raw) => {
        const row = asObject(raw);
        const id = str(row?.["id"]);
        if (!id) return [];
        /** This vendor's list carries no display name, so the id is the label. */
        return [{ id, label: id }];
      });
      return { ok: true, models };
    },
  };
}

registerAiProvider("openai", (settings, secret) =>
  openAiProvider(settings as OpenAiSettings, secret));
