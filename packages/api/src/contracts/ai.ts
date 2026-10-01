import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * BRING YOUR OWN MODEL
 *
 * The `capability` enum has carried `ai_model` since the first migration with
 * nothing behind it, and `agent:configure` sat in the permission catalogue as
 * a promise about a module nobody had built. A company could grant or
 * withhold that permission and change nothing either way.
 *
 * WHAT THIS IS: a company connects the Claude, OpenAI or Gemini account they
 * already pay for, the key lives in their own secret store and never in this
 * database, and the product calls it on their behalf. No platform account, no
 * resale, no cut, the same posture as the payments seam and for the same
 * reason.
 *
 * WHAT A MODEL CAN REACH. `runAiCompletion` can offer the model the MCP tool
 * catalogue filtered by the permissions of the caller it runs as, so an agent
 * can be told about nothing the person whose authority it borrowed could not
 * do themselves. It does NOT run the tools: it returns the calls the model
 * asked for, and the caller runs them through the MCP server or this API,
 * which is the one place a permission is checked.
 *
 * SPENDING IS A CEILING THAT REFUSES. Every call records its tokens and an
 * estimated cost. An operator sets a monthly limit and a call that would
 * breach it is refused and recorded as refused, because the alternative to
 * refusing is a bill with a warning in a log beside it.
 */

const ToolCallId = z.string().min(1).max(200);
const ToolName = z.string().min(1).max(200);

/**
 * One piece of a conversation.
 *
 * A tool result carries BOTH the call id and the tool name, and the
 * redundancy is load bearing rather than sloppy. Anthropic and OpenAI match a
 * result to a call by id; Gemini has no id at all and matches by name.
 * Sending only the id makes this unusable on one of the three vendors, and it
 * is the field a reader assumes is enough.
 */
const AiContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(400_000) }),
  z.object({
    type: z.literal("toolCall"),
    callId: ToolCallId,
    name: ToolName,
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("toolResult"),
    callId: ToolCallId,
    name: ToolName,
    result: z.string().max(400_000),
    /**
     * Honest on one vendor and simulated on two: only Anthropic has a flag
     * for it, so the other adapters mark the failure in the text the model
     * reads. Sent either way, so the caller never has to know which.
     */
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("vendorState"),
    /**
     * A block one vendor produced and needs back, carried opaquely and
     * tagged. Anthropic's current models return their reasoning this way and
     * a tool loop that drops it loses the reasoning behind the tool call, and
     * on the newest models is refused outright as an edited turn. Each
     * adapter sends back its own and drops everybody else's, so a
     * conversation can be moved between vendors without sending one of them a
     * block it has never heard of.
     */
    vendor: z.string().min(1).max(50),
    block: z.record(z.unknown()),
  }),
]);

const AiMessage = z.object({
  /**
   * No `system` role. All three vendors keep the standing instruction
   * somewhere other than the message list, so it is its own field and each
   * adapter puts it where its vendor wants it.
   */
  role: z.enum(["user", "assistant"]),
  content: z.array(AiContent).max(200),
});

export const getAiStatus = defineRoute({
  method: "get",
  path: "/v1/ai/connections",
  summary: "Which model accounts are connected, and what they have cost",
  description:
    "Lists every connected model provider rather than one, because a company running a cheap model for summaries and an expensive one for decisions has several and a screen showing one describes half their bill. Reports the monthly ceiling, what has been spent against it, and how many calls this month could not be priced at all, which is the number that makes a ceiling meaningless.",
  module: "M27",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    connections: z.array(z.object({
      connectionId: Uuid,
      provider: z.string(),
      accountLabel: z.string().nullable(),
      connected: z.boolean(),
      lastError: z.string().nullable(),
    })),
    /** Millionths of a dollar. Null means no ceiling has been set. */
    monthlyLimitMicros: z.number().nullable(),
    spentThisMonthMicros: z.number(),
    unpricedCallsThisMonth: z.number(),
  }),
});

export const getAiUsage = defineRoute({
  method: "get",
  path: "/v1/ai/usage",
  summary: "What the models cost this month, by model",
  description:
    "Grouped by provider and model, for the calendar month in the company's own timezone. The cost is an ESTIMATE from the rate this deployment holds: cached input is counted at the full input rate because the vendors do not agree on how a cache read is priced, which overstates a cached call. `pricedCalls` says how many of the calls behind a total had a known rate, because a total that silently omits half its calls is the number somebody budgets against.",
  module: "M27",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    models: z.array(z.object({
      provider: z.string(),
      model: z.string(),
      calls: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      estimatedCostMicros: z.number().nullable(),
      pricedCalls: z.number(),
    })),
  }),
});

export const listAgentTools = defineRoute({
  method: "get",
  path: "/v1/ai/tools",
  summary: "What an agent running as you would be allowed to do",
  description:
    "The MCP tool catalogue filtered by the permissions this caller holds, which is exactly the list a model is told about when a completion offers tools. It is here so an operator deciding whether to turn an agent on can read the list rather than take a sentence's word for it.",
  module: "M27",
  permissions: ["agent:configure"],
  input: z.object({}),
  output: z.object({
    tools: z.array(z.object({ name: z.string(), description: z.string() })),
  }),
});

export const connectAiProvider = defineRoute({
  method: "post",
  path: "/v1/ai/connections",
  summary: "Connect a model account",
  description:
    "Takes the NAME of the secret holding the API key, never the key. Refuses a provider this deployment has no adapter for, because a settings screen that says connected beside a feature that fails on every call is worse than a refusal. Put `defaultModel` and, for a vendor whose prices this deployment does not hold, a `rates` table in settings: without a rate the spend ceiling refuses rather than letting an unpriced model run underneath a limit that can never be reached.",
  module: "M27",
  permissions: ["agent:configure"],
  idempotent: true,
  input: z.object({
    provider: z.string().min(1).max(50),
    /** The name of the secret. The key itself never reaches this API. */
    credentialRef: z.string().min(1).max(200),
    accountLabel: z.string().max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    connectionId: Uuid,
    provider: z.string(),
    status: z.string(),
  }),
});

export const disconnectAiProvider = defineRoute({
  method: "delete",
  path: "/v1/ai/connections/{provider}",
  summary: "Stop calling a model account",
  description:
    "The usage rows are kept. They are what an operator reconciles against a bill that arrives after they disconnected, and deleting the record of spend because the key was removed would hide the month somebody is asking about.",
  module: "M27",
  permissions: ["agent:configure"],
  input: z.object({ provider: z.string().min(1).max(50) }),
  output: z.object({ provider: z.string(), status: z.string() }),
});

export const testAiConnection = defineRoute({
  method: "post",
  path: "/v1/ai/connections/{provider}/test",
  summary: "Check a key works",
  description:
    "Lists the models the key can reach, which is the only call any of these vendors offers that costs nothing. A test that sent a greeting would charge an operator for pressing a button labelled Test. Also reports whether this vendor issues its own tool call ids, because the one that does not pairs repeated calls to a single tool in order rather than by id.",
  module: "M27",
  permissions: ["agent:configure"],
  /**
   * A POST, so it carries a key like every other one. Asking a vendor whether
   * a key works twice is harmless, and the rule here is that the shape is
   * uniform rather than argued case by case.
   */
  idempotent: true,
  /**
   * REQUIRED, because it is in the path. An optional path parameter is a
   * route that cannot be built: the caller is told they may leave out the
   * one segment the URL needs. The MCP tool schema is generated from this,
   * so a model would have been handed a tool it could call in a way that
   * could never resolve.
   */
  input: z.object({ provider: z.string().min(1).max(50) }),
  output: z.object({
    provider: z.string(),
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    defaultModel: z.string().nullable(),
    toolCallIdentity: z.union([
      z.object({ kind: z.literal("vendor") }),
      z.object({ kind: z.literal("synthetic"), because: z.string() }),
    ]),
  }),
});

export const setAiSpendLimit = defineRoute({
  method: "put",
  path: "/v1/ai/spend-limit",
  summary: "Cap what the models may cost in a month",
  description:
    "Millionths of a dollar, per calendar month in the company's own timezone, or null for no ceiling. A call is refused unless the ceiling has room for the worst case output of that call, so the most a month can exceed the ceiling is one call's input cost, which is not knowable before the call is made. It refuses rather than warning: a warning beside a runaway loop is a line in a log nobody reads and a bill somebody pays.",
  module: "M27",
  permissions: ["agent:configure"],
  idempotent: true,
  input: z.object({
    monthlyLimitMicros: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  }),
  output: z.object({ monthlyLimitMicros: z.number().nullable() }),
});

export const runAiCompletion = defineRoute({
  method: "post",
  path: "/v1/ai/completions",
  summary: "Ask the connected model",
  description:
    "Returns the model's text and any tool calls it asked for, and DOES NOT RUN THEM. The caller runs them through the MCP server or this API, which is the one place a permission is checked; a second execution path here would be a second gate and the second gate written is the one that forgets. Set offerTools to tell the model about the tools this caller may use, filtered by the permissions this caller holds, so a model is never told about a tool its operator could not use by hand. THIS CALL IS NOT IDEMPOTENT AND SAYS SO: a retry is a second call and a second charge, because returning the first answer would mean storing the conversation, and no prompt or response text is stored anywhere by this module.",
  module: "M27",
  permissions: ["agent:configure"],
  /**
   * A retry is refused rather than replayed, and the service says why: the
   * answer is not stored, so there is nothing to hand back, and charging a
   * second time for an answer we cannot return is the worse of the two.
   */
  idempotent: true,
  input: z.object({
    /** Omit when exactly one provider is connected; refused when several are. */
    provider: z.string().min(1).max(50).optional(),
    /** Omit to use the connection's default. Refused when there is none. */
    model: z.string().min(1).max(200).optional(),
    system: z.string().max(400_000).optional(),
    messages: z.array(AiMessage).min(1).max(200),
    /**
     * The hard ceiling on one answer, in tokens. Required, because it is the
     * only number known before a call that bounds what the call can cost and
     * the spend ceiling is built on exactly that.
     */
    maxOutputTokens: z.number().int().min(1).max(128_000),
    offerTools: z.boolean().optional(),
    /** A short label recorded against the spend. Not sent to the model. */
    purpose: z.string().min(1).max(200),
  }),
  output: z.object({
    usageId: Uuid,
    provider: z.string(),
    model: z.string(),
    stop: z.enum(["end", "toolUse", "maxTokens", "refused", "other"]),
    text: z.string(),
    toolCalls: z.array(z.object({
      callId: z.string(),
      name: z.string(),
      input: z.record(z.unknown()),
    })),
    /**
     * The whole turn in order, including the vendor state blocks that have to
     * be echoed back as the assistant turn to continue a tool loop.
     */
    content: z.array(AiContent),
    inputTokens: z.number(),
    outputTokens: z.number(),
    /** Null when the vendor did not say. Zero is the stronger claim of a miss. */
    cachedInputTokens: z.number().nullable(),
    /** Null when no rate is known for this model. Not zero. */
    estimatedCostMicros: z.number().nullable(),
    spentThisMonthMicros: z.number(),
    monthlyLimitMicros: z.number().nullable(),
  }),
});

export const aiRoutes = {
  getAiStatus, getAiUsage, listAgentTools,
  connectAiProvider, disconnectAiProvider, testAiConnection,
  setAiSpendLimit, runAiCompletion,
} as const;
