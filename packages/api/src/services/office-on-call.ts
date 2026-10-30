import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, notices as rules, time, type Actor } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, timezoneOf, ConflictError, type ServiceContext } from "./context";
import { memberActor } from "./session";

/**
 * WHO IS ON CALL FOR THE OFFICE'S NOTICES (M34)
 *
 * Three notices are not for one named person: a deadline about to be missed,
 * a customer asking to change a visit and an automatic payment that failed.
 * Each tells everybody who holds the permission that answers it. That is right
 * for a company of two and wrong for one with six people in the office, who
 * are all told, at night as well.
 *
 * So a company can keep an office rota: a person and the company days they
 * cover. And it can send any of the three kinds to whoever is on call that day
 * instead, kind by kind. Off for every kind until it switches one on, so
 * nothing changes for a company that never opens the page.
 *
 * NOT THE TECHNICIANS' ROTA. `on-call.ts` is who takes customers' calls after
 * hours: a technician and a branch, by the minute, with a pay multiplier. The
 * people who answer the office queue mostly have no technician record, and
 * "on call for the office" is a day's duty, not a night's shift. Two rotas
 * for two jobs, each on its own page.
 *
 * NEVER NOBODY. `raiseToHolders` asks `onCallToday` first. Where the kind goes
 * to the rota and somebody on it today can be told, only they are told. Where
 * nobody is on call, or nobody on call holds the permission or can open the
 * record, everybody who handles it is told, as before. A gap in the rota is
 * never how a failed payment goes unheard.
 *
 * The company's to keep, with `settings:read` to look and `settings:write` to
 * change, like what new people are told, and every change audited. A person
 * sees their own turns on their own page (`staff-notices.settings`).
 */

export interface OnCallTurnView {
  id: string;
  userId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
  /** Whether this turn covers the company's today. */
  today: boolean;
}

export interface OnCallView {
  /** The company's today, the day the rota is read for. */
  today: string;
  kinds: { kind: rules.OnCallKind; label: string; description: string; on: boolean }[];
  /** Turns that cover today or a day after it, soonest first. */
  turns: OnCallTurnView[];
  /** Who is on call today, by name. Empty is nobody, so everybody is told. */
  onCallToday: string[];
  /** The people who can be put on the rota: working here, and able to answer at least one of the three kinds. */
  people: { userId: string; name: string; answers: rules.OnCallKind[] }[];
}

const SETTING = "officeOnCall";

async function savedKinds(tx: Database, organizationId: string): Promise<rules.OnCallKind[]> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return rules.onCallKinds(((row?.settings ?? {}) as Record<string, unknown>)[SETTING]);
}

async function todayOf(tx: Database, organizationId: string, now: Date): Promise<string> {
  return time.dateIn(now, await timezoneOf(tx, organizationId));
}

/** Names of the people who work here, by user. */
async function names(tx: Database): Promise<Map<string, string>> {
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  return new Map([...rows].map((r) => [r.user_id, r.name ?? r.email]));
}

/** Which of the three kinds this person may answer, as their own session would. */
function answers(actor: Actor): rules.OnCallKind[] {
  return rules.ON_CALL_KINDS.filter((kind) => {
    const permission = rules.QUEUE_KIND_HANDLER[kind];
    return permission ? can(actor, permission) : false;
  });
}

/**
 * The people on call today for this kind, or null when the kind does not go
 * to the rota or nobody is on it today. Read inside the caller's transaction,
 * for the company's day at `now`.
 */
export async function onCallToday(
  tx: Database, organizationId: string, kind: rules.NoticeKind, now: Date = new Date(),
): Promise<string[] | null> {
  if (!rules.isOnCallKind(kind)) return null;
  const routed = await savedKinds(tx, organizationId);
  if (!routed.includes(kind)) return null;
  const today = await todayOf(tx, organizationId, now);
  const turns = await tx.select({
    userId: schema.officeOnCall.userId, startsOn: schema.officeOnCall.startsOn, endsOn: schema.officeOnCall.endsOn,
  }).from(schema.officeOnCall)
    .where(and(
      eq(schema.officeOnCall.organizationId, organizationId),
      lte(schema.officeOnCall.startsOn, today),
      gte(schema.officeOnCall.endsOn, today),
    ))
    .orderBy(asc(schema.officeOnCall.startsOn), asc(schema.officeOnCall.createdAt));
  const audience = rules.onCallAudience({ kind, routed, onCallToday: rules.onCallOn(turns, today) });
  return audience.to === "on_call" ? audience.userIds : null;
}

/** A person's own turns from today on, for their own page. */
export async function myTurns(
  tx: Database, organizationId: string, userId: string, now: Date = new Date(),
): Promise<{ startsOn: string; endsOn: string; today: boolean }[]> {
  const today = await todayOf(tx, organizationId, now);
  const rows = await tx.select({ startsOn: schema.officeOnCall.startsOn, endsOn: schema.officeOnCall.endsOn })
    .from(schema.officeOnCall)
    .where(and(
      eq(schema.officeOnCall.organizationId, organizationId),
      eq(schema.officeOnCall.userId, userId),
      gte(schema.officeOnCall.endsOn, today),
    ))
    .orderBy(asc(schema.officeOnCall.startsOn)).limit(5);
  return rows.map((r) => ({ ...r, today: r.startsOn <= today && today <= r.endsOn }));
}

async function viewWithin(tx: Database, organizationId: string, now: Date): Promise<OnCallView> {
  const today = await todayOf(tx, organizationId, now);
  const routed = await savedKinds(tx, organizationId);
  const named = await names(tx);
  const rows = await tx.select().from(schema.officeOnCall)
    .where(and(eq(schema.officeOnCall.organizationId, organizationId), gte(schema.officeOnCall.endsOn, today)))
    .orderBy(asc(schema.officeOnCall.startsOn), asc(schema.officeOnCall.createdAt))
    .limit(200);
  const turns = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: named.get(r.userId) ?? "Somebody who has left",
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    note: r.note,
    today: r.startsOn <= today && today <= r.endsOn,
  }));
  const members = await tx.select({ userId: schema.membership.userId }).from(schema.membership)
    .where(and(eq(schema.membership.organizationId, organizationId), eq(schema.membership.active, true)))
    .orderBy(asc(schema.membership.createdAt));
  const people: OnCallView["people"] = [];
  for (const m of members) {
    const actor = await memberActor(tx, organizationId, m.userId);
    if (!actor || actor.readOnly) continue;
    const answered = answers(actor);
    if (answered.length > 0) people.push({ userId: m.userId, name: named.get(m.userId) ?? "Unnamed", answers: answered });
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return {
    today,
    kinds: rules.ON_CALL_KINDS.map((kind) => ({ kind, ...rules.NOTICE_KIND_WORDS[kind], on: routed.includes(kind) })),
    turns,
    onCallToday: [...new Set(turns.filter((s) => s.today).map((s) => s.name))],
    people,
  };
}

/** The rota and which kinds go to it. `settings:read`. */
export function view(ctx: ServiceContext, now: Date = new Date()): Promise<OnCallView> {
  return guardedRead(ctx, "settings:read", (tx) => viewWithin(tx, ctx.actor.organizationId, now));
}

/**
 * Which of the three kinds go to whoever is on call. `settings:write`,
 * audited. Every kind not listed goes to everybody who handles it.
 */
export function setKinds(ctx: ServiceContext, input: { kinds: string[] }, now: Date = new Date()): Promise<OnCallView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const unknown = input.kinds.filter((k) => !rules.isOnCallKind(k));
    if (unknown.length > 0) {
      throw new ConflictError(`Only a deadline, a visit change and a failed automatic payment can go to whoever is on call, not ${unknown.join(", ")}.`);
    }
    const before = await savedKinds(tx, ctx.actor.organizationId);
    const kinds = rules.ON_CALL_KINDS.filter((k) => input.kinds.includes(k));
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ [SETTING]: { kinds } })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    if (before.join(",") !== kinds.join(",")) {
      await audit(tx, ctx, "office_on_call.kinds_changed", "organization", ctx.actor.organizationId, { kinds: before }, { kinds });
    }
    return viewWithin(tx, ctx.actor.organizationId, now);
  });
}

/**
 * Put somebody on call for some days. `settings:write`, audited.
 *
 * They must work here and be able to answer at least one of the three kinds,
 * because a turn for somebody who would never be told is a gap in the rota that
 * looks covered. The same person for the same days again is the first answer
 * back, so a retry adds nothing.
 */
export function addTurn(
  ctx: ServiceContext,
  input: { userId: string; startsOn: string; endsOn: string; note?: string | null | undefined },
  now: Date = new Date(),
): Promise<OnCallTurnView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const today = await todayOf(tx, organizationId, now);
    const problem = rules.onCallShiftProblem({ startsOn: input.startsOn, endsOn: input.endsOn, today });
    if (problem) throw new ConflictError(problem);
    const actor = await memberActor(tx, organizationId, input.userId);
    if (!actor || actor.readOnly) throw new ConflictError("That person does not work here now.");
    if (answers(actor).length === 0) {
      throw new ConflictError("That person cannot answer any of these notices, so they would never be told. Choose somebody who can.");
    }
    const note = input.note?.trim().slice(0, 300) || null;
    const [made] = await tx.insert(schema.officeOnCall).values({
      organizationId, userId: input.userId, startsOn: input.startsOn, endsOn: input.endsOn, note,
    }).onConflictDoNothing().returning();
    const row = made ?? (await tx.select().from(schema.officeOnCall).where(and(
      eq(schema.officeOnCall.organizationId, organizationId),
      eq(schema.officeOnCall.userId, input.userId),
      eq(schema.officeOnCall.startsOn, input.startsOn),
      eq(schema.officeOnCall.endsOn, input.endsOn),
    )).limit(1))[0]!;
    if (made) {
      await audit(tx, ctx, "office_on_call.turn_added", "office_on_call", made.id, null,
        { userId: made.userId, startsOn: made.startsOn, endsOn: made.endsOn, note: made.note });
    }
    const named = await names(tx);
    return {
      id: row.id, userId: row.userId, name: named.get(row.userId) ?? "Unnamed",
      startsOn: row.startsOn, endsOn: row.endsOn, note: row.note,
      today: row.startsOn <= today && today <= row.endsOn,
    };
  });
}

/**
 * Take a turn off the rota. `settings:write`, audited with what it was.
 * Removing one already gone answers `removed: false`, so a retry is safe.
 */
export function removeTurn(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: boolean }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [gone] = await tx.delete(schema.officeOnCall)
      .where(and(eq(schema.officeOnCall.id, input.id), eq(schema.officeOnCall.organizationId, ctx.actor.organizationId)))
      .returning();
    if (!gone) return { id: input.id, removed: false };
    await audit(tx, ctx, "office_on_call.turn_removed", "office_on_call", gone.id,
      { userId: gone.userId, startsOn: gone.startsOn, endsOn: gone.endsOn, note: gone.note }, null);
    return { id: gone.id, removed: true };
  });
}

export const handlers = {
  getOfficeOnCall: (ctx: ServiceContext) => view(ctx),
  setOfficeOnCallKinds: (ctx: ServiceContext, input: { kinds: string[] }) => setKinds(ctx, input),
  addOfficeOnCallTurn: (
    ctx: ServiceContext, input: { userId: string; startsOn: string; endsOn: string; note?: string | null | undefined },
  ) => addTurn(ctx, input),
  removeOfficeOnCallTurn: (ctx: ServiceContext, input: { id: string }) => removeTurn(ctx, input),
} as const;
