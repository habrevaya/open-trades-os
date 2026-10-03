import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { connectors, isSystem, type Permission } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { toolsFor, type McpTool } from "../mcp/tools";
import {
  createAiProvider, registeredAiProviders, AiProviderNotConfiguredError,
  type AiContent, type AiMessage, type AiProvider, type AiToolDefinition,
  type ModelRate,
} from "../ai/provider";

/**
 * BRING YOUR OWN MODEL
 *
 * The `capability` enum has carried `ai_model` since the first migration with
 * no provider behind it, and `agent:configure` sat in the permission
 * catalogue excused as "M27, AI agents. Planned." A company running this
 * could see a permission that promised control over AI agents, grant it or
 * withhold it, and change nothing either way.
 *
 * What this is: a company connects the model account they already pay for,
 * the key stays in their secret store, and this product calls it on their
 * behalf. There is no platform account, no resale, and no cut, for the same
 * reason the payments seam has none: the alternative puts somebody else's
 * secret on infrastructure this project does not control, and it makes the
 * product the thing that stops working when a vendor changes their mind.
 *
 * WHAT A MODEL CAN REACH, AND WHERE THE LINE IS.
 *
 * `runCompletion` can offer the model the MCP tool catalogue, FILTERED BY THE
 * PERMISSIONS OF THE PERSON THE CALL RUNS AS. That filtering is what makes an
 * agent safe to turn on: a model is never told about a tool the person whose
 * authority it borrowed could not use themselves, so the worst an agent can
 * do is what its operator could already do by hand.
 *
 * AND THIS SERVICE DOES NOT RUN THE TOOLS. It returns the calls the model
 * asked for, and the caller runs them through the MCP server or the HTTP API
 * it already holds a credential for. That boundary is deliberate and it is
 * not timidity:
 *
 *   `mcp/tools.ts` says, at length, that a tool call becomes a Request and
 *   goes through the SAME dispatcher an HTTP client reaches, so a permission
 *   is checked in exactly one place, and that "the second gate written is
 *   always the one that forgets". A service that executed tool calls would be
 *   that second gate. It would also have to invent a credential, because a
 *   ServiceContext holds an actor and not a token, and inventing a credential
 *   inside the thing that decides what an agent may do is how an agent layer
 *   becomes a privilege escalation.
 *
 * So the loop lives with the caller: ask, run the calls through the one gate,
 * feed the results back as `toolResult` content, ask again. Every turn is
 * priced and recorded here.
 *
 * SPEND IS THE RISK, AND IT IS HANDLED HERE RATHER THAN DOCUMENTED.
 *
 * A connected key plus a loop that does not terminate is a bill, and the
 * first anybody hears of it is the bill. So every call records its tokens and
 * an estimated cost, an operator can set a monthly ceiling, and the ceiling
 * REFUSES. See `ceilingVerdict` for what it can and cannot promise.
 */

/* --------------------------------------------------------- the connection */

/**
 * A model connection, with the credential held as a REFERENCE into whatever
 * the deployment uses for secrets.
 *
 * A row in this database is not a secret store, and this is the one capability
 * where that matters most: a model key is bearer authority over an account
 * with a spending limit on it, usable from anywhere, with no second factor and
 * no per-request signature a webhook could catch.
 */
export interface Connection {
  id: string;
  organizationId: string;
  provider: string;
  credentialRef: string;
  settings: Record<string, unknown>;
}

function readConnection(row: typeof schema.integrationConnection.$inferSelect): Connection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    credentialRef: row.credentialRef ?? "",
    settings: row.settings ?? {},
  };
}

async function connectedRows(tx: Database, organizationId: string) {
  return tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "ai_model"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    ));
}

/**
 * Which connection a call runs against.
 *
 * Unlike every other capability here, a company genuinely does connect
 * several of these at once: the whole point is that an owner can run the
 * cheap model for a summary and the expensive one for a decision. So when
 * more than one is connected and the caller did not say which, this REFUSES
 * and names them rather than picking.
 *
 * Picking would mean this product choosing, silently and forever, which
 * vendor a company is billed by. The two are not the same price: on published
 * rates the spread across models a company might reasonably connect is more
 * than tenfold.
 */
async function connectionFor(
  tx: Database, organizationId: string, provider?: string | undefined,
): Promise<Connection> {
  const rows = await connectedRows(tx, organizationId);

  if (provider) {
    const row = rows.find((candidate) => candidate.provider === provider);
    if (!row) {
      throw new AiProviderNotConfiguredError(provider);
    }
    return readConnection(row);
  }

  if (rows.length === 0) throw new AiProviderNotConfiguredError("ai_model");
  if (rows.length > 1) {
    throw new ConflictError(
      `This company has ${rows.length} model providers connected `
      + `(${rows.map((row) => row.provider).sort().join(", ")}). `
      + "Name the one this call should use: they are not the same price and "
      + "choosing for you would decide which account gets billed.",
    );
  }
  return readConnection(rows[0]!);
}

/**
 * How a secret is fetched.
 *
 * Injected rather than imported, the same as the payments seam: a deployment
 * keeps these in Supabase Vault, a KMS, or a file the orchestrator mounted,
 * and a service that read `process.env` directly would work in exactly one of
 * those. It also means no test in this repository has to hold anything that
 * looks like a model API key.
 */
export type ReadSecret = (ref: string) => Promise<string>;

/**
 * The default, which reads an environment variable named by the reference.
 *
 * It throws rather than returning an empty string. An empty key reaches a
 * vendor as an unauthenticated request and comes back as a 401, which
 * presents to the operator as "Anthropic rejected our key" when the truth is
 * that nobody ever gave us one.
 */
export const secretFromEnvironment: ReadSecret = async (ref: string) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No AI credential in the environment under "${ref}". The connection points `
      + "at that name and nothing is set there, so no model can be called.",
    );
  }
  return value;
};

export interface AiDeps {
  readSecret: ReadSecret;
  /** Injected so a test never reaches a vendor and a deployment never fakes one. */
  provider?: AiProvider | undefined;
  /** Injected so a test can stand at a chosen point in a billing month. */
  now?: (() => Date) | undefined;
}

const DEFAULT_DEPS: AiDeps = { readSecret: secretFromEnvironment };

async function providerFrom(connection: Connection, deps: AiDeps): Promise<AiProvider> {
  if (deps.provider) return deps.provider;
  const key = await deps.readSecret(connection.credentialRef);
  return createAiProvider(connection.provider, connection.settings, key);
}

/* -------------------------------------------------------------- the money */

/**
 * What this company has spent this calendar month, in millionths of a dollar.
 *
 * The month is bounded in the COMPANY'S timezone rather than UTC, because
 * that is the window an operator means by "a hundred dollars a month". A
 * ceiling that rolled over at six in the evening on the last of the month
 * would be reported as a bug by the one person who noticed.
 *
 * Only calls that actually ran count. A refused call spent nothing, and
 * counting it would make a ceiling that refuses one call refuse every call
 * after it for the rest of the month.
 */
async function spentThisMonth(
  tx: Database, organizationId: string, now: Date,
): Promise<number> {
  const timezone = await timezoneOf(tx, organizationId);
  const [row] = await tx.execute<{ spent: string }>(sql`
    select coalesce(sum(estimated_cost_micros), 0)::text as spent
    from public.ai_usage
    where organization_id = ${organizationId}
      and outcome = 'ok'
      and created_at >= date_trunc(
        'month', (${now.toISOString()}::timestamptz at time zone ${timezone})
      ) at time zone ${timezone}`);
  return Number(row?.spent ?? "0");
}

async function limitFor(tx: Database, organizationId: string): Promise<number | null> {
  const [row] = await tx.select().from(schema.aiBudget)
    .where(eq(schema.aiBudget.organizationId, organizationId)).limit(1);
  return row?.monthlyLimitMicros ?? null;
}

const costOf = (rate: ModelRate, inputTokens: number, outputTokens: number): number =>
  Math.round(inputTokens * rate.inputMicrosPerToken + outputTokens * rate.outputMicrosPerToken);

/** Micro-dollars as a sentence somebody can act on. */
const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/**
 * WHETHER THIS CALL MAY RUN, AND WHAT THE CEILING HONESTLY PROMISES.
 *
 * It is checked BEFORE the call, against spend already recorded, and the
 * number of input tokens a call will use is not knowable before it is made.
 * So the promise is bounded rather than absolute, and stating the bound is
 * the point of this comment:
 *
 *   A call is refused unless the ceiling has room for the WORST CASE OUTPUT
 *   of this call, which is `maxOutputTokens` at the model's output rate. The
 *   most a month can therefore exceed its ceiling is one call's input cost.
 *
 * That is a real guarantee and it is not "spend never exceeds the limit",
 * which nothing checking beforehand can offer. Claiming the stronger one
 * would be the defect this codebase spends its time removing.
 *
 * AND A CALL THAT CANNOT BE PRICED IS REFUSED WHEN A CEILING IS SET. A rate
 * this deployment does not hold means every call costs null, every month sums
 * to zero, and the ceiling is a setting that does nothing while an operator
 * believes it is protecting them. Refusing is rude and visible; the
 * alternative is quiet and expensive.
 */
function ceilingVerdict(
  limit: number | null, spent: number, rate: ModelRate | null,
  model: string, maxOutputTokens: number,
): string | null {
  if (limit === null) return null;

  if (!rate) {
    return (
      `This company has a monthly AI ceiling of ${dollars(limit)} and no price is known for `
      + `"${model}", so a call on it could not be counted against the ceiling. Put the rate for `
      + "this model on the connection settings, or clear the ceiling."
    );
  }

  if (spent >= limit) {
    return (
      `This company has spent ${dollars(spent)} on AI this month and its ceiling is `
      + `${dollars(limit)}. Raise the ceiling or wait for the month to roll over.`
    );
  }

  const worstCase = Math.ceil(rate.outputMicrosPerToken * maxOutputTokens);
  if (spent + worstCase > limit) {
    return (
      `This call could cost up to ${dollars(worstCase)} in output alone, and only `
      + `${dollars(limit - spent)} is left under this month's ceiling of ${dollars(limit)}. `
      + "Ask for a shorter answer, raise the ceiling, or wait for the month to roll over."
    );
  }

  return null;
}

/* ---------------------------------------------------------- the tool list */

/**
 * This module's own routes, which a model is never told about.
 *
 * Everything else here is reachable by an agent precisely because its
 * operator could reach it by hand. This one is different in kind: the tool
 * that runs a model would let a model run a model, and a loop whose every
 * turn starts another turn is the exact failure this module's ceiling exists
 * for, running at machine speed with a credit card attached. The ceiling
 * bounds what that costs; it does not make it a sensible thing to offer.
 *
 * Matched on the path rather than on a list of route names, so a route added
 * to this module later is excluded by existing, which is the safe direction.
 * The routes stay reachable over HTTP and MCP for a person or an
 * application: what is prevented is a model driving itself.
 */
const AGENT_PATH_PREFIX = "/v1/ai/";

/**
 * What a model may be told about, for THIS caller.
 *
 * `toolsFor` is the MCP server's own filter, reused rather than
 * reimplemented. A second copy of "which tools may this actor see" would
 * disagree with the first eventually, and the disagreement would be silent in
 * the direction that matters: a model told about a tool its operator cannot
 * use.
 *
 * The catalogue is a parameter with a default so the exclusion above can be
 * asserted directly. It was not, and the test for it could not fail: these
 * routes are not in the registry until a deployment wires them, so a check
 * against the live catalogue passed by having nothing to exclude.
 */
export function offeredTools(
  ctx: ServiceContext, catalogue: readonly McpTool[] = toolsFor(ctx.actor),
): AiToolDefinition[] {
  return catalogue
    .filter((tool) => !tool.route.path.startsWith(AGENT_PATH_PREFIX))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema },
    }));
}

/* ------------------------------------------------------------ connecting */

export interface ConnectInput {
  provider: string;
  /** The NAME of the secret, never the secret. */
  credentialRef: string;
  accountLabel?: string | undefined;
  /** Model defaults and operator supplied rates live here. */
  settings?: Record<string, unknown> | undefined;
}

export async function connect(ctx: ServiceContext, input: ConnectInput) {
  return guardedWrite(ctx, "agent:configure", async (tx) => {
    /**
     * Refused when no adapter is registered, rather than stored and
     * discovered later. A connection naming a vendor nothing implements is a
     * settings screen that says connected beside a feature that fails on
     * every call.
     */
    if (!registeredAiProviders().includes(input.provider)) {
      throw new ConflictError(
        `No adapter for "${input.provider}". This deployment can call: `
        + `${registeredAiProviders().sort().join(", ")}.`,
      );
    }

    if (input.credentialRef.trim() === "") {
      throw new ConflictError(
        "A model connection needs the name of the secret holding the API key. "
        + "The key itself is never stored here.",
      );
    }
    if (connectors.looksLikeSecretValue(input.credentialRef)) {
      throw new ConflictError(
        "That looks like the API key itself rather than the name it is kept under. Nothing was "
        + "saved. Put the key in your secret store and send its name.",
      );
    }
    const checked = connectors.checkConnectorSettings(input.provider, input.settings ?? {});
    if (!checked.ok) throw new ConflictError(checked.reason);

    const [row] = await tx.insert(schema.integrationConnection).values({
      organizationId: ctx.actor.organizationId,
      capability: "ai_model",
      provider: input.provider,
      status: "connected",
      accountLabel: input.accountLabel ?? input.provider,
      credentialRef: input.credentialRef,
      settings: input.settings ?? {},
    }).onConflictDoUpdate({
      target: [
        schema.integrationConnection.organizationId,
        schema.integrationConnection.capability,
        schema.integrationConnection.provider,
      ],
      set: {
        status: "connected",
        accountLabel: input.accountLabel ?? input.provider,
        credentialRef: input.credentialRef,
        settings: input.settings ?? {},
        lastError: null,
        updatedAt: new Date(),
      },
    }).returning();

    /**
     * The audit entry names the provider and NOT the credential reference.
     * The reference is not a secret, but an audit log is the most widely read
     * table in this database and there is no reason for the name of a
     * company's key to be in it.
     */
    await audit(tx, ctx, "ai.connected", "integration_connection", row!.id, null, {
      provider: input.provider,
    });

    return { connectionId: row!.id, provider: input.provider, status: row!.status };
  });
}

export async function disconnect(ctx: ServiceContext, input: { provider: string }) {
  return guardedWrite(ctx, "agent:configure", async (tx) => {
    const [row] = await tx.update(schema.integrationConnection)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(and(
        eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
        eq(schema.integrationConnection.capability, "ai_model"),
        eq(schema.integrationConnection.provider, input.provider),
        isNull(schema.integrationConnection.deletedAt),
      )).returning();

    if (!row) throw new NotFoundError("AI connection");

    /**
     * The usage rows are left alone. They are what an operator reconciles
     * against a bill that arrives after they disconnected, and deleting the
     * record of spend because the key was removed would hide exactly the
     * month somebody is asking about.
     */
    await audit(tx, ctx, "ai.disconnected", "integration_connection", row.id,
      { status: "connected" }, { status: "disconnected" });

    return { provider: input.provider, status: row.status };
  });
}

/* -------------------------------------------------------------- the limit */

export async function setSpendLimit(
  ctx: ServiceContext, input: { monthlyLimitMicros: number | null },
) {
  return guardedWrite(ctx, "agent:configure", async (tx) => {
    if (input.monthlyLimitMicros !== null && input.monthlyLimitMicros < 0) {
      throw new ConflictError("A spending ceiling cannot be less than nothing.");
    }

    const [existing] = await tx.select().from(schema.aiBudget)
      .where(eq(schema.aiBudget.organizationId, ctx.actor.organizationId)).limit(1);

    const [row] = await tx.insert(schema.aiBudget).values({
      organizationId: ctx.actor.organizationId,
      monthlyLimitMicros: input.monthlyLimitMicros,
    }).onConflictDoUpdate({
      target: schema.aiBudget.organizationId,
      set: { monthlyLimitMicros: input.monthlyLimitMicros, updatedAt: new Date() },
    }).returning();

    await audit(tx, ctx, "ai.spend_limit_set", "ai_budget", row!.id,
      { monthlyLimitMicros: existing?.monthlyLimitMicros ?? null },
      { monthlyLimitMicros: input.monthlyLimitMicros });

    return { monthlyLimitMicros: row!.monthlyLimitMicros };
  });
}

/* ------------------------------------------------------------ reading it */

export async function status(ctx: ServiceContext, deps: AiDeps = DEFAULT_DEPS) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const rows = await tx.select().from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
        eq(schema.integrationConnection.capability, "ai_model"),
        isNull(schema.integrationConnection.deletedAt),
      ));

    const limit = await limitFor(tx, ctx.actor.organizationId);
    const spent = await spentThisMonth(tx, ctx.actor.organizationId, (deps.now ?? (() => new Date()))());

    return {
      /**
       * Every connected provider, not one. A company running the cheap model
       * for summaries and the expensive one for decisions has two, and a
       * screen that showed one would be describing half their bill.
       */
      connections: rows.map((row) => ({
        connectionId: row.id,
        provider: row.provider,
        accountLabel: row.accountLabel,
        connected: row.status === "connected",
        lastError: row.lastError,
      })),
      monthlyLimitMicros: limit,
      spentThisMonthMicros: spent,
      /**
       * Said out loud, because a ceiling with no price behind it is a setting
       * that does nothing. The models an operator has actually used are in
       * `usage`; this is the count of calls this month whose cost nobody
       * could work out.
       */
      unpricedCallsThisMonth: await unpricedCount(
        tx, ctx.actor.organizationId, (deps.now ?? (() => new Date()))()),
    };
  });
}

async function unpricedCount(tx: Database, organizationId: string, now: Date): Promise<number> {
  const timezone = await timezoneOf(tx, organizationId);
  const [row] = await tx.execute<{ unpriced: string }>(sql`
    select count(*)::text as unpriced
    from public.ai_usage
    where organization_id = ${organizationId}
      and outcome = 'ok'
      and estimated_cost_micros is null
      and created_at >= date_trunc(
        'month', (${now.toISOString()}::timestamptz at time zone ${timezone})
      ) at time zone ${timezone}`);
  return Number(row?.unpriced ?? "0");
}

/** What was spent this month, broken down by what spent it. */
export async function usage(ctx: ServiceContext, deps: AiDeps = DEFAULT_DEPS) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const now = (deps.now ?? (() => new Date()))();
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const rows = await tx.execute<{
      provider: string; model: string; calls: string;
      input_tokens: string; output_tokens: string;
      cost_micros: string | null; priced: string;
    }>(sql`
      select provider, model,
             count(*)::text as calls,
             coalesce(sum(input_tokens), 0)::text as input_tokens,
             coalesce(sum(output_tokens), 0)::text as output_tokens,
             sum(estimated_cost_micros)::text as cost_micros,
             count(estimated_cost_micros)::text as priced
      from public.ai_usage
      where organization_id = ${ctx.actor.organizationId}
        and outcome = 'ok'
        and created_at >= date_trunc(
          'month', (${now.toISOString()}::timestamptz at time zone ${timezone})
        ) at time zone ${timezone}
      group by provider, model
      order by provider, model`);

    return {
      models: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        calls: Number(row.calls),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        /**
         * Null when NOTHING in this group could be priced. A partially priced
         * group reports the sum it has and says how many calls are behind it,
         * because a total that silently omits half its calls is the number
         * somebody budgets against.
         */
        estimatedCostMicros: row.cost_micros === null ? null : Number(row.cost_micros),
        pricedCalls: Number(row.priced),
      })),
    };
  });
}

/**
 * Which tools an agent running as this caller would be told about.
 *
 * Worth a surface of its own, because the answer is the whole security story
 * and an operator deciding whether to turn an agent on deserves to read the
 * list rather than take a sentence's word for it.
 */
export async function tools(ctx: ServiceContext) {
  return guardedRead(ctx, "agent:configure", async () => ({
    tools: offeredTools(ctx).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }));
}

/**
 * Prove a key works, without spending anything on finding out.
 *
 * Listing models is the only call any of these vendors offers that costs no
 * tokens. A connection test that sent a greeting would charge an operator for
 * pressing a button labelled Test.
 */
export async function verify(
  ctx: ServiceContext, input: { provider?: string | undefined }, deps: AiDeps = DEFAULT_DEPS,
) {
  const connection = await guardedRead(ctx, "agent:configure", (tx) =>
    connectionFor(tx, ctx.actor.organizationId, input.provider));

  const provider = await providerFrom(connection, deps);
  const outcome = await provider.models();

  if (!outcome.ok) {
    /**
     * Recorded on the connection so the settings screen can say what is
     * wrong without anybody re-running the test, and in its own transaction
     * because the test is not a mutation anybody asked for.
     */
    await guardedWrite(ctx, "agent:configure", async (tx) => {
      await tx.update(schema.integrationConnection)
        .set({
          lastError: `${outcome.code}: ${outcome.message}`,
          lastCheckedAt: new Date(), updatedAt: new Date(),
        })
        .where(eq(schema.integrationConnection.id, connection.id));
    });
    throw new ConflictError(outcome.message);
  }

  await guardedWrite(ctx, "agent:configure", async (tx) => {
    await tx.update(schema.integrationConnection)
      .set({ lastError: null, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationConnection.id, connection.id));
  });

  return {
    provider: connection.provider,
    models: outcome.models,
    defaultModel: provider.defaultModel,
    toolCallIdentity: provider.toolCallIdentity,
  };
}

/* ------------------------------------------------------------ running one */

export interface CompleteInput {
  /** Omit when exactly one provider is connected. See `connectionFor`. */
  provider?: string | undefined;
  /** Omit to use the connection's default. Refused when there is none. */
  model?: string | undefined;
  system?: string | undefined;
  messages: AiMessage[];
  maxOutputTokens: number;
  /** Whether to tell the model about the tools this caller may use. */
  offerTools?: boolean | undefined;
  /** A short label recorded against the spend. No prompt text is stored. */
  purpose: string;
}

async function recordUsage(
  tx: Database, ctx: ServiceContext, row: {
    connectionId: string; provider: string; model: string; purpose: string;
    inputTokens: number; outputTokens: number;
    cachedInputTokens: number | null; estimatedCostMicros: number | null;
    outcome: "ok" | "failed" | "refused"; detail: string | null;
  },
): Promise<string> {
  const [written] = await tx.insert(schema.aiUsage).values({
    organizationId: ctx.actor.organizationId,
    connectionId: row.connectionId,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    estimatedCostMicros: row.estimatedCostMicros,
    outcome: row.outcome,
    detail: row.detail,
    /**
     * Written on every row this call produces, including the refusals, so a
     * retry of a call that was refused by the ceiling is also refused as a
     * duplicate rather than being allowed through to spend money the second
     * time somebody presses the button.
     */
    idempotencyKey: ctx.idempotencyKey ?? null,
    /**
     * The same rule the audit log follows: the system and a portal caller
     * have no user row, and writing the nil uuid breaks a foreign key
     * underneath anybody who could read the error.
     */
    actorUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    agentId: ctx.agentId ?? ctx.actor.agentId ?? null,
  }).returning();
  return written!.id;
}

/**
 * Ask the model, record what it cost.
 *
 * Three phases, and the shape is the interesting part.
 *
 * The vendor call happens BETWEEN two transactions rather than inside one.
 * The payments seam holds a transaction across its processor call, which is
 * right there: a card authorization is a second or two. A model call with a
 * large answer is a minute or more, and a Postgres transaction held open for
 * a minute per agent turn exhausts the connection pool of a box that is also
 * serving a dispatch board.
 *
 * The cost is that the ceiling is checked against spend recorded at the start
 * of the call rather than at the instant the vendor is billed, which is the
 * same bound `ceilingVerdict` already states and not a new weakness.
 */
export async function runCompletion(
  ctx: ServiceContext, input: CompleteInput, deps: AiDeps = DEFAULT_DEPS,
) {
  return turn(ctx, "agent:configure", input,
    input.offerTools ? offeredTools(ctx) : undefined, deps);
}

/**
 * One turn for one of the product's own agents.
 *
 * The same three phases, the same ceiling, the same usage row and the same
 * refusal of a repeated key as `runCompletion`, with two differences, and both
 * are narrower rather than wider:
 *
 *   THE TOOLS ARE THE AGENT'S OWN SHORT LIST (`core/agents`), already filtered
 *   by the permissions of the person it runs as, rather than the MCP
 *   catalogue. An agent that runs unattended on a stranger's words is offered
 *   what its job needs and nothing else.
 *
 *   THE GUARD IS THE AGENT'S OWN PERMISSION rather than `agent:configure`.
 *   Configuring agents is an owner's job; an agent answering the website as a
 *   customer service person runs with that person's authority, and that person
 *   does not configure agents. Requiring `agent:configure` here would mean every
 *   agent had to run as an owner, which is the opposite of the point.
 */
export async function agentTurn(
  ctx: ServiceContext,
  input: Omit<CompleteInput, "offerTools"> & { permission: Permission; tools: AiToolDefinition[] },
  deps: AiDeps = DEFAULT_DEPS,
) {
  return turn(ctx, input.permission, input, input.tools, deps);
}

async function turn(
  ctx: ServiceContext, guard: Permission, input: Omit<CompleteInput, "offerTools">,
  tools: AiToolDefinition[] | undefined, deps: AiDeps,
) {
  const now = (deps.now ?? (() => new Date()))();

  /* Phase one: who, which model, and may it run at all. */
  const plan = await guardedWrite(ctx, guard, async (tx) => {
    /**
     * A RETRY IS REFUSED, NOT REPLAYED, and this is the first thing checked.
     *
     * Every other POST here carries an idempotency key because a client on a
     * truck with bad signal retries. The usual reasoning is a duplicate
     * record; here it is money, which makes it stronger: a retried completion
     * is a second answer nobody asked for, on a bill the operator pays per
     * token.
     *
     * Replaying would mean returning the first answer, which would mean
     * having stored it, and this module stores no word of any prompt or
     * response because they routinely carry a customer's address and their
     * invoice. So a duplicate costs the caller an error they can act on
     * rather than costing them that promise.
     */
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ id: schema.aiUsage.id, at: schema.aiUsage.createdAt })
        .from(schema.aiUsage)
        .where(and(
          eq(schema.aiUsage.organizationId, ctx.actor.organizationId),
          eq(schema.aiUsage.idempotencyKey, ctx.idempotencyKey),
        )).limit(1);

      if (seen) {
        throw new ConflictError(
          `A completion was already run under that idempotency key at ${seen.at.toISOString()}. `
          + "The answer is not stored here, so it cannot be handed back: send a new key if you "
          + "meant to ask again.",
        );
      }
    }

    const connection = await connectionFor(tx, ctx.actor.organizationId, input.provider);
    const provider = await providerFrom(connection, deps);

    const settingsModel = connection.settings["defaultModel"];
    const model = input.model
      ?? (typeof settingsModel === "string" ? settingsModel : null)
      ?? provider.defaultModel;

    if (!model) {
      /**
       * Refused rather than guessed. A model name written from memory is
       * either one the vendor withdrew, which reads to an operator as a
       * broken integration, or a real one that is not the one they chose to
       * be billed for.
       */
      throw new ConflictError(
        `No model named for the ${connection.provider} connection. Name one on the call, `
        + "or set defaultModel in the connection's settings.",
      );
    }

    const rate = provider.rateFor(model);
    const limit = await limitFor(tx, ctx.actor.organizationId);
    const spent = await spentThisMonth(tx, ctx.actor.organizationId, now);
    const refusal = ceilingVerdict(limit, spent, rate, model, input.maxOutputTokens);

    if (refusal) {
      /**
       * The refusal is RECORDED, and that is why this phase is a write.
       *
       * A ceiling that refuses and leaves no trace produces a support
       * conversation with nothing behind it: the person who hit it saw an
       * error and the owner who set it sees a quiet month. Tokens are zero
       * because nothing was sent.
       */
      const usageId = await recordUsage(tx, ctx, {
        connectionId: connection.id, provider: connection.provider, model,
        purpose: input.purpose,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: null,
        estimatedCostMicros: 0,
        outcome: "refused", detail: refusal,
      });
      await audit(tx, ctx, "ai.refused", "ai_usage", usageId, null,
        { model, provider: connection.provider, limit, spent });
      return { refusal, connection: null, provider: null, model: null, rate: null, limit, spent } as const;
    }

    return { refusal: null, connection, provider, model, rate, limit, spent } as const;
  });

  /**
   * A DISCRIMINATED ARM, not an `in` check on a field one arm happens to lack.
   *
   * Both arms carry every key now, so narrowing on `refusal` is a property
   * check the compiler can act on under any configuration. The `in` form
   * depended on `exactOptionalPropertyTypes`, which the API package sets and
   * the web app does not: the same source typechecked clean in one and failed
   * in the other, which is a worse outcome than either error alone because
   * one of the two builds would have shipped it.
   */
  if (plan.refusal !== null) throw new ConflictError(plan.refusal);

  /* Phase two: the vendor, outside any transaction. */
  const outcome = await plan.provider.complete({
    model: plan.model,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    maxOutputTokens: input.maxOutputTokens,
  });

  /* Phase three: what it cost. */
  if (!outcome.ok) {
    await guardedWrite(ctx, guard, async (tx) => {
      /**
       * Recorded with no tokens, which is the truth for every failure these
       * vendors have: a request they refused at the edge was not metered.
       * Cost is null rather than zero, because "we do not know what this cost"
       * and "this cost nothing" are different claims and only one of them is
       * safe to sum.
       */
      await recordUsage(tx, ctx, {
        connectionId: plan.connection.id, provider: plan.connection.provider,
        model: plan.model, purpose: input.purpose,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: null,
        estimatedCostMicros: null,
        outcome: "failed", detail: `${outcome.code}: ${outcome.message}`,
      });
    });
    throw new ConflictError(outcome.message);
  }

  const completion = outcome.completion;
  const cost = plan.rate
    ? costOf(plan.rate, completion.usage.inputTokens, completion.usage.outputTokens)
    : null;

  const usageId = await guardedWrite(ctx, guard, async (tx) => {
    const id = await recordUsage(tx, ctx, {
      connectionId: plan.connection.id, provider: plan.connection.provider,
      model: completion.model, purpose: input.purpose,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      cachedInputTokens: completion.usage.cachedInputTokens,
      estimatedCostMicros: cost,
      outcome: "ok", detail: null,
    });
    /**
     * The audit row carries the counts and the cost and NOT a word of the
     * conversation. An audit log is read by people investigating a bill, and
     * a prompt in this product routinely contains a customer's address and an
     * invoice.
     */
    await audit(tx, ctx, "ai.completion", "ai_usage", id, null, {
      provider: plan.connection.provider, model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      estimatedCostMicros: cost,
    });
    return id;
  });

  return {
    usageId,
    provider: plan.connection.provider,
    model: completion.model,
    stop: completion.stop,
    /**
     * Text and tool calls, separated, because the caller does two different
     * things with them: show one to a person and run the other through the
     * dispatcher. `content` carries the whole thing in order, including the
     * vendor state blocks a caller has to echo back to continue the loop.
     */
    text: completion.content
      .filter((part): part is Extract<AiContent, { type: "text" }> => part.type === "text")
      .map((part) => part.text).join(""),
    toolCalls: completion.content
      .filter((part): part is Extract<AiContent, { type: "toolCall" }> => part.type === "toolCall")
      .map((part) => ({ callId: part.callId, name: part.name, input: part.input })),
    content: completion.content,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    cachedInputTokens: completion.usage.cachedInputTokens,
    estimatedCostMicros: cost,
    spentThisMonthMicros: plan.spent + (cost ?? 0),
    monthlyLimitMicros: plan.limit,
  };
}

export const handlers = {
  getAiStatus: (ctx: ServiceContext) => status(ctx),
  getAiUsage: (ctx: ServiceContext) => usage(ctx),
  listAgentTools: (ctx: ServiceContext) => tools(ctx),
  connectAiProvider: (ctx: ServiceContext, input: ConnectInput) => connect(ctx, input),
  disconnectAiProvider: (ctx: ServiceContext, input: { provider: string }) =>
    disconnect(ctx, input),
  setAiSpendLimit: (ctx: ServiceContext, input: { monthlyLimitMicros: number | null }) =>
    setSpendLimit(ctx, input),
  testAiConnection: (ctx: ServiceContext, input: { provider?: string | undefined }) =>
    verify(ctx, input),
  runAiCompletion: (ctx: ServiceContext, input: CompleteInput) => runCompletion(ctx, input),
} as const;
