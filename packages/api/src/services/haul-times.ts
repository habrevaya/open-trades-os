import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { time, isSystem, type field } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { remember, replayed } from "./once";

/**
 * THE THREE TIMES A CONTAINER'S TURNAROUND IS MADE OF
 *
 * The dumpster pack's `turnaround_hours` is "hours from a container being
 * emptied at the facility to it being placed on the next customer site",
 * EXCLUDING "cans routed to the yard for repair and cans held at customer
 * request". Nothing recorded either end to the hour, and neither exclusion as
 * history:
 *
 *   THE DROP. The containers board took a delivery as a day and kept it at
 *   midday. A hire now says whether its delivery time is the moment the can
 *   was put down (`delivered_time_known`): the board takes a time with the
 *   day, the driver's phone records it on the stop, and a delivery recorded as
 *   a day stays one, counted beside the figure and never given an hour.
 *
 *   THE TIP. A pickup kept the scale ticket, which is the weighbridge and not
 *   the tip, and a facility's file is read only to the day. A haul now has the
 *   moment its full can was emptied (`tipped_at`), from the driver's phone or
 *   typed by the office when the ticket arrives.
 *
 *   A CAN THAT CAME BACK EMPTY. A customer who put nothing in it leaves no
 *   tip to record, and none will come. The office marks the haul with the
 *   moment it was collected (`came_back_empty_at`), and the turnaround runs
 *   from there. A haul cannot be both: a tip time or a scale ticket on it
 *   says it was not empty.
 *
 *   THE HOLDS. Out of service was the can's state today, with no history. A
 *   repair and a customer hold are now periods with a start and an end
 *   (`container_hold`), so last month's figure can still tell a welder from a
 *   dispatcher.
 *
 * WHAT IS REFUSED, and why each one. A time still to come. A tip before the
 * delivery it empties, or on a day before the collection that took the can
 * away. A tip after the can was already on its next site, and a placement
 * before the can's last tip: either way the turnaround would run backwards, and
 * the office is told which two times disagree rather than shown a negative
 * number. A drop time on another day than the delivery, because the day is
 * what the hire bills and an hour cannot move it.
 */

/** A phone's clock a few minutes fast is not a time still to come. */
const SKEW_MS = 10 * 60_000;

const actingUser = (ctx: ServiceContext): string | null =>
  ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId;

/** "3:10 PM on Jun 8", in the company's clock, for a refusal. */
export function when(instant: Date, zone: string): string {
  const clock = instant.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  const day = instant.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });
  return `${clock} on ${day}`;
}

/** "Jun 8", in the company's calendar. */
const dayWords = (instant: Date, zone: string) =>
  instant.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });

function instant(value: string, what: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ConflictError(`${what} is not a time.`);
  return parsed;
}

function notYet(at: Date, what: string) {
  if (at.getTime() > Date.now() + SKEW_MS) {
    throw new ConflictError(`${what} has not come yet. Record it when it happens.`);
  }
}

async function containerLabel(tx: Database, assetId: string): Promise<string> {
  const [row] = await tx.select({ identifier: schema.rentableAsset.identifier })
    .from(schema.rentableAsset).where(eq(schema.rentableAsset.id, assetId)).limit(1);
  return `Container ${row?.identifier ?? ""}`.trim();
}

async function hireWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.rental)
    .where(and(eq(schema.rental.organizationId, ctx.actor.organizationId), eq(schema.rental.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError("Rental");
  return row;
}

/* ------------------------------------------------------------ the checks */

/**
 * The can's last haul before a placement: its hire delivered before this one,
 * by delivery and not by collection, because a collection recorded as a day
 * sits at midday and a can put back out that morning would otherwise skip
 * back a hire. Its tip is where the turnaround starts.
 */
async function haulBefore(tx: Database, assetId: string, placedAt: Date, except: string | null) {
  const [row] = await tx.select().from(schema.rental)
    .where(and(
      eq(schema.rental.assetId, assetId),
      sql`${schema.rental.deliveredAt} < ${placedAt.toISOString()}::timestamptz`,
      ...(except ? [ne(schema.rental.id, except)] : []),
    ))
    .orderBy(desc(schema.rental.deliveredAt))
    .limit(1);
  return row ?? null;
}

/** The can's next placement after a haul: its first hire delivered after this one. */
async function placementAfter(tx: Database, hire: typeof schema.rental.$inferSelect) {
  if (hire.deliveredAt === null) return null;
  const [row] = await tx.select().from(schema.rental)
    .where(and(
      eq(schema.rental.assetId, hire.assetId),
      ne(schema.rental.id, hire.id),
      sql`${schema.rental.deliveredAt} > ${hire.deliveredAt.toISOString()}::timestamptz`,
    ))
    .orderBy(asc(schema.rental.deliveredAt))
    .limit(1);
  return row ?? null;
}

/**
 * A placement must come after the can's last tip, or the turnaround runs
 * backwards. To the minute when both are known; by the day when the placement
 * is only a day.
 */
export async function assertPlacedAfterTip(tx: Database, input: {
  assetId: string; placedAt: Date; timeKnown: boolean; zone: string; except: string | null;
}) {
  const before = await haulBefore(tx, input.assetId, input.placedAt, input.except);
  /** A can that came back empty was ready when it was collected, the same as one emptied at the facility. */
  const ready = before?.tippedAt ?? before?.cameBackEmptyAt ?? null;
  if (!ready) return;
  const late = input.timeKnown
    ? ready.getTime() > input.placedAt.getTime()
    : time.dateIn(ready, input.zone) > time.dateIn(input.placedAt, input.zone);
  if (!late) return;
  throw new ConflictError(
    `${await containerLabel(tx, input.assetId)} was recorded ${before?.tippedAt ? "emptied at the facility" : "collected empty"} at `
    + `${when(ready, input.zone)}, after this delivery. A can ${before?.tippedAt ? "is emptied" : "comes back"} before it goes out `
    + "again: correct one of the two times.",
  );
}

/**
 * Whether a tip time fits the haul it empties: not before the delivery, not on
 * a day before the collection, and not after the can was on its next site.
 */
async function assertTipFits(tx: Database, hire: typeof schema.rental.$inferSelect, tippedAt: Date, zone: string) {
  notYet(tippedAt, "That tip time");
  if (hire.deliveredAt && tippedAt.getTime() < hire.deliveredAt.getTime()) {
    throw new ConflictError(
      `That is before the can was delivered (${dayWords(hire.deliveredAt, zone)}). A load is emptied after `
      + "the can is collected.",
    );
  }
  if (hire.pickedUpAt && time.dateIn(tippedAt, zone) < time.dateIn(hire.pickedUpAt, zone)) {
    throw new ConflictError(
      `The can was collected on ${dayWords(hire.pickedUpAt, zone)}, so it cannot have been emptied the day before.`,
    );
  }
  const next = await placementAfter(tx, hire);
  if (next?.deliveredAt) {
    const late = next.deliveredTimeKnown
      ? tippedAt.getTime() > next.deliveredAt.getTime()
      : time.dateIn(tippedAt, zone) > time.dateIn(next.deliveredAt, zone);
    if (late) {
      throw new ConflictError(
        `${await containerLabel(tx, hire.assetId)} was on its next site `
        + `${next.deliveredTimeKnown ? `at ${when(next.deliveredAt, zone)}` : `on ${dayWords(next.deliveredAt, zone)}`}, `
        + "before that time. Correct one of the two times.",
      );
    }
  }
}

/* -------------------------------------------------------------- the tip */

/**
 * Record when a haul's full can was emptied at the facility, inside a
 * transaction, from the office or a phone. A haul that is still on site may
 * have one (the driver tips the load before the office records the
 * collection). Null clears it.
 */
export async function recordTipWithin(
  tx: Database, ctx: ServiceContext, input: { id: string; tippedAt: Date | null; source: "office" | "phone" },
) {
  const hire = await hireWithin(tx, ctx, input.id);
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  if (input.tippedAt && hire.cameBackEmptyAt) {
    throw new ConflictError(
      `That can is recorded as coming back empty at ${when(hire.cameBackEmptyAt, zone)}, so there was nothing to tip. `
      + "Take that mark off first if it was full.",
    );
  }
  if (input.tippedAt) await assertTipFits(tx, hire, input.tippedAt, zone);
  if ((hire.tippedAt?.getTime() ?? null) === (input.tippedAt?.getTime() ?? null)) return hire;
  const [row] = await tx.update(schema.rental)
    .set({ tippedAt: input.tippedAt, updatedAt: new Date() })
    .where(eq(schema.rental.id, hire.id)).returning();
  await audit(tx, ctx, "rental.tipped", "rental", hire.id,
    { tippedAt: hire.tippedAt }, { tippedAt: row!.tippedAt, source: input.source });
  return row!;
}

/** The office records the tip when the ticket arrives, or corrects it. `asset:write`. */
export function recordTip(ctx: ServiceContext, input: { id: string; tippedAt: string | null }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await recordTipWithin(tx, ctx, {
      id: input.id, tippedAt: input.tippedAt === null ? null : instant(input.tippedAt, "That tip time"), source: "office",
    });
    return { id: row.id, tippedAt: row.tippedAt?.toISOString() ?? null };
  });
}

/* ------------------------------------------------------- came back empty */

/**
 * Mark a collected haul as having come back empty, at the moment it was
 * collected, or take the mark off (null). On the collection's day, because the
 * day is what the hire billed and an hour cannot move it; not still to come;
 * and not after the can was already on its next site. Refused for a haul with
 * a tip time or anything from a scale ticket on it, because then it was not
 * empty, and before the collection is recorded, because an empty can on a
 * site is still a hire.
 */
export async function recordEmptyWithin(
  tx: Database, ctx: ServiceContext, input: { id: string; at: Date | null },
) {
  const hire = await hireWithin(tx, ctx, input.id);
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  if (input.at) {
    if (hire.pickedUpAt === null) {
      throw new ConflictError("That can is still on its site. Record the collection first, then that it came back empty.");
    }
    if (hire.tippedAt) {
      throw new ConflictError(
        `That load was recorded emptied at the facility at ${when(hire.tippedAt, zone)}, so it did not come back empty. `
        + "Clear the time emptied first if that was a mistake.",
      );
    }
    if (hire.disposalTicketNumber || (hire.weightTons !== null && Number(hire.weightTons) > 0) || hire.disposalFee !== null) {
      throw new ConflictError(
        "That haul has a scale ticket, a weight or a disposal fee on it, so it did not come back empty. Correct the ticket first.",
      );
    }
    notYet(input.at, "That time");
    if (time.dateIn(input.at, zone) !== time.dateIn(hire.pickedUpAt, zone)) {
      throw new ConflictError(
        `The collection is recorded on ${dayWords(hire.pickedUpAt, zone)}. The time it came back empty is on that day; `
        + "the day is what the hire billed, and a time cannot move it.",
      );
    }
    if (hire.deliveredAt && input.at.getTime() < hire.deliveredAt.getTime()) {
      throw new ConflictError(`That is before the can was delivered (${dayWords(hire.deliveredAt, zone)}).`);
    }
    const next = await placementAfter(tx, hire);
    if (next?.deliveredAt) {
      const late = next.deliveredTimeKnown
        ? input.at.getTime() > next.deliveredAt.getTime()
        : time.dateIn(input.at, zone) > time.dateIn(next.deliveredAt, zone);
      if (late) {
        throw new ConflictError(
          `${await containerLabel(tx, hire.assetId)} was on its next site `
          + `${next.deliveredTimeKnown ? `at ${when(next.deliveredAt, zone)}` : `on ${dayWords(next.deliveredAt, zone)}`}, `
          + "before that time. Correct one of the two times.",
        );
      }
    }
  }
  if ((hire.cameBackEmptyAt?.getTime() ?? null) === (input.at?.getTime() ?? null)) return hire;
  const [row] = await tx.update(schema.rental)
    .set({ cameBackEmptyAt: input.at, updatedAt: new Date() })
    .where(eq(schema.rental.id, hire.id)).returning();
  await audit(tx, ctx, "rental.came_back_empty", "rental", hire.id,
    { cameBackEmptyAt: hire.cameBackEmptyAt }, { cameBackEmptyAt: row!.cameBackEmptyAt });
  return row!;
}

/** The office marks a collected can as having come back empty, or takes the mark off. `asset:write`. */
export function recordEmpty(ctx: ServiceContext, input: { id: string; at: string | null }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await recordEmptyWithin(tx, ctx, { id: input.id, at: input.at === null ? null : instant(input.at, "That time") });
    return { id: row.id, cameBackEmptyAt: row.cameBackEmptyAt?.toISOString() ?? null };
  });
}

/* ------------------------------------------------------------- the drop */

/**
 * Record the moment a can was put down, for a hire whose delivery is
 * recorded, inside a transaction. On the same day as the delivery recorded,
 * because the day is what the hire bills and a time cannot move it. A can put
 * down by a swap moves the swap with it: the full can left at the same moment.
 */
export async function recordPlacementWithin(
  tx: Database, ctx: ServiceContext, input: { id: string; deliveredAt: Date; source: "office" | "phone" },
) {
  const hire = await hireWithin(tx, ctx, input.id);
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  if (hire.deliveredAt === null) throw new ConflictError("That hire has no delivery recorded, so there is no drop to time.");
  notYet(input.deliveredAt, "That drop time");
  if (time.dateIn(input.deliveredAt, zone) !== time.dateIn(hire.deliveredAt, zone)) {
    throw new ConflictError(
      `The delivery is recorded on ${dayWords(hire.deliveredAt, zone)}. A drop time sets the hour on that day; `
      + "the day is what the hire bills, and a time cannot move it.",
    );
  }
  await assertPlacedAfterTip(tx, { assetId: hire.assetId, placedAt: input.deliveredAt, timeKnown: true, zone, except: hire.id });
  if (hire.deliveredTimeKnown && hire.deliveredAt.getTime() === input.deliveredAt.getTime()) return hire;

  const [row] = await tx.update(schema.rental)
    .set({ deliveredAt: input.deliveredAt, deliveredTimeKnown: true, updatedAt: new Date() })
    .where(eq(schema.rental.id, hire.id)).returning();
  if (hire.previousRentalId) {
    /** The full can the swap took away left when this one arrived. */
    await tx.update(schema.rental)
      .set({ pickedUpAt: input.deliveredAt, updatedAt: new Date() })
      .where(and(eq(schema.rental.id, hire.previousRentalId), eq(schema.rental.pickedUpAt, hire.deliveredAt)));
  }
  await audit(tx, ctx, "rental.placed", "rental", hire.id,
    { deliveredAt: hire.deliveredAt, deliveredTimeKnown: hire.deliveredTimeKnown },
    { deliveredAt: row!.deliveredAt, deliveredTimeKnown: true, source: input.source });
  return row!;
}

/** The office sets the time a can was dropped, on the day recorded. `asset:write`. */
export function recordPlacement(ctx: ServiceContext, input: { id: string; deliveredAt: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await recordPlacementWithin(tx, ctx, {
      id: input.id, deliveredAt: instant(input.deliveredAt, "That drop time"), source: "office",
    });
    return { id: row.id, deliveredAt: row.deliveredAt!.toISOString(), deliveredTimeKnown: row.deliveredTimeKnown };
  });
}

/* ------------------------------------------------------------ the holds */

/** Open a repair on a can, from when it was tagged out. Used by tagging out and by a collection that leaves it tagged out. */
export async function openRepair(tx: Database, ctx: ServiceContext, assetId: string, at: Date, reason: string) {
  const [open] = await tx.select({ id: schema.containerHold.id }).from(schema.containerHold)
    .where(and(eq(schema.containerHold.assetId, assetId), eq(schema.containerHold.kind, "repair"), isNull(schema.containerHold.endsAt)))
    .limit(1);
  if (open) return;
  const [row] = await refusingDuplicate(
    "container_hold_open_idx",
    "That container is already out for repair.",
    () => tx.insert(schema.containerHold).values({
      organizationId: ctx.actor.organizationId, assetId, kind: "repair", startsAt: at, reason,
      recordedByUserId: actingUser(ctx),
    }).returning(),
  );
  await audit(tx, ctx, "container_hold.open", "container_hold", row!.id, null, row);
}

/**
 * Close the can's running repair when it goes back in service. A can tagged
 * out with no repair running (written by something that did not open one)
 * gets one with no start, said rather than guessed, and closed at once.
 */
export async function closeRepair(tx: Database, ctx: ServiceContext, assetId: string, at: Date, zone: string) {
  const [open] = await tx.select().from(schema.containerHold)
    .where(and(eq(schema.containerHold.assetId, assetId), eq(schema.containerHold.kind, "repair"), isNull(schema.containerHold.endsAt)))
    .limit(1);
  if (!open) {
    const [row] = await tx.insert(schema.containerHold).values({
      organizationId: ctx.actor.organizationId, assetId, kind: "repair", startsAt: null, endsAt: at,
      reason: "Tagged out before repair history was kept", recordedByUserId: actingUser(ctx),
    }).returning();
    await audit(tx, ctx, "container_hold.close", "container_hold", row!.id, null, row);
    return;
  }
  if (open.startsAt && at.getTime() < open.startsAt.getTime()) {
    throw new ConflictError(`It went out for repair at ${when(open.startsAt, zone)}, so it cannot be back before then.`);
  }
  const [row] = await tx.update(schema.containerHold).set({ endsAt: at, updatedAt: new Date() })
    .where(eq(schema.containerHold.id, open.id)).returning();
  await audit(tx, ctx, "container_hold.close", "container_hold", open.id, open, row);
}

/**
 * A can delivered is no longer held in the yard: a customer hold running on it
 * ends when it is put down (or at its own start, for one recorded as starting
 * later).
 */
export async function releaseOnDelivery(tx: Database, ctx: ServiceContext, assetId: string, at: Date) {
  const [open] = await tx.select().from(schema.containerHold)
    .where(and(eq(schema.containerHold.assetId, assetId), eq(schema.containerHold.kind, "customer"), isNull(schema.containerHold.endsAt)))
    .limit(1);
  if (!open) return;
  const endsAt = open.startsAt && open.startsAt.getTime() > at.getTime() ? open.startsAt : at;
  const [row] = await tx.update(schema.containerHold).set({ endsAt, updatedAt: new Date() })
    .where(eq(schema.containerHold.id, open.id)).returning();
  await audit(tx, ctx, "container_hold.close", "container_hold", open.id, open, row);
}

export interface HoldView {
  id: string;
  assetId: string;
  assetIdentifier: string;
  kind: "repair" | "customer";
  startsAt: string | null;
  endsAt: string | null;
  reason: string;
  customerId: string | null;
  customerName: string | null;
}

async function holdViews(tx: Database, where: ReturnType<typeof and>, limit: number): Promise<HoldView[]> {
  const rows = await tx.select({
    hold: schema.containerHold,
    identifier: schema.rentableAsset.identifier,
    customerName: schema.customer.name,
  }).from(schema.containerHold)
    .innerJoin(schema.rentableAsset, eq(schema.rentableAsset.id, schema.containerHold.assetId))
    .leftJoin(schema.customer, eq(schema.customer.id, schema.containerHold.customerId))
    .where(where)
    .orderBy(desc(sql`coalesce(${schema.containerHold.startsAt}, ${schema.containerHold.createdAt})`))
    .limit(limit);
  return rows.map(({ hold, identifier, customerName }) => ({
    id: hold.id, assetId: hold.assetId, assetIdentifier: identifier, kind: hold.kind,
    startsAt: hold.startsAt?.toISOString() ?? null, endsAt: hold.endsAt?.toISOString() ?? null,
    reason: hold.reason, customerId: hold.customerId, customerName: customerName ?? null,
  }));
}

/** The periods containers were kept off the road, newest first. `asset:read`. */
export function listHolds(ctx: ServiceContext, input: { assetId?: string | undefined; open?: boolean | undefined; limit: number }) {
  return guardedRead(ctx, "asset:read", async (tx) => ({
    data: await holdViews(tx, and(
      eq(schema.containerHold.organizationId, ctx.actor.organizationId),
      ...(input.assetId ? [eq(schema.containerHold.assetId, input.assetId)] : []),
      ...(input.open ? [isNull(schema.containerHold.endsAt)] : []),
    ), input.limit),
  }));
}

export interface HoldInput {
  assetId: string;
  reason: string;
  customerId?: string | null | undefined;
  startsAt?: string | undefined;
  endsAt?: string | null | undefined;
}

/**
 * Hold a can for a customer who asked: from when, and until when if it has
 * ended. A hold still running keeps a can in the yard, so it is refused for a
 * can on a site; a hold that has ended is history and can be recorded after
 * the fact. Two customer holds on one can at once are refused. `asset:write`.
 */
export function holdForCustomer(ctx: ServiceContext, input: HoldInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const again = await replayed<HoldView>(tx, ctx, "container_hold");
    if (again) return again;
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const [asset] = await tx.select().from(schema.rentableAsset)
      .where(and(
        eq(schema.rentableAsset.organizationId, ctx.actor.organizationId),
        eq(schema.rentableAsset.id, input.assetId),
        isNull(schema.rentableAsset.deletedAt),
      )).limit(1);
    if (!asset) throw new NotFoundError("Container");
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError("Say who asked for the hold and why. A hold nobody can explain is one nobody knows when to end.");
    }
    if (input.customerId) {
      const [found] = await tx.select({ id: schema.customer.id }).from(schema.customer)
        .where(and(eq(schema.customer.organizationId, ctx.actor.organizationId), eq(schema.customer.id, input.customerId)))
        .limit(1);
      if (!found) throw new NotFoundError("Customer");
    }
    const startsAt = input.startsAt ? instant(input.startsAt, "The start of the hold") : new Date();
    notYet(startsAt, "That hold");
    const endsAt = input.endsAt ? instant(input.endsAt, "The end of the hold") : null;
    if (endsAt) {
      notYet(endsAt, "The end of that hold");
      if (endsAt.getTime() <= startsAt.getTime()) throw new ConflictError("A hold ends after it starts.");
    } else if (asset.status === "on_site") {
      throw new ConflictError(
        `Container ${asset.identifier} is on a site. A hold keeps a can in the yard for a customer: record it when the can is back.`,
      );
    }
    const [overlap] = await tx.select().from(schema.containerHold)
      .where(and(
        eq(schema.containerHold.assetId, asset.id),
        eq(schema.containerHold.kind, "customer"),
        or(isNull(schema.containerHold.endsAt), sql`${schema.containerHold.endsAt} > ${startsAt.toISOString()}::timestamptz`),
        ...(endsAt ? [sql`coalesce(${schema.containerHold.startsAt}, '-infinity'::timestamptz) < ${endsAt.toISOString()}::timestamptz`] : []),
      )).limit(1);
    if (overlap) {
      throw new ConflictError(
        `Container ${asset.identifier} was already held for a customer from `
        + `${overlap.startsAt ? when(overlap.startsAt, zone) : "before holds were kept"}`
        + `${overlap.endsAt ? ` to ${when(overlap.endsAt, zone)}` : ", and still is"}.`,
      );
    }
    const [row] = await refusingDuplicate(
      "container_hold_open_idx",
      `Container ${asset.identifier} is already held for a customer.`,
      () => tx.insert(schema.containerHold).values({
        organizationId: ctx.actor.organizationId, assetId: asset.id, kind: "customer", startsAt, endsAt, reason,
        customerId: input.customerId ?? null, recordedByUserId: actingUser(ctx),
      }).returning(),
    );
    await audit(tx, ctx, "container_hold.open", "container_hold", row!.id, null, row);
    const [view] = await holdViews(tx, and(eq(schema.containerHold.id, row!.id)), 1);
    await remember(tx, ctx, "container_hold", row!.id, view!);
    return view!;
  });
}

/** End a customer hold: the customer no longer wants that can kept. A repair ends by putting the can back in service. `asset:write`. */
export function endHold(ctx: ServiceContext, input: { id: string; endsAt?: string | undefined }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const again = await replayed<HoldView>(tx, ctx, "container_hold.end");
    if (again) return again;
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const [hold] = await tx.select().from(schema.containerHold)
      .where(and(eq(schema.containerHold.organizationId, ctx.actor.organizationId), eq(schema.containerHold.id, input.id)))
      .limit(1);
    if (!hold) throw new NotFoundError("Hold");
    if (hold.kind === "repair") throw new ConflictError("A repair ends when the can is put back in service.");
    if (hold.endsAt) throw new ConflictError(`That hold already ended at ${when(hold.endsAt, zone)}.`);
    const endsAt = input.endsAt ? instant(input.endsAt, "The end of the hold") : new Date();
    notYet(endsAt, "The end of that hold");
    if (hold.startsAt && endsAt.getTime() <= hold.startsAt.getTime()) {
      throw new ConflictError(`The hold began at ${when(hold.startsAt, zone)}, so it ends after that.`);
    }
    const [row] = await tx.update(schema.containerHold).set({ endsAt, updatedAt: new Date() })
      .where(eq(schema.containerHold.id, hold.id)).returning();
    await audit(tx, ctx, "container_hold.close", "container_hold", hold.id, hold, row);
    const [view] = await holdViews(tx, and(eq(schema.containerHold.id, hold.id)), 1);
    await remember(tx, ctx, "container_hold.end", hold.id, view!);
    return view!;
  });
}

/* ------------------------------------------------------------- the phone */

/** In a savepoint, with the service's own refusal said in words; anything else is a fault and is thrown. */
async function savepoint(tx: Database, run: (sp: Database) => Promise<string | null>): Promise<string | null> {
  try {
    return await tx.transaction(async (sp) => run(sp as unknown as Database));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "ConflictError" || name === "NotFoundError") return (error as Error).message;
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `haul.time` from a phone: the moment the driver put a can down (`placed`)
 * or emptied one at the facility (`tipped`). The subject is the hire and the
 * payload names which of the two as its field, so a second tap on the same
 * one supersedes the first and the other is left alone.
 *
 * Only for a hire on a stop sent to the phone's own person: the drop of a
 * delivery or of the can a swap left, the tip of a collection or of the can a
 * swap took. Anybody else's haul is the office's to time.
 */
export async function haulTimeOperation(
  tx: Database, ctx: ServiceContext, op: field.FieldOperation, technicianId: string | null,
): Promise<string | null> {
  if (!technicianId) return "This phone is not registered to a driver, so there is nobody to record the haul for.";
  if (!op.subjectId || !UUID.test(op.subjectId)) return "That time names no container.";
  const which = op.payload["field"];
  if (which !== "placed" && which !== "tipped") return "Say whether the can was dropped or emptied.";
  const raw = typeof op.payload["at"] === "string" ? op.payload["at"] : op.occurredAt.toISOString();
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "That is not a time.";
  const rentalId = op.subjectId;
  return savepoint(tx, async (sp) => {
    const [hire] = await sp.select({ id: schema.rental.id, previousRentalId: schema.rental.previousRentalId })
      .from(schema.rental).where(and(eq(schema.rental.organizationId, ctx.actor.organizationId), eq(schema.rental.id, rentalId)))
      .limit(1);
    if (!hire) return "That container hire is not on the books.";
    const onStops = [hire.id, ...(which === "placed" && hire.previousRentalId ? [hire.previousRentalId] : [])];
    const [mine] = await sp.select({ id: schema.visit.id }).from(schema.visit)
      .innerJoin(schema.visitAssignment, eq(schema.visitAssignment.visitId, schema.visit.id))
      .where(and(
        eq(schema.visitAssignment.technicianId, technicianId),
        inArray(schema.visit.rentalId, onStops),
      )).limit(1);
    if (!mine) return "That haul is not on one of your stops, so its time cannot be recorded from your phone. Ask the office to record it.";
    if (which === "tipped") await recordTipWithin(sp, ctx, { id: hire.id, tippedAt: at, source: "phone" });
    else await recordPlacementWithin(sp, ctx, { id: hire.id, deliveredAt: at, source: "phone" });
    return null;
  });
}

export interface FieldHaul {
  visitId: string;
  /** What the stop is: a drop, a collection, or a swap. */
  leg: "delivery" | "pickup" | "swap";
  /** The can put down on this stop, when there is one: a delivery's, or the empty a swap left. */
  drop: { rentalId: string; container: string; deliveredAt: string | null; timeKnown: boolean } | null;
  /** The can taken to the facility from this stop, when there is one: a collection's, or the full can a swap took. */
  tip: { rentalId: string; container: string; tippedAt: string | null } | null;
}

/**
 * The hauls on a person's stops, so the phone can record the drop and the tip
 * with no signal. A delivery's drop is its own hire; a collection's tip is its
 * own hire; a swap's tip is the hire on the stop (the full can) and its drop is
 * the hire the swap opened, once the office has recorded the swap.
 */
export async function haulsForField(
  tx: Database, visits: ReadonlyArray<{ id: string; rentalId: string | null; rentalEvent: string | null }>,
): Promise<FieldHaul[]> {
  const onHire = visits.filter((v) => v.rentalId !== null);
  if (onHire.length === 0) return [];
  const ids = onHire.map((v) => v.rentalId!);
  const hires = await tx.select({
    rental: schema.rental, identifier: schema.rentableAsset.identifier, size: schema.rentableAsset.size,
  }).from(schema.rental)
    .innerJoin(schema.rentableAsset, eq(schema.rentableAsset.id, schema.rental.assetId))
    .where(or(inArray(schema.rental.id, ids), inArray(schema.rental.previousRentalId, ids)));
  const name = (h: (typeof hires)[number]) => `${h.identifier}${h.size ? ` (${h.size})` : ""}`;
  const out: FieldHaul[] = [];
  for (const v of onHire) {
    const own = hires.find((h) => h.rental.id === v.rentalId);
    if (!own) continue;
    const leg = v.rentalEvent === "delivery" || v.rentalEvent === "pickup" || v.rentalEvent === "swap" ? v.rentalEvent : null;
    if (!leg) continue;
    const opened = leg === "swap" ? hires.find((h) => h.rental.previousRentalId === own.rental.id) : undefined;
    const placed = leg === "delivery" ? own : opened;
    out.push({
      visitId: v.id,
      leg,
      drop: placed ? {
        rentalId: placed.rental.id, container: name(placed),
        deliveredAt: placed.rental.deliveredAt?.toISOString() ?? null, timeKnown: placed.rental.deliveredTimeKnown,
      } : null,
      tip: leg === "delivery" ? null : { rentalId: own.rental.id, container: name(own), tippedAt: own.rental.tippedAt?.toISOString() ?? null },
    });
  }
  return out;
}

/** What the phone's revision adds for hauls: a time the office recorded on a hire on these stops reaches a phone that polls. */
export async function haulRevision(tx: Database, visitIds: readonly string[]): Promise<number> {
  if (visitIds.length === 0) return 0;
  const rows = await tx.execute<{ revision: string }>(sql`
    select coalesce(extract(epoch from max(r.updated_at))::bigint % 1000000 + count(*), 0)::text as revision
    from public.rental r
    where r.id in (select v.rental_id from public.visit v where v.id = any(${sql.param([...visitIds])}::uuid[]))
       or r.previous_rental_id in (select v.rental_id from public.visit v where v.id = any(${sql.param([...visitIds])}::uuid[]))`);
  return Number(rows[0]?.revision ?? 0);
}

export const handlers = {
  recordRentalTip: (ctx: ServiceContext, input: { id: string; tippedAt: string | null }) => recordTip(ctx, input),
  recordRentalEmpty: (ctx: ServiceContext, input: { id: string; at: string | null }) => recordEmpty(ctx, input),
  recordRentalDrop: (ctx: ServiceContext, input: { id: string; deliveredAt: string }) => recordPlacement(ctx, input),
  listContainerHolds: listHolds,
  holdContainer: (ctx: ServiceContext, { id, ...input }: Omit<HoldInput, "assetId"> & { id: string }) =>
    holdForCustomer(ctx, { ...input, assetId: id }),
  endContainerHold: (ctx: ServiceContext, input: { id: string; endsAt?: string | undefined }) => endHold(ctx, input),
} as const;
