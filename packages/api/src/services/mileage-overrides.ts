import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { payExtras as px, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { settingsWithin } from "./pay-extras";
import { technicianScopeFilter } from "./scope";

/**
 * A MILEAGE RATE OF ONE PERSON'S OR ONE VEHICLE'S OWN (M17)
 *
 * The company's rate for a mile is a history in its pay settings (`services/pay-extras.ts`). A company that
 * pays one driver more, or one vehicle less, keeps a line here for that person or that vehicle, in the same
 * shape: a day it starts from and dollars for one mile. When a claim in miles is made, the rate is the
 * vehicle's line in force on the day of the drive, else the person's, else the company's. The claim keeps the
 * rate and where it came from, so adding or taking off a line here never reprices a claim already made.
 *
 * Whether a rate is within what the tax authority allows without tax is the company's to check, as it is for
 * the company's own rate. Nothing here knows or judges it.
 *
 * WHO. Setting a rate is a statement about what a person is owed, so `payroll:configure`, the permission for
 * the company's own rate (the owner and the accountant, not the office manager). Reading is the timesheet's
 * `timesheet:read`, narrowed to the people the reader's timesheet scope reaches for a person's line; a
 * vehicle's line is the company's and is read by anyone who reads the timesheet.
 */

export interface OverrideLine {
  id: string;
  kind: "person" | "vehicle";
  technicianId: string | null;
  assetId: string | null;
  /** The person's name, or the vehicle's label. */
  subjectName: string;
  from: string;
  perMile: string;
  /** This is the line in force today for its person or vehicle. */
  inForceToday: boolean;
}

export interface OverrideLines { lines: OverrideLine[] }

/** What the rows of one person and one vehicle say, as the company's own kind of list. */
export interface SubjectLines { person: px.MileageRate[]; vehicle: px.MileageRate[] }

const rateOf = (r: { fromDay: string; perMile: string }): px.MileageRate => ({ from: r.fromDay, perMile: r.perMile });

/** The lines of one person and of one vehicle, oldest first, for working a claim out. */
export async function linesWithin(
  tx: Database, organizationId: string, subject: { technicianId?: string | null | undefined; assetId?: string | null | undefined },
): Promise<SubjectLines> {
  const person = subject.technicianId ? (await tx.select().from(schema.mileageRateOverride).where(and(
    eq(schema.mileageRateOverride.organizationId, organizationId),
    eq(schema.mileageRateOverride.technicianId, subject.technicianId),
  )).orderBy(asc(schema.mileageRateOverride.fromDay))).map(rateOf) : [];
  const vehicle = subject.assetId ? (await tx.select().from(schema.mileageRateOverride).where(and(
    eq(schema.mileageRateOverride.organizationId, organizationId),
    eq(schema.mileageRateOverride.assetId, subject.assetId),
  )).orderBy(asc(schema.mileageRateOverride.fromDay))).map(rateOf) : [];
  return { person, vehicle };
}

/**
 * The rate for a mile for this person on this day, and where it came from, or null when nothing has started.
 * `assetId` is the vehicle the person named, if they named one.
 */
export async function resolveWithin(
  tx: Database, organizationId: string,
  input: { day: string; technicianId: string | null; assetId?: string | null | undefined },
): Promise<{ rate: px.MileageRate; source: px.MileageRateSource } | null> {
  const own = await linesWithin(tx, organizationId, { technicianId: input.technicianId, assetId: input.assetId ?? null });
  const company = (await settingsWithin(tx, organizationId)).mileageRates;
  return px.resolveMileageRate(input.day, { vehicle: own.vehicle, person: own.person, company });
}

/** The vehicles that have a line of their own, with the rate each pays today (null while every line is still to come). */
export async function vehiclesWithinRates(
  tx: Database, organizationId: string, today: string,
): Promise<{ id: string; label: string; rateToday: string | null }[]> {
  const rows = await tx.select({
    assetId: schema.mileageRateOverride.assetId, label: schema.companyAsset.label,
    fromDay: schema.mileageRateOverride.fromDay, perMile: schema.mileageRateOverride.perMile,
  }).from(schema.mileageRateOverride)
    .innerJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.mileageRateOverride.assetId))
    .where(and(eq(schema.mileageRateOverride.organizationId, organizationId), isNull(schema.companyAsset.retiredOn)))
    .orderBy(asc(schema.companyAsset.label), asc(schema.mileageRateOverride.fromDay));
  const found = new Map<string, { id: string; label: string; lines: px.MileageRate[] }>();
  for (const r of rows) {
    const entry = found.get(r.assetId!) ?? { id: r.assetId!, label: r.label, lines: [] };
    entry.lines.push(rateOf(r));
    found.set(r.assetId!, entry);
  }
  return [...found.values()].map((v) => ({ id: v.id, label: v.label, rateToday: px.mileageRateOn(v.lines, today)?.perMile ?? null }));
}

const todayOf = async (tx: Database, organizationId: string) => time.dateIn(new Date(), await timezoneOf(tx, organizationId));

async function viewWithin(
  tx: Database, ctx: ServiceContext, filter: { technicianId?: string | undefined; assetId?: string | undefined } = {},
): Promise<OverrideLines> {
  const today = await todayOf(tx, ctx.actor.organizationId);
  const reach = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  const rows = await tx.select({
    id: schema.mileageRateOverride.id,
    technicianId: schema.mileageRateOverride.technicianId,
    assetId: schema.mileageRateOverride.assetId,
    fromDay: schema.mileageRateOverride.fromDay,
    perMile: schema.mileageRateOverride.perMile,
    personName: schema.technician.displayName,
    vehicleLabel: schema.companyAsset.label,
  }).from(schema.mileageRateOverride)
    .leftJoin(schema.technician, eq(schema.technician.id, schema.mileageRateOverride.technicianId))
    .leftJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.mileageRateOverride.assetId))
    .where(and(
      eq(schema.mileageRateOverride.organizationId, ctx.actor.organizationId),
      filter.technicianId ? eq(schema.mileageRateOverride.technicianId, filter.technicianId) : undefined,
      filter.assetId ? eq(schema.mileageRateOverride.assetId, filter.assetId) : undefined,
      /** A person's line is read by whoever reaches that person on the timesheet; a vehicle's by all who read it. */
      reach === undefined ? undefined : sql`(${schema.mileageRateOverride.technicianId} is null or ${reach})`,
    ))
    .orderBy(asc(schema.technician.displayName), asc(schema.companyAsset.label), asc(schema.mileageRateOverride.fromDay));
  const bySubject = new Map<string, px.MileageRate[]>();
  for (const r of rows) {
    const key = r.technicianId ?? r.assetId!;
    bySubject.set(key, [...(bySubject.get(key) ?? []), rateOf(r)]);
  }
  return {
    lines: rows.map((r) => {
      const key = r.technicianId ?? r.assetId!;
      return {
        id: r.id,
        kind: r.technicianId ? "person" : "vehicle",
        technicianId: r.technicianId,
        assetId: r.assetId,
        subjectName: r.personName ?? r.vehicleLabel ?? "",
        from: r.fromDay,
        perMile: r.perMile,
        inForceToday: px.mileageRateOn(bySubject.get(key) ?? [], today)?.from === r.fromDay,
      };
    }),
  };
}

export async function list(
  ctx: ServiceContext, filter: { technicianId?: string | undefined; assetId?: string | undefined } = {},
): Promise<OverrideLines> {
  return guardedRead(ctx, "timesheet:read", (tx) => viewWithin(tx, ctx, filter));
}

export interface OverrideInput {
  /** The person whose rate it is. Exactly one of this and `assetId`. */
  technicianId?: string | undefined;
  /** The vehicle whose rate it is. Exactly one of this and `technicianId`. */
  assetId?: string | undefined;
  from: string;
  perMile: string;
}

export async function add(ctx: ServiceContext, input: OverrideInput): Promise<OverrideLines> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    if ((input.technicianId === undefined) === (input.assetId === undefined)) {
      throw new ConflictError("Say whose rate it is: one person or one vehicle, not both and not neither.");
    }
    const organizationId = ctx.actor.organizationId;
    let subjectName: string;
    if (input.technicianId) {
      const [person] = await tx.select({ name: schema.technician.displayName }).from(schema.technician)
        .where(and(eq(schema.technician.id, input.technicianId), eq(schema.technician.organizationId, organizationId))).limit(1);
      if (!person) throw new NotFoundError("Person");
      subjectName = person.name;
    } else {
      const [vehicle] = await tx.select({ label: schema.companyAsset.label, kind: schema.companyAsset.kind, retiredOn: schema.companyAsset.retiredOn })
        .from(schema.companyAsset)
        .where(and(eq(schema.companyAsset.id, input.assetId!), eq(schema.companyAsset.organizationId, organizationId))).limit(1);
      if (!vehicle) throw new NotFoundError("Vehicle");
      if (vehicle.kind !== "vehicle") throw new ConflictError(`${vehicle.label} is not a vehicle, so it cannot have a rate for a mile.`);
      if (vehicle.retiredOn !== null) throw new ConflictError(`${vehicle.label} is retired, so it cannot be given a rate for a mile.`);
      subjectName = vehicle.label;
    }
    const own = await linesWithin(tx, organizationId, input);
    const existing = input.technicianId ? own.person : own.vehicle;
    /** The same line sent again, by a caller that lost the answer, is the first one back and changes nothing. */
    const same = px.checkMileageRate(input);
    if (!same.ok) throw new ConflictError(same.reason);
    if (existing.some((r) => r.from === same.rate.from && r.perMile === same.rate.perMile)) {
      return viewWithin(tx, ctx);
    }
    if (existing.some((r) => r.from === same.rate.from)) {
      throw new ConflictError(`There is already a rate from ${same.rate.from} for ${subjectName}. Take it off first if it is wrong.`);
    }
    const added = px.addMileageRate(existing, input);
    if (!added.ok) throw new ConflictError(added.reason);
    const line = added.rates.find((r) => r.from === same.rate.from)!;
    const [row] = await tx.insert(schema.mileageRateOverride).values({
      organizationId,
      technicianId: input.technicianId ?? null,
      assetId: input.assetId ?? null,
      fromDay: line.from,
      perMile: line.perMile,
      createdByUserId: ctx.actor.userId,
    }).returning({ id: schema.mileageRateOverride.id });
    await audit(tx, ctx, "mileage_rate_override.added", "mileage_rate_override", row!.id, null, {
      kind: input.technicianId ? "person" : "vehicle", technicianId: input.technicianId ?? null,
      assetId: input.assetId ?? null, subjectName, from: line.from, perMile: line.perMile,
    });
    return viewWithin(tx, ctx);
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }): Promise<OverrideLines> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const [row] = await tx.select().from(schema.mileageRateOverride)
      .where(and(eq(schema.mileageRateOverride.id, input.id), eq(schema.mileageRateOverride.organizationId, ctx.actor.organizationId))).limit(1);
    /** Nothing there: taking it off again changes nothing, so a retry is not an error. */
    if (!row) return viewWithin(tx, ctx);
    await tx.delete(schema.mileageRateOverride).where(eq(schema.mileageRateOverride.id, row.id));
    await audit(tx, ctx, "mileage_rate_override.removed", "mileage_rate_override", row.id, {
      technicianId: row.technicianId, assetId: row.assetId, from: row.fromDay, perMile: row.perMile,
    }, null);
    return viewWithin(tx, ctx);
  });
}

/**
 * The vehicle a claim names, checked to be one that is still in use and has a rate of its own. Only those are
 * offered on the claim, so a person cannot read the name of any other vehicle in the fleet by naming it.
 */
export async function vehicleForClaim(
  tx: Database, organizationId: string, assetId: string,
): Promise<{ id: string; label: string }> {
  const [vehicle] = await tx.select({ id: schema.companyAsset.id, label: schema.companyAsset.label })
    .from(schema.companyAsset)
    .where(and(
      eq(schema.companyAsset.id, assetId), eq(schema.companyAsset.organizationId, organizationId),
      eq(schema.companyAsset.kind, "vehicle"), isNull(schema.companyAsset.retiredOn),
      sql`exists (select 1 from public.mileage_rate_override o where o.asset_id = ${schema.companyAsset.id})`,
    )).limit(1);
  if (!vehicle) {
    throw new ConflictError("That vehicle is not on the list. Pick one from the list, or leave it empty for your own.");
  }
  return vehicle;
}

export const handlers = {
  listMileageOverrides: (ctx: ServiceContext, input: { technicianId?: string | undefined; assetId?: string | undefined }) => list(ctx, input),
  addMileageOverride: (ctx: ServiceContext, input: OverrideInput) => add(ctx, input),
  removeMileageOverride: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
