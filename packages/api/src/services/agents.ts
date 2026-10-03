import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  agents as a, assertCan, can, permissionsFor, SYSTEM_USER_ID, time,
  type Actor, type Permission,
} from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, audit, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { memberActor } from "./session";
import { agentTurn, secretFromEnvironment, type AiDeps } from "./ai";
import { companyPeople } from "./report-delivery";
import "../ai/index";

/**
 * THE AGENTS, ON THE SEAM
 *
 * `ai.ts` is the seam: a company's own key, a bill, a ceiling, and a model
 * that is told about nothing its operator could not do. This file is what sits
 * on it: five agents, each with a short list of actions (`core/agents`), each
 * acting as a named person and never with more than that person may do, and
 * every one of them PROPOSING rather than changing anything until a person, or
 * the company's own standing choice, says yes.
 *
 * WHO AN AGENT IS.
 *
 * A run somebody starts (a dispatcher asking the copilot, an estimator asking
 * for a draft, the office asking intake to read a thread) runs as THEM, with
 * the agent's id beside their user id on every audit line. A run nobody starts
 * (a text arriving at nine at night, a visitor on the website, the morning's
 * collections) runs as the person the company chose on the agent's settings,
 * read fresh from their membership each time: somebody removed from the
 * company, or narrowed since, is what the agent becomes too.
 *
 * WHAT IT MAY DO is the intersection of two lists: the agent's own actions,
 * and that person's permissions. A model is only told about actions in both,
 * and an answer naming anything else is refused here and logged as refused.
 *
 * WHAT HAPPENS TO ITS ANSWER. It is checked against its schema and against
 * the company's records, written down as a proposal, and then either waits for
 * a person or, on an agent the company set to act on its own, is applied at
 * once by the same service a person's click would call, under the same
 * permission check, as the same person. There is no path from a model's
 * answer to a change that a person could not have made by hand.
 */

export const agentId = (kind: a.AgentKind): string => `ai:${kind}`;

/* -------------------------------------------------------------- settings */

export async function settingWithin(
  tx: Database, organizationId: string, kind: a.AgentKind,
): Promise<a.AgentSettings> {
  const [row] = await tx.select().from(schema.aiAgentSetting)
    .where(and(
      eq(schema.aiAgentSetting.organizationId, organizationId),
      eq(schema.aiAgentSetting.agent, kind),
    )).limit(1);
  return a.readSettings(kind, { ...(row?.settings ?? {}), runAsUserId: row?.runAsUserId ?? null });
}

/** When this agent was last switched on, or null when it is off. */
export async function enabledSince(tx: Database, organizationId: string, kind: a.AgentKind): Promise<Date | null> {
  const [row] = await tx.select({ settings: schema.aiAgentSetting.settings }).from(schema.aiAgentSetting)
    .where(and(eq(schema.aiAgentSetting.organizationId, organizationId), eq(schema.aiAgentSetting.agent, kind))).limit(1);
  const at = row?.settings["enabledAt"];
  return typeof at === "string" && row?.settings["enabled"] === true ? new Date(at) : null;
}

/**
 * Whether an agent is switched on, for a screen deciding whether to offer its
 * button. Says nothing else, so it asks no permission beyond being a member;
 * whatever the button does is guarded by its own service.
 */
export async function isOn(ctx: ServiceContext, kind: a.AgentKind): Promise<boolean> {
  return inTenant(ctx, async (tx) => (await settingWithin(tx, ctx.actor.organizationId, kind)).enabled);
}

/** How many model calls this agent has made today, in the company's day. */
async function runsToday(tx: Database, organizationId: string, kind: a.AgentKind, now: Date): Promise<number> {
  const timezone = await timezoneOf(tx, organizationId);
  const { start } = time.dayBoundsIn(time.dateIn(now, timezone), timezone);
  const [row] = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from public.ai_usage
    where organization_id = ${organizationId}
      and agent_id = ${agentId(kind)}
      and outcome <> 'refused'
      and created_at >= ${start.toISOString()}::timestamptz`);
  return Number(row?.n ?? "0");
}

/** Every agent, as the settings screen shows it. */
export async function list(ctx: ServiceContext, deps: Pick<AiDeps, "now"> = {}) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const people = await companyPeople(tx);
    const now = (deps.now ?? (() => new Date()))();
    const out = [];
    for (const kind of a.AGENT_KINDS) {
      const settings = await settingWithin(tx, ctx.actor.organizationId, kind);
      const runAs = settings.runAsUserId
        ? await memberActor(tx, ctx.actor.organizationId, settings.runAsUserId)
        : null;
      const def = a.AGENTS[kind];
      out.push({
        agent: kind,
        label: def.label,
        description: def.description,
        autoAllowed: def.autoAllowed,
        settings,
        runAs: settings.runAsUserId
          ? {
              userId: settings.runAsUserId,
              name: people.get(settings.runAsUserId)?.name ?? people.get(settings.runAsUserId)?.email ?? null,
              active: runAs !== null,
              /** What the agent may actually do as them, which is the honest answer to "what can it do". */
              actions: runAs ? a.offeredActions(kind, runAs).map((action) => action.name) : [],
              missing: runAs ? a.missingToRun(kind, runAs) : [],
            }
          : null,
        actions: def.actions.map((action) => ({
          name: action.name, description: action.description,
          permissions: [...action.permissions], consequential: action.consequential,
        })),
        runsToday: await runsToday(tx, ctx.actor.organizationId, kind, now),
      });
    }
    return { agents: out };
  });
}

export interface ConfigureInput {
  agent: a.AgentKind;
  settings: a.AgentSettings;
}

/**
 * Save one agent's settings.
 *
 * The person an agent runs as may hold NOTHING the person choosing them does
 * not. Without that, anybody allowed to configure agents could point one at
 * the owner and borrow everything the owner can do through it. Checked against
 * the chosen person's membership as it is today; their role changing later is
 * read fresh on every run, so it can narrow the agent and never widen what was
 * agreed to here beyond that person's own access.
 */
export async function configure(ctx: ServiceContext, input: ConfigureInput) {
  return guardedWrite(ctx, "agent:configure", async (tx) => {
    const checked = a.checkSettings(input.agent, input.settings);
    if (!checked.ok) throw new ConflictError(checked.reason);
    const settings = checked.settings;

    if (settings.runAsUserId) {
      const runAs = await memberActor(tx, ctx.actor.organizationId, settings.runAsUserId);
      if (!runAs) throw new ConflictError("That person is not an active member of this company, so an agent cannot act as them.");
      const widened = a.wouldWiden(permissionsFor(ctx.actor), permissionsFor(runAs));
      if (widened.length > 0) {
        throw new ConflictError(
          `That person can do things you cannot (${widened.slice(0, 6).join(", ")}${widened.length > 6 ? ", and more" : ""}), `
          + "so you cannot hand their access to an agent. Choose somebody with the same access as you or less, or ask an owner.",
        );
      }
      const missing = a.missingToRun(input.agent, runAs);
      if (settings.enabled && missing.length > 0) {
        throw new ConflictError(
          `That person cannot read what this agent reads (${missing.join(", ")}). Choose somebody who can.`,
        );
      }
    }

    const [before] = await tx.select().from(schema.aiAgentSetting)
      .where(and(
        eq(schema.aiAgentSetting.organizationId, ctx.actor.organizationId),
        eq(schema.aiAgentSetting.agent, input.agent),
      )).limit(1);

    const was = before ? a.readSettings(input.agent, { ...before.settings, runAsUserId: before.runAsUserId }) : null;
    const { runAsUserId, ...rest } = settings;
    /**
     * When it was last switched on, kept beside the settings so an agent that
     * reads what has arrived "since it was turned on" does not start again
     * every time somebody changes its tone, and does not read a year of old
     * messages the first time it is switched on.
     */
    const enabledAt = settings.enabled
      ? (was?.enabled && typeof before?.settings["enabledAt"] === "string" ? before.settings["enabledAt"] : new Date().toISOString())
      : null;
    const document = { ...rest, enabledAt };
    const [row] = await tx.insert(schema.aiAgentSetting).values({
      organizationId: ctx.actor.organizationId,
      agent: input.agent,
      runAsUserId,
      settings: document as unknown as Record<string, unknown>,
      updatedByUserId: ctx.actor.userId,
    }).onConflictDoUpdate({
      target: [schema.aiAgentSetting.organizationId, schema.aiAgentSetting.agent],
      set: {
        runAsUserId,
        settings: document as unknown as Record<string, unknown>,
        updatedByUserId: ctx.actor.userId,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "ai.agent_configured", "ai_agent_setting", row!.id,
      was ? { enabled: was.enabled, mode: was.mode, runAsUserId: was.runAsUserId } : null,
      { enabled: settings.enabled, mode: settings.mode, runAsUserId: settings.runAsUserId });
    await note(tx, ctx, {
      agent: input.agent, kind: "settings",
      detail: settings.enabled
        ? `Turned on, ${settings.mode === "auto" ? "acting on its own" : "proposing for a person to approve"}.`
        : "Turned off.",
    });
    return { agent: input.agent, settings };
  });
}

/* -------------------------------------------------------------- the log */

export type ActivityKind =
  | "settings" | "drafted" | "applied" | "dismissed" | "refused" | "failed"
  | "answered" | "handed_off" | "skipped";

/** One line in an agent's log. */
export async function note(tx: Database, ctx: ServiceContext, input: {
  agent: a.AgentKind; kind: ActivityKind; detail: string;
  proposalId?: string | null | undefined; automatic?: boolean | undefined;
}): Promise<void> {
  await tx.insert(schema.aiAgentActivity).values({
    organizationId: ctx.actor.organizationId,
    agent: input.agent,
    kind: input.kind,
    proposalId: input.proposalId ?? null,
    /** Never a prompt. A sentence written here, by this code, about what happened. */
    detail: input.detail.slice(0, 1000),
    actorUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    automatic: input.automatic ?? false,
  });
}

export async function activity(ctx: ServiceContext, input: { agent?: a.AgentKind | undefined; limit?: number | undefined }) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const people = await companyPeople(tx);
    const rows = await tx.select().from(schema.aiAgentActivity)
      .where(input.agent ? eq(schema.aiAgentActivity.agent, input.agent) : undefined)
      .orderBy(desc(schema.aiAgentActivity.createdAt), desc(schema.aiAgentActivity.id))
      .limit(Math.min(input.limit ?? 100, 500));
    return {
      entries: rows.map((row) => ({
        id: row.id,
        agent: row.agent,
        kind: row.kind,
        detail: row.detail,
        proposalId: row.proposalId,
        automatic: row.automatic,
        actorUserId: row.actorUserId,
        actorName: row.actorUserId ? people.get(row.actorUserId)?.name ?? people.get(row.actorUserId)?.email ?? null : null,
        at: row.createdAt.toISOString(),
      })),
    };
  });
}

/* --------------------------------------------------------- who it runs as */

export type Acting =
  | { ok: true; ctx: ServiceContext; settings: a.AgentSettings; startedBy: string | null }
  | { ok: false; reason: string; settings: a.AgentSettings };

/** A context that may only read settings, for a run nobody started. */
const settingsReader = (db: Database, organizationId: string): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [] },
  db,
});

/**
 * The context an agent runs in.
 *
 * Started by a person: that person, with the agent's id on every audit line.
 * Started by nobody: the person on the agent's settings, read from their
 * membership NOW. Either way the result is an ordinary service context, and
 * everything the agent then reads or changes goes through the ordinary guards.
 */
export async function actingAs(
  db: Database, organizationId: string, kind: a.AgentKind, startedBy?: ServiceContext | undefined,
): Promise<Acting> {
  const settings = await inTenant(settingsReader(db, organizationId),
    (tx) => settingWithin(tx, organizationId, kind));

  if (startedBy) {
    return {
      ok: true, settings, startedBy: startedBy.actor.userId,
      ctx: {
        ...startedBy,
        actor: { ...startedBy.actor, agentId: agentId(kind) },
        agentId: agentId(kind),
      },
    };
  }

  if (!settings.enabled) return { ok: false, reason: `The ${a.AGENTS[kind].label.toLowerCase()} agent is off.`, settings };
  if (!settings.runAsUserId) {
    return { ok: false, reason: "Nobody is chosen for this agent to act as, so it does not run on its own.", settings };
  }
  const actor = await inTenant(settingsReader(db, organizationId),
    (tx) => memberActor(tx, organizationId, settings.runAsUserId!));
  if (!actor) {
    return { ok: false, reason: "The person this agent acts as is no longer an active member, so it has stopped.", settings };
  }
  const missing = a.missingToRun(kind, actor);
  if (missing.length > 0) {
    return { ok: false, reason: `The person this agent acts as can no longer read what it needs (${missing.join(", ")}).`, settings };
  }
  const agentActor: Actor = { ...actor, agentId: agentId(kind) };
  return { ok: true, settings, startedBy: null, ctx: { actor: agentActor, db, agentId: agentId(kind) } };
}

/* ------------------------------------------------------------ asking it */

export type Answer =
  | { ok: true; usageId: string; action: a.AgentAction; input: Record<string, unknown> }
  | { ok: false; usageId: string | null; refusal: "unknown" | "not_permitted" | "invalid" | "no_tool" | "limit" | "model"; reason: string };

export const DEFAULT_AGENT_DEPS: AiDeps = { readSecret: secretFromEnvironment };

/**
 * Ask the model, once, and hold its answer to the agent's rules.
 *
 * ONE TURN, AND ONE TOOL CALL READ FROM IT. Every agent here is shaped so a
 * single answer is enough: the facts it may choose from are in the message,
 * so it never needs to call a tool to look something up. That is cheaper, it
 * bounds what one run can cost to one call, and it means the only thing a
 * model's answer can be is a proposal.
 *
 * A refused answer is logged here, in the agent's own log, with the reason,
 * because "the model asked for something it may not have" is the line an
 * owner most needs to be able to find.
 */
export async function ask(
  acting: Extract<Acting, { ok: true }>, kind: a.AgentKind,
  prompt: a.Prompt, purpose: string, deps: AiDeps,
): Promise<Answer> {
  const { ctx, settings } = acting;
  for (const permission of a.AGENTS[kind].basePermissions) assertCan(ctx.actor, permission);

  const now = (deps.now ?? (() => new Date()))();
  const used = await inTenant(ctx, (tx) => runsToday(tx, ctx.actor.organizationId, kind, now));
  if (used >= settings.limits.runsPerDay) {
    const reason = `The ${a.AGENTS[kind].label.toLowerCase()} agent has used today's ${settings.limits.runsPerDay} runs. It starts again tomorrow, or raise the limit.`;
    await inTenant(ctx, (tx) => note(tx, ctx, { agent: kind, kind: "skipped", detail: reason }));
    return { ok: false, usageId: null, refusal: "limit", reason };
  }

  const offered = a.offeredActions(kind, ctx.actor);
  let turn;
  try {
    turn = await agentTurn(ctx, {
      permission: a.AGENTS[kind].basePermissions[0]!,
      ...(settings.provider ? { provider: settings.provider } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      system: prompt.system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
      tools: offered.map((action) => ({
        name: action.name, description: action.description, inputSchema: action.inputSchema,
      })),
      maxOutputTokens: settings.limits.maxOutputTokens,
      purpose,
    }, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The model could not be reached.";
    await inTenant(ctx, (tx) => note(tx, ctx, { agent: kind, kind: "failed", detail: reason }));
    return { ok: false, usageId: null, refusal: "model", reason };
  }

  const call = turn.toolCalls[0];
  if (!call) {
    const reason = turn.stop === "maxTokens"
      ? "The model ran out of room before it finished. Raise the longest answer limit."
      : "The model answered in words rather than with a draft, so nothing was proposed.";
    await inTenant(ctx, (tx) => note(tx, ctx, { agent: kind, kind: "failed", detail: reason }));
    return { ok: false, usageId: turn.usageId, refusal: "no_tool", reason };
  }

  const verdict = a.admitCall(kind, call, ctx.actor);
  if (!verdict.ok) {
    await inTenant(ctx, (tx) => note(tx, ctx, { agent: kind, kind: "refused", detail: verdict.reason }));
    await inTenant(ctx, (tx) => audit(tx, ctx, "ai.agent_refused", "ai_usage", turn.usageId, null, {
      agent: kind, tool: call.name.slice(0, 100), refusal: verdict.refusal,
    }));
    return { ok: false, usageId: turn.usageId, refusal: verdict.refusal, reason: verdict.reason };
  }
  return { ok: true, usageId: turn.usageId, action: verdict.action, input: verdict.input };
}

/* ------------------------------------------------------------ proposals */

export type ProposalRow = typeof schema.aiAgentProposal.$inferSelect;

/**
 * Write a proposal down, or hand back the open one already there.
 *
 * The open proposal for a thing wins over a new one, because two drafts for
 * one text on the office's list is how a booking gets made twice. A caller
 * that wants a fresh draft supersedes the old one first.
 */
export async function propose(tx: Database, acting: Extract<Acting, { ok: true }>, input: {
  agent: a.AgentKind; action: string; sourceKind: string; sourceId: string;
  summary: string; draft: Record<string, unknown>; usageId: string | null;
  idempotencyKey?: string | null | undefined;
}): Promise<{ row: ProposalRow; created: boolean }> {
  const { ctx } = acting;
  const inserted = await tx.insert(schema.aiAgentProposal).values({
    organizationId: ctx.actor.organizationId,
    agent: input.agent,
    action: input.action,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    summary: input.summary.slice(0, 300),
    draft: input.draft,
    usageId: input.usageId,
    runAsUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    startedByUserId: acting.startedBy,
    idempotencyKey: input.idempotencyKey ?? null,
  }).onConflictDoNothing().returning();

  if (inserted[0]) {
    await note(tx, ctx, {
      agent: input.agent, kind: "drafted", proposalId: inserted[0].id, detail: input.summary,
    });
    return { row: inserted[0], created: true };
  }
  const [open] = await tx.select().from(schema.aiAgentProposal)
    .where(and(
      eq(schema.aiAgentProposal.agent, input.agent),
      eq(schema.aiAgentProposal.sourceKind, input.sourceKind),
      eq(schema.aiAgentProposal.sourceId, input.sourceId),
      eq(schema.aiAgentProposal.status, "proposed"),
    )).limit(1);
  if (open) return { row: open, created: false };
  const [byKey] = input.idempotencyKey
    ? await tx.select().from(schema.aiAgentProposal)
        .where(eq(schema.aiAgentProposal.idempotencyKey, input.idempotencyKey)).limit(1)
    : [];
  if (byKey) return { row: byKey, created: false };
  throw new ConflictError("Another draft for this was being written at the same moment. Try again.");
}

/** The proposal a caller asked for, if it belongs to this agent. */
export async function proposalWithin(tx: Database, agent: a.AgentKind, id: string): Promise<ProposalRow> {
  const [row] = await tx.select().from(schema.aiAgentProposal)
    .where(and(eq(schema.aiAgentProposal.id, id), eq(schema.aiAgentProposal.agent, agent))).limit(1);
  if (!row) throw new NotFoundError("Draft");
  return row;
}

/** Whether a proposal created under this key already exists, for a retried request. */
export async function proposalByKey(tx: Database, key: string | undefined): Promise<ProposalRow | null> {
  if (!key) return null;
  const [row] = await tx.select().from(schema.aiAgentProposal)
    .where(eq(schema.aiAgentProposal.idempotencyKey, key)).limit(1);
  return row ?? null;
}

export async function markApplied(tx: Database, ctx: ServiceContext, row: ProposalRow, input: {
  outcome: Record<string, unknown>; automatic: boolean; detail: string;
}): Promise<ProposalRow> {
  const [updated] = await tx.update(schema.aiAgentProposal).set({
    status: "applied",
    outcome: input.outcome,
    appliedAutomatically: input.automatic,
    decidedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    decidedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.aiAgentProposal.id, row.id)).returning();
  await note(tx, ctx, {
    agent: row.agent, kind: "applied", proposalId: row.id, detail: input.detail, automatic: input.automatic,
  });
  await audit(tx, ctx, "ai.proposal_applied", "ai_agent_proposal", row.id,
    { status: row.status }, { status: "applied", automatic: input.automatic, outcome: input.outcome });
  return updated!;
}

export async function markFailed(tx: Database, ctx: ServiceContext, row: ProposalRow, reason: string, automatic: boolean): Promise<void> {
  await tx.update(schema.aiAgentProposal).set({
    note: reason.slice(0, 1000), updatedAt: new Date(),
  }).where(eq(schema.aiAgentProposal.id, row.id));
  await note(tx, ctx, { agent: row.agent, kind: "failed", proposalId: row.id, detail: reason, automatic });
}

/**
 * Say no to a proposal.
 *
 * Guarded by the permission it would have taken to say yes, because the
 * person who decides whether a booking is made is the person who may decide
 * it is not.
 */
export async function dismiss(
  ctx: ServiceContext, permission: Permission, agent: a.AgentKind, input: { id: string; reason?: string | undefined },
) {
  return guardedWrite(ctx, permission, async (tx) => {
    const row = await proposalWithin(tx, agent, input.id);
    if (row.status === "dismissed") return shape(row);
    if (row.status !== "proposed") throw new ConflictError(`This draft was already ${row.status}.`);
    const [updated] = await tx.update(schema.aiAgentProposal).set({
      status: "dismissed",
      decidedByUserId: ctx.actor.userId,
      decidedAt: new Date(),
      note: input.reason?.slice(0, 1000) ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.aiAgentProposal.id, row.id)).returning();
    await note(tx, ctx, {
      agent, kind: "dismissed", proposalId: row.id,
      detail: input.reason ? `Dismissed: ${input.reason}` : "Dismissed.",
    });
    await audit(tx, ctx, "ai.proposal_dismissed", "ai_agent_proposal", row.id, { status: "proposed" }, { status: "dismissed" });
    return shape(updated!);
  });
}

/** A proposal as the API returns it. */
export function shape(row: ProposalRow) {
  return {
    id: row.id,
    agent: row.agent,
    action: row.action,
    status: row.status,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    summary: row.summary,
    draft: row.draft,
    appliedAutomatically: row.appliedAutomatically,
    outcome: row.outcome ?? null,
    note: row.note,
    runAsUserId: row.runAsUserId,
    startedByUserId: row.startedByUserId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type ProposalView = ReturnType<typeof shape>;

/** Proposals for one agent, newest first. */
export async function proposals(ctx: ServiceContext, permission: Permission, agent: a.AgentKind, input: {
  status?: ("proposed" | "applied" | "dismissed" | "failed" | "superseded")[] | undefined;
  sourceKind?: string | undefined; sourceId?: string | undefined; limit?: number | undefined;
}) {
  return guardedRead(ctx, permission, async (tx) => {
    const rows = await tx.select().from(schema.aiAgentProposal)
      .where(and(
        eq(schema.aiAgentProposal.agent, agent),
        input.status && input.status.length > 0
          ? inArray(schema.aiAgentProposal.status, input.status) : undefined,
        input.sourceKind ? eq(schema.aiAgentProposal.sourceKind, input.sourceKind) : undefined,
        input.sourceId ? eq(schema.aiAgentProposal.sourceId, input.sourceId) : undefined,
      ))
      .orderBy(desc(schema.aiAgentProposal.createdAt), desc(schema.aiAgentProposal.id))
      .limit(Math.min(input.limit ?? 50, 200));
    return { drafts: rows.map(shape) };
  });
}

/** Whether a person holding these permissions could apply this agent's proposals. */
export const mayDecide = (actor: Actor, permissions: readonly Permission[]): boolean =>
  permissions.every((p) => can(actor, p));

export const handlers = {
  listAgents: (ctx: ServiceContext) => list(ctx),
  configureAgent: (ctx: ServiceContext, input: ConfigureInput) => configure(ctx, input),
  listAgentActivity: (ctx: ServiceContext, input: { agent?: a.AgentKind | undefined; limit?: number | undefined }) =>
    activity(ctx, input),
} as const;
