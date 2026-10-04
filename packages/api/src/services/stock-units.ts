import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, inventory as inv, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { inForceAt } from "./pricebook";
import * as once from "./once";
import {
  history, itemLabel, nextSequence, placeLabel, relieveLateFreight, trackingOf, transfer, writeMovements, type UnitInput,
} from "./inventory";

/**
 * SERIALS, LOTS AND TRUCK STOCK: THE READS AND THE SETTINGS
 *
 * The movements themselves (receiving, moving and using a tracked unit) go
 * through `inventory.ts` like every other movement, because a second way to
 * move stock is the one that forgets a check. This file is what surrounds
 * them: saying an item is tracked, finding a serial and tracing it to the
 * customer it went to, writing off a unit that has gone, and what each truck
 * should carry.
 *
 * Reading is `inventory:read`. Deciding how an item is tracked, writing off a
 * unit and setting a truck's minimums are `inventory:adjust`: all three are
 * statements about what is physically on the shelf, not about what to spend.
 */

/* ---------------------------------------------------------- the locations */

/**
 * Where stock can be, for a screen that moves it. Its own read under
 * `inventory:read`, because the company's location list is a settings read
 * and a technician who may see what is on their van may not see settings.
 */
export function stockLocations(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const rows = await tx.select({
      id: schema.location.id, name: schema.location.name, isWarehouse: schema.location.isWarehouse,
    }).from(schema.location)
      .where(and(eq(schema.location.organizationId, ctx.actor.organizationId), eq(schema.location.active, true)))
      .orderBy(asc(schema.location.name));
    return rows;
  });
}

/**
 * The parts a screen can move: active materials and equipment, with how each
 * is tracked, so a form knows to ask for serial numbers. Services, labour and
 * fees are never on a shelf.
 */
export function stockItems(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const rows = await tx.select({ id: schema.priceBookItem.id, code: schema.priceBookItem.code, mode: schema.stockTracking.mode })
      .from(schema.priceBookItem)
      .leftJoin(schema.stockTracking, eq(schema.stockTracking.itemId, schema.priceBookItem.id))
      .where(and(
        eq(schema.priceBookItem.active, true),
        isNull(schema.priceBookItem.deletedAt),
        inArray(schema.priceBookItem.kind, ["material", "equipment"]),
      ));
    const names = await namesFor(tx, rows.map((r) => r.id));
    return rows.map((r) => ({ id: r.id, code: r.code, name: names.get(r.id) ?? r.code, tracking: r.mode }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * A job by the number people say out loud. A technician knows "job 1042",
 * never its id.
 */
export function jobByNumber(ctx: ServiceContext, input: { number: number }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [row] = await tx.select({ id: schema.job.id, number: schema.job.number, summary: schema.job.summary })
      .from(schema.job)
      .where(and(eq(schema.job.number, input.number), isNull(schema.job.deletedAt))).limit(1);
    if (!row) throw new NotFoundError(`Job ${input.number}`);
    return row;
  });
}

/* ------------------------------------------------------- tracking an item */

/**
 * Track an item by serial or lot, or stop tracking it (`mode: null`).
 *
 * UNITS ALREADY ON HAND STAY WHERE THEY ARE, WITHOUT NUMBERS, until
 * somebody reads their labels: `numberUnits` below gives them their numbers
 * as a count by number for a location. Until then they cannot be moved,
 * because every move of a tracked item has to say which units, and the
 * answer says how many at each place are waiting for numbers. Turning it
 * off is always allowed: the numbers stay on the movements that carried
 * them, as history.
 */
export function setTracking(ctx: ServiceContext, input: { itemId: string; mode: inv.TrackingMode | null }) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const [item] = await tx.select({ id: schema.priceBookItem.id, code: schema.priceBookItem.code })
      .from(schema.priceBookItem).where(eq(schema.priceBookItem.id, input.itemId)).limit(1);
    if (!item) throw new NotFoundError("Item");
    const current = await trackingOf(tx, input.itemId);
    const answer = async () => ({
      itemId: input.itemId, mode: input.mode, unnumbered: input.mode ? await unnumberedWithin(tx, input.itemId) : [],
    });
    if (current === input.mode) return answer();

    if (input.mode === null) {
      await tx.delete(schema.stockTracking).where(eq(schema.stockTracking.itemId, input.itemId));
    } else if (current) {
      /**
       * Serial to lot or back is refused while numbered units are on hand: a
       * serial is one unit and a lot is a batch, so every number already on
       * the shelf would mean something else the moment it changed.
       */
      const numbered = inv.deriveUnitLevels(await history(tx, input.itemId)).some((u) => u.onHand > inv.ZERO_QUANTITY);
      if (numbered) {
        throw new ConflictError(
          `${item.code} has units on hand with ${current === "serial" ? "serial numbers" : "lot numbers"}. `
          + "Change how it is tracked when none are left, or stop tracking it first.",
        );
      }
      await tx.update(schema.stockTracking).set({ mode: input.mode, setByUserId: ctx.actor.userId, updatedAt: new Date() })
        .where(eq(schema.stockTracking.itemId, input.itemId));
    } else {
      await tx.insert(schema.stockTracking).values({
        organizationId: ctx.actor.organizationId, itemId: input.itemId, mode: input.mode, setByUserId: ctx.actor.userId,
      });
    }
    await audit(tx, ctx, "stock_tracking.set", "price_book_item", input.itemId, { mode: current }, { mode: input.mode });
    return answer();
  });
}

/** How many of a tracked item at each place have no numbers yet. */
async function unnumberedWithin(tx: Database, itemId: string): Promise<{ locationId: string; locationName: string; quantity: string }[]> {
  const movements = await history(tx, itemId);
  const loose = inv.unnumberedByLocation(inv.deriveLevels(movements), inv.deriveUnitLevels(movements));
  const out = [];
  for (const row of loose) {
    out.push({ locationId: row.locationId, locationName: await placeLabel(tx, row.locationId), quantity: inv.quantityLabel(row.quantity) });
  }
  return out;
}

/* ------------------------------------------- numbers for what is on hand */

export interface NumberingResult {
  /** Numbers given to units that had none. */
  numbered: string[];
  /** Numbers already on this shelf, counted again. Nothing changed for them. */
  alreadyHere: string[];
  /** Units at this place still without a number. */
  stillUnnumbered: string;
}

/**
 * GIVE NUMBERS TO UNITS ALREADY ON HAND, as a count by number for one
 * location: somebody walks the shelf reading every label, and each new
 * number takes one of the unnumbered units there (or, for a lot, the
 * quantity said). Nothing moves and nothing is bought, so the item's level
 * and its value do not change; the numbered units can now be moved, used
 * and traced like any received by number.
 *
 * REFUSED DUPLICATES. A number already in stock somewhere else, already used
 * on a job or gone is refused by name with where it is, because the same
 * number twice is a misread label or a second unit, and either way a person
 * has to look. A number read twice in one count is refused. More new numbers
 * than unnumbered units is refused, because the extra units were never
 * received and stock cannot appear without a cost. Fewer is allowed and
 * said: a label that cannot be read today is still a unit on the shelf.
 */
export function numberUnits(ctx: ServiceContext, input: {
  itemId: string; locationId: string; units: readonly UnitInput[];
}): Promise<NumberingResult> {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await once.replayed<NumberingResult>(tx, ctx, "inventory.numbered");
    if (seen) return seen;

    const label = await itemLabel(tx, input.itemId);
    const mode = await trackingOf(tx, input.itemId);
    if (!mode) {
      throw new ConflictError(`${label} is not tracked by serial or lot. Choose how to track it first, then give the units on hand their numbers.`);
    }
    if (input.units.length === 0) throw new ConflictError("Read at least one number off the shelf.");
    const [place] = await tx.select({ id: schema.location.id, name: schema.location.name }).from(schema.location)
      .where(eq(schema.location.id, input.locationId)).limit(1);
    if (!place) throw new NotFoundError("Location");

    const movements = await history(tx, input.itemId);
    const level = inv.deriveLevel(movements, input.itemId, input.locationId);
    const unitLevels = inv.deriveUnitLevels(movements);
    const loose = inv.unnumberedByLocation([level], unitLevels)[0]?.quantity ?? inv.ZERO_QUANTITY;

    const picks: inv.UnitPick[] = [];
    const numbers = new Map<string, string>();
    for (const unit of input.units) {
      const number = unit.number.trim();
      if (number === "") throw new ConflictError("A serial or lot number cannot be blank.");
      const [found] = await tx.select().from(schema.stockLot)
        .where(and(eq(schema.stockLot.itemId, input.itemId), sql`lower(${schema.stockLot.number}) = lower(${number})`))
        .limit(1);
      let lotId = found?.id;
      if (found && mode === "serial") {
        const state = inv.serialState(movements, found.id);
        if (state.state === "in_stock" && state.locationId !== input.locationId) {
          throw new ConflictError(`Serial ${found.number} of ${label} is already in stock at ${await placeLabel(tx, state.locationId)}. The same number twice is a misread label or a second unit: look at both.`);
        }
        if (state.state === "used") {
          throw new ConflictError(`Serial ${found.number} of ${label} was used on a job. If it came back, take it back off the job by its number instead.`);
        }
        if (state.state === "gone") {
          throw new ConflictError(`Serial ${found.number} of ${label} was written off or sent back to the vendor. If it is on the shelf again, receive it with its cost.`);
        }
      }
      if (!lotId) {
        const [row] = await tx.insert(schema.stockLot).values({
          organizationId: ctx.actor.organizationId, itemId: input.itemId, mode, number,
          expiresOn: mode === "lot" ? unit.expiresOn ?? null : null,
        }).returning({ id: schema.stockLot.id });
        lotId = row!.id;
      }
      numbers.set(lotId, found?.number ?? number);
      const quantity = unit.quantity?.trim()
        ? inv.quantity(unit.quantity)
        : mode === "serial" ? inv.quantity("1") : input.units.length === 1 ? loose : null;
      if (quantity === null) throw new ConflictError(`Say how much of lot ${number} is on the shelf. With more than one lot, each needs its own quantity.`);
      picks.push({ lotId, quantity });
    }

    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();
    const decision = inv.planNumbering({
      mode, itemLabel: label, locationLabel: place.name, level, unitLevels, picks, numbers,
      stamps: picks.map((_, i) => ({ id: crypto.randomUUID(), sequence: sequence + i, occurredAt })),
    });
    if (!decision.ok) throw new ConflictError(inv.explainUnitRefusal(decision));

    await writeMovements(tx, ctx, decision.movements);
    const answer: NumberingResult = {
      numbered: decision.movements.map((mv) => numbers.get(mv.lotId!) ?? ""),
      alreadyHere: decision.alreadyHere,
      stillUnnumbered: inv.quantityLabel(decision.stillUnnumbered),
    };
    await audit(tx, ctx, "inventory.numbered", "price_book_item", input.itemId, null, {
      locationId: input.locationId, ...answer,
    });
    await once.remember(tx, ctx, "inventory.numbered", decision.movements[0]?.id ?? null, answer);
    return answer;
  });
}

export interface TrackedItemView { itemId: string; itemCode: string; itemName: string; mode: inv.TrackingMode }

export function trackedItems(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx): Promise<TrackedItemView[]> => {
    const rows = await tx.select({
      itemId: schema.stockTracking.itemId, mode: schema.stockTracking.mode, code: schema.priceBookItem.code,
    }).from(schema.stockTracking)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.stockTracking.itemId));
    const names = await namesFor(tx, rows.map((r) => r.itemId));
    return rows.map((r) => ({ itemId: r.itemId, itemCode: r.code, itemName: names.get(r.itemId) ?? r.code, mode: r.mode }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName));
  });
}

async function namesFor(tx: Database, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
    .from(schema.priceBookItemVersion)
    .where(and(inArray(schema.priceBookItemVersion.itemId, [...new Set(itemIds)]), inForceAt()));
  return new Map(rows.map((r) => [r.itemId, r.name]));
}

/* ------------------------------------------------------ finding a serial */

export interface UnitView {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  mode: inv.TrackingMode;
  number: string;
  expiresOn: string | null;
  /** In stock, used on a job, or gone (written off or returned). */
  state: "in_stock" | "used" | "gone";
  /** Where it is, with how much, for anything still on a shelf or a truck. */
  where: { locationId: string; locationName: string; quantity: string }[];
  jobId: string | null;
  jobNumber: number | null;
  equipmentId: string | null;
}

/**
 * Serials and lots, filtered by item, by where they are, or by number (a
 * number matches anywhere in it, because a label read off a dark basement
 * unit is often half a number).
 */
export function units(ctx: ServiceContext, input: {
  itemId?: string | undefined; locationId?: string | undefined; number?: string | undefined;
  inStockOnly?: boolean | undefined; limit?: number | undefined;
}) {
  return guardedRead(ctx, "inventory:read", async (tx): Promise<UnitView[]> => {
    const needle = input.number?.trim();
    const lots = await tx.select({ lot: schema.stockLot, code: schema.priceBookItem.code })
      .from(schema.stockLot)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.stockLot.itemId))
      .where(and(
        input.itemId ? eq(schema.stockLot.itemId, input.itemId) : undefined,
        needle ? sql`lower(${schema.stockLot.number}) like ${`%${needle.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`}` : undefined,
      ))
      .orderBy(asc(schema.stockLot.number))
      .limit(Math.min(input.limit ?? 500, 2000));
    if (lots.length === 0) return [];
    return viewsOf(tx, lots, input);
  });
}

async function viewsOf(
  tx: Database,
  lots: { lot: typeof schema.stockLot.$inferSelect; code: string }[],
  filter: { locationId?: string | undefined; inStockOnly?: boolean | undefined },
): Promise<UnitView[]> {
  const lotIds = lots.map((l) => l.lot.id);
  const rows = await tx.select().from(schema.stockMovement).where(inArray(schema.stockMovement.lotId, lotIds));
  const movements: inv.Movement[] = rows.map((row) => ({
    id: row.id, sequence: row.sequence, occurredAt: row.occurredAt, itemId: row.itemId, locationId: row.locationId,
    kind: row.kind, quantity: inv.quantity(row.quantity), lotId: row.lotId ?? undefined, jobId: row.jobId ?? undefined,
  }));
  const levels = inv.deriveUnitLevels(movements);
  const [names, places] = await Promise.all([
    namesFor(tx, lots.map((l) => l.lot.itemId)),
    tx.select({ id: schema.location.id, name: schema.location.name }).from(schema.location),
  ]);
  const placeOf = new Map(places.map((p) => [p.id, p.name]));
  const jobIds = rows.map((r) => r.jobId).filter((id): id is string => id !== null);
  const jobs = jobIds.length === 0 ? [] : await tx.select({ id: schema.job.id, number: schema.job.number })
    .from(schema.job).where(inArray(schema.job.id, [...new Set(jobIds)]));
  const jobNumber = new Map(jobs.map((j) => [j.id, j.number]));

  const out: UnitView[] = [];
  for (const { lot, code } of lots) {
    const where = inv.unitWhereabouts(levels, lot.id).map((level) => ({
      locationId: level.locationId,
      locationName: placeOf.get(level.locationId) ?? "",
      quantity: inv.quantityLabel(level.onHand),
    }));
    let state: UnitView["state"] = where.length > 0 ? "in_stock" : "gone";
    let jobId: string | null = null;
    if (lot.mode === "serial") {
      const s = inv.serialState(movements, lot.id);
      state = s.state;
      if (s.state === "used") jobId = s.jobId;
    } else if (where.length === 0) {
      const issued = movements.filter((mv) => mv.lotId === lot.id && mv.kind === "issue");
      if (issued.length > 0) { state = "used"; jobId = issued.at(-1)?.jobId ?? null; }
    }
    if (filter.inStockOnly && state !== "in_stock") continue;
    if (filter.locationId && !where.some((w) => w.locationId === filter.locationId)) continue;
    out.push({
      id: lot.id,
      itemId: lot.itemId,
      itemCode: code,
      itemName: names.get(lot.itemId) ?? code,
      mode: lot.mode,
      number: lot.number,
      expiresOn: lot.expiresOn,
      state,
      where,
      jobId,
      jobNumber: jobId ? jobNumber.get(jobId) ?? null : null,
      equipmentId: lot.equipmentId,
    });
  }
  return out;
}

export interface TraceStep {
  at: string;
  kind: string;
  label: string;
  quantity: string;
  locationName: string;
  jobId: string | null;
  jobNumber: number | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: number | null;
  vendorName: string | null;
  /** What the unit cost when it came in, for a reader who may see cost. */
  cost: string | null;
}

export interface UnitTrace {
  unit: UnitView;
  steps: TraceStep[];
  /** The customer's unit this became, when the reader may see equipment. */
  equipment: {
    id: string; category: string; tag: string | null; manufacturer: string | null; model: string | null;
    serialNumber: string | null; propertyId: string; address: string;
    customerId: string | null; customerName: string | null;
  } | null;
}

/**
 * EVERYTHING THAT HAPPENED TO ONE SERIAL OR LOT, oldest first: the order it
 * arrived on and from whom, every move between the warehouse and a truck,
 * the job it went to, and the customer's equipment record it became.
 *
 * Cost is shown only to somebody holding `pricebook.cost:read`, and the
 * customer's equipment and name only to somebody who may read those, so a
 * technician tracing a unit off their own van sees where it went and not
 * what it cost.
 */
export function trace(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "inventory:read", async (tx): Promise<UnitTrace> => {
    const [found] = await tx.select({ lot: schema.stockLot, code: schema.priceBookItem.code })
      .from(schema.stockLot)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.stockLot.itemId))
      .where(eq(schema.stockLot.id, input.id)).limit(1);
    if (!found) throw new NotFoundError("Serial or lot");
    const [unit] = await viewsOf(tx, [found], {});

    const rows = await tx.select({
      movement: schema.stockMovement,
      locationName: schema.location.name,
      jobNumber: schema.job.number,
      orderNumber: schema.purchaseOrder.number,
      vendorName: schema.vendor.name,
    }).from(schema.stockMovement)
      .innerJoin(schema.location, eq(schema.location.id, schema.stockMovement.locationId))
      .leftJoin(schema.job, eq(schema.job.id, schema.stockMovement.jobId))
      .leftJoin(schema.purchaseOrder, eq(schema.purchaseOrder.id, schema.stockMovement.purchaseOrderId))
      .leftJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseOrder.vendorId))
      .where(eq(schema.stockMovement.lotId, input.id))
      .orderBy(asc(schema.stockMovement.occurredAt), asc(schema.stockMovement.sequence));
    const seesCost = can(ctx.actor, "pricebook.cost:read");

    let equipment: UnitTrace["equipment"] = null;
    if (found.lot.equipmentId && can(ctx.actor, "equipment:read")) {
      const [row] = await tx.select({
        equipment: schema.equipment, line1: schema.property.addressLine1, city: schema.property.city,
      }).from(schema.equipment)
        .innerJoin(schema.property, eq(schema.property.id, schema.equipment.propertyId))
        .where(eq(schema.equipment.id, found.lot.equipmentId)).limit(1);
      if (row) {
        let customer: { id: string; name: string } | undefined;
        if (can(ctx.actor, "customer:read")) {
          [customer] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
            .from(schema.customerProperty)
            .innerJoin(schema.customer, eq(schema.customer.id, schema.customerProperty.customerId))
            .where(eq(schema.customerProperty.propertyId, row.equipment.propertyId)).limit(1);
        }
        equipment = {
          id: row.equipment.id,
          category: row.equipment.category,
          tag: row.equipment.tag,
          manufacturer: row.equipment.manufacturer,
          model: row.equipment.model,
          serialNumber: row.equipment.serialNumber,
          propertyId: row.equipment.propertyId,
          address: [row.line1, row.city].filter((p) => p).join(", "),
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? null,
        };
      }
    }

    return {
      unit: unit!,
      steps: rows.map((r) => ({
        at: r.movement.occurredAt.toISOString(),
        kind: r.movement.kind,
        label: inv.MOVEMENT_EFFECTS[r.movement.kind].label,
        quantity: inv.quantityLabel(inv.quantity(r.movement.quantity)),
        locationName: r.locationName,
        jobId: r.movement.jobId,
        jobNumber: r.jobNumber,
        purchaseOrderId: r.movement.purchaseOrderId,
        purchaseOrderNumber: r.orderNumber,
        vendorName: r.vendorName,
        cost: seesCost && r.movement.totalCost ? m.toString(m.round(m.money(r.movement.totalCost), 2)) : null,
      })),
      equipment,
    };
  });
}

/**
 * THE TRACE ON THE CUSTOMER'S EQUIPMENT PAGE: every serial of ours that
 * became this unit, each with its whole history from the order it arrived
 * on. Usually one; a unit we replaced a compressor in twice has two.
 */
export function traceForEquipment(ctx: ServiceContext, input: { equipmentId: string }): Promise<UnitTrace[]> {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const lots = await tx.select({ id: schema.stockLot.id }).from(schema.stockLot)
      .where(eq(schema.stockLot.equipmentId, input.equipmentId))
      .orderBy(asc(schema.stockLot.createdAt));
    return lots.map((lot) => lot.id);
  }).then((ids) => Promise.all(ids.map((id) => trace(ctx, { id }))));
}

/* ------------------------------------------------------ writing a unit off */

/**
 * A serial or lot that has gone: damaged, lost, stolen from a truck. Written
 * off as an adjustment with the reason, by number, which is the only way a
 * tracked item's count comes down without a job. A count by number alone is
 * refused for a tracked item, for the reason `inventory.count` gives.
 */
export function writeOff(ctx: ServiceContext, input: {
  itemId: string; locationId: string; units: readonly UnitInput[]; reason: string;
}) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await once.replayed<{ written: number }>(tx, ctx, "inventory.written_off");
    if (seen) return seen;
    const reason = input.reason.trim();
    if (reason === "") throw new ConflictError("Say why it is being written off. A unit that vanished with no reason is the one an audit asks about.");
    const mode = await trackingOf(tx, input.itemId);
    if (!mode) throw new ConflictError("That item is not tracked by serial or lot. Record a count instead.");

    const movements = await history(tx, input.itemId);
    const levels = inv.deriveUnitLevels(movements);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();
    const planned: inv.Movement[] = [];
    for (const [index, unit] of input.units.entries()) {
      const [lot] = await tx.select().from(schema.stockLot)
        .where(and(eq(schema.stockLot.itemId, input.itemId), sql`lower(${schema.stockLot.number}) = lower(${unit.number.trim()})`))
        .limit(1);
      if (!lot) throw new ConflictError(`No ${mode} ${unit.number} of that item has ever been received.`);
      const here = levels.find((l) => l.lotId === lot.id && l.locationId === input.locationId)?.onHand ?? inv.ZERO_QUANTITY;
      const quantity = unit.quantity?.trim() ? inv.quantity(unit.quantity) : (mode === "serial" ? inv.quantity("1") : here);
      if (quantity <= inv.ZERO_QUANTITY || quantity > here) {
        throw new ConflictError(`${lot.number} has ${inv.quantityLabel(here)} at that location, so ${inv.quantityLabel(quantity)} cannot be written off there.`);
      }
      planned.push({
        id: crypto.randomUUID(), sequence: sequence + index, occurredAt,
        itemId: input.itemId, locationId: input.locationId, kind: "adjustment_out",
        quantity, lotId: lot.id, reasonCode: reason.slice(0, 200),
      });
    }
    if (planned.length === 0) throw new ConflictError("Name the serials or lots to write off.");

    /**
     * The item level must not go below zero either. It cannot when the units
     * are where they are said to be, and checking says so if the history is
     * broken rather than writing a negative shelf.
     */
    const level = inv.deriveLevel(movements, input.itemId, input.locationId);
    const total = planned.reduce((t, p) => t + p.quantity, inv.ZERO_QUANTITY);
    if (total > level.onHand) {
      throw new ConflictError(inv.explainRefusal({
        ok: false, reason: "insufficient_on_hand", itemId: input.itemId, locationId: input.locationId,
        requested: total, onHand: level.onHand, shortfall: total - level.onHand,
      }));
    }

    const written = await writeMovements(tx, ctx, planned);
    await relieveLateFreight(tx, ctx, input.itemId, planned.map((p) => p.id), occurredAt);
    await audit(tx, ctx, "inventory.written_off", "price_book_item", input.itemId, null, {
      locationId: input.locationId, reason, units: input.units.map((u) => u.number),
    });
    const answer = { written: written.length };
    await once.remember(tx, ctx, "inventory.written_off", written[0]?.id ?? null, answer);
    return answer;
  });
}

/* --------------------------------------------------------- truck minimums */

export interface TruckMinimumView {
  id: string; itemId: string; itemName: string; locationId: string; locationName: string;
  minimum: string; target: string;
}

/**
 * What a truck should carry. Refused at a warehouse, which is bought for
 * with a reorder point rather than filled from somewhere else.
 */
export function setTruckMinimum(ctx: ServiceContext, input: {
  itemId: string; locationId: string; minimum: string; target: string;
}) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const minimum = inv.quantity(input.minimum);
    const target = inv.quantity(input.target);
    if (minimum < inv.ZERO_QUANTITY) throw new ConflictError("A truck's minimum cannot be negative.");
    if (target <= minimum) {
      throw new ConflictError(
        "Fill to more than the minimum. A target at or under it would restock a truck to the level that triggered the restock, and it would ask again tomorrow.",
      );
    }
    const [place] = await tx.select({ isWarehouse: schema.location.isWarehouse, name: schema.location.name })
      .from(schema.location).where(eq(schema.location.id, input.locationId)).limit(1);
    if (!place) throw new NotFoundError("Location");
    if (place.isWarehouse) {
      throw new ConflictError(
        `${place.name} is a warehouse. A warehouse is bought for with a reorder point on Purchasing; a truck minimum is filled from one.`,
      );
    }
    const [row] = await tx.insert(schema.truckStockMinimum).values({
      organizationId: ctx.actor.organizationId, itemId: input.itemId, locationId: input.locationId,
      minimum: inv.quantityToString(minimum), target: inv.quantityToString(target),
    }).onConflictDoUpdate({
      target: [schema.truckStockMinimum.organizationId, schema.truckStockMinimum.itemId, schema.truckStockMinimum.locationId],
      targetWhere: isNull(schema.truckStockMinimum.deletedAt),
      set: { minimum: inv.quantityToString(minimum), target: inv.quantityToString(target), updatedAt: new Date() },
    }).returning();
    await audit(tx, ctx, "truck_stock_minimum.set", "truck_stock_minimum", row!.id, null, row!);
    return { id: row!.id, itemId: row!.itemId, locationId: row!.locationId, minimum: row!.minimum, target: row!.target };
  });
}

export function clearTruckMinimum(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const [row] = await tx.update(schema.truckStockMinimum).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.truckStockMinimum.id, input.id), isNull(schema.truckStockMinimum.deletedAt))).returning();
    if (!row) throw new NotFoundError("Truck minimum");
    await audit(tx, ctx, "truck_stock_minimum.cleared", "truck_stock_minimum", row.id, row, null);
    return { id: row.id, cleared: true as const };
  });
}

async function minimumsWithin(tx: Database) {
  return tx.select().from(schema.truckStockMinimum).where(isNull(schema.truckStockMinimum.deletedAt));
}

export function truckMinimums(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx): Promise<TruckMinimumView[]> => {
    const rows = await minimumsWithin(tx);
    const names = await namesFor(tx, rows.map((r) => r.itemId));
    const places = await tx.select({ id: schema.location.id, name: schema.location.name }).from(schema.location);
    const placeOf = new Map(places.map((p) => [p.id, p.name]));
    return rows.map((r) => ({
      id: r.id, itemId: r.itemId, itemName: names.get(r.itemId) ?? "",
      locationId: r.locationId, locationName: placeOf.get(r.locationId) ?? "",
      minimum: inv.quantityLabel(inv.quantity(r.minimum)), target: inv.quantityLabel(inv.quantity(r.target)),
    })).sort((a, b) => a.locationName.localeCompare(b.locationName) || a.itemName.localeCompare(b.itemName));
  });
}

export interface RestockView {
  itemId: string; itemName: string; truckId: string; truckName: string;
  onTruck: string; minimum: string; target: string; wanted: string;
  fromLocationId: string | null; fromLocationName: string | null; take: string; short: string;
  /** Tracked by serial or lot, so the restock has to name units. */
  tracking: inv.TrackingMode | null;
  why: string;
}

/** Which trucks are under their minimums, and where to fill them from. */
export function restockSuggestions(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx): Promise<RestockView[]> => {
    const rows = await minimumsWithin(tx);
    if (rows.length === 0) return [];
    const places = await tx.select({ id: schema.location.id, name: schema.location.name, isWarehouse: schema.location.isWarehouse })
      .from(schema.location).where(eq(schema.location.active, true));
    const suggestions = inv.suggestRestock({
      minimums: rows.map((r) => ({
        itemId: r.itemId, locationId: r.locationId, minimum: inv.quantity(r.minimum), target: inv.quantity(r.target),
      })),
      levels: inv.deriveLevels(await history(tx)),
      warehouses: places.filter((p) => p.isWarehouse).map((p) => p.id),
    });
    const names = await namesFor(tx, suggestions.map((s) => s.itemId));
    const placeOf = new Map(places.map((p) => [p.id, p.name]));
    const tracked = await tx.select({ itemId: schema.stockTracking.itemId, mode: schema.stockTracking.mode }).from(schema.stockTracking);
    const modeOf = new Map(tracked.map((t) => [t.itemId, t.mode]));
    return suggestions.map((s) => ({
      itemId: s.itemId, itemName: names.get(s.itemId) ?? "",
      truckId: s.truckId, truckName: placeOf.get(s.truckId) ?? "",
      onTruck: inv.quantityLabel(s.onTruck), minimum: inv.quantityLabel(s.minimum), target: inv.quantityLabel(s.target),
      wanted: inv.quantityLabel(s.wanted),
      fromLocationId: s.fromLocationId, fromLocationName: s.fromLocationId ? placeOf.get(s.fromLocationId) ?? null : null,
      take: inv.quantityLabel(s.take), short: inv.quantityLabel(s.short),
      tracking: modeOf.get(s.itemId) ?? null,
      why: s.why,
    }));
  });
}

/**
 * Fill a truck: the transfer the suggestion proposed, through the one
 * transfer path, so the warehouse's reservations and a tracked item's units
 * are checked exactly as for a transfer typed by hand.
 */
export async function restock(ctx: ServiceContext, input: {
  itemId: string; truckId: string; fromLocationId: string; quantity: string; units?: readonly UnitInput[] | undefined;
}) {
  const written = await transfer(ctx, {
    itemId: input.itemId, fromLocationId: input.fromLocationId, toLocationId: input.truckId,
    quantity: input.quantity, units: input.units,
  });
  return { moved: inv.quantityLabel(inv.quantity(input.quantity)), movements: written.length };
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listStockLocations: async (ctx: ServiceContext): Promise<{ locations: { id: string; name: string; isWarehouse: boolean }[] }> =>
    ({ locations: await stockLocations(ctx) }),
  setStockTracking: (ctx: ServiceContext, input: { itemId: string; mode: inv.TrackingMode | null }):
    Promise<{ itemId: string; mode: "serial" | "lot" | null; unnumbered: { locationId: string; locationName: string; quantity: string }[] }> =>
    setTracking(ctx, input),
  numberStockUnits: (ctx: ServiceContext, input: {
    itemId: string; locationId: string;
    units: readonly { number: string; quantity?: string | undefined; expiresOn?: string | undefined }[];
  }): Promise<NumberingResult> => numberUnits(ctx, input),
  traceEquipmentStock: async (ctx: ServiceContext, input: { id: string }): Promise<{ units: UnitTrace[] }> =>
    ({ units: await traceForEquipment(ctx, { equipmentId: input.id }) }),
  listTrackedItems: async (ctx: ServiceContext): Promise<{ items: TrackedItemView[] }> => ({ items: await trackedItems(ctx) }),
  listStockUnits: async (ctx: ServiceContext, input: {
    itemId?: string | undefined; locationId?: string | undefined; number?: string | undefined;
    inStockOnly?: boolean | undefined; limit?: number | undefined;
  }): Promise<{ units: UnitView[] }> => ({ units: await units(ctx, input) }),
  traceStockUnit: (ctx: ServiceContext, input: { id: string }): Promise<UnitTrace> => trace(ctx, input),
  writeOffStockUnits: (ctx: ServiceContext, input: {
    itemId: string; locationId: string; reason: string; units: readonly { number: string; quantity?: string | undefined }[];
  }): Promise<{ written: number }> => writeOff(ctx, input),
  listTruckMinimums: async (ctx: ServiceContext): Promise<{ minimums: TruckMinimumView[] }> =>
    ({ minimums: await truckMinimums(ctx) }),
  setTruckMinimum: (ctx: ServiceContext, input: { itemId: string; locationId: string; minimum: string; target: string }):
    Promise<{ id: string; itemId: string; locationId: string; minimum: string; target: string }> => setTruckMinimum(ctx, input),
  clearTruckMinimum: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; cleared: true }> =>
    clearTruckMinimum(ctx, input),
  listRestockSuggestions: async (ctx: ServiceContext): Promise<{ suggestions: RestockView[] }> =>
    ({ suggestions: await restockSuggestions(ctx) }),
  restockTruck: (ctx: ServiceContext, input: {
    itemId: string; truckId: string; fromLocationId: string; quantity: string;
    units?: readonly { number: string; quantity?: string | undefined }[] | undefined;
  }): Promise<{ moved: string; movements: number }> => restock(ctx, input),
} as const;
