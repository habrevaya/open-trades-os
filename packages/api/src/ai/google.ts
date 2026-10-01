import {
  registerAiProvider, fetchTransport, withoutSecret, retryableStatus,
  asArray, asObject, num, str, rateFromSettings,
  type AiContent, type AiProvider, type CompletionOutcome, type CompletionRequest,
  type HttpTransport, type ModelListOutcome, type ModelRate, type StopReason,
} from "./provider";

/**
 * GOOGLE, THE GEMINI generateContent API
 *
 * Written against the HTTP API directly rather than the SDK, for the reasons
 * the seam gives. Nothing else imports this file; it registers itself.
 *
 * THE KEY GOES IN A HEADER, NOT IN THE QUERY STRING.
 *
 * Google's own documentation puts the API key in the URL as `?key=...`, and
 * that is the one thing in this file worth arguing about. A URL is logged
 * everywhere by default: by a forward proxy, by a reverse proxy, by the
 * vendor, by whatever sits between a self hosted box and the internet, and by
 * this process if anybody ever logs a failing request. A header is logged by
 * far fewer of those and by none of them accidentally. `x-goog-api-key` is
 * supported on the same endpoints and is what this adapter uses.
 *
 * THREE PLACES THIS VENDOR DOES NOT LINE UP WITH THE SEAM.
 *
 * A FUNCTION CALL HAS NO ID. Anthropic and OpenAI both mint one per tool call
 * and expect it back; Gemini's `functionCall` is a name and arguments. So
 * this adapter declares `toolCallIdentity: synthetic`, mints ids of its own
 * so callers above the seam can work one way, and matches results back by
 * NAME on the way down, which is what the vendor matches on. The thing that
 * genuinely does not survive: two calls to the same tool in one turn are
 * distinct above this seam and are not distinct to the vendor, which pairs
 * their results in order.
 *
 * A TOOL RESULT CANNOT BE MARKED AS AN ERROR, the same as OpenAI. The failure
 * goes into the response object the model reads.
 *
 * THE FUNCTION SCHEMA IS AN OPENAPI SUBSET, not full JSON Schema. This
 * adapter passes the tool's schema through unchanged, so a schema using a
 * keyword Gemini does not accept fails at the vendor with the vendor's own
 * message. Stripping the unsupported keywords here would be quieter and
 * worse: it would change what the model is told a tool accepts, and the model
 * would then call it with arguments the tool refuses.
 */

interface GoogleSettings {
  /** Override for testing, and for a deployment behind its own gateway. */
  baseUrl?: string;
  /** Required in practice. See `defaultModel` for why there is no fallback. */
  defaultModel?: string;
  rates?: Record<string, unknown>;
}

const API = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The prefix Gemini puts on every model name in its own list, and takes in
 * its own paths.
 *
 * Stripped on the way out and added on the way in, so an id from `models()`
 * can be handed straight back to `complete()`. Leaving it on would produce
 * `models/models/gemini-x` in a URL and a 404 that reads like the model was
 * withdrawn.
 */
const PREFIX = "models/";

const bare = (name: string): string => name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;

function stopFrom(reason: string | null): StopReason {
  if (reason === "STOP") return "end";
  if (reason === "MAX_TOKENS") return "maxTokens";
  /**
   * Four different ways this vendor says it declined, and they are all
   * refusals rather than failures: the call was made and billed.
   */
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST"
    || reason === "PROHIBITED_CONTENT" || reason === "SPII") return "refused";
  return "other";
}

/** Our conversation, as Gemini's `contents`. */
function contentsFor(messages: readonly { role: string; content: AiContent[] }[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text === "") continue;
        parts.push({ text: part.text });
      } else if (part.type === "toolCall") {
        /** The id is ours and the vendor has no field for it, so it is dropped. */
        parts.push({ functionCall: { name: part.name, args: part.input } });
      } else if (part.type === "toolResult") {
        parts.push({
          functionResponse: {
            /** Matched by NAME. This is the field that makes the loop work here. */
            name: part.name,
            /**
             * The response has to be an object. A failure is reported under
             * its own key rather than as text, because that is the closest
             * this vendor comes to an error flag and the model reads the key.
             */
            response: part.isError ? { error: part.result } : { result: part.result },
          },
        });
      }
      /** A vendorState block belongs to another vendor; it is dropped. */
    }
    if (parts.length === 0) continue;
    /** Gemini calls the assistant `model`. Everything else is `user`. */
    out.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return out;
}

export function googleProvider(
  settings: GoogleSettings,
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
        /** In a header rather than the URL. See the note at the top of the file. */
        "x-goog-api-key": apiKey,
        "content-type": "application/json",
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
      code: str(error?.["status"]) ?? `http_${status}`,
      message: clean(str(error?.["message"]) ?? `Google answered ${status}.`),
      retryable: retryableStatus(status),
    };
  };

  return {
    name: "google",
    toolCallIdentity: {
      kind: "synthetic",
      because:
        "Gemini identifies a function call by name and issues no id of its own, so this "
        + "connection mints one. Results are matched back by name, which is what the vendor "
        + "matches on, so two calls to the same tool in one turn are paired in order rather "
        + "than by id.",
    },
    /** No guessed default, for the reason the OpenAI adapter states. */
    defaultModel: settings.defaultModel ?? null,
    /** Operator rates only, for the reason the OpenAI adapter states. */
    rateFor(model: string): ModelRate | null {
      return rateFromSettings(settings as Record<string, unknown>, model);
    },

    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      const model = bare(request.model);
      const { status, json } = await call(
        `/${PREFIX}${encodeURIComponent(model)}:generateContent`, "POST", {
          contents: contentsFor(request.messages),
          ...(request.system
            ? { systemInstruction: { parts: [{ text: request.system }] } }
            : {}),
          generationConfig: { maxOutputTokens: request.maxOutputTokens },
          ...(request.tools && request.tools.length > 0
            ? {
                tools: [{
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  })),
                }],
              }
            : {}),
        });

      if (status < 200 || status >= 300) return failure(status, json);

      const candidate = asObject(asArray(json["candidates"])[0]);
      /**
       * NO CANDIDATE IS A REFUSAL, NOT AN EMPTY ANSWER.
       *
       * Gemini answers a blocked prompt with 200, no candidates, and a
       * `promptFeedback.blockReason`. Returning that as an empty success
       * would show a user a blank answer and tell them nothing, and it is the
       * single most common way this vendor says no.
       */
      if (!candidate) {
        const reason = str(asObject(json["promptFeedback"])?.["blockReason"]);
        return {
          ok: false,
          code: reason ? `blocked_${reason.toLowerCase()}` : "no_candidate",
          message: reason
            ? `Gemini declined to answer: ${reason}.`
            : "Gemini accepted the request and returned no answer to read.",
          retryable: false,
        };
      }

      const content: AiContent[] = [];
      let callIndex = 0;
      for (const raw of asArray(asObject(candidate["content"])?.["parts"])) {
        const part = asObject(raw);
        if (!part) continue;
        const text = str(part["text"]);
        if (text) {
          content.push({ type: "text", text });
          continue;
        }
        const fn = asObject(part["functionCall"]);
        const name = str(fn?.["name"]);
        if (!name) continue;
        content.push({
          type: "toolCall",
          /**
           * Minted here, because the vendor issues none. The name is in it so
           * a human reading a log can see which tool a call belongs to, and
           * the index keeps two calls to one tool distinct above this seam
           * even though the vendor cannot tell them apart.
           */
          callId: `gemini-${callIndex}-${name}`,
          name,
          input: asObject(fn?.["args"]) ?? {},
        });
        callIndex += 1;
      }

      const usage = asObject(json["usageMetadata"]);
      const inputTokens = num(usage?.["promptTokenCount"]);
      /**
       * Absent when the model produced no output tokens at all, which happens
       * on a turn cut short, so it reads as zero rather than as missing. The
       * input count is the one that is always reported on a billed call, and
       * its absence is what makes a response uncostable.
       */
      const outputTokens = num(usage?.["candidatesTokenCount"]) ?? 0;
      if (inputTokens === null) {
        return {
          ok: false,
          code: "no_usage",
          message: "Gemini answered without reporting token usage, so this call cannot be costed.",
          retryable: false,
        };
      }

      return {
        ok: true,
        completion: {
          model: str(json["modelVersion"]) ?? model,
          content,
          stop: content.some((part) => part.type === "toolCall")
            /**
             * This vendor reports `STOP` on a turn that asked for a function
             * call, so the finish reason alone would say the answer is
             * complete while a tool call is sitting in it unrun.
             */
            ? "toolUse"
            : stopFrom(str(candidate["finishReason"])),
          usage: {
            inputTokens,
            outputTokens,
            /** Only reported when explicit context caching was used. */
            cachedInputTokens: num(usage?.["cachedContentTokenCount"]),
          },
        },
      };
    },

    async models(): Promise<ModelListOutcome> {
      const { status, json } = await call(`/${PREFIX.slice(0, -1)}`, "GET");
      if (status < 200 || status >= 300) return failure(status, json);

      const models = asArray(json["models"]).flatMap((raw) => {
        const row = asObject(raw);
        const name = str(row?.["name"]);
        if (!name) return [];
        const id = bare(name);
        return [{ id, label: str(row?.["displayName"]) ?? id }];
      });
      return { ok: true, models };
    },
  };
}

registerAiProvider("google", (settings, secret) =>
  googleProvider(settings as GoogleSettings, secret));
