import { and, asc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, time, isSystem, type field } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { truckDaysSql } from "./kpi-catalogue";

/**
 * FRESH WATER, BY TRUCK AND DAY
 *
 * The trash bin trade's "fresh water per stop" is fresh water used divided by
 * completed stops, per truck. A truck drifting upward is a nozzle or a burner
 * going, and it shows in this number before it shows in a complaint, but only
 * per truck: a fleet wide figure hides the one truck. Nothing recorded water.
 * The per stop "water used" reading on a service report is somebody's guess
 * at one bin, and a meter reading is a counter the machine wears out by. This
 * is the tank: what the gauge or the fill meter says the truck used that day.
 *
 * THE DRIVER READS IT ON THE PHONE (`truck.water`), for a truck checked out to
 * them that day, and the office can type or correct it here. One figure per
 * truck per day in the company's calendar. Between two readings of one day the
 * later one stands, by when it was read: a correction lands, and a phone that
 * synced late with an older reading does not undo it.
 *
 * Which stops were the truck's is not recorded here, because it is already
 * known: the visits completed that day by whoever had the truck checked out,
 * sent to them by name or with a crew they are on. The same reading the
 * scorecard makes (`truckDaysSql`), so this screen and the figure agree.
 */

/** No truck carries this much. A slip of the thumb (4100 for 410) is refused here, the one cheap moment. */
export const MOST_GALLONS_IN_A_DAY = 5000;

const actingUser = (ctx: ServiceContext): string | null =>
  ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId;

export interface WaterInput {
  assetId: string;
  onDay: string;
  gallons: string;
  note?: string | null | undefined;
}

export interface WaterReading {
  id: string;
  assetId: string;
  onDay: string;
  gallons: string;
  source: string;
  recordedAt: string;
  note: string | null;
}

const view = (row: typeof schema.truckWaterDay.$inferSelect): WaterReading => ({
  id: row.id, assetId: row.assetId, onDay: row.onDay, gallons: row.gallons, source: row.source,
  recordedAt: row.recordedAt.toISOString(), note: row.note,
});

/**
 * Record a truck's water for a day, inside a transaction, from the office or
 * from a phone. Refused for anything that is not a vehicle still in the
 * fleet on that day, for a day that has not come yet, and for a figure that
 * is not a number of gallons a truck could use. Returns whether it stood: a
 * reading made before the one already recorded for that day does not.
 */
export async function recordWithin(
  tx: Database, ctx: ServiceContext,
  input: WaterInput & { source: "phone" | "office"; technicianId: string | null; recordedAt: Date },
): Promise<{ reading: WaterReading; stood: boolean }> {
  const organizationId = ctx.actor.organizationId;
  const [asset] = await tx.select().from(schema.companyAsset)
    .where(and(eq(schema.companyAsset.id, input.assetId), eq(schema.companyAsset.organizationId, organizationId)))
    .limit(1);
  if (!asset) throw new NotFoundError("Truck");
  if (asset.kind !== "vehicle") {
    throw new ConflictError(`${asset.label} is not a vehicle, so it has no water tank to read.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.onDay)) throw new ConflictError("Say which day the water was used on.");
  if (asset.retiredOn !== null && asset.retiredOn <= input.onDay) {
    throw new ConflictError(`${asset.label} had left the fleet by ${input.onDay}.`);
  }
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  if (input.onDay > today) throw new ConflictError("That day has not come yet. Record the water at the end of the day.");

  let gallons: m.Money;
  try {
    gallons = m.money(input.gallons.trim());
  } catch {
    throw new ConflictError("Type the gallons as a number, for example 410.");
  }
  if (m.isNegative(gallons)) throw new ConflictError("Gallons used cannot be less than nothing.");
  if (m.compare(gallons, m.money(String(MOST_GALLONS_IN_A_DAY))) > 0) {
    throw new ConflictError(`${input.gallons.trim()} gallons is more than a truck uses in a day. Check the figure and type it again.`);
  }

  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const [before] = await tx.select().from(schema.truckWaterDay)
    .where(and(
      eq(schema.truckWaterDay.organizationId, organizationId),
      eq(schema.truckWaterDay.assetId, asset.id),
      eq(schema.truckWaterDay.onDay, input.onDay),
    )).limit(1);
  if (before && before.recordedAt.getTime() > input.recordedAt.getTime()) {
    return { reading: view(before), stood: false };
  }

  const values = {
    gallons: m.toString(gallons), source: input.source, technicianId: input.technicianId,
    recordedByUserId: actingUser(ctx), recordedAt: input.recordedAt, note,
  };
  /**
   * Upserted on the truck and day, and only over a reading made no later than
   * this one, so two phones racing for one day cannot both insert and an
   * older reading cannot win the race either.
   */
  const [after] = await tx.insert(schema.truckWaterDay).values({
    organizationId, assetId: asset.id, onDay: input.onDay, ...values,
  }).onConflictDoUpdate({
    target: [schema.truckWaterDay.organizationId, schema.truckWaterDay.assetId, schema.truckWaterDay.onDay],
    set: { ...values, updatedAt: new Date() },
    setWhere: sql`${schema.truckWaterDay.recordedAt} <= excluded.recorded_at`,
  }).returning();
  if (!after) {
    const [standing] = await tx.select().from(schema.truckWaterDay)
      .where(and(
        eq(schema.truckWaterDay.organizationId, organizationId),
        eq(schema.truckWaterDay.assetId, asset.id),
        eq(schema.truckWaterDay.onDay, input.onDay),
      )).limit(1);
    return { reading: view(standing!), stood: false };
  }
  await audit(tx, ctx, "truck_water.recorded", "company_asset", asset.id, before ?? null, after!);
  return { reading: view(after!), stood: true };
}

/** The office types or corrects a truck's water for a day. `asset:write`, as a meter reading is. */
export async function record(ctx: ServiceContext, input: WaterInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const { reading } = await recordWithin(tx, ctx, { ...input, source: "office", technicianId: null, recordedAt: new Date() });
    return reading;
  });
}

/**
 * Take a day's reading off: it was read on the wrong truck. The day is then
 * not read, which the scorecard counts beside the figure rather than as no
 * water. `asset:write`, on the audit log.
 */
export async function remove(ctx: ServiceContext, input: { assetId: string; onDay: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const [row] = await tx.delete(schema.truckWaterDay)
      .where(and(eq(schema.truckWaterDay.assetId, input.assetId), eq(schema.truckWaterDay.onDay, input.onDay)))
      .returning();
    if (!row) throw new NotFoundError("Water reading");
    await audit(tx, ctx, "truck_water.removed", "company_asset", input.assetId, row, null);
    return { ok: true as const };
  });
}

export interface TruckDay {
  assetId: string;
  label: string;
  onDay: string;
  /** Stops completed that day by whoever had the truck. */
  stops: number;
  gallons: string | null;
  source: string | null;
  /** Gallons a stop, to one place, when the day has both. */
  perStop: string | null;
}

/**
 * Each truck's days in a window: the stops its driver completed and the water
 * read, a day with either. The same truck days the scorecard counts.
 */
export async function days(ctx: ServiceContext, input: { from: string; to: string }) {
  return guardedRead(ctx, "asset:read", async (tx): Promise<{ days: TruckDay[] }> => {
    if (input.to < input.from) throw new ConflictError("The end of the window is before its start.");
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const rows = await tx.execute<{
      asset_id: string; label: string; day: string; stops: number; gallons: string | null; source: string | null;
    }>(truckDaysSql(input.from, input.to, zone));
    return {
      days: rows.map((r) => ({
        assetId: r.asset_id, label: r.label, onDay: r.day, stops: Number(r.stops), gallons: r.gallons, source: r.source,
        perStop: r.gallons !== null && Number(r.stops) > 0 ? (Number(r.gallons) / Number(r.stops)).toFixed(1) : null,
      })),
    };
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

/** Whether a technician had this truck checked out on this day: half open, like every custody period. */
async function heldOn(tx: Database, assetId: string, technicianId: string, day: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [row] = await tx.select({ id: schema.assetCustody.id }).from(schema.assetCustody)
    .where(and(
      eq(schema.assetCustody.assetId, assetId),
      eq(schema.assetCustody.custodianKind, "technician"),
      eq(schema.assetCustody.custodianId, technicianId),
      lte(schema.assetCustody.heldFrom, day),
      or(isNull(schema.assetCustody.heldUntil), gt(schema.assetCustody.heldUntil, day)),
    )).limit(1);
  return row !== undefined;
}

/**
 * `truck.water` from a phone: the gallons a truck used on a day, read by the
 * person who had it. Only for a truck checked out to the phone's own person on
 * that day, because a reading on somebody else's truck is the office's to
 * make. The subject is the truck and the payload names the day as its field,
 * so a later reading of the same day supersedes an earlier one and a reading
 * of another day does not.
 */
export async function waterOperation(tx: Database, ctx: ServiceContext, op: field.FieldOperation, technicianId: string | null): Promise<string | null> {
  if (!technicianId) return "This phone is not registered to a technician, so there is no driver to record the water for.";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(op.subjectId)) return "That reading names no truck.";
  const onDay = typeof op.payload["onDay"] === "string" ? op.payload["onDay"] : "";
  const gallons = typeof op.payload["gallons"] === "string" ? op.payload["gallons"] : "";
  return savepoint(tx, async (sp) => {
    if (!(await heldOn(sp, op.subjectId, technicianId, onDay))) {
      return "That truck was not checked out to you on that day, so its water cannot be recorded from your phone. Ask the office to record it.";
    }
    await recordWithin(sp, ctx, {
      assetId: op.subjectId, onDay, gallons, note: null, source: "phone", technicianId, recordedAt: op.occurredAt,
    });
    return null;
  });
}

/**
 * The trucks a person had on the snapshot's days, with the water read for
 * each, so the phone can show and record the day's reading with no signal.
 */
export async function trucksForField(tx: Database, technicianId: string, from: string, to: string) {
  const custody = await tx.select({
    assetId: schema.assetCustody.assetId,
    heldFrom: schema.assetCustody.heldFrom,
    heldUntil: schema.assetCustody.heldUntil,
    label: schema.companyAsset.label,
    kind: schema.companyAsset.kind,
    retiredOn: schema.companyAsset.retiredOn,
  }).from(schema.assetCustody)
    .innerJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.assetCustody.assetId))
    .where(and(
      eq(schema.assetCustody.custodianKind, "technician"),
      eq(schema.assetCustody.custodianId, technicianId),
      eq(schema.companyAsset.kind, "vehicle"),
      lte(schema.assetCustody.heldFrom, to),
    ))
    .orderBy(asc(schema.companyAsset.label));
  const held = custody.filter((c) => (c.heldUntil === null || c.heldUntil > from) && (c.retiredOn === null || c.retiredOn > from));
  const trucks = new Map<string, { assetId: string; label: string; days: string[] }>();
  for (const c of held) {
    const days: string[] = [];
    for (let day = c.heldFrom > from ? c.heldFrom : from; day <= to; day = time.addDays(day, 1)) {
      if (c.heldUntil !== null && day >= c.heldUntil) break;
      if (c.retiredOn !== null && day >= c.retiredOn) break;
      days.push(day);
    }
    if (days.length === 0) continue;
    const truck = trucks.get(c.assetId) ?? { assetId: c.assetId, label: c.label, days: [] };
    truck.days.push(...days);
    trucks.set(c.assetId, truck);
  }
  if (trucks.size === 0) return [];
  const readings = await tx.select().from(schema.truckWaterDay)
    .where(and(gte(schema.truckWaterDay.onDay, from), lte(schema.truckWaterDay.onDay, to)));
  return [...trucks.values()].map((t) => ({
    assetId: t.assetId,
    label: t.label,
    days: [...new Set(t.days)].sort(),
    water: readings.filter((r) => r.assetId === t.assetId && t.days.includes(r.onDay))
      .map((r) => ({ onDay: r.onDay, gallons: r.gallons })),
  }));
}

/**
 * What the phone's revision adds for trucks: the trucks this person has been
 * handed and the water read on them, so a truck checked out to them or a
 * reading the office corrected reaches a phone that polls with its revision.
 */
export async function waterRevision(tx: Database, technicianId: string): Promise<number> {
  const rows = await tx.execute<{ revision: string }>(sql`
    select (
      coalesce((select extract(epoch from max(ac.updated_at))::bigint % 1000000 + count(*)
                from public.asset_custody ac
                where ac.custodian_kind = 'technician' and ac.custodian_id = ${technicianId}::uuid), 0)
      + coalesce((select extract(epoch from max(w.updated_at))::bigint % 1000000 + count(*)
                  from public.truck_water_day w
                  where exists (select 1 from public.asset_custody ac
                                where ac.asset_id = w.asset_id and ac.custodian_kind = 'technician'
                                  and ac.custodian_id = ${technicianId}::uuid)), 0)
    )::text as revision`);
  return Number(rows[0]?.revision ?? 0);
}

export const handlers = {
  listTruckWater: (ctx: ServiceContext, input: { from: string; to: string }) => days(ctx, input),
  recordTruckWater: (ctx: ServiceContext, input: { assetId: string; day: string; gallons: string; note?: string | null | undefined }) =>
    record(ctx, { assetId: input.assetId, onDay: input.day, gallons: input.gallons, note: input.note }),
  removeTruckWater: (ctx: ServiceContext, input: { assetId: string; day: string }) =>
    remove(ctx, { assetId: input.assetId, onDay: input.day }),
} as const;
