import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, type ServiceContext,
} from "./context";
import { tellApprovers } from "./apps";

/**
 * A REQUEST NOBODY HAS ANSWERED IS CHASED ONCE
 *
 * An app that asks to connect tells everybody who could approve it, once, when
 * it asks. A request then waits up to seven days, and the first notice is the
 * one that gets buried: it arrives on the day somebody is on a roof, and
 * nothing says it is still there. After a number of days the company chooses
 * (three until it says otherwise, or none) the same people are told once more,
 * by the same notice path: the bell, the phone and a text as each of them
 * chose, and an email when the company sends email.
 *
 * ONCE PER REQUEST, BY CLAIM. `connected_app.reminded_at` is set by an update
 * that only lands on a request that has none, in the transaction that tells
 * them, so a pass cut short and run again, or two workers at once, remind
 * once; and the notice carries its own key, so even a lost claim could not tell
 * a person twice.
 *
 * ONLY WHILE IT WAITS. Pending and not yet ended. An answered request needs no
 * reminder, and a request that has ended is not worth interrupting anybody for.
 * The days are the company's calendar days from the day it asked, as a hold
 * is counted, and are at most six because the request ends on the seventh.
 *
 * THE SETTING lives in `organization.settings.appRequests.reminderDays`:
 * absent means three, a number means that many, and null means no reminder.
 */
export const DEFAULT_REMINDER_DAYS = 3;
export const MOST_REMINDER_DAYS = 6;

/** Why a reminder setting is refused, or null when it is a whole number of days from one to six, or off. */
export function reminderProblem(days: unknown): string | null {
  if (days === null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MOST_REMINDER_DAYS) {
    return `Give the days as a whole number from 1 to ${MOST_REMINDER_DAYS}, or leave it empty. A request ends after seven days.`;
  }
  return null;
}

export async function reminderDaysWithin(tx: Database, organizationId: string): Promise<number | null> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const saved = ((row?.settings ?? {}) as Record<string, unknown>)["appRequests"] as Record<string, unknown> | undefined;
  if (!saved || !("reminderDays" in saved)) return DEFAULT_REMINDER_DAYS;
  const days = saved["reminderDays"];
  return typeof days === "number" && reminderProblem(days) === null ? days : null;
}

export function reminderSetting(ctx: ServiceContext): Promise<{ days: number | null }> {
  return guardedRead(ctx, "settings:read", async (tx) => ({ days: await reminderDaysWithin(tx, ctx.actor.organizationId) }));
}

/**
 * Say after how many days an unanswered request is chased, or that it is not.
 * Applies from the next pass, to requests still waiting: one already past the
 * new number is reminded then, once.
 */
export function setReminder(ctx: ServiceContext, input: { days: number | null }): Promise<{ days: number | null }> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const problem = reminderProblem(input.days);
    if (problem) throw new ConflictError(problem);
    const before = await reminderDaysWithin(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ appRequests: { reminderDays: input.days } })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "organization.app_request_reminder_set", "organization", ctx.actor.organizationId,
      { days: before }, { days: input.days });
    return { days: input.days };
  });
}

/** The most one pass reminds for one company; the rest wait for the next pass. */
const REMINDERS_PER_PASS = 50;

/**
 * Remind the approvers of this company's requests that have waited long
 * enough, as of `now`. Returns the apps it reminded for.
 */
export async function remindIn(tx: Database, ctx: ServiceContext, now = new Date()): Promise<string[]> {
  const organizationId = ctx.actor.organizationId;
  const days = await reminderDaysWithin(tx, organizationId);
  if (days === null) return [];
  const zone = await timezoneOf(tx, organizationId);
  const today = time.dateIn(now, zone);
  /** Asked on or before this day has waited the days: the first instant after it is the bound. */
  const askedBefore = time.startOfDayIn(time.addDays(today, 1 - days), zone);

  const waiting = await tx.select().from(schema.connectedApp)
    .where(and(
      eq(schema.connectedApp.organizationId, organizationId),
      eq(schema.connectedApp.status, "pending"),
      isNull(schema.connectedApp.remindedAt),
      gt(schema.connectedApp.requestExpiresAt, now),
      lt(schema.connectedApp.createdAt, askedBefore),
    ))
    .orderBy(asc(schema.connectedApp.createdAt))
    .limit(REMINDERS_PER_PASS);

  const reminded: string[] = [];
  for (const app of waiting) {
    /** The claim. Only the pass whose update lands tells anybody. */
    const [claimed] = await tx.update(schema.connectedApp).set({ remindedAt: now })
      .where(and(
        eq(schema.connectedApp.id, app.id),
        eq(schema.connectedApp.status, "pending"),
        isNull(schema.connectedApp.remindedAt),
      ))
      .returning();
    if (!claimed) continue;
    const waited = Math.max(1, Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${time.dateIn(app.createdAt, zone)}T00:00:00Z`)) / 864e5,
    ));
    await tellApprovers(tx, organizationId, claimed, { daysWaiting: waited });
    await audit(tx, ctx, "app.request_reminded", "connectedApp", app.id, null, { daysWaiting: waited });
    reminded.push(app.id);
  }
  return reminded;
}

/** What the worker acts as. It writes notices and an email in the outbox, and nothing else. */
function workerActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "app-request-reminders" };
}

export interface ReminderPassResult { organizationId: string; reminded: number; failed: string | null }

let lastPass: number | null = null;

/**
 * Every company with a request that could be due, once a minute at most per
 * process: the days are whole, and nothing gains from asking more often. One
 * company's failure is kept to that company.
 */
export async function reminderPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<ReminderPassResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.app_request_reminder_organizations(${options.limit ?? 200})`,
  );
  const results: ReminderPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const ctx: ServiceContext = { actor: workerActor(row.organization_id), db };
    try {
      const reminded = await inTenant(ctx, (tx) => remindIn(tx, ctx, options.now ?? new Date()));
      results.push({ organizationId: row.organization_id, reminded: reminded.length, failed: null });
    } catch (error) {
      results.push({ organizationId: row.organization_id, reminded: 0, failed: (error as Error).message });
    }
  }
  return results;
}

export const handlers = {
  getAppRequestReminder: (ctx: ServiceContext) => reminderSetting(ctx),
  setAppRequestReminder: (ctx: ServiceContext, input: { days: number | null }) => setReminder(ctx, input),
} as const;
