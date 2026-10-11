import { and, asc, eq, ne } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, rental as rt, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import * as once from "./once";
import { placePin, clearPin } from "./geocoding";

/**
 * DISPOSAL FACILITIES AS PLACES
 *
 * A full can is tipped at a landfill or a transfer station, not at the yard.
 * Until this existed a hire recorded the facility's name as free text, so the
 * route could not drive to it, nobody could be told it closes at half past
 * four, and the fee on a weighed load was a number somebody typed from
 * memory. A facility here has an address and a pin (put on the map by the
 * worker like a property, or placed by hand and then never moved), the hours
 * it takes loads, and what it charges by the ton or by the load.
 *
 * `rental.disposal_facility_id` points a haul at one, and the planner
 * (`dispatch-map.ts`) runs a driver's day through the company's default
 * facility, or the one asked for: yard to customer to facility to the next
 * stop, counting the time at the gate, and naming any run that reaches it
 * after it has closed.
 *
 * HOLIDAYS ARE NOT HERE. A facility shut for Thanksgiving looks open on that
 * Thursday, and the doc says so.
 *
 * A FACILITY IS CLOSED, NEVER DELETED. Every haul that went there keeps
 * pointing at it, and the scale ticket reconciliation is against its name.
 */

export interface FacilityInput {
  name: string;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
  hours?: rt.DayHours[] | undefined;
  feeBasis?: rt.FeeBasis | null | undefined;
  feeAmount?: string | null | undefined;
  minimumFee?: string | null | undefined;
  tipMinutes?: number | undefined;
  isDefault?: boolean | undefined;
  notes?: string | null | undefined;
}

export interface FacilityPatch extends Omit<FacilityInput, "name"> {
  id: string;
  name?: string | undefined;
  active?: boolean | undefined;
}

type Row = typeof schema.disposalFacility.$inferSelect;

export interface FacilityView {
  id: string;
  name: string;
  address: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** The pin, when it is on the map. */
  latitude: string | null;
  longitude: string | null;
  locationPrecision: string | null;
  /** `manual` for a pin placed by hand, otherwise the geocoder that found it. */
  locationSource: string | null;
  onTheMap: boolean;
  hours: rt.DayHours[];
  hoursText: string;
  feeBasis: rt.FeeBasis | null;
  feeAmount: string | null;
  minimumFee: string | null;
  /** The rate in words, for a screen: "62.50 a ton, at least 40.00". */
  feeText: string;
  tipMinutes: number;
  isDefault: boolean;
  active: boolean;
  notes: string | null;
}

export const addressText = (row: Pick<Row, "addressLine1" | "addressLine2" | "city" | "state" | "postalCode">) =>
  [row.addressLine1, row.addressLine2, [row.city, [row.state, row.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
    .filter((part) => part && part !== "").join(", ");

function feeText(row: Pick<Row, "feeBasis" | "feeAmount" | "minimumFee">): string {
  if (!row.feeBasis || row.feeAmount === null) return "No rate recorded";
  const amount = Number(row.feeAmount).toFixed(2);
  const least = row.minimumFee !== null ? `, at least ${Number(row.minimumFee).toFixed(2)}` : "";
  return `${amount} ${row.feeBasis === "per_ton" ? "a ton" : "a load"}${least}`;
}

export const viewOf = (row: Row): FacilityView => ({
  id: row.id,
  name: row.name,
  address: addressText(row),
  addressLine1: row.addressLine1, addressLine2: row.addressLine2, city: row.city, state: row.state, postalCode: row.postalCode,
  latitude: row.latitude, longitude: row.longitude,
  locationPrecision: row.locationPrecision, locationSource: row.locationSource,
  onTheMap: row.latitude !== null && row.longitude !== null,
  hours: row.hours, hoursText: rt.hoursWords(row.hours),
  feeBasis: row.feeBasis, feeAmount: row.feeAmount, minimumFee: row.minimumFee,
  feeText: feeText(row),
  tipMinutes: row.tipMinutes, isDefault: row.isDefault, active: row.active, notes: row.notes,
});

/** The facility's rate as core's fee arithmetic wants it, or null when none is recorded. */
export const rateOf = (row: Pick<Row, "feeBasis" | "feeAmount" | "minimumFee">): rt.FacilityRate | null =>
  row.feeBasis && row.feeAmount !== null
    ? { basis: row.feeBasis, amount: row.feeAmount, minimum: row.minimumFee }
    : null;

/** Everything about a facility a person typed, checked and said in words when it is wrong. */
function checked(input: FacilityInput, before?: Row) {
  const name = (input.name ?? before?.name ?? "").trim();
  if (name === "") throw new ConflictError("Give the facility a name, the one on its scale tickets.");

  const hours = input.hours !== undefined ? input.hours : before?.hours ?? [];
  const verdict = rt.checkHours(hours);
  if (!verdict.ok) throw new ConflictError(verdict.message);

  const basis = input.feeBasis !== undefined ? input.feeBasis : before?.feeBasis ?? null;
  const amount = input.feeAmount !== undefined ? input.feeAmount : before?.feeAmount ?? null;
  const minimum = input.minimumFee !== undefined ? input.minimumFee : before?.minimumFee ?? null;
  if ((basis === null) !== (amount === null)) {
    throw new ConflictError("A rate needs both what it is charged by (a ton or a load) and how much.");
  }
  for (const [label, value] of [["rate", amount], ["minimum", minimum]] as const) {
    if (value !== null && (!/^\d+(\.\d{1,4})?$/.test(value))) {
      throw new ConflictError(`The ${label} is an amount of money, like 62.50.`);
    }
  }
  if (minimum !== null && basis === null) {
    throw new ConflictError("A minimum charge belongs to a rate. Give the rate first.");
  }
  const tip = input.tipMinutes ?? before?.tipMinutes ?? 20;
  if (!Number.isInteger(tip) || tip < 0 || tip > 180) {
    throw new ConflictError("Time at the facility is between none and three hours.");
  }
  const text = (value: string | null | undefined, kept: string | null | undefined) =>
    value === undefined ? kept ?? null : value?.trim() || null;
  return {
    name, hours: verdict.hours, feeBasis: basis, feeAmount: amount === null ? null : m.toString(m.money(amount)),
    minimumFee: minimum === null ? null : m.toString(m.money(minimum)), tipMinutes: tip,
    addressLine1: text(input.addressLine1, before?.addressLine1), addressLine2: text(input.addressLine2, before?.addressLine2),
    city: text(input.city, before?.city), state: text(input.state, before?.state), postalCode: text(input.postalCode, before?.postalCode),
    notes: text(input.notes, before?.notes),
  };
}

const oneDefault = "Another facility is already the default. Make this one the default and that one stops being it, or leave it as it is.";

export function listFacilities(ctx: ServiceContext, input: { includeClosed?: boolean | undefined } = {}) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const rows = await tx.select().from(schema.disposalFacility)
      .where(and(
        eq(schema.disposalFacility.organizationId, ctx.actor.organizationId),
        ...(input.includeClosed ? [] : [eq(schema.disposalFacility.active, true)]),
      ))
      .orderBy(asc(schema.disposalFacility.name));
    return { facilities: rows.map(viewOf) };
  });
}

async function facilityWithin(tx: Database, ctx: ServiceContext, id: string): Promise<Row> {
  const [row] = await tx.select().from(schema.disposalFacility)
    .where(and(eq(schema.disposalFacility.id, id), eq(schema.disposalFacility.organizationId, ctx.actor.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Disposal facility");
  return row;
}

/** The facility's own record, for a service that needs its rate or hours inside a transaction. */
export const facilityOf = (tx: Database, ctx: ServiceContext, id: string) => facilityWithin(tx, ctx, id);

/** Make this the one default, and the one that was stops being it, in the same write. */
async function makeDefault(tx: Database, ctx: ServiceContext, id: string) {
  await tx.update(schema.disposalFacility).set({ isDefault: false, updatedAt: new Date() })
    .where(and(
      eq(schema.disposalFacility.organizationId, ctx.actor.organizationId),
      eq(schema.disposalFacility.isDefault, true), ne(schema.disposalFacility.id, id),
    ));
}

export function createFacility(ctx: ServiceContext, input: FacilityInput) {
  return guardedWrite(ctx, "asset:write", async (tx): Promise<FacilityView> => {
    const seen = await once.replayed<FacilityView>(tx, ctx, "disposal_facility");
    if (seen) return seen;
    const figures = checked(input);
    const isDefault = input.isDefault === true;
    const [first] = await tx.select({ id: schema.disposalFacility.id }).from(schema.disposalFacility)
      .where(and(eq(schema.disposalFacility.organizationId, ctx.actor.organizationId), eq(schema.disposalFacility.active, true)))
      .limit(1);
    if (isDefault) await makeDefault(tx, ctx, "00000000-0000-0000-0000-000000000000");
    const [row] = await refusingDuplicate("disposal_facility_default_idx", oneDefault, () =>
      tx.insert(schema.disposalFacility).values({
        organizationId: ctx.actor.organizationId, ...figures,
        /** The first facility a company records is the one its days are planned around until it says otherwise. */
        isDefault: isDefault || !first,
      }).returning());
    await audit(tx, ctx, "disposal_facility.created", "disposal_facility", row!.id, null, row!);
    const view = viewOf(row!);
    await once.remember(tx, ctx, "disposal_facility", row!.id, view);
    return view;
  });
}

export function updateFacility(ctx: ServiceContext, input: FacilityPatch) {
  return guardedWrite(ctx, "asset:write", async (tx): Promise<FacilityView> => {
    const before = await facilityWithin(tx, ctx, input.id);
    const figures = checked({ ...input, name: input.name ?? before.name }, before);
    const active = input.active ?? before.active;
    const wantsDefault = input.isDefault ?? before.isDefault;
    if (!active && input.isDefault === true) {
      throw new ConflictError("A closed facility cannot be the default. Reopen it first.");
    }
    const isDefault = active && wantsDefault;
    if (isDefault && !before.isDefault) await makeDefault(tx, ctx, before.id);
    const [row] = await refusingDuplicate("disposal_facility_default_idx", oneDefault, () =>
      tx.update(schema.disposalFacility)
        .set({ ...figures, active, isDefault, updatedAt: new Date() })
        .where(eq(schema.disposalFacility.id, before.id)).returning());
    await audit(tx, ctx, "disposal_facility.updated", "disposal_facility", before.id, before, row!);
    return viewOf(row!);
  });
}

/** Stop using a facility: it leaves the lists and the plan, and the hauls that went there still name it. */
export function closeFacility(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const before = await facilityWithin(tx, ctx, input.id);
    const [row] = await tx.update(schema.disposalFacility)
      .set({ active: false, isDefault: false, updatedAt: new Date() })
      .where(eq(schema.disposalFacility.id, before.id)).returning();
    await audit(tx, ctx, "disposal_facility.closed", "disposal_facility", before.id, before, row!);
    return { id: before.id, closed: true as const };
  });
}

/**
 * Whether a facility takes loads at an instant, in the company's own clock, and
 * the sentence when it does not. "Open" for a facility with no hours recorded,
 * which is unknown and never a reason to refuse.
 */
export function openAt(ctx: ServiceContext, input: { id: string; at: string }) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const facility = await facilityWithin(tx, ctx, input.id);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const instant = new Date(input.at);
    const date = time.dateIn(instant, zone);
    const why = rt.closedWords(facility.name, facility.hours, rt.weekdayOf(date), time.minutesInDay(instant, zone));
    return { id: facility.id, name: facility.name, at: instant.toISOString(), open: why === null, why, hoursKnown: facility.hours.length > 0 };
  });
}

/**
 * The facility a day is planned around: the one asked for, or the company's
 * default, or none. Closed facilities are never planned around.
 */
export async function facilityForPlan(tx: Database, organizationId: string, id: string | null): Promise<Row | null> {
  const [row] = await tx.select().from(schema.disposalFacility)
    .where(and(
      eq(schema.disposalFacility.organizationId, organizationId),
      eq(schema.disposalFacility.active, true),
      id ? eq(schema.disposalFacility.id, id) : eq(schema.disposalFacility.isDefault, true),
    )).limit(1);
  if (!row && id) throw new NotFoundError("Disposal facility");
  return row ?? null;
}

export interface FeeFigure {
  /** The disposal fee of one haul. */
  amount: string;
  /** `recorded` when somebody typed what the facility charged, `worked_out` when it comes from the ticket's weight and the facility's rate. */
  source: "recorded" | "worked_out";
  why: string;
  facility: string | null;
}

/**
 * WHAT THE FACILITY CHARGED FOR A HAUL, and where that figure came from.
 *
 * What was recorded on the haul wins, because it is what the facility billed.
 * Otherwise the weight on the scale ticket at the haul's facility's rate, which
 * is an estimate until the facility's invoice says otherwise and says so. Not
 * written to the haul: an estimate stored as the cost would read as fact in
 * every report afterwards.
 *
 * A haul with neither is not a fee of nothing: the answer says what is missing.
 */
export async function feeFigure(
  tx: Database, ctx: ServiceContext,
  hire: { disposalFee: string | null; disposalFacilityId: string | null; disposalFacility: string | null; weightTons: string | null },
): Promise<{ ok: true; figure: FeeFigure } | { ok: false; why: string }> {
  if (hire.disposalFee !== null) {
    return {
      ok: true,
      figure: { amount: hire.disposalFee, source: "recorded", why: "the fee recorded on the haul", facility: hire.disposalFacility },
    };
  }
  if (!hire.disposalFacilityId) {
    return { ok: false, why: "No fee is recorded on the haul and it names no recorded facility, so there is no rate to work one out from." };
  }
  const facility = await facilityWithin(tx, ctx, hire.disposalFacilityId);
  const verdict = rt.disposalFee(rateOf(facility), hire.weightTons);
  if (!verdict.ok) return { ok: false, why: verdict.why };
  return { ok: true, figure: { amount: verdict.fee, source: "worked_out", why: verdict.why, facility: facility.name } };
}

/** A facility is a pin on the map, the same pin a property has. */
export const pinFacility = (ctx: ServiceContext, input: { id: string; latitude: number; longitude: number }) =>
  placePin(ctx, { entity: "disposal_facility", ...input });
export const unpinFacility = (ctx: ServiceContext, input: { id: string }) =>
  clearPin(ctx, { entity: "disposal_facility", id: input.id });

export const handlers = {
  listDisposalFacilities: (ctx: ServiceContext, input: { includeClosed?: boolean | undefined }) => listFacilities(ctx, input),
  createDisposalFacility: (ctx: ServiceContext, input: FacilityInput) => createFacility(ctx, input),
  updateDisposalFacility: (ctx: ServiceContext, input: FacilityPatch) => updateFacility(ctx, input),
  closeDisposalFacility: (ctx: ServiceContext, input: { id: string }) => closeFacility(ctx, input),
  getDisposalFacilityOpen: (ctx: ServiceContext, input: { id: string; at: string }) => openAt(ctx, input),
  pinDisposalFacility: (ctx: ServiceContext, input: { id: string; latitude: number; longitude: number }) => pinFacility(ctx, input),
  unpinDisposalFacility: (ctx: ServiceContext, input: { id: string }) => unpinFacility(ctx, input),
} as const;
