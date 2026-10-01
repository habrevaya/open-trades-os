/**
 * THE AI PROVIDER SEAM
 *
 * The fourth of these, and the same shape as the three next door for the same
 * reason: a contractor self hosting this must be able to point it at whichever
 * model vendor they already have an account with, and must be able to leave.
 * So the product knows about "answer this, and here are the tools you may
 * ask me to run" and nothing about Anthropic, OpenAI or Google, and an
 * adapter is a few hundred lines of `fetch`.
 *
 * NO SDKS, FOR THE REASON THE PAYMENTS ADAPTER GIVES AND ONE MORE.
 *
 * Three vendor SDKs is three large dependencies for one endpoint each, on a
 * box whose owner did not choose them and has to audit what leaves their
 * network. The extra reason here is that model vendor SDKs move faster than
 * any other dependency in this file's neighbourhood: they ship breaking
 * changes on minor versions, they add telemetry, and a library that updates
 * itself is a library that can change what it sends. Four hundred lines of
 * `fetch` against a documented HTTP shape does not.
 *
 * NO STREAMING, SAID OUT LOUD RATHER THAN LEFT AS AN ABSENCE.
 *
 * Every one of these vendors streams and this interface does not, because a
 * streamed answer has nowhere to go: the callers here are a service layer
 * that returns a value and an MCP tool call that returns a result. Adding a
 * streaming method that two adapters implement and the service never calls
 * would be a feature in the interface and nothing in the product. When
 * something in this codebase can genuinely consume a token at a time, this
 * seam grows a second method and every adapter has to answer for it.
 *
 * WHAT IS DELIBERATELY NOT THE PROVIDER'S BUSINESS.
 *
 * WHICH TOOLS EXIST. The provider is handed a list of tool definitions and
 * never asked to decide one. The list comes from the MCP catalogue filtered
 * by the permissions of the person the call runs as, which is the whole
 * safety property: a model can be told about nothing its operator could not
 * do themselves. A provider that could add a tool would be a provider that
 * could widen that.
 *
 * WHETHER A TOOL CALL RUNS. Adapters return the calls a model asked for.
 * Nothing in this directory executes one. See `services/ai.ts` for why that
 * boundary is where it is.
 *
 * WHETHER THE COMPANY CAN AFFORD IT. The ceiling is ours, checked before a
 * provider is built, because a provider that refused on cost would be a
 * spend control that a deployment could remove by writing a different
 * adapter.
 */

/** A tool the model may ask to use. The schema is JSON Schema, as all three want. */
export interface AiToolDefinition {
  name: string;
  description: string;
  /** A JSON Schema object. Passed through; this seam does not validate it. */
  inputSchema: Record<string, unknown>;
}

/**
 * One piece of a conversation.
 *
 * `toolResult` carries BOTH the call id and the tool name, and the redundancy
 * is the interesting part of this type. Anthropic matches a result to a call
 * by `tool_use_id` and ignores the name. OpenAI matches by `tool_call_id` and
 * ignores the name. Gemini matches by NAME and has no id at all. Carrying one
 * of the two would make this interface unimplementable for one of the three
 * vendors, and carrying the id alone is the trap, because it is the field two
 * thirds of the vendors use and the one a reader assumes is sufficient.
 */
export type AiContent =
  | { type: "text"; text: string }
  | { type: "toolCall"; callId: string; name: string; input: Record<string, unknown> }
  | {
      type: "toolResult";
      callId: string;
      name: string;
      /** The result, already serialized. Every vendor accepts a string. */
      result: string;
      /**
       * Whether the tool refused or failed.
       *
       * Honest on one vendor and simulated on two. Anthropic has an
       * `is_error` flag on a tool result; OpenAI's tool message and Gemini's
       * `functionResponse` have no such field, so those adapters mark the
       * failure in the text the model reads. The model is told either way.
       * What differs is that on two of the three nothing downstream of the
       * model can filter on it, which is why this is a field on our type
       * rather than a convention in the string: the caller always knows.
       */
      isError: boolean;
    }
  /**
   * A BLOCK ONE VENDOR PRODUCED AND HAS TO BE GIVEN BACK.
   *
   * The escape hatch, and it exists because leaving it out breaks a real
   * thing rather than because an adapter was inconvenient.
   *
   * Anthropic's current models reason before they answer and return that
   * reasoning as blocks in the assistant turn. Continuing a tool loop without
   * echoing them back loses the model's reasoning between turns, and on the
   * newest models an edited assistant turn is rejected outright. There is no
   * portable shape for it: OpenAI and Google carry nothing equivalent in
   * their message lists.
   *
   * So it is carried opaquely and tagged with the provider that made it. Each
   * adapter sends back its OWN and drops everybody else's, which is what
   * makes it safe to hand a conversation started on one vendor to another:
   * the second vendor is never sent a block it has no idea about.
   */
  | { type: "vendorState"; vendor: string; block: Record<string, unknown> };

export interface AiMessage {
  /**
   * Only two roles, and `system` is not one of them.
   *
   * All three vendors put the system prompt somewhere other than the message
   * list (Anthropic a top level field, OpenAI a message with a third role,
   * Google a `systemInstruction` object), so it is a separate field on the
   * request and each adapter puts it where its vendor wants it. A `system`
   * role in this list would be a role two adapters had to lift back out.
   */
  role: "user" | "assistant";
  content: AiContent[];
}

export interface CompletionRequest {
  model: string;
  /** The standing instruction, if any. See `AiMessage.role` for why it is here. */
  system?: string | undefined;
  messages: AiMessage[];
  /** Omit, or pass an empty list, and the model is offered no tools at all. */
  tools?: AiToolDefinition[] | undefined;
  /**
   * The hard ceiling on what one answer may cost, in tokens.
   *
   * Not optional. Anthropic requires it outright, and the other two default
   * it to something large. More to the point, it is the only number known
   * BEFORE a call that bounds what the call can cost, and the spend ceiling
   * in `services/ai.ts` is built on exactly that.
   */
  maxOutputTokens: number;
}

/**
 * What a vendor reported it used.
 *
 * Required on every successful completion, with no optional fields and no
 * "unknown" case, and the adapters enforce it: a response that carries no
 * usage is a FAILURE here rather than a success with zeros. Zero tokens is a
 * claim that the call was free, and an operator whose ceiling is built on
 * these numbers would have a ceiling that never moves while the vendor's
 * meter does.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * What the vendor served from its prompt cache, or null when it did not
   * say. Null and zero are different answers: zero means the vendor told us
   * there was no cache hit.
   */
  cachedInputTokens: number | null;
}

/**
 * Why the model stopped, normalized.
 *
 * `maxTokens` is separated from `end` because they need opposite treatment: an
 * answer that ran out of room is truncated mid sentence and asking again with
 * more room is the fix, where an answer that ended is finished. A caller that
 * cannot tell them apart shows a user half a sentence and calls it the
 * answer.
 *
 * `refused` is a vendor safety decision. It is not an error and not a failure
 * to reach the vendor: the call was made, it was billed, and the model
 * declined. Reporting it as a failure sends somebody to look at the network.
 */
export type StopReason = "end" | "toolUse" | "maxTokens" | "refused" | "other";

export interface Completion {
  /** What actually answered. Vendors route and substitute; this is their word. */
  model: string;
  /** Text and tool calls, in the order the model produced them. */
  content: AiContent[];
  stop: StopReason;
  usage: TokenUsage;
}

/**
 * `retryable` is the whole reason these are results rather than exceptions,
 * and the model vendors make the case louder than anybody.
 *
 * A rate limit and a revoked key both fail. Treating them the same means
 * either abandoning a request that would have worked thirty seconds later,
 * which is the single most common failure a model API has, or hammering a key
 * that will never work again while every retry is another entry in a vendor's
 * abuse metrics.
 */
export type CompletionOutcome =
  | { ok: true; completion: Completion }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface ModelDescription {
  id: string;
  /** What the vendor calls it, where it says. Falls back to the id. */
  label: string;
}

export type ModelListOutcome =
  | { ok: true; models: ModelDescription[] }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * HOW A TOOL CALL IS IDENTIFIED, and the field that stops an adapter
 * pretending.
 *
 * Required and discriminated, for the same reason `delivery` is required on
 * the email seam: a new adapter cannot be written without answering the
 * question, and the honest answer carries a sentence rather than a boolean.
 *
 * Anthropic and OpenAI both mint an id per tool call and expect it back.
 * Gemini does not: a `functionCall` carries a name and arguments and nothing
 * else, so an adapter has to invent an id for the interface above it and
 * throw it away on the way back down. That is fine, it is also invisible, and
 * the thing it breaks is specific: two calls to the SAME tool in one turn are
 * distinguishable here and are not distinguishable to Gemini, so their
 * results are matched by name and the vendor pairs them in order.
 */
export type ToolCallIdentity =
  | { kind: "vendor" }
  | {
      kind: "synthetic";
      /** Shown to an operator. A full sentence, not a code. */
      because: string;
    };

/**
 * What a model costs to run, in millionths of a dollar per token.
 *
 * Micro-dollars because a token is cheap: a dollar per million tokens is
 * exactly one micro-dollar per token, so every published rate any of these
 * vendors has is a small integer in this unit and a month of arithmetic has
 * no rounding in it.
 *
 * `source` is on here because the two sources fail differently. A rate from
 * an adapter's own table is as current as the day somebody checked it, and
 * `asOf` says which day so a reader can judge it. A rate the operator typed
 * into their connection settings is as current as they are, and is the only
 * way this codebase can price a vendor whose price list it does not hold.
 */
export interface ModelRate {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
  source: "adapter" | "settings";
  /** ISO date the adapter's table was last checked. Null for an operator rate. */
  asOf: string | null;
}

export interface AiProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionOutcome>;
  /**
   * What this key can run.
   *
   * Separate from `complete` and worth its own method because it is the only
   * call in this interface that costs nothing: it is how a settings screen
   * proves a key works without spending a token on a greeting.
   */
  models(): Promise<ModelListOutcome>;
  readonly toolCallIdentity: ToolCallIdentity;
  /**
   * The model this adapter will use when the operator has not named one, or
   * null when it will not guess.
   *
   * Null is the honest answer for a vendor whose current model ids this
   * codebase does not hold a dated reference for. A guessed default is a 404
   * from the vendor that an operator reads as a broken integration, or worse,
   * a real model that is not the one they are paying to use.
   */
  readonly defaultModel: string | null;
  /**
   * What this model costs, or null when this deployment does not know.
   *
   * Null rather than a guess, and the distinction has money on it: the spend
   * ceiling refuses a call it cannot price rather than letting an unpriced
   * model run free underneath a limit that can never be reached.
   */
  rateFor(model: string): ModelRate | null;
}

export class AiProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No AI provider configured for "${provider}"`);
    this.name = "AiProviderNotConfiguredError";
  }
}

/**
 * Providers are registered rather than imported.
 *
 * Same as the three seams next door: a self hoster pointing this at a model
 * their regulator will let them use should not have to edit a switch
 * statement in the middle of the call path, and a build that imports every
 * vendor pulls every vendor's shape into a deployment that uses one.
 */
const registry = new Map<string, (settings: Record<string, unknown>, secret: string) => AiProvider>();

export function registerAiProvider(
  name: string,
  factory: (settings: Record<string, unknown>, secret: string) => AiProvider,
): void {
  registry.set(name, factory);
}

export function createAiProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
): AiProvider {
  const factory = registry.get(name);
  if (!factory) throw new AiProviderNotConfiguredError(name);
  return factory(settings, secret);
}

export const registeredAiProviders = (): string[] => [...registry.keys()];

/* ------------------------------------------------------------- the plumbing */

/**
 * A minimal HTTP shape, so a test can hand an adapter a transport and never
 * reach a vendor, and so no test needs a real API key.
 *
 * Copied from the accounting seam rather than imported from it, because the
 * alternative is this directory importing the accounting provider to talk to
 * a model.
 */
export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { status: response.status, text: () => response.text() };
};

/**
 * THE KEY NEVER LEAVES THIS DIRECTORY, AND NEVER REACHES A STRING ANYBODY
 * KEEPS.
 *
 * Every one of these vendors can echo part of a request back in an error, and
 * an error message is the single most widely copied string in any system: it
 * reaches a log, a support ticket, a screenshot and an issue tracker, usually
 * within the hour.
 *
 * So every message an adapter builds out of a vendor's body goes through
 * here first. It is not a substitute for not sending the key where it does
 * not belong, which is why the Google adapter sends its key in a header
 * rather than in the query string the vendor's own documentation uses: a URL
 * is logged by proxies, by the vendor, and by whatever sits between, and no
 * amount of scrubbing on this side reaches those.
 */
export function withoutSecret(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join("[redacted]");
}

/** A failure a vendor will answer differently if asked again. */
export const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * An operator supplied rate table, read off the connection's settings.
 *
 * This is how a deployment prices a vendor whose published prices are not in
 * this repository, and how it corrects one whose prices have moved since an
 * adapter's table was written. It wins over the adapter's own table, because
 * the operator is the one holding the invoice.
 */
export function rateFromSettings(
  settings: Record<string, unknown>, model: string,
): ModelRate | null {
  const rates = asObject(settings["rates"]);
  const entry = asObject(rates?.[model]);
  if (!entry) return null;
  const input = num(entry["inputMicrosPerToken"]);
  const output = num(entry["outputMicrosPerToken"]);
  /**
   * Both or neither. A half filled rate would price the input of a call and
   * not its output, which on a model that charges five times as much for
   * output is a cost estimate wrong by most of the bill.
   */
  if (input === null || output === null || input < 0 || output < 0) return null;
  return { inputMicrosPerToken: input, outputMicrosPerToken: output, source: "settings", asOf: null };
}
