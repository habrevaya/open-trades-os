import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { coverage, time, work } from "@opentradesos/core";
import { audit, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext } from "./context";
import { raise } from "./obligations";
import { load as currentItem } from "./pricebook";

/**
 * A MAKER'S REGISTRATION DEADLINE, KEPT UNTIL THE UNIT IS REGISTERED
 *
 * Plenty of makers start the warranty only when the installer registers the
 * unit, and give a number of days to do it. A contractor who misses the day
 * has installed a furnace the customer will find has no warranty, which is the
 * customer's complaint and the contractor's cost. The schema has named an
 * obligation kind for exactly this (`warranty.register_by`) since the
 * obligation table was written, and nothing raised one.
 *
 * WHERE THE TERM LIVES. The price book item already carries the warranty a
 * unit comes with (`warrantyMonths`, versioned with the price), and the unit of
 * a serialised item is the thing installed. So "register within N days" sits
 * beside it as `warrantyRegistrationDays`, empty for every item until somebody
 * says otherwise: a deadline invented for an item whose maker asks for nothing
 * would put a false obligation in a real queue.
 *
 * WHEN IT IS RAISED. When a serialised part is issued to a job and becomes, or
 * goes into, a customer's unit (`inventory.issue`, the one place the product
 * records that a unit was installed on a job). Counted from the day it went in,
 * in the company's calendar.
 *
 * KEYED BY THE UNIT, NOT THE JOB. A job can put in a furnace, a coil and a
 * condenser, each registered on its own, and an obligation on the job could not
 * say which one was done. The unit is the record the registration is of; the job
 * is named in the sentence, as M34 says of any obligation.
 *
 * CLOSED BY SAYING SO. Recording the registration on the unit (the day, and the
 * maker's reference when they gave one) satisfies the deadline with the day it
 * was done, so a registration that came in late is met late and not hidden.
 * Retiring the unit cancels it.
 */

const { WARRANTY_REGISTRATION_KIND: KIND } = coverage;

/** What a unit is called in a sentence: its kind, and its model and serial when known. */
function unitWords(unit: { category: string; model: string | null; serialNumber: string | null; tag: string | null }): string {
  const bits = [unit.model, unit.serialNumber ? `serial ${unit.serialNumber}` : null, unit.tag].filter((b): b is string => !!b);
  return `the ${unit.category}${bits.length > 0 ? ` (${bits.join(", ")})` : ""}`;
}

/**
 * Raise the registration deadline for a unit that has just gone onto a job, if
 * the item it came from says its maker asks for one.
 *
 * Inside the install's own transaction, so a deadline exists only for an install
 * that did. A deadline already open for the unit is left alone: the earlier
 * date stands, and a second part going into the same unit does not stack a
 * second reminder on the first.
 */
export async function raiseForInstall(
  tx: Database, organizationId: string, input: { equipmentId: string; itemId: string; jobId: string },
): Promise<{ raised: boolean; lastDay: string | null }> {
  const item = await currentItem(tx, input.itemId);
  const days = item?.version.warrantyRegistrationDays ?? null;
  if (days === null) return { raised: false, lastDay: null };

  const [open] = await tx.select({ id: schema.obligation.id }).from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.kind, KIND),
      eq(schema.obligation.entityType, "equipment"),
      eq(schema.obligation.entityId, input.equipmentId),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).limit(1);
  if (open) return { raised: false, lastDay: null };

  const [unit] = await tx.select().from(schema.equipment).where(eq(schema.equipment.id, input.equipmentId)).limit(1);
  const [job] = await tx.select({ number: schema.job.number, prefix: schema.job.numberPrefix }).from(schema.job)
    .where(eq(schema.job.id, input.jobId)).limit(1);
  if (!unit) throw new NotFoundError("Equipment");

  const zone = await timezoneOf(tx, organizationId);
  const installedOn = time.dateIn(new Date(), zone);
  const lastDay = coverage.registrationLastDay(installedOn, days);
  await raise(tx, organizationId, {
    kind: KIND,
    entityType: "equipment",
    entityId: input.equipmentId,
    /** The end of the last day, so registering on it is in time. */
    dueAt: time.startOfDayIn(time.nextDay(lastDay), zone),
    consequence: coverage.registrationConsequence({
      unit: unitWords(unit), maker: unit.manufacturer, lastDay,
      jobLabel: job ? work.documentNumber(job.prefix, job.number) : null,
    }),
    /** A week ahead, or the install day when the maker allows a week or less: the reminder lands in the task queue. */
    escalateAt: time.startOfDayIn(coverage.registrationReminderDay(installedOn, lastDay), zone),
  });
  return { raised: true, lastDay };
}

/** A unit taken off the register owes nobody a registration. Cancelled, not satisfied: it did not happen. */
export async function cancelForRetired(tx: Database, organizationId: string, equipmentId: string): Promise<number> {
  const cancelled = await tx.update(schema.obligation).set({ state: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.kind, KIND),
      eq(schema.obligation.entityType, "equipment"),
      eq(schema.obligation.entityId, equipmentId),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).returning({ consequence: schema.obligation.consequence });
  await closeReminders(tx, equipmentId, cancelled.map((c) => c.consequence), "The unit was taken off the register.");
  return cancelled.length;
}

/** The reminder the sweep put in the queue goes with the deadline it was about. */
async function closeReminders(
  tx: Database, equipmentId: string, consequences: (string | null)[], outcome: string,
): Promise<void> {
  const titles = [...new Set(consequences.map((c) => coverage.registrationTitle(c)))];
  if (titles.length === 0) return;
  await tx.update(schema.task).set({ status: "done", completedAt: new Date(), outcome, updatedAt: new Date() })
    .where(and(
      eq(schema.task.entityType, "equipment"),
      eq(schema.task.entityId, equipmentId),
      inArray(schema.task.title, titles),
      inArray(schema.task.status, ["open", "in_progress"]),
    ));
}

export interface RegistrationStanding {
  registeredOn: string | null;
  reference: string | null;
  /** The last day to register, in the company's calendar, while a deadline is open. Null when none is. */
  dueBy: string | null;
  /** Past that day and still not recorded. Worked out against the clock, never read from a stored state. */
  overdue: boolean;
}

/** Where one unit stands on its registration, for its page and the API. */
export async function standingWithin(
  tx: Database, organizationId: string, unit: { id: string; registeredOn: string | null; reference: string | null },
): Promise<RegistrationStanding> {
  const [open] = await tx.select({ dueAt: schema.obligation.dueAt }).from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.kind, KIND),
      eq(schema.obligation.entityType, "equipment"),
      eq(schema.obligation.entityId, unit.id),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).orderBy(schema.obligation.dueAt).limit(1);
  const zone = await timezoneOf(tx, organizationId);
  return {
    registeredOn: unit.registeredOn,
    reference: unit.reference,
    // One minute before the deadline's instant is still the last day, whatever the zone's offset.
    dueBy: open ? time.dateIn(new Date(open.dueAt.getTime() - 60_000), zone) : null,
    overdue: open ? open.dueAt.getTime() <= Date.now() : false,
  };
}

export interface RegistrationRecorded {
  id: string;
  registeredOn: string;
  reference: string | null;
  /** How many open deadlines this closed. */
  closed: number;
}

/**
 * Say the unit has been registered with its maker.
 *
 * `equipment:write`, not the task permissions an obligation is normally closed
 * with: the person who registers a unit is usually the technician who installed
 * it, and the register is theirs to write (M04). It closes only this kind of
 * deadline, on this unit, and says on the deadline what closed it.
 *
 * A date in the future is refused, and so is one before the unit went in: either
 * is a typo, and a typo here would close a deadline as met on a day it was not.
 * Saying it again with a different day or reference corrects what the unit
 * shows; a deadline already closed stays closed with the day it was closed on.
 */
export async function record(
  ctx: ServiceContext,
  input: { id: string; registeredOn?: string | undefined; reference?: string | null | undefined },
): Promise<RegistrationRecorded> {
  return guardedWrite(ctx, "equipment:write", async (tx) => {
    const [before] = await tx.select().from(schema.equipment)
      .where(and(
        eq(schema.equipment.id, input.id),
        eq(schema.equipment.organizationId, ctx.actor.organizationId),
        isNull(schema.equipment.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Equipment");

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const now = new Date();
    const today = time.dateIn(now, zone);
    const registeredOn = input.registeredOn ?? today;
    if (registeredOn > today) {
      throw new ConflictError("A registration cannot be on a day that has not come yet. Say the day it was done.");
    }
    if (before.installedOn && registeredOn < before.installedOn) {
      throw new ConflictError(`That is before the unit went in on ${before.installedOn}. Check the day.`);
    }
    const reference = input.reference?.trim() ? input.reference.trim().slice(0, 120) : null;

    const [after] = await tx.update(schema.equipment)
      .set({ warrantyRegisteredOn: registeredOn, warrantyRegistrationReference: reference, updatedAt: now })
      .where(eq(schema.equipment.id, input.id)).returning();

    /** Met at the end of the day it was done, or now when that day is today: late if the deadline had passed. */
    const metAt = new Date(Math.min(now.getTime(), time.startOfDayIn(time.nextDay(registeredOn), zone).getTime()));
    const closed = await tx.update(schema.obligation).set({
      state: "satisfied",
      satisfiedAt: metAt,
      satisfiedByEvent: `Registered with the maker on ${registeredOn}${reference ? `, reference ${reference}` : ""}`,
      updatedAt: now,
    }).where(and(
      eq(schema.obligation.organizationId, ctx.actor.organizationId),
      eq(schema.obligation.kind, KIND),
      eq(schema.obligation.entityType, "equipment"),
      eq(schema.obligation.entityId, input.id),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).returning({ id: schema.obligation.id, consequence: schema.obligation.consequence });
    await closeReminders(tx, input.id, closed.map((c) => c.consequence), `Registered with the maker on ${registeredOn}.`);

    await audit(tx, ctx, "equipment.warranty_registered", "equipment", input.id,
      { registeredOn: before.warrantyRegisteredOn, reference: before.warrantyRegistrationReference },
      { registeredOn: after!.warrantyRegisteredOn, reference: after!.warrantyRegistrationReference, closed: closed.length });
    return { id: input.id, registeredOn, reference, closed: closed.length };
  });
}

export const handlers = {
  recordWarrantyRegistration: (
    ctx: ServiceContext, input: { id: string; registeredOn?: string | undefined; reference?: string | null | undefined },
  ) => record(ctx, input),
} as const;
