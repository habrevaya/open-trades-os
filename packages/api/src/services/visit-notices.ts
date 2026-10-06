import { eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { ServiceContext } from "./context";
import { emit } from "./events";

/**
 * SAYING WHAT CHANGED ON SOMEBODY'S DAY
 *
 * Four things change a technician's day from the office: a visit is put on
 * it, taken off it, moved, or cancelled. Each is written by a different path
 * (the board, booking a job, adding a visit, answering a customer's request),
 * and every one of those paths had to agree on what to emit or the phone
 * would hear about some changes and not others, which is worse than hearing
 * about none because the technician learns to trust it.
 *
 * So every path does the same two things: read the visit as it was with
 * `sideOf` before it writes, and hand that to `announce` after, which reads
 * it as it is now and emits whatever the difference amounts to. The decision
 * about what a change IS lives here once.
 *
 * Emitted in the caller's transaction, like every event, so a change that
 * rolls back tells nobody and one that commits cannot be missed.
 */

export interface VisitSide {
  technicianIds: string[];
  windowStart: Date | null;
  windowEnd: Date | null;
  status: string;
}

/** The visit as it stands, for comparing after the write. Null for a visit that is not there. */
export async function sideOf(tx: Database, visitId: string): Promise<VisitSide | null> {
  const [visit] = await tx.select({
    windowStart: schema.visit.windowStart,
    windowEnd: schema.visit.windowEnd,
    status: schema.visit.status,
  }).from(schema.visit).where(eq(schema.visit.id, visitId)).limit(1);
  if (!visit) return null;

  const people = await tx.select({ technicianId: schema.visitAssignment.technicianId })
    .from(schema.visitAssignment)
    .where(eq(schema.visitAssignment.visitId, visitId));

  return {
    technicianIds: [...new Set(people.map((p) => p.technicianId))],
    windowStart: visit.windowStart,
    windowEnd: visit.windowEnd,
    status: visit.status,
  };
}

/**
 * A visit that did not exist: nobody was on it and it had no time, so
 * everything about it is news. Its status is not a real one, so a visit
 * written as cancelled from the start (a migration's history) is not
 * announced as a cancellation of something nobody was ever sent to.
 */
export const NEW_VISIT: VisitSide = { technicianIds: [], windowStart: null, windowEnd: null, status: "new" };

/**
 * States in which a change is not news to anybody in a van. A finished visit
 * moved for the record, or a no show tidied up, would otherwise buzz a phone
 * about work that is over.
 */
const OVER = new Set(["completed", "completed_after_cancellation", "no_show"]);

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Emit what the difference between `before` and now amounts to.
 *
 * Cancelled wins over everything else, because a cancellation usually takes
 * the people off as well, and "taken off your day" would undersell "do not
 * go". Otherwise each person hears one thing: the people added hear that it
 * is theirs (at its new time, if it moved), the people taken off hear that it
 * is not, and the people who stayed hear that it moved.
 */
export async function announce(
  tx: Database,
  ctx: ServiceContext,
  visitId: string,
  before: VisitSide,
): Promise<string[]> {
  const after = await sideOf(tx, visitId);
  if (!after) return [];
  if (OVER.has(after.status)) return [];

  const facts = await factsOf(tx, visitId);
  if (!facts) return [];

  const payload = (technicianIds: string[], extra: Record<string, unknown> = {}) => ({
    visitId,
    jobId: facts.jobId,
    jobNumber: facts.jobNumber,
    customerName: facts.customerName,
    technicianIds,
    windowStart: after.windowStart?.toISOString() ?? null,
    windowEnd: after.windowEnd?.toISOString() ?? null,
    status: after.status,
    ...extra,
  });

  const emitted: string[] = [];
  const say = async (
    name: "visit.assigned" | "visit.unassigned" | "visit.rescheduled" | "visit.cancelled",
    technicianIds: string[],
    extra?: Record<string, unknown>,
  ) => {
    if (technicianIds.length === 0) return;
    const body = { entityType: "visit", entityId: visitId, payload: payload(technicianIds, extra) };
    /**
     * Each name written out where it is emitted, so the catalogue's check
     * (`events-catalogue.test.ts`) finds every one of them in the source.
     */
    switch (name) {
      case "visit.assigned": await emit(tx, ctx, { name: "visit.assigned", ...body }); break;
      case "visit.unassigned": await emit(tx, ctx, { name: "visit.unassigned", ...body }); break;
      case "visit.rescheduled": await emit(tx, ctx, { name: "visit.rescheduled", ...body }); break;
      case "visit.cancelled": await emit(tx, ctx, { name: "visit.cancelled", ...body }); break;
    }
    emitted.push(name);
  };

  if (after.status === "cancelled" && before.status !== "cancelled" && before.status !== "new") {
    await say("visit.cancelled", [...new Set([...before.technicianIds, ...after.technicianIds])]);
    return emitted;
  }
  if (after.status === "cancelled") return emitted;

  const was = new Set(before.technicianIds);
  const now = new Set(after.technicianIds);
  const added = after.technicianIds.filter((id) => !was.has(id));
  const removed = before.technicianIds.filter((id) => !now.has(id));
  const stayed = after.technicianIds.filter((id) => was.has(id));
  const moved = !sameInstant(before.windowStart, after.windowStart)
    || !sameInstant(before.windowEnd, after.windowEnd);

  await say("visit.assigned", added);
  await say("visit.unassigned", removed);
  if (moved) {
    await say("visit.rescheduled", stayed, {
      previousWindowStart: before.windowStart?.toISOString() ?? null,
      previousWindowEnd: before.windowEnd?.toISOString() ?? null,
    });
  }
  return emitted;
}

/**
 * What a notice needs to name the job, captured with the event.
 *
 * Denormalised into the payload on purpose, like every event: the notice
 * should say what was true when the change was made, and a customer renamed
 * an hour later did not change what the technician was told.
 */
async function factsOf(tx: Database, visitId: string) {
  const [row] = await tx.select({
    jobId: schema.job.id,
    jobNumber: schema.job.number,
    customerName: schema.customer.name,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .where(eq(schema.visit.id, visitId)).limit(1);
  return row ?? null;
}
