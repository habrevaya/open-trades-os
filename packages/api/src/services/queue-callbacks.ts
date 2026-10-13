import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { voice } from "@opentradesos/core";
import { audit, type ServiceContext } from "./context";
import * as callTracking from "./call-tracking";

/**
 * BEING CALLED BACK INSTEAD OF WAITING, AND WHO IS ALREADY ON A CALL
 *
 * The parts of a waiting line that are about the company's records rather
 * than about the carrier: whether a person is talking to somebody right now,
 * how long callers have lately waited, and what happens to a callback the
 * office could not make. The carrier's side (placing the calls, what the
 * caller hears) is in `voice.ts` with the rest of a call.
 *
 * WHO IS ON A CALL is what this product saw, never a guess: somebody who
 * picked up in the browser, from a waiting line, a callback, or on a number
 * that whispers (that step is where the call learns who answered), and
 * somebody who placed a call from the browser, until the call is over. A
 * person who picked up a plain forwarded call on their own phone is not seen
 * picking up, so they are not known to be busy. A call the carrier never
 * reported the end of stops counting after three hours, so one lost status
 * report cannot take somebody off the phones for the rest of the day.
 */

export type CallbackRow = typeof schema.queueCallback.$inferSelect;

/** How long a call that was never reported over keeps its person counted as busy. */
export const BUSY_FOR_AT_MOST_HOURS = 3;

/** The people talking to somebody right now, as far as this product saw them pick up. */
export async function busyUsers(tx: Database, organizationId: string, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - BUSY_FOR_AT_MOST_HOURS * 3600_000);
  const rows = await tx.select({
    answered: schema.call.answeredByUserId, placed: schema.call.placedByUserId,
  }).from(schema.call).where(and(
    eq(schema.call.organizationId, organizationId),
    sql`${schema.call.status} in ('ringing', 'in_progress')`,
    isNull(schema.call.endedAt),
    sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) > ${since.toISOString()}::timestamptz`,
    or(isNotNull(schema.call.answeredByUserId), isNotNull(schema.call.placedByUserId)),
  ));
  const busy = new Set<string>();
  for (const row of rows) {
    const who = row.answered ?? row.placed;
    if (who) busy.add(who);
  }
  return busy;
}

/**
 * The numbers and browsers of the people on a call right now: what a round
 * of ringing leaves out. Both of a person's ways of being rung, because the
 * round may hold either.
 */
export async function busyNumbers(tx: Database, organizationId: string, directory: voice.Directory, now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  for (const userId of await busyUsers(tx, organizationId, now)) {
    out.add(voice.clientAddress(userId));
    const phone = directory.people.get(userId)?.phone;
    if (phone) out.add(phone);
  }
  return out;
}

/**
 * How long callers have lately waited in this line before somebody answered,
 * or null when too few were answered lately to say (core's `estimateWait`).
 * Only callers who were put through count: a caller who gave up or went to
 * voicemail says nothing about how long answering takes.
 */
export async function estimatedWait(tx: Database, queueId: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - voice.ESTIMATE_WITHIN_HOURS * 3600_000);
  const rows = await tx.select({ waited: schema.call.queueWaitSeconds }).from(schema.call).where(and(
    eq(schema.call.queueId, queueId),
    eq(schema.call.queueResult, "bridged"),
    isNotNull(schema.call.queueWaitSeconds),
    gt(schema.call.queuedAt, since),
  )).orderBy(desc(schema.call.queuedAt)).limit(voice.ESTIMATE_FROM_LAST);
  return voice.estimateWait(rows.map((r) => r.waited!));
}

/** The callback that is next in this line, if any: the one whose caller joined first. */
export async function nextCallback(tx: Database, queueId: string, now: Date): Promise<CallbackRow | null> {
  const [row] = await tx.select().from(schema.queueCallback).where(and(
    eq(schema.queueCallback.queueId, queueId),
    eq(schema.queueCallback.status, "waiting"),
    or(isNull(schema.queueCallback.notBefore), sql`${schema.queueCallback.notBefore} <= ${now.toISOString()}::timestamptz`),
  )).orderBy(asc(schema.queueCallback.joinedAt)).limit(1);
  return row ?? null;
}

/** When the caller who has waited longest on the line itself joined it, or null when nobody is waiting. */
export async function longestWaiting(tx: Database, queueId: string): Promise<Date | null> {
  const [row] = await tx.select({ at: sql<Date | null>`min(${schema.call.queuedAt})` }).from(schema.call).where(and(
    eq(schema.call.queueId, queueId),
    isNull(schema.call.queueResult),
    isNotNull(schema.call.queuedAt),
  ));
  const at = row?.at ?? null;
  return at === null ? null : new Date(at);
}

/**
 * Add a sentence to "Where it went" on a call, the way the call's own steps
 * do, so the caller's call says what became of their callback.
 */
export async function noteOnCall(tx: Database, callId: string, sentence: string): Promise<void> {
  const [call] = await tx.select({ routed: schema.call.routedBecause }).from(schema.call)
    .where(eq(schema.call.id, callId)).limit(1);
  if (!call) return;
  await tx.update(schema.call).set({
    routedBecause: [call.routed, sentence].filter(Boolean).join(" ").slice(0, 2000), updatedAt: new Date(),
  }).where(eq(schema.call.id, callId));
}

/**
 * A callback the office could not make by ringing: the caller did not pick up
 * twice, nobody was free within the hour, or the line was deleted. It becomes
 * a task on the office's queue, on the customer when there is one, saying who
 * to ring and why, and the caller's call is announced as missed (once), which
 * is what the missed call text back listens for. A promise to call somebody
 * back ends with a person deciding what to do, never with nothing.
 */
export async function handToOffice(tx: Database, ctx: ServiceContext, callback: CallbackRow, why: string): Promise<void> {
  const [ended] = await tx.update(schema.queueCallback).set({
    status: "given_up", outcome: why.slice(0, 500), endedAt: new Date(), legsOut: 0, updatedAt: new Date(),
  }).where(and(
    eq(schema.queueCallback.id, callback.id),
    sql`${schema.queueCallback.status} in ('waiting', 'calling')`,
  )).returning();
  if (!ended) return;
  const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, callback.callId)).limit(1);
  await tx.insert(schema.task).values({
    organizationId: ctx.actor.organizationId,
    title: `Call back ${callback.callbackE164}`.slice(0, 200),
    body: `They asked to be called back instead of waiting on the phone. ${why}`.slice(0, 4000),
    priority: "high",
    entityType: call?.customerId ? "customer" : "call",
    entityId: call?.customerId ?? callback.callId,
  });
  await noteOnCall(tx, callback.callId, `Not called back: ${why} A task was made for the office to call them.`);
  await audit(tx, ctx, "call.callback_given_up", "call", callback.callId, null, { reason: why });
  await callTracking.emitMissed(tx, ctx, callback.callId);
}

/**
 * Callbacks that have waited as long as one is kept, handed to the office.
 * Run by the carrier's own steps and by the worker, so an hour is an hour
 * whether or not anybody rang the company in it.
 */
export async function expireDue(tx: Database, ctx: ServiceContext, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - voice.CALLBACK_EXPIRES_SECONDS * 1000);
  const due = await tx.select().from(schema.queueCallback).where(and(
    eq(schema.queueCallback.organizationId, ctx.actor.organizationId),
    eq(schema.queueCallback.status, "waiting"),
    or(lt(schema.queueCallback.createdAt, cutoff), isNull(schema.queueCallback.queueId)),
  )).limit(50);
  for (const callback of due) {
    await handToOffice(tx, ctx, callback, callback.queueId === null
      ? "The waiting line was deleted before they were called back."
      : `Nobody in the line's ring group was free to call them back within ${voice.CALLBACK_EXPIRES_SECONDS / 60} minutes.`);
  }
  return due.length;
}

/** Whether this call asked to be called back, which makes a caller who hangs up afterwards not a missed call yet. */
export async function forCall(tx: Database, callId: string): Promise<CallbackRow | null> {
  const [row] = await tx.select().from(schema.queueCallback).where(eq(schema.queueCallback.callId, callId)).limit(1);
  return row ?? null;
}
