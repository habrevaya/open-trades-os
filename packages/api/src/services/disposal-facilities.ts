import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
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
 * HOLIDAYS ARE A LIST ON THE FACILITY. One shut for Thanksgiving is shut on
 * that Thursday whatever its week says, for the planner, for "is it open" and
 * for the day's choice among facilities. The list is the company's own: no
 * calendar of public holidays is assumed, because a transfer station keeps its
 * own.
 *
 * WHAT IT TAKES IS A LIST ON THE FACILITY, each material with its own rate
 * when it has one. A facility that lists what it takes is not sent a can of
 * anything else, and the planner weighs each one's fee for the load beside the
 * drive. An empty list is not recorded, which never turns a load away.
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
  holidays?: rt.FacilityHoliday[] | undefined;
  feeBasis?: rt.FeeBasis | null | undefined;
  feeAmount?: string | null | undefined;
  minimumFee?: string | null | undefined;
  /** What it takes, each with its own rate or none. Empty is not recorded. */
  materials?: rt.FacilityMaterial[] | undefined;
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
  /** Days it is shut whatever its week says. */
  holidays: rt.FacilityHoliday[];
  feeBasis: rt.FeeBasis | null;
  feeAmount: string | null;
  minimumFee: string | null;
  /** The rate in words, for a screen: "62.50 a ton, at least 40.00". */
  feeText: string;
  /** What it takes, each with its own rate or none. Empty when nobody recorded it. */
  materials: rt.FacilityMaterial[];
  /** The same in words: "Takes Yard waste, 38.00 a ton; Concrete, 120.00 a load", or that it is not recorded. */
  materialsText: string;
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
  hours: row.hours, hoursText: rt.hoursWords(row.hours), holidays: row.holidays,
  feeBasis: row.feeBasis, feeAmount: row.feeAmount, minimumFee: row.minimumFee,
  feeText: feeText(row),
  materials: row.materials,
  materialsText: row.materials.length === 0
    ? "What it takes is not recorded"
    : `Takes ${row.materials.map(rt.materialLine).join("; ")}`,
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

  const closures = rt.checkHolidays(input.holidays !== undefined ? input.holidays : before?.holidays ?? []);
  if (!closures.ok) throw new ConflictError(closures.message);

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
  const listed = rt.checkMaterials(input.materials !== undefined ? input.materials : before?.materials ?? []);
  if (!listed.ok) throw new ConflictError(listed.message);
  const tip = input.tipMinutes ?? before?.tipMinutes ?? 20;
  if (!Number.isInteger(tip) || tip < 0 || tip > 180) {
    throw new ConflictError("Time at the facility is between none and three hours.");
  }
  const text = (value: string | null | undefined, kept: string | null | undefined) =>
    value === undefined ? kept ?? null : value?.trim() || null;
  return {
    name, hours: verdict.hours, holidays: closures.holidays, feeBasis: basis, feeAmount: amount === null ? null : m.toString(m.money(amount)),
    minimumFee: minimum === null ? null : m.toString(m.money(minimum)), tipMinutes: tip, materials: listed.materials,
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
    const why = rt.closedOnWords(facility.name, facility.hours, facility.holidays, date, time.minutesInDay(instant, zone));
    return {
      id: facility.id, name: facility.name, at: instant.toISOString(), open: why === null, why,
      hoursKnown: facility.hours.length > 0 || rt.holidayOn(facility.holidays, date) !== null,
    };
  });
}

/**
 * The facilities a day is planned among: the one asked for alone, or every
 * active facility the company has, nearest open one chosen for each haul by the
 * planner. The company's default breaks a tie on drive time and is the one the
 * answer names when the day cannot tell them apart. Closed facilities are never
 * planned around. Asking for one that does not exist is a refusal.
 */
export async function facilitiesForPlan(tx: Database, organizationId: string, id: string | null): Promise<Row[]> {
  const rows = await tx.select().from(schema.disposalFacility)
    .where(and(
      eq(schema.disposalFacility.organizationId, organizationId),
      eq(schema.disposalFacility.active, true),
      ...(id ? [eq(schema.disposalFacility.id, id)] : []),
    ))
    .orderBy(asc(schema.disposalFacility.name));
  if (id && rows.length === 0) throw new NotFoundError("Disposal facility");
  return rows;
}

export interface FeeFigure {
  /** The disposal fee of one haul. */
  amount: string;
  /** `recorded` when somebody typed what the facility charged, `worked_out` when it comes from the ticket's weight and the facility's rate. */
  source: "recorded" | "worked_out";
  why: string;
  facility: string | null;
  /** The recorded facility the haul names, for a markup set for it. Null when the haul names one only in words, or none. */
  facilityId: string | null;
  /** The haul's material as written, for a markup set for it. */
  material: string | null;
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
  hire: {
    disposalFee: string | null; disposalFacilityId: string | null; disposalFacility: string | null; weightTons: string | null;
    materialType?: string | null | undefined; cameBackEmptyAt?: Date | null | undefined;
  },
): Promise<{ ok: true; figure: FeeFigure } | { ok: false; why: string }> {
  if (hire.disposalFee === null && hire.cameBackEmptyAt) {
    return { ok: false, why: "The can came back empty, so nothing was tipped and there is no disposal fee. Leave it off." };
  }
  if (hire.disposalFee !== null) {
    return {
      ok: true,
      figure: {
        amount: hire.disposalFee, source: "recorded", why: "the fee recorded on the haul", facility: hire.disposalFacility,
        facilityId: hire.disposalFacilityId, material: hire.materialType ?? null,
      },
    };
  }
  if (!hire.disposalFacilityId) {
    return { ok: false, why: "No fee is recorded on the haul and it names no recorded facility, so there is no rate to work one out from." };
  }
  const facility = await facilityWithin(tx, ctx, hire.disposalFacilityId);
  /** A material the facility prices on its own is charged at that rate, as the facility's invoice will be. */
  const verdict = rt.disposalFee(rt.rateForMaterial(facility.materials, rateOf(facility), hire.materialType ?? null), hire.weightTons);
  if (!verdict.ok) return { ok: false, why: verdict.why };
  return {
    ok: true,
    figure: {
      amount: verdict.fee, source: "worked_out", why: verdict.why, facility: facility.name,
      facilityId: hire.disposalFacilityId, material: hire.materialType ?? null,
    },
  };
}

/* ------------------------------------- what the customer is charged for a fee */

/**
 * HOW THE COMPANY PASSES A FACILITY'S FEE ON, a company setting kept with the
 * others on `organization.settings` (`disposalBilling`).
 *
 * `markup` is a fraction of the fee added on top ("0.15" for 15%), null for
 * none, which is the default: a fee passed on at cost is what a customer who
 * agreed to pay "the dump fee" expects, and charging more is a decision the
 * company makes, not one made for it. `addWithoutAsking` puts the fee on the
 * hire's invoice when it is raised without the office pressing a button for
 * it, off by default; the hire still records that it was passed on and by
 * whose invoice. Either way the line says what it is.
 */
export interface DisposalBillingSettings {
  markup: string | null;
  addWithoutAsking: boolean;
  /**
   * A markup of one facility's own, by the facility's id, and of one
   * material's own, by its key (`rental.materialKey`) with the name as it was
   * typed. Either may be "0", which passes that fee on at cost. Read before
   * the company's markup (`rental.disposalMarkupFor`); empty by default.
   */
  facilityMarkups: Record<string, string>;
  materialMarkups: Record<string, { material: string; markup: string }>;
}

const sane = (value: unknown): value is string => typeof value === "string" && rt.disposalMarkupProblem(value) === null;

export async function disposalBillingOf(tx: Database, organizationId: string): Promise<DisposalBillingSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const held = ((row?.settings ?? {}) as Record<string, unknown>)["disposalBilling"] as Partial<DisposalBillingSettings> | undefined;
  const markup = sane(held?.markup) && Number(held.markup) > 0 ? held.markup : null;
  /** Anything hand edited into nonsense is left out, which falls back to the company's markup. */
  const facilityMarkups = Object.fromEntries(Object.entries(held?.facilityMarkups ?? {}).filter(([, v]) => sane(v)));
  const materialMarkups = Object.fromEntries(Object.entries(held?.materialMarkups ?? {})
    .filter(([, v]) => v && typeof v.material === "string" && sane(v.markup)));
  return { markup, addWithoutAsking: held?.addWithoutAsking === true, facilityMarkups, materialMarkups };
}

/** The company's markup and whether the fee is added without asking, as `GET /v1/disposal-billing` answers. */
export interface DisposalBillingView {
  markup: string | null;
  addWithoutAsking: boolean;
}

/** The markups of one facility's or one material's own, as `GET /v1/disposal-billing/markups` answers. */
export interface DisposalMarkupsView {
  facilityMarkups: { facilityId: string; facilityName: string; markup: string }[];
  materialMarkups: { material: string; markup: string }[];
}

/** The markups with each facility named, facilities and materials in alphabetical order. */
async function markupsOf(tx: Database, organizationId: string, settings: DisposalBillingSettings): Promise<DisposalMarkupsView> {
  const ids = Object.keys(settings.facilityMarkups);
  const names = ids.length === 0 ? [] : await tx.select({ id: schema.disposalFacility.id, name: schema.disposalFacility.name })
    .from(schema.disposalFacility)
    .where(and(eq(schema.disposalFacility.organizationId, organizationId), inArray(schema.disposalFacility.id, ids)));
  return {
    facilityMarkups: names.map((n) => ({ facilityId: n.id, facilityName: n.name, markup: settings.facilityMarkups[n.id]! }))
      .sort((a, b) => a.facilityName.localeCompare(b.facilityName)),
    materialMarkups: Object.values(settings.materialMarkups).sort((a, b) => a.material.localeCompare(b.material)),
  };
}

export function disposalBilling(ctx: ServiceContext): Promise<DisposalBillingView> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const settings = await disposalBillingOf(tx, ctx.actor.organizationId);
    return { markup: settings.markup, addWithoutAsking: settings.addWithoutAsking };
  });
}

/** Every facility's and material's own markup. Read like the company's, under `asset:read`. */
export function disposalMarkups(ctx: ServiceContext): Promise<DisposalMarkupsView> {
  return guardedRead(ctx, "asset:read", async (tx) => markupsOf(tx, ctx.actor.organizationId, await disposalBillingOf(tx, ctx.actor.organizationId)));
}

/**
 * Set the markup and whether the fee is added without asking. A company
 * setting, so `settings:write`, with the before and after on the audit line.
 * Left out keeps what it was; a markup of null or nothing turns it off.
 */
export function setDisposalBilling(
  ctx: ServiceContext, input: { markup?: string | null | undefined; addWithoutAsking?: boolean | undefined },
): Promise<DisposalBillingView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await disposalBillingOf(tx, ctx.actor.organizationId);
    const typed = input.markup === undefined ? before.markup : input.markup;
    const problem = rt.disposalMarkupProblem(typed);
    if (problem) throw new ConflictError(problem);
    const after: DisposalBillingSettings = {
      ...before,
      markup: typed !== null && Number(typed) > 0 ? String(Number(typed)) : null,
      addWithoutAsking: input.addWithoutAsking ?? before.addWithoutAsking,
    };
    await save(tx, ctx, before, after);
    return { markup: after.markup, addWithoutAsking: after.addWithoutAsking };
  });
}

async function save(tx: Database, ctx: ServiceContext, before: DisposalBillingSettings, after: DisposalBillingSettings): Promise<void> {
  await tx.update(schema.organization).set({
    settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ disposalBilling: after })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(schema.organization.id, ctx.actor.organizationId));
  await audit(tx, ctx, "rental.disposal_billing_set", "organization", ctx.actor.organizationId, before, after);
}

/**
 * A MARKUP FOR ONE FACILITY OR ONE MATERIAL, or taken off with `markup: null`.
 * Exactly one of `facilityId` (a facility of this company's, open or closed)
 * and `material` (as it is written on a haul; case and spacing ignored, as
 * everywhere materials are matched). "0" is allowed and passes that fee on at
 * cost. A company setting, so `settings:write`, with the before and after on
 * the audit line; the same markup sent again changes nothing. Applies to
 * invoices raised from then on: a hire already invoiced keeps what it was
 * charged.
 */
export function setDisposalMarkup(
  ctx: ServiceContext, input: { facilityId?: string | undefined; material?: string | undefined; markup: string | null },
): Promise<DisposalMarkupsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const material = input.material?.trim().replace(/\s+/g, " ") || undefined;
    if (!!input.facilityId === !!material) {
      throw new ConflictError("Say which facility or which material the markup is for: one of them, not both.");
    }
    const problem = rt.disposalMarkupProblem(input.markup);
    if (problem) throw new ConflictError(problem);
    const before = await disposalBillingOf(tx, ctx.actor.organizationId);
    const after: DisposalBillingSettings = {
      ...before, facilityMarkups: { ...before.facilityMarkups }, materialMarkups: { ...before.materialMarkups },
    };
    const markup = input.markup === null ? null : String(Number(input.markup));
    if (input.facilityId) {
      const [facility] = await tx.select({ id: schema.disposalFacility.id }).from(schema.disposalFacility)
        .where(and(eq(schema.disposalFacility.id, input.facilityId), eq(schema.disposalFacility.organizationId, ctx.actor.organizationId)))
        .limit(1);
      if (!facility) throw new NotFoundError("Disposal facility");
      if (markup === null) delete after.facilityMarkups[facility.id];
      else after.facilityMarkups[facility.id] = markup;
    } else {
      const key = rt.materialKey(material!);
      if (markup === null) delete after.materialMarkups[key];
      /** The same markup for the same material written another way keeps the name it was first given. */
      else if (before.materialMarkups[key]?.markup !== markup) after.materialMarkups[key] = { material: material!, markup };
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) await save(tx, ctx, before, after);
    return markupsOf(tx, ctx.actor.organizationId, after);
  });
}

/**
 * A haul's fee as the customer would be charged it: the figure, marked up by
 * its facility's or its material's own markup, else the company's
 * (`rental.disposalMarkupFor`), and the words for the line, which say whose
 * markup it was when it was not the company's.
 */
export function chargedFee(figure: FeeFigure, settings: DisposalBillingSettings) {
  const chosen = rt.disposalMarkupFor({
    company: settings.markup,
    facility: figure.facilityId ? settings.facilityMarkups[figure.facilityId] ?? null : null,
    material: figure.material ? settings.materialMarkups[rt.materialKey(figure.material)]?.markup ?? null : null,
  });
  const markup = chosen.markup !== null && Number(chosen.markup) > 0 ? chosen.markup : null;
  const passed = rt.passedOnFee({ cost: figure.amount, markup });
  const whose = chosen.from === "facility" ? ` set for ${figure.facility ?? "this facility"}`
    : chosen.from === "material" ? ` set for ${settings.materialMarkups[rt.materialKey(figure.material!)]?.material ?? figure.material}`
      : "";
  const words = whose === "" ? passed.words : markup === null ? `at cost, as${whose}` : `${passed.words}${whose}`;
  return {
    cost: m.toString(m.money(figure.amount)), amount: passed.amount, markup,
    markupFrom: chosen.from, words,
  };
}

/**
 * A facility as the day's planner weighs it: the materials it takes, as keys,
 * and what it would charge for the full cans on a truck, in cents, or null
 * when that cannot be worked out (no rate for one of them, or a can charged by
 * the ton with no expected weight).
 */
export function planTerms(row: Pick<Row, "materials" | "feeBasis" | "feeAmount" | "minimumFee">) {
  const general = rateOf(row);
  return {
    takes: row.materials.map((entry) => rt.materialKey(entry.material)),
    fee: (cargo: readonly { material: string | null; tons: string | null }[]) => {
      const verdict = rt.feeForLoads(row.materials, general, cargo);
      return verdict.ok ? verdict.cents : null;
    },
  };
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
  getDisposalBilling: (ctx: ServiceContext) => disposalBilling(ctx),
  setDisposalBilling: (ctx: ServiceContext, input: { markup?: string | null | undefined; addWithoutAsking?: boolean | undefined }) =>
    setDisposalBilling(ctx, input),
  listDisposalMarkups: (ctx: ServiceContext) => disposalMarkups(ctx),
  setDisposalMarkup: (ctx: ServiceContext, input: { facilityId?: string | undefined; material?: string | undefined; markup: string | null }) =>
    setDisposalMarkup(ctx, input),
} as const;
