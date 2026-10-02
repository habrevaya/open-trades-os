import { and, asc, eq, ne } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, money as m, time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";

/**
 * THE COMPANY'S OWN STRUCTURE, WHICH NOTHING COULD DESCRIBE
 *
 * Three tables shipped in the first migration, are read by seven services,
 * are referenced by twenty other tables between them, and had no writer
 * anywhere in the product. A company could not create a business unit, a
 * location or a territory, which means every feature built on top of one was
 * reachable only by a human writing SQL.
 *
 * THIS IS A SHARPER CLASS OF DEFECT THAN A MISSING FEATURE, because the
 * features that depend on these are not missing. They are built, tested and
 * shipped, and they cannot fire:
 *
 *   `services/crews.ts` refuses a crew with `different_business_unit`,
 *   comparing `crew.business_unit_id` against `job.business_unit_id`. Both
 *   are nullable, nothing could set either, so the comparison was between
 *   two nulls on every job in every company and the blocker had never once
 *   been raised. The code is correct and it was unreachable.
 *
 *   `services/properties.ts` resolves a property's territory from its postal
 *   code, which decides the travel fee and which route a stop belongs to.
 *   With no territory it resolves to nothing, so every property in every
 *   company was outside every territory.
 *
 *   `membership.location_id` and `membership.business_unit_id` scope a
 *   person to a branch. `services/roles.ts` reads both. Nobody could be
 *   scoped to anything, so a multi-branch company ran as one undivided pool
 *   while the schema said otherwise.
 *
 *   `location.is_warehouse` is what `services/inventory.ts` counts stock
 *   against, and `purchase_order.default_location_id` is NOT NULL with ON
 *   DELETE RESTRICT. A company could not raise a purchase order without a
 *   location, so purchasing was unreachable too.
 *
 * ONE FILE FOR THE THREE, which is a judgement worth stating. They are not
 * the same shape, but they are one question an operator asks once when they
 * set the company up, they are read together by the same screen, and
 * splitting them across three files would make the thing a reader is looking
 * for an exercise in grep. The alternative, folding them into `settings.ts`
 * alongside the single-row company record, would mix "the one row that is
 * this company" with "the many rows that are its parts".
 *
 * ON PERMISSIONS. `settings:read` and `settings:write`, both already in the
 * catalogue. Inventing a `businessunit:write` was not an option:
 * `packages/core/src/access/permissions.ts` is the whole of the
 * authorization model and a string that is not in it cannot be granted to
 * anybody. These are the company's own shape, which is what settings are.
 */

/* --------------------------------------------------------- business units */

export interface BusinessUnitInput {
  name: string;
  /**
   * The operator's own short code, which is what appears on a report and in
   * an accounting export rather than the name.
   */
  code?: string | null | undefined;
}

export interface BusinessUnitUpdate {
  id: string;
  name?: string | undefined;
  code?: string | null | undefined;
  active?: boolean | undefined;
}

export interface BusinessUnitView {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
}

const viewOfUnit = (row: typeof schema.businessUnit.$inferSelect): BusinessUnitView => ({
  id: row.id, name: row.name, code: row.code, active: row.active,
});

export async function listBusinessUnits(ctx: ServiceContext): Promise<BusinessUnitView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.businessUnit)
      .where(eq(schema.businessUnit.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.businessUnit.name));
    return rows.map(viewOfUnit);
  });
}

export async function createBusinessUnit(
  ctx: ServiceContext, input: BusinessUnitInput,
): Promise<BusinessUnitView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A business unit needs a name.");
    const code = input.code?.trim() || null;

    /**
     * The code is unique within the company when one is given.
     *
     * Checked here rather than by a database constraint, because the schema
     * has no unique index on it and adding one would be a migration that
     * fails on any company that already holds two. Two units sharing a code
     * means an accounting export that attributes revenue to whichever one
     * the join happened to pick.
     */
    if (code !== null) await assertCodeFree(tx, ctx.actor.organizationId, code, null);

    const [row] = await tx.insert(schema.businessUnit).values({
      organizationId: ctx.actor.organizationId, name, code,
    }).returning();

    await audit(tx, ctx, "business_unit.created", "business_unit", row!.id, null, row!);
    return viewOfUnit(row!);
  });
}

export async function updateBusinessUnit(
  ctx: ServiceContext, input: BusinessUnitUpdate,
): Promise<BusinessUnitView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await loadUnit(tx, ctx.actor.organizationId, input.id);

    const name = input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined && name === "") throw new ConflictError("A business unit needs a name.");

    const code = input.code === undefined ? undefined : (input.code?.trim() || null);
    if (code) await assertCodeFree(tx, ctx.actor.organizationId, code, input.id);

    /**
     * RETIRING A UNIT DOES NOT DETACH WHAT POINTS AT IT.
     *
     * Every foreign key onto `business_unit` is ON DELETE SET NULL, so a
     * delete would silently unscope twelve tables' worth of history: jobs,
     * invoices, ledger entries and phone numbers would all become
     * company-wide, and last year's revenue by branch would change. So this
     * only ever sets `active = false`, and the rows that reference it keep
     * doing so.
     */
    const [row] = await tx.update(schema.businessUnit).set({
      ...(name === undefined ? {} : { name }),
      ...(code === undefined ? {} : { code }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.businessUnit.organizationId, ctx.actor.organizationId),
      eq(schema.businessUnit.id, input.id),
    )).returning();

    await audit(tx, ctx, "business_unit.updated", "business_unit", input.id, before, row!);
    return viewOfUnit(row!);
  });
}

async function loadUnit(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.businessUnit)
    .where(and(
      eq(schema.businessUnit.organizationId, organizationId),
      eq(schema.businessUnit.id, id),
    ));
  if (!row) throw new NotFoundError("Business unit");
  return row;
}

async function assertCodeFree(
  tx: Database,
  organizationId: string, code: string, exceptId: string | null,
): Promise<void> {
  const clash = await tx.select({ id: schema.businessUnit.id }).from(schema.businessUnit)
    .where(and(
      eq(schema.businessUnit.organizationId, organizationId),
      eq(schema.businessUnit.code, code),
      exceptId === null ? undefined : ne(schema.businessUnit.id, exceptId),
    ));
  if (clash.length > 0) {
    throw new ConflictError(
      `Another business unit already uses the code "${code}". Two units with one code `
      + "means an export that attributes revenue to whichever one the join picked.",
    );
  }
}

/* -------------------------------------------------------------- locations */

export interface LocationInput {
  name: string;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | undefined;
  /**
   * The branch's own zone, which is NOT the company's.
   *
   * A company in Austin with a branch in Phoenix draws two different days in
   * March, and the dispatch board bounds its day in the zone it is given.
   * Null means "use the company's", which is what every existing caller
   * already falls back to.
   */
  timezone?: string | null | undefined;
  /** Whether stock is counted here. `services/inventory.ts` reads this. */
  isWarehouse?: boolean | undefined;
}

export interface LocationUpdate {
  id: string;
  name?: string | undefined;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | undefined;
  timezone?: string | null | undefined;
  isWarehouse?: boolean | undefined;
  active?: boolean | undefined;
}

export interface LocationView {
  id: string;
  name: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  timezone: string | null;
  isWarehouse: boolean;
  active: boolean;
}

const viewOfLocation = (row: typeof schema.location.$inferSelect): LocationView => ({
  id: row.id, name: row.name,
  addressLine1: row.addressLine1, city: row.city, state: row.state,
  postalCode: row.postalCode, country: row.country,
  timezone: row.timezone, isWarehouse: row.isWarehouse, active: row.active,
});

export async function listLocations(
  ctx: ServiceContext, input: { warehousesOnly?: boolean | undefined } = {},
): Promise<LocationView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.location)
      .where(and(
        eq(schema.location.organizationId, ctx.actor.organizationId),
        input.warehousesOnly ? eq(schema.location.isWarehouse, true) : undefined,
      ))
      .orderBy(asc(schema.location.name));
    return rows.map(viewOfLocation);
  });
}

export async function createLocation(
  ctx: ServiceContext, input: LocationInput,
): Promise<LocationView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A location needs a name.");
    assertZone(input.timezone);

    const [row] = await tx.insert(schema.location).values({
      organizationId: ctx.actor.organizationId,
      name,
      addressLine1: input.addressLine1?.trim() || null,
      addressLine2: input.addressLine2?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      postalCode: input.postalCode?.trim() || null,
      ...(input.country ? { country: input.country.trim().toUpperCase() } : {}),
      timezone: input.timezone?.trim() || null,
      isWarehouse: input.isWarehouse ?? false,
    }).returning();

    await audit(tx, ctx, "location.created", "location", row!.id, null, row!);
    return viewOfLocation(row!);
  });
}

export async function updateLocation(
  ctx: ServiceContext, input: LocationUpdate,
): Promise<LocationView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.location)
      .where(and(
        eq(schema.location.organizationId, ctx.actor.organizationId),
        eq(schema.location.id, input.id),
      ));
    if (!before) throw new NotFoundError("Location");
    if (input.timezone !== undefined) assertZone(input.timezone);

    /**
     * A WAREHOUSE WITH STOCK IN IT CANNOT STOP BEING A WAREHOUSE.
     *
     * `stock_level` is keyed on the location, and `services/inventory.ts`
     * only counts where `is_warehouse` is true. Turning the flag off on a
     * location holding parts does not move them, it hides them: the count
     * drops, the reorder report starts asking for things that are on the
     * shelf, and nothing anywhere says where they went.
     */
    if (input.isWarehouse === false && before.isWarehouse) {
      if (await holdsStock(tx, ctx.actor.organizationId, input.id)) {
        throw new ConflictError(
          `${before.name} still holds stock, so it cannot stop being a warehouse. `
          + "The parts would not move, they would stop being counted. Transfer or write "
          + "them off first.",
        );
      }
    }

    const [row] = await tx.update(schema.location).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1?.trim() || null }),
      ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2?.trim() || null }),
      ...(input.city === undefined ? {} : { city: input.city?.trim() || null }),
      ...(input.state === undefined ? {} : { state: input.state?.trim() || null }),
      ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode?.trim() || null }),
      ...(input.country === undefined ? {} : { country: input.country.trim().toUpperCase() }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone?.trim() || null }),
      ...(input.isWarehouse === undefined ? {} : { isWarehouse: input.isWarehouse }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.location.organizationId, ctx.actor.organizationId),
      eq(schema.location.id, input.id),
    )).returning();

    await audit(tx, ctx, "location.updated", "location", input.id, before, row!);
    return viewOfLocation(row!);
  });
}

/**
 * Is anything actually on the shelf here.
 *
 * FOLDED THROUGH `inv.deriveLevels`, NOT SUMMED IN SQL, and that is the
 * whole point of the function existing rather than being a `count(*)`.
 *
 * There is no stock level table. `schema/inventory.ts` says it out loud:
 * nothing writes a level, because there is no level to write. On hand is
 * derived from the append only `stock_movement` ledger, and the sign of a
 * movement is a property of its KIND rather than of its quantity, which is
 * how a receipt of minus three ends up in the history at all.
 *
 * A `sum(quantity)` here would be a second rule about which movements add
 * and which subtract, sitting in a different file from the first, and the two
 * would disagree the first time a movement kind was added. Reading the ledger
 * and handing it to the one function that knows costs a query on a path a
 * person walks once, when they untick a box on a settings form.
 *
 * Not clamped at zero either, for the reason core gives: a negative on hand
 * is evidence of a broken history, and a location showing minus two of
 * something is exactly a location whose warehouse flag should not be quietly
 * turned off.
 */
async function holdsStock(
  tx: Database, organizationId: string, locationId: string,
): Promise<boolean> {
  const rows = await tx.select().from(schema.stockMovement)
    .where(and(
      eq(schema.stockMovement.organizationId, organizationId),
      eq(schema.stockMovement.locationId, locationId),
    ))
    .orderBy(schema.stockMovement.occurredAt, schema.stockMovement.sequence);
  if (rows.length === 0) return false;

  const levels = inv.deriveLevels(rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    itemId: row.itemId,
    locationId: row.locationId,
    kind: row.kind,
    quantity: inv.quantity(row.quantity),
    ...(row.totalCost ? { totalCost: m.money(row.totalCost, "USD") } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.transferId ? { transferId: row.transferId } : {}),
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    ...(row.purchaseOrderLineId ? { purchaseOrderLineId: row.purchaseOrderLineId } : {}),
  })));

  return levels.some((level) => level.locationId === locationId && level.onHand !== 0n);
}

/**
 * A zone this platform can actually resolve, refused at the moment somebody
 * types it.
 *
 * `time.dayBoundsIn` and every day window in the product take an IANA name.
 * An unrecognised one does not throw there, it silently produces the wrong
 * day, so a board in "US/Pacfic" would draw a day nobody worked. Refused
 * here, in front of the person who typed it, rather than at six the next
 * morning in front of a dispatcher.
 */
function assertZone(zone: string | null | undefined): void {
  const value = zone?.trim();
  if (!value) return;
  if (!time.isZone(value)) {
    throw new ConflictError(
      `"${value}" is not a time zone this platform recognises. It needs an IANA name `
      + 'such as "America/Chicago".',
    );
  }
}

/* ------------------------------------------------------------ territories */

export interface TerritoryInput {
  name: string;
  /** The postal codes this territory covers. What `properties.ts` matches on. */
  postalCodes?: string[] | undefined;
  homeLocationId?: string | null | undefined;
  /** What it costs to send somebody here. A decimal string: never a float. */
  travelFee?: string | null | undefined;
  color?: string | null | undefined;
}

export interface TerritoryUpdate {
  id: string;
  name?: string | undefined;
  postalCodes?: string[] | undefined;
  homeLocationId?: string | null | undefined;
  travelFee?: string | null | undefined;
  color?: string | null | undefined;
  active?: boolean | undefined;
}

export interface TerritoryView {
  id: string;
  name: string;
  postalCodes: string[];
  homeLocationId: string | null;
  travelFee: string | null;
  color: string | null;
  active: boolean;
}

const viewOfTerritory = (row: typeof schema.territory.$inferSelect): TerritoryView => ({
  id: row.id, name: row.name, postalCodes: row.postalCodes,
  homeLocationId: row.homeLocationId, travelFee: row.travelFee,
  color: row.color, active: row.active,
});

export async function listTerritories(ctx: ServiceContext): Promise<TerritoryView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.territory)
      .where(eq(schema.territory.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.territory.name));
    return rows.map(viewOfTerritory);
  });
}

export async function createTerritory(
  ctx: ServiceContext, input: TerritoryInput,
): Promise<TerritoryView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A territory needs a name.");
    const codes = normalisePostalCodes(input.postalCodes ?? []);
    await assertNoCodeOverlap(tx, ctx.actor.organizationId, codes, null);

    const [row] = await tx.insert(schema.territory).values({
      organizationId: ctx.actor.organizationId,
      name,
      postalCodes: codes,
      homeLocationId: input.homeLocationId ?? null,
      travelFee: input.travelFee ?? null,
      color: input.color ?? null,
    }).returning();

    await audit(tx, ctx, "territory.created", "territory", row!.id, null, row!);
    return viewOfTerritory(row!);
  });
}

export async function updateTerritory(
  ctx: ServiceContext, input: TerritoryUpdate,
): Promise<TerritoryView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.territory)
      .where(and(
        eq(schema.territory.organizationId, ctx.actor.organizationId),
        eq(schema.territory.id, input.id),
      ));
    if (!before) throw new NotFoundError("Territory");

    /**
     * A rename to nothing is refused, the same as a creation with no name.
     *
     * `createTerritory` has always refused an empty name and this did not, so a
     * territory could be renamed to the empty string and then be a row in the
     * settings list with a blank cell where its name goes, matched against by
     * postal code and nameable by nobody. The asymmetry was invisible for as
     * long as the only caller was an API nobody pointed a form at.
     */
    if (input.name !== undefined && input.name.trim() === "") {
      throw new ConflictError("A territory needs a name.");
    }

    const codes = input.postalCodes === undefined
      ? undefined
      : normalisePostalCodes(input.postalCodes);
    if (codes !== undefined) {
      await assertNoCodeOverlap(tx, ctx.actor.organizationId, codes, input.id);
    }

    const [row] = await tx.update(schema.territory).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(codes === undefined ? {} : { postalCodes: codes }),
      ...(input.homeLocationId === undefined ? {} : { homeLocationId: input.homeLocationId }),
      ...(input.travelFee === undefined ? {} : { travelFee: input.travelFee }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.territory.organizationId, ctx.actor.organizationId),
      eq(schema.territory.id, input.id),
    )).returning();

    await audit(tx, ctx, "territory.updated", "territory", input.id, before, row!);
    return viewOfTerritory(row!);
  });
}

/**
 * Upper case, trimmed, deduplicated, and in the order they were given.
 *
 * A postal code is matched as a string against a property's own, and
 * "78701 " never equals "78701". Case matters for the countries whose codes
 * carry letters: a Canadian property stored "K1A 0B1" would not match a
 * territory holding "k1a 0b1", and the symptom is one neighbourhood having
 * no travel fee for no visible reason.
 */
function normalisePostalCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (code === "" || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * ONE POSTAL CODE BELONGS TO AT MOST ONE TERRITORY.
 *
 * `services/properties.ts` resolves a territory by finding the one whose
 * `postal_codes` contains the property's. With two matches it takes whichever
 * row the database returned first, which is not deterministic across a
 * vacuum, so the same property can change territory, travel fee and route
 * between two reads with nothing changing in the data.
 *
 * Refused at the moment somebody draws the overlap, which is the only moment
 * anybody can see both territories at once.
 */
async function assertNoCodeOverlap(
  tx: Database,
  organizationId: string, codes: string[], exceptId: string | null,
): Promise<void> {
  if (codes.length === 0) return;
  const others = await tx.select({
    id: schema.territory.id,
    name: schema.territory.name,
    postalCodes: schema.territory.postalCodes,
  }).from(schema.territory)
    .where(and(
      eq(schema.territory.organizationId, organizationId),
      /**
       * Active territories only, and NOT `isNull(deletedAt)`.
       *
       * The first version of this filtered on both. Nothing in this product
       * soft deletes a territory: retiring one sets `active = false`, for the
       * reason the business unit comment gives, because every foreign key
       * onto it is ON DELETE SET NULL and a delete would silently unscope the
       * jobs and routes that reference it.
       *
       * So the `deleted_at` half could never be the thing that decided, which
       * makes it a filter that reads as protection and is not. This codebase
       * has removed three of those already, and a test counts the tables in
       * that state so the number cannot quietly grow.
       */
      eq(schema.territory.active, true),
      exceptId === null ? undefined : ne(schema.territory.id, exceptId),
    ));

  const taken = new Map<string, string>();
  for (const other of others) {
    for (const code of other.postalCodes) taken.set(code, other.name);
  }
  const clashes = codes.filter((code) => taken.has(code));
  if (clashes.length > 0) {
    const first = clashes[0]!;
    throw new ConflictError(
      `${first} is already in "${taken.get(first)}"`
      + (clashes.length > 1 ? `, along with ${clashes.length - 1} more of these codes` : "")
      + ". A postal code in two territories means a property whose travel fee and route "
      + "change between two reads, with nothing in the data changing.",
    );
  }
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listBusinessUnits: async (ctx: ServiceContext): Promise<{ units: BusinessUnitView[] }> =>
    ({ units: await listBusinessUnits(ctx) }),
  createBusinessUnit: (ctx: ServiceContext, input: BusinessUnitInput): Promise<BusinessUnitView> =>
    createBusinessUnit(ctx, input),
  updateBusinessUnit: (ctx: ServiceContext, input: BusinessUnitUpdate): Promise<BusinessUnitView> =>
    updateBusinessUnit(ctx, input),

  listLocations: async (
    ctx: ServiceContext, input: { warehousesOnly?: boolean | undefined },
  ): Promise<{ locations: LocationView[] }> => ({ locations: await listLocations(ctx, input) }),
  createLocation: (ctx: ServiceContext, input: LocationInput): Promise<LocationView> =>
    createLocation(ctx, input),
  updateLocation: (ctx: ServiceContext, input: LocationUpdate): Promise<LocationView> =>
    updateLocation(ctx, input),

  listTerritories: async (ctx: ServiceContext): Promise<{ territories: TerritoryView[] }> =>
    ({ territories: await listTerritories(ctx) }),
  createTerritory: (ctx: ServiceContext, input: TerritoryInput): Promise<TerritoryView> =>
    createTerritory(ctx, input),
  updateTerritory: (ctx: ServiceContext, input: TerritoryUpdate): Promise<TerritoryView> =>
    updateTerritory(ctx, input),
} as const;
