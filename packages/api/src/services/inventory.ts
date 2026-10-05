import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, catalogue, inventory as inv, ledger, money as m, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as equipmentRegister from "./equipment";
import * as approvals from "./purchase-approvals";
import { sendsWithin } from "./purchase-order-email";
import { refusingDuplicate } from "./duplicates";
import { nextNumber } from "./jobs";
import { inForceAt } from "./pricebook";
import { resolvePart } from "./vendor-catalogue";
import * as once from "./once";
import { writePosting } from "./ledger";

/**
 * PURCHASING, VENDORS AND INVENTORY
 *
 * Every decision in here is made in `core/inventory` and every one of them is
 * pure. This file does three things and nothing else: read the history, hand
 * it to a decision, and write what the decision returned.
 *
 * That division is the point rather than tidiness. A stock level is folded
 * from an append only history, so the arithmetic has to be identical whether
 * it runs against a database, in a test, or in a field app that has not seen
 * the server for two hours. Arithmetic that lives in a service is arithmetic
 * that exists once and cannot be checked anywhere else.
 *
 * NOTHING HERE WRITES A LEVEL, because there is no level to write. If you
 * find yourself reaching for an `update ... set on_hand` in this file, the
 * thing you actually want is an adjustment movement that says what changed
 * and why.
 */

/** Everything that has ever moved for this organization, in order. */
export async function history(tx: Database, itemId?: string): Promise<inv.Movement[]> {
  const rows = await tx.select().from(schema.stockMovement)
    .where(itemId ? eq(schema.stockMovement.itemId, itemId) : undefined)
    .orderBy(schema.stockMovement.occurredAt, schema.stockMovement.sequence);

  return rows.map((row) => ({
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
    ...(row.lotId ? { lotId: row.lotId } : {}),
    ...(row.revaluesMovementId ? { revaluesMovementId: row.revaluesMovementId } : {}),
    ...(row.lateCost ? { lateCost: m.money(row.lateCost, "USD") } : {}),
  }));
}

/**
 * The next sequence number, inside the caller's transaction.
 *
 * A total order per organization, taken as `max + 1` under the write. It is
 * not a global sequence because a sequence is not transactional: a rolled
 * back write would leave a gap, and a gap in the one column that orders a
 * financial history is a question nobody can answer later.
 */
export async function nextSequence(tx: Database, organizationId: string): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${schema.stockMovement.sequence})` })
    .from(schema.stockMovement)
    .where(eq(schema.stockMovement.organizationId, organizationId));
  return (row?.max ?? 0) + 1;
}

/**
 * What a movement carries that core does not decide: the freight spread onto
 * a receipt line, and the delivery it came on. Keyed by movement id.
 */
export type MovementExtras = ReadonlyMap<string, {
  landedCost?: string; receiptId?: string; landedCostBillId?: string; vendorReturnId?: string;
}>;

export async function writeMovements(
  tx: Database, ctx: ServiceContext, movements: readonly inv.Movement[], extras: MovementExtras = new Map(),
) {
  if (movements.length === 0) return [];
  return tx.insert(schema.stockMovement).values(movements.map((movement) => ({
    /**
     * The id core stamped, kept, so a later movement can name this one: a
     * revaluation names the use it adds late freight to, and a return off a
     * job names the use it undoes.
     */
    id: movement.id,
    organizationId: ctx.actor.organizationId,
    itemId: movement.itemId,
    locationId: movement.locationId,
    kind: movement.kind,
    quantity: inv.quantityToString(movement.quantity),
    totalCost: movement.totalCost ? m.toString(movement.totalCost) : null,
    jobId: movement.jobId ?? null,
    transferId: movement.transferId ?? null,
    reasonCode: movement.reasonCode ?? null,
    purchaseOrderId: movement.purchaseOrderId ?? null,
    purchaseOrderLineId: movement.purchaseOrderLineId ?? null,
    lotId: movement.lotId ?? null,
    landedCost: extras.get(movement.id)?.landedCost ?? null,
    receiptId: extras.get(movement.id)?.receiptId ?? null,
    landedCostBillId: extras.get(movement.id)?.landedCostBillId ?? null,
    vendorReturnId: extras.get(movement.id)?.vendorReturnId ?? null,
    revaluesMovementId: movement.revaluesMovementId ?? null,
    lateCost: movement.lateCost ? m.toString(movement.lateCost) : null,
    sequence: movement.sequence,
    occurredAt: movement.occurredAt,
    recordedByUserId: ctx.actor.userId,
  }))).returning();
}

/**
 * LATE FREIGHT LEAVES STOCK WITH THE PARTS THAT CARRIED IT.
 *
 * A freight bill that came after its delivery put its share for the parts
 * still on a shelf into the ledger's inventory account
 * (`landed-cost.ts`). When one of those parts is then used on a job,
 * scrapped, counted short or sent back to the vendor, the late freight it
 * carried has to leave that account, onto the job's cost of goods sold when
 * there is a job, or the account would hold freight for parts long gone.
 *
 * Read from a replay that includes the movements just written, so the
 * amount is exactly the share core allocated to them. An item no late bill
 * has ever touched has nothing to relieve, and is not replayed at all.
 */
export async function relieveLateFreight(
  tx: Database, ctx: ServiceContext, itemId: string, movementIds: readonly string[], occurredAt: Date,
): Promise<void> {
  if (movementIds.length === 0) return;
  const movements = await history(tx, itemId);
  if (!movements.some((mv) => mv.kind === "revaluation" || mv.lateCost)) return;
  const run = inv.costMovements({ movements, method: "fifo", currency: "USD" });
  /**
   * A history that cannot be costed cannot say how much late freight left
   * with these parts, and guessing would leave the inventory account wrong
   * with nothing to point at. The move is refused with costing's sentence.
   */
  if (!run.ok) throw new ConflictError(inv.explainRefusal(run));
  for (const relief of inv.lateRelief(run, movementIds)) {
    await writePosting(tx, ctx, ledger.postLateCostRelief({
      movementId: relief.movementId, occurredAt, amount: relief.amount, jobId: relief.jobId,
    }));
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LevelRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  locationId: string;
  locationName: string;
  onHand: string;
  committed: string;
  available: string;
}

/**
 * Where everything is.
 *
 * Returns a row per item per location rather than a row per item, because
 * "is it in stock" has no single answer once a van is a location, and
 * flattening it is what produces the technician who was told yes and drives
 * to a property without the part.
 */
export async function levels(ctx: ServiceContext): Promise<LevelRow[]> {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const movements = await history(tx);
    const derived = inv.deriveLevels(movements);
    if (derived.length === 0) return [];

    const items = await tx.select({
      id: schema.priceBookItem.id,
      code: schema.priceBookItem.code,
    }).from(schema.priceBookItem);
    const names = await tx.select({
      itemId: schema.priceBookItemVersion.itemId,
      name: schema.priceBookItemVersion.name,
    }).from(schema.priceBookItemVersion);
    const places = await tx.select({
      id: schema.location.id, name: schema.location.name,
    }).from(schema.location);

    const codeOf = new Map(items.map((i) => [i.id, i.code]));
    const nameOf = new Map(names.map((n) => [n.itemId, n.name]));
    const placeOf = new Map(places.map((p) => [p.id, p.name]));

    return derived
      .map((level) => ({
        itemId: level.itemId,
        itemCode: codeOf.get(level.itemId) ?? "",
        itemName: nameOf.get(level.itemId) ?? "",
        locationId: level.locationId,
        locationName: placeOf.get(level.locationId) ?? "",
        onHand: inv.quantityLabel(level.onHand),
        committed: inv.quantityLabel(level.committed),
        available: inv.quantityLabel(inv.available(level)),
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName)
        || a.locationName.localeCompare(b.locationName));
  });
}

/**
 * Who is holding what, and for which job.
 *
 * Names rather than ids, for the same reason every other read in this file
 * resolves them: a screen showing a uuid where a part should be is the
 * database on somebody's screen, and they cannot act on it.
 */
export async function commitments(ctx: ServiceContext) {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const open = inv.deriveCommitments(await history(tx));
    if (open.length === 0) return [];

    const [jobRows, itemRows, placeRows] = await Promise.all([
      tx.select({ id: schema.job.id, number: schema.job.number, summary: schema.job.summary })
        .from(schema.job),
      tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
        .from(schema.priceBookItemVersion),
      tx.select({ id: schema.location.id, name: schema.location.name }).from(schema.location),
    ]);
    const jobOf = new Map(jobRows.map((j) => [j.id, j]));
    const itemOf = new Map(itemRows.map((i) => [i.itemId, i.name]));
    const placeOf = new Map(placeRows.map((p) => [p.id, p.name]));

    return open.map((c) => ({
      ...c,
      quantity: inv.quantityLabel(c.quantity),
      itemName: itemOf.get(c.itemId) ?? "",
      locationName: placeOf.get(c.locationId) ?? "",
      jobNumber: jobOf.get(c.jobId)?.number ?? null,
      jobSummary: jobOf.get(c.jobId)?.summary ?? null,
    }));
  });
}

/**
 * What to buy.
 *
 * The position compared against the reorder point is available PLUS what is
 * already on order, and the on order half is derived from purchase order
 * status here rather than trusted from a column. That one line is the whole
 * of the bug where a system reorders the same part every night until twelve
 * of them arrive.
 */
/* ---------------------------------------------- when to buy it, declared */

export interface ReorderPolicyInput {
  itemId: string;
  locationId: string;
  /** Buy when the position reaches this. A decimal string: never a float. */
  reorderPoint: string;
  /** How much to buy, when `targetLevel` is not given. */
  reorderQuantity: string;
  /**
   * Buy up TO this instead of buying a fixed amount.
   *
   * `inv.suggestReorders` prefers it when present, which is the difference
   * between a part that arrives in boxes of fifty and one you keep twelve of.
   */
  targetLevel?: string | null | undefined;
  preferredVendorId?: string | null | undefined;
}

export interface ReorderPolicyView {
  id: string;
  itemId: string;
  itemName: string | null;
  locationId: string;
  locationName: string | null;
  reorderPoint: string;
  reorderQuantity: string;
  targetLevel: string | null;
  preferredVendorId: string | null;
}

/**
 * WHAT TO BUY HAD NOTHING TO READ.
 *
 * `toOrder` below opens with `if (policies.length === 0) return []`, and
 * nothing in the product could write a `reorder_policy` row. So the
 * suggestion screen returned an empty array for every company that ever
 * opened it, and `inv.suggestReorders` in core, with its reorder point, its
 * target level and its on-order arithmetic, had no caller that could reach
 * it with data.
 *
 * The empty return is not a bug. It is the correct answer to "what should I
 * buy" when nobody has said what they keep in stock. What was missing was any
 * way to say.
 *
 * ON THE PERMISSION. `po:write`, not `inventory:adjust`. Adjusting inventory
 * is a statement about what is physically on the shelf; a reorder point is a
 * decision about what to spend money on, and the person who may raise a
 * purchase order is the person who gets to make it. `settings:write` would
 * have been wrong in the other direction: this is per item and per location
 * and changes weekly, which is not what a settings screen is.
 */
export async function setReorderPolicy(
  ctx: ServiceContext, input: ReorderPolicyInput,
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const point = inv.quantity(input.reorderPoint);
    const amount = inv.quantity(input.reorderQuantity);
    const target = input.targetLevel ? inv.quantity(input.targetLevel) : null;

    if (point < 0n) {
      throw new ConflictError(
        "A reorder point cannot be negative. Buying when stock falls below minus two means "
        + "never buying.",
      );
    }
    if (amount <= 0n && target === null) {
      throw new ConflictError(
        "A policy needs something to buy: a reorder quantity above zero, or a target level "
        + "to buy up to. Zero of both is a policy that fires and orders nothing.",
      );
    }
    /**
     * A target below the point would suggest an order and then cap it at less
     * than the level that triggered it, so the position stays under the point
     * and the same suggestion appears again tomorrow, forever.
     */
    if (target !== null && target < point) {
      throw new ConflictError(
        "The target level is below the reorder point, so every order would leave stock under "
        + "the point that triggered it and the same suggestion would come back tomorrow.",
      );
    }

    const [location] = await tx.select({ isWarehouse: schema.location.isWarehouse })
      .from(schema.location)
      .where(and(
        eq(schema.location.organizationId, ctx.actor.organizationId),
        eq(schema.location.id, input.locationId),
      ));
    if (!location) throw new NotFoundError("Location");
    /**
     * Stock is only counted where `is_warehouse` is true, which is the filter
     * `levels` applies. A policy against anywhere else compares a reorder
     * point against a position that is always zero, so it suggests an order
     * every single day and the suggestion is never satisfied by anything
     * arriving.
     */
    if (!location.isWarehouse) {
      throw new ConflictError(
        "Stock is only counted at a warehouse, so a reorder policy anywhere else would "
        + "compare against a position of zero and suggest the same order every day.",
      );
    }

    const [row] = await tx.insert(schema.reorderPolicy).values({
      organizationId: ctx.actor.organizationId,
      itemId: input.itemId,
      locationId: input.locationId,
      reorderPoint: input.reorderPoint,
      reorderQuantity: input.reorderQuantity,
      targetLevel: input.targetLevel ?? null,
      preferredVendorId: input.preferredVendorId ?? null,
    })
      /**
       * One LIVE policy per item per location. Upserting rather than
       * refusing, because "set the reorder point for this part here" is one
       * intention whether or not a row exists, and making the caller know
       * which is a screen that fails the second time somebody uses it.
       *
       * `targetWhere` IS REQUIRED HERE AND ITS ABSENCE IS NOT A TYPE ERROR.
       *
       * The index is PARTIAL: unique on (organization, item, location) where
       * `deleted_at is null`. Postgres will not match an ON CONFLICT
       * specification to a partial index unless the predicate is given, and
       * it says so at runtime with "there is no unique or exclusion
       * constraint matching the ON CONFLICT specification" rather than at
       * compile time. Drizzle spells it `targetWhere` on this method and
       * plain `where` on `onConflictDoNothing`, which is a trap worth naming
       * because the two read as the same thing.
       *
       * WHAT THE PARTIAL PREDICATE MEANS FOR A CLEARED POLICY, since it is
       * not what it looks like: a soft deleted row does not take part in the
       * index, so it does not conflict. Setting a policy after clearing one
       * INSERTS a second row and leaves the dead one in place, which is the
       * behaviour worth having: the cleared policy stays readable as the
       * record that somebody once bought this part automatically. An earlier
       * version of this set `deletedAt: null` in the update clause to
       * "un-delete" it, which could never fire, because the conflict it was
       * written for cannot happen.
       */
      .onConflictDoUpdate({
        target: [
          schema.reorderPolicy.organizationId,
          schema.reorderPolicy.itemId,
          schema.reorderPolicy.locationId,
        ],
        targetWhere: isNull(schema.reorderPolicy.deletedAt),
        set: {
          reorderPoint: input.reorderPoint,
          reorderQuantity: input.reorderQuantity,
          targetLevel: input.targetLevel ?? null,
          preferredVendorId: input.preferredVendorId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    await audit(tx, ctx, "reorder_policy.set", "reorder_policy", row!.id, null, row!);
    return row!;
  });
}

/** Stop buying this automatically. Soft deleted, which is what `toOrder` filters on. */
export async function clearReorderPolicy(
  ctx: ServiceContext, input: { itemId: string; locationId: string },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const [row] = await tx.update(schema.reorderPolicy)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.reorderPolicy.organizationId, ctx.actor.organizationId),
        eq(schema.reorderPolicy.itemId, input.itemId),
        eq(schema.reorderPolicy.locationId, input.locationId),
        isNull(schema.reorderPolicy.deletedAt),
      )).returning();
    if (!row) throw new NotFoundError("Reorder policy");

    await audit(tx, ctx, "reorder_policy.cleared", "reorder_policy", row.id, row, null);
    return { itemId: row.itemId, locationId: row.locationId, cleared: true };
  });
}

export async function reorderPolicies(ctx: ServiceContext): Promise<ReorderPolicyView[]> {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const rows = await tx.select().from(schema.reorderPolicy)
      .where(and(
        eq(schema.reorderPolicy.organizationId, ctx.actor.organizationId),
        isNull(schema.reorderPolicy.deletedAt),
      ));

    const items = await tx.select({
      itemId: schema.priceBookItemVersion.itemId,
      name: schema.priceBookItemVersion.name,
    }).from(schema.priceBookItemVersion);
    const places = await tx.select({ id: schema.location.id, name: schema.location.name })
      .from(schema.location);
    const nameOf = new Map(items.map((i) => [i.itemId, i.name]));
    const placeOf = new Map(places.map((p) => [p.id, p.name]));

    return rows.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      itemName: nameOf.get(row.itemId) ?? null,
      locationId: row.locationId,
      locationName: placeOf.get(row.locationId) ?? null,
      reorderPoint: row.reorderPoint,
      reorderQuantity: row.reorderQuantity,
      targetLevel: row.targetLevel,
      preferredVendorId: row.preferredVendorId,
    }));
  });
}

export async function toOrder(ctx: ServiceContext, now = new Date()) {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const policies = await tx.select().from(schema.reorderPolicy)
      .where(isNull(schema.reorderPolicy.deletedAt));
    if (policies.length === 0) return [];

    const orders = await loadPurchaseOrders(tx);
    const suggestions = inv.suggestReorders({
      policies: policies.map((p) => ({
        itemId: p.itemId,
        locationId: p.locationId,
        reorderPoint: inv.quantity(p.reorderPoint),
        reorderQuantity: inv.quantity(p.reorderQuantity),
        ...(p.targetLevel ? { targetLevel: inv.quantity(p.targetLevel) } : {}),
        ...(p.preferredVendorId ? { preferredVendorId: p.preferredVendorId } : {}),
      })),
      levels: inv.deriveLevels(await history(tx)),
      onOrder: inv.onOrderFrom(orders),
      now,
    });

    const items = await tx.select({
      itemId: schema.priceBookItemVersion.itemId,
      name: schema.priceBookItemVersion.name,
    }).from(schema.priceBookItemVersion);
    const places = await tx.select({ id: schema.location.id, name: schema.location.name })
      .from(schema.location);
    const nameOf = new Map(items.map((i) => [i.itemId, i.name]));
    const placeOf = new Map(places.map((p) => [p.id, p.name]));

    return suggestions.map((s) => ({
      ...s,
      itemName: nameOf.get(s.itemId) ?? "",
      locationName: placeOf.get(s.locationId) ?? "",
      suggested: inv.quantityLabel(s.suggested),
      position: inv.quantityLabel(s.position),
      availableNow: inv.quantityLabel(s.availableNow),
      onOrder: inv.quantityLabel(s.onOrder),
      reorderPoint: inv.quantityLabel(s.reorderPoint),
    }));
  });
}

async function loadPurchaseOrders(tx: Database): Promise<inv.PurchaseOrder[]> {
  const orders = await tx.select().from(schema.purchaseOrder)
    .where(isNull(schema.purchaseOrder.deletedAt));
  if (orders.length === 0) return [];

  const lines = await tx.select().from(schema.purchaseOrderLine);
  return orders.map((order) => toCore(order, lines));
}

/** One stored order, in the shape core reads. */
function toCore(
  order: typeof schema.purchaseOrder.$inferSelect,
  lines: (typeof schema.purchaseOrderLine.$inferSelect)[],
): inv.PurchaseOrder {
  return {
    id: order.id,
    vendorId: order.vendorId,
    status: order.status,
    ...(order.expectedAt ? { expectedAt: order.expectedAt } : {}),
    ...(order.submittedAt ? { submittedAt: order.submittedAt } : {}),
    lines: lines.filter((l) => l.purchaseOrderId === order.id).map((line) => ({
      id: line.id,
      itemId: line.itemId,
      locationId: line.locationId,
      quantityOrdered: inv.quantity(line.quantityOrdered),
      quantityReceived: inv.quantity(line.quantityReceived),
      unitPrice: m.money(line.unitPrice, "USD"),
      packQuantity: inv.quantity(line.packQuantity),
      ...(line.packPrice ? { packPrice: m.money(line.packPrice, "USD") } : {}),
    })),
  };
}

/* ------------------------------------------------- serial numbers and lots */

/**
 * WHICH UNITS MOVED, for an item tracked by serial or lot.
 *
 * `number` is the serial or the lot as printed. `quantity` is one for a
 * serial and is left out; a lot moves part of itself and says how much (left
 * out when one lot covers the whole movement). The equipment fields are read
 * only when a serialised unit is issued to a job: the customer's unit it
 * went into, or the record to make for it.
 */
export interface UnitInput {
  number: string;
  quantity?: string | undefined;
  /** A lot's use by date, on a receipt. */
  expiresOn?: string | undefined;
  /** On an issue: the customer's equipment record this unit is, or went into. */
  equipmentId?: string | undefined;
  /** On an issue: record it as new equipment at the job's property. */
  installAs?: InstallAs | undefined;
}

export interface InstallAs {
  category: string;
  tag?: string | undefined;
  manufacturer?: string | undefined;
  model?: string | undefined;
  location?: string | undefined;
}

/** How this item is tracked, or null when it is counted only. */
export async function trackingOf(tx: Database, itemId: string): Promise<inv.TrackingMode | null> {
  const [row] = await tx.select({ mode: schema.stockTracking.mode }).from(schema.stockTracking)
    .where(eq(schema.stockTracking.itemId, itemId)).limit(1);
  return row?.mode ?? null;
}

/** An item as a person names it: the name in force, else the code. */
export async function itemLabel(tx: Database, itemId: string): Promise<string> {
  const names = await itemNames(tx, [itemId]);
  if (names.get(itemId)) return names.get(itemId)!;
  const [row] = await tx.select({ code: schema.priceBookItem.code }).from(schema.priceBookItem)
    .where(eq(schema.priceBookItem.id, itemId)).limit(1);
  return row?.code ?? "That item";
}

export async function placeLabel(tx: Database, locationId: string): Promise<string> {
  const [row] = await tx.select({ name: schema.location.name }).from(schema.location)
    .where(eq(schema.location.id, locationId)).limit(1);
  return row?.name ?? "that location";
}

const unitRefusal = (refusal: inv.UnitRefusal) => new ConflictError(inv.explainUnitRefusal(refusal));

/**
 * The serials or lots ARRIVING, created where they are new.
 *
 * A serial that is already in stock or already on a job is refused with
 * where it is: the same number arriving twice is a typo or a second unit with
 * a label misread, and either way a person has to look. A serial that left
 * (written off, returned) and comes back is the same unit, so its row is
 * reused and its history continues. A lot that arrives again is the same
 * batch, so it is reused too.
 */
async function arrivingUnits(
  tx: Database, ctx: ServiceContext,
  input: { itemId: string; mode: inv.TrackingMode; quantity: inv.Quantity; units: readonly UnitInput[]; movements: readonly inv.Movement[] },
): Promise<inv.UnitPick[]> {
  const label = await itemLabel(tx, input.itemId);
  if (input.units.length === 0) throw unitRefusal({ ok: false, reason: "units_required", mode: input.mode, itemLabel: label });
  const picks: inv.UnitPick[] = [];
  const numbers = new Map<string, string>();
  for (const unit of input.units) {
    const number = unit.number.trim();
    if (number === "") throw new ConflictError("A serial or lot number cannot be blank.");
    const [found] = await tx.select().from(schema.stockLot)
      .where(and(eq(schema.stockLot.itemId, input.itemId), sql`lower(${schema.stockLot.number}) = lower(${number})`))
      .limit(1);
    let lotId = found?.id;
    if (found && input.mode === "serial") {
      const state = inv.serialState(input.movements, found.id);
      if (state.state === "in_stock") {
        throw new ConflictError(`Serial ${found.number} of ${label} is already in stock at ${await placeLabel(tx, state.locationId)}. The same number twice is a misread label or a typo.`);
      }
      if (state.state === "used") {
        throw new ConflictError(`Serial ${found.number} of ${label} was already used on a job. If it came back, record it as back from the job under Serials and lots, rather than as a new receipt.`);
      }
    }
    if (found && unit.expiresOn && !found.expiresOn) {
      await tx.update(schema.stockLot).set({ expiresOn: unit.expiresOn, updatedAt: new Date() })
        .where(eq(schema.stockLot.id, found.id));
    }
    if (!lotId) {
      const [row] = await tx.insert(schema.stockLot).values({
        organizationId: ctx.actor.organizationId,
        itemId: input.itemId,
        mode: input.mode,
        number,
        expiresOn: input.mode === "lot" ? unit.expiresOn ?? null : null,
      }).returning({ id: schema.stockLot.id });
      lotId = row!.id;
    }
    numbers.set(lotId, number);
    picks.push({ lotId, quantity: unitQuantity(unit, input.mode, input.quantity, input.units.length) });
  }
  const check = inv.checkUnitPicks({ mode: input.mode, itemLabel: label, quantity: input.quantity, picks, numbers, from: null });
  if (!check.ok) throw unitRefusal(check);
  return picks;
}

/** One for a serial; for a lot, what was said, or the whole movement when one lot covers it. */
function unitQuantity(unit: UnitInput, mode: inv.TrackingMode, total: inv.Quantity, count: number): inv.Quantity {
  if (unit.quantity?.trim()) return inv.quantity(unit.quantity);
  if (mode === "serial") return inv.quantity("1");
  if (count === 1) return total;
  throw new ConflictError(`Say how much of lot ${unit.number} moved. With more than one lot, each needs its own quantity.`);
}

/**
 * The serials or lots LEAVING a location: each must exist for this item and
 * be there in the quantity asked.
 */
export async function leavingUnits(
  tx: Database,
  input: {
    itemId: string; mode: inv.TrackingMode; quantity: inv.Quantity; locationId: string;
    units: readonly UnitInput[]; movements: readonly inv.Movement[];
  },
): Promise<{ picks: inv.UnitPick[]; numbers: Map<string, string> }> {
  const label = await itemLabel(tx, input.itemId);
  if (input.units.length === 0) throw unitRefusal({ ok: false, reason: "units_required", mode: input.mode, itemLabel: label });
  const picks: inv.UnitPick[] = [];
  const numbers = new Map<string, string>();
  for (const unit of input.units) {
    const number = unit.number.trim();
    const [found] = await tx.select({ id: schema.stockLot.id, number: schema.stockLot.number }).from(schema.stockLot)
      .where(and(eq(schema.stockLot.itemId, input.itemId), sql`lower(${schema.stockLot.number}) = lower(${number})`))
      .limit(1);
    if (!found) {
      throw new ConflictError(`No ${input.mode === "serial" ? "serial" : "lot"} ${number} of ${label} has ever been received. Check the number on the label.`);
    }
    numbers.set(found.id, found.number);
    picks.push({ lotId: found.id, quantity: unitQuantity(unit, input.mode, input.quantity, input.units.length) });
  }
  const check = inv.checkUnitPicks({
    mode: input.mode, itemLabel: label, quantity: input.quantity, picks, numbers,
    from: {
      locationId: input.locationId,
      locationLabel: await placeLabel(tx, input.locationId),
      levels: inv.deriveUnitLevels(input.movements),
    },
  });
  if (!check.ok) throw unitRefusal(check);
  return { picks, numbers };
}

/**
 * A RETRIED MOVEMENT IS THE FIRST ONE, NOT A SECOND.
 *
 * Every stock route has said it was idempotent and none of them was: a
 * technician's phone on one bar retrying an issue wrote it twice, and the
 * van was a part short by the history's own arithmetic. The movements a
 * write made are remembered against the caller's key, and a retry reads
 * those same rows back.
 */
async function replayedMovements(tx: Database, ctx: ServiceContext, entity: string) {
  const seen = await once.replayed<{ ids: string[] }>(tx, ctx, entity);
  if (!seen) return null;
  if (seen.ids.length === 0) return [];
  return tx.select().from(schema.stockMovement)
    .where(inArray(schema.stockMovement.id, seen.ids))
    .orderBy(asc(schema.stockMovement.sequence));
}

async function rememberMovements(
  tx: Database, ctx: ServiceContext, entity: string, rows: readonly { id: string }[],
) {
  await once.remember(tx, ctx, entity, rows[0]?.id ?? null, { ids: rows.map((r) => r.id) });
}

/** Fresh stamps from a starting sequence, one per movement, all at one instant. */
export const stampsFrom = (sequence: number, count: number, occurredAt: Date): inv.MovementStamp[] =>
  Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), sequence: sequence + i, occurredAt }));

/**
 * Units named for an item that is not tracked, refused, rather than ignored:
 * somebody believes they recorded serial numbers, and they did not.
 */
async function refuseUnitsOnUntracked(tx: Database, itemId: string, units: readonly UnitInput[] | undefined) {
  if (units && units.length > 0) {
    throw unitRefusal({ ok: false, reason: "untracked_given_units", itemLabel: await itemLabel(tx, itemId) });
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Every write takes the same shape: fold the history, ask core, write what it
 * said. The decision is never made here, so a refusal always carries the
 * sentence core wrote for it rather than one invented at the edge.
 *
 * A TRACKED ITEM goes through the same decision about the item as a whole
 * (enough on the shelf, nobody else's reservation taken) and then the
 * movement core returned is cut into one per serial or lot. `units` says what
 * to do: `"refuse"` for a write that cannot name units (a count), a list for
 * the units leaving, and `undefined` for a write that moves no stock (a
 * reservation, which is of the item and not of a unit).
 */
async function decide(
  ctx: ServiceContext,
  permission: Parameters<typeof guardedWrite>[1],
  plan: (input: {
    tx: Database;
    level: inv.StockLevel;
    stamp: inv.MovementStamp;
    movements: inv.Movement[];
  }) => inv.MovementDecision,
  where: { itemId: string; locationId: string },
  event: string,
  units?: "refuse" | readonly UnitInput[],
) {
  return guardedWrite(ctx, permission, async (tx) => {
    const again = await replayedMovements(tx, ctx, event);
    if (again) return { rows: again, replayed: true };

    const movements = await history(tx, where.itemId);
    const level = inv.deriveLevel(movements, where.itemId, where.locationId);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();

    const decision = plan({
      tx,
      level,
      stamp: { id: crypto.randomUUID(), sequence, occurredAt },
      movements,
    });
    if (!decision.ok) throw new ConflictError(inv.explainRefusal(decision));

    let planned = decision.movements;
    const mode = units === undefined ? null : await trackingOf(tx, where.itemId);
    if (mode && units === "refuse") {
      throw new ConflictError(
        `${await itemLabel(tx, where.itemId)} is tracked by ${mode === "serial" ? "serial number" : "lot"}, so a count by number alone `
        + "cannot say which units are missing or found. Write off the missing ones by number, and receive a found one with its number and cost.",
      );
    }
    if (!mode && Array.isArray(units)) await refuseUnitsOnUntracked(tx, where.itemId, units);
    if (mode && Array.isArray(units) && planned.length > 0) {
      const leaving = planned[0]!;
      const { picks } = await leavingUnits(tx, {
        itemId: where.itemId, mode, quantity: leaving.quantity, locationId: where.locationId,
        units, movements,
      });
      planned = inv.splitAcrossUnits(leaving, picks, stampsFrom(sequence, picks.length, occurredAt));
    }

    const written = await writeMovements(tx, ctx, planned);
    await relieveLateFreight(tx, ctx, where.itemId, planned.map((mv) => mv.id), occurredAt);
    await audit(tx, ctx, event, "price_book_item", where.itemId, null, {
      locationId: where.locationId,
      movements: planned.map((mv) => mv.kind),
      ...(planned.some((mv) => mv.lotId) ? { units: planned.map((mv) => mv.lotId) } : {}),
    });
    await rememberMovements(tx, ctx, event, written);
    return { rows: written, replayed: false };
  });
}

export async function reserve(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; jobId: string; quantity: string },
) {
  return (await decide(ctx, "inventory:adjust", ({ level, stamp }) =>
    inv.planCommitment({ level, quantity: inv.quantity(input.quantity), jobId: input.jobId, stamp }),
    input, "inventory.reserved")).rows;
}

/**
 * Stock onto a job.
 *
 * A job is required, by core and therefore here. An issue with no job is
 * stock leaving the shelf for nobody, which is a real thing that happens and
 * is an ADJUSTMENT rather than an issue: the difference is whether anybody
 * can be told later what the part was for.
 *
 * A SERIALISED UNIT CAN SAY WHICH OF THE CUSTOMER'S UNITS IT IS. Linked to
 * an equipment record at the job's property, or recorded as a new one there
 * with its serial, which is what makes "which compressor is in my house" a
 * lookup rather than an archaeology project. Recording a new one needs
 * `equipment:write`, checked by the equipment register itself.
 */
export async function issue(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; quantity: string; jobId: string; units?: readonly UnitInput[] | undefined },
) {
  const units = input.units ?? [];
  const outcome = await decide(ctx, "inventory:adjust", ({ level, stamp, movements }) =>
    inv.planIssue({
      level, quantity: inv.quantity(input.quantity), jobId: input.jobId, stamp,
      /**
       * Every open reservation on this item, so core can subtract the ones
       * belonging to OTHER jobs and leave this job its own. `movements` is
       * the history `decide` already folded to get the level, so this costs
       * nothing extra.
       */
      commitments: inv.deriveCommitments(movements),
    }),
    input, "inventory.issued", units);

  const installing = units.filter((u) => u.equipmentId || u.installAs);
  if (installing.length > 0 && !outcome.replayed) await installUnits(ctx, input.itemId, input.jobId, installing);
  return outcome.rows;
}

/**
 * THE TRACE FROM OUR SHELF TO THEIR BASEMENT.
 *
 * Written after the stock has moved and in its own transaction, so the
 * equipment register's own checks (a serial already on file at the property,
 * a category) run exactly as they do for a unit added by hand. A refusal
 * there leaves the part issued and says what to fix, which is the right way
 * round: the part is in the customer's unit whatever the register thinks.
 */
async function installUnits(ctx: ServiceContext, itemId: string, jobId: string, units: readonly UnitInput[]) {
  await guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const [job] = await tx.select({ propertyId: schema.job.propertyId }).from(schema.job)
      .where(eq(schema.job.id, jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");
    const zone = await timezoneOf(tx, ctx.actor.organizationId);

    for (const unit of units) {
      const [lot] = await tx.select().from(schema.stockLot)
        .where(and(eq(schema.stockLot.itemId, itemId), sql`lower(${schema.stockLot.number}) = lower(${unit.number.trim()})`))
        .limit(1);
      if (!lot) continue;
      if (lot.mode !== "serial") {
        throw new ConflictError(`Lot ${lot.number} is a batch, not one unit, so it cannot be a customer's equipment record.`);
      }
      let equipmentId = unit.equipmentId ?? null;
      if (equipmentId) {
        assertCan(ctx.actor, "equipment:read");
        const [found] = await tx.select({ propertyId: schema.equipment.propertyId }).from(schema.equipment)
          .where(and(eq(schema.equipment.id, equipmentId), isNull(schema.equipment.deletedAt))).limit(1);
        if (!found) throw new NotFoundError("Equipment");
        if (found.propertyId !== job.propertyId) {
          throw new ConflictError(`That equipment is at a different address from the job, so serial ${lot.number} cannot have gone into it.`);
        }
      } else if (unit.installAs) {
        const made = await equipmentRegister.register({ ...ctx, db: tx }, {
          propertyId: job.propertyId,
          category: unit.installAs.category,
          tag: unit.installAs.tag ?? null,
          manufacturer: unit.installAs.manufacturer ?? null,
          model: unit.installAs.model ?? null,
          location: unit.installAs.location ?? null,
          serialNumber: lot.number,
          installedOn: time.dateIn(new Date(), zone),
          installedByUs: true,
        });
        equipmentId = made.id;
      }
      if (!equipmentId) continue;
      await tx.update(schema.stockLot).set({ equipmentId, updatedAt: new Date() }).where(eq(schema.stockLot.id, lot.id));
      await audit(tx, ctx, "stock_lot.installed", "stock_lot", lot.id, { equipmentId: lot.equipmentId }, { equipmentId, jobId });
    }
  });
}

/**
 * Stock arriving outside a purchase order.
 *
 * Core has no planner for this and does not need one: a receipt refuses
 * nothing, because stock that has physically arrived has arrived whatever the
 * system thinks. The one rule is that it carries what it COST, since a
 * receipt is the only movement that establishes a cost layer, and a receipt
 * with no cost is stock that will be issued at nothing and quietly overstate
 * every job's margin. A tracked item also carries its serial numbers or lot,
 * and the cost is allocated across them.
 */
export async function receive(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; quantity: string; totalCost: string; units?: readonly UnitInput[] | undefined },
) {
  const quantity = inv.quantity(input.quantity);
  if (quantity <= inv.ZERO_QUANTITY) throw new ConflictError("A receipt has to be for something.");

  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const again = await replayedMovements(tx, ctx, "inventory.received");
    if (again) return again;
    const movements = await history(tx, input.itemId);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();
    const receipt: inv.Movement = {
      id: crypto.randomUUID(), sequence, occurredAt,
      itemId: input.itemId, locationId: input.locationId,
      kind: "receipt", quantity, totalCost: m.money(input.totalCost, "USD"),
    };
    const mode = await trackingOf(tx, input.itemId);
    let planned: inv.Movement[] = [receipt];
    if (mode) {
      const picks = await arrivingUnits(tx, ctx, { itemId: input.itemId, mode, quantity, units: input.units ?? [], movements });
      planned = inv.splitAcrossUnits(receipt, picks, stampsFrom(sequence, picks.length, occurredAt));
    } else {
      await refuseUnitsOnUntracked(tx, input.itemId, input.units);
    }
    const written = await writeMovements(tx, ctx, planned);
    await audit(tx, ctx, "inventory.received", "price_book_item", input.itemId, null, {
      locationId: input.locationId, quantity: input.quantity,
      ...(mode ? { units: (input.units ?? []).map((u) => u.number) } : {}),
    });
    await rememberMovements(tx, ctx, "inventory.received", written);
    return written;
  });
}

/**
 * A count, recorded as the correction it is.
 *
 * The counted number is not written anywhere. What is written is the
 * DIFFERENCE, as an adjustment with a reason, so the history still explains
 * every number it produces. A count that overwrote the level would be the one
 * write in this module that destroys evidence. Refused for a tracked item,
 * whose missing and found units have numbers a count cannot give.
 */
export async function count(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; counted: string; reasonCode?: string; foundAtCost?: string },
) {
  return (await decide(ctx, "inventory:adjust", ({ level, stamp }) =>
    inv.reconcileCount({
      level,
      counted: inv.quantity(input.counted),
      stamp,
      reasonCode: input.reasonCode ?? "cycle_count",
      /**
       * Required only when the count found MORE than the history expected,
       * and it has to come from somewhere. Stock that appeared has no receipt
       * behind it, so there is no layer to take its cost from, and valuing it
       * at nothing makes every later issue look free.
       */
      ...(input.foundAtCost ? { foundAtCost: m.money(input.foundAtCost, "USD") } : {}),
    }),
    input, "inventory.counted", "refuse")).rows;
}

/**
 * Between the warehouse and a truck, or truck to truck. A tracked item says
 * which units went, and each unit leaves and arrives as its own pair.
 */
export async function transfer(
  ctx: ServiceContext,
  input: {
    itemId: string; fromLocationId: string; toLocationId: string; quantity: string;
    units?: readonly UnitInput[] | undefined;
  },
) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const again = await replayedMovements(tx, ctx, "inventory.transferred");
    if (again) return again;
    const movements = await history(tx, input.itemId);
    const from = inv.deriveLevel(movements, input.itemId, input.fromLocationId);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();

    /**
     * Both halves or neither, and core returns them as one array so there is
     * no shape of the return value that lets this write one leg. One leg of a
     * transfer is stock that left a van and arrived nowhere.
     */
    const decision = inv.planTransfer({
      from,
      toLocationId: input.toLocationId,
      quantity: inv.quantity(input.quantity),
      out: { id: crypto.randomUUID(), sequence, occurredAt },
      in: { id: crypto.randomUUID(), sequence: sequence + 1, occurredAt },
      transferId: crypto.randomUUID(),
    });
    if (!decision.ok) throw new ConflictError(inv.explainRefusal(decision));

    let planned = decision.movements;
    const mode = await trackingOf(tx, input.itemId);
    if (mode) {
      const { picks } = await leavingUnits(tx, {
        itemId: input.itemId, mode, quantity: inv.quantity(input.quantity), locationId: input.fromLocationId,
        units: input.units ?? [], movements,
      });
      planned = inv.splitTransfer({
        out: planned[0]!, in: planned[1]!, picks,
        stamps: picks.map((_, i) => ({
          out: { id: crypto.randomUUID(), sequence: sequence + i * 2, occurredAt },
          in: { id: crypto.randomUUID(), sequence: sequence + i * 2 + 1, occurredAt },
          transferId: crypto.randomUUID(),
        })),
      });
    } else {
      await refuseUnitsOnUntracked(tx, input.itemId, input.units);
    }

    const written = await writeMovements(tx, ctx, planned);
    await audit(tx, ctx, "inventory.transferred", "price_book_item", input.itemId, null, {
      from: input.fromLocationId, to: input.toLocationId, quantity: input.quantity,
      ...(mode ? { units: (input.units ?? []).map((u) => u.number) } : {}),
    });
    await rememberMovements(tx, ctx, "inventory.transferred", written);
    return written;
  });
}

/** What a job has consumed, at cost, for job costing. */
export async function costOfJob(ctx: ServiceContext, input: { jobId: string }) {
  return guardedRead(ctx, "inventory:read", async (tx) => {
    const costed = inv.costMovements({
      movements: await history(tx),
      method: "fifo",
      currency: "USD",
    });
    if (!costed.ok) throw new ConflictError(inv.explainRefusal(costed));

    /** Net of any unit that came back off the job, at the cost it left at. */
    const byJob = inv.cogsByJob(costed.issues, "USD", costed.returns);
    return m.toString(byJob.get(input.jobId) ?? m.zero("USD"));
  });
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function purchaseOrders(ctx: ServiceContext) {
  return guardedRead(ctx, "po:read", async (tx) => {
    const orders = await tx.select().from(schema.purchaseOrder)
      .where(isNull(schema.purchaseOrder.deletedAt))
      .orderBy(desc(schema.purchaseOrder.number));
    if (orders.length === 0) return [];

    const vendors = await tx.select().from(schema.vendor);
    const lines = await tx.select().from(schema.purchaseOrderLine);
    const vendorOf = new Map(vendors.map((v) => [v.id, v.name]));

    return orders.map((order) => {
      const mine = lines.filter((l) => l.purchaseOrderId === order.id);
      return {
        id: order.id,
        number: order.number,
        status: order.status,
        vendorName: vendorOf.get(order.vendorId) ?? "",
        expectedAt: order.expectedAt,
        lineCount: mine.length,
        total: m.toString(approvals.totalOf(mine)),
        outstanding: mine.some((l) =>
          inv.quantity(l.quantityReceived) < inv.quantity(l.quantityOrdered)),
      };
    });
  });
}

export interface ReceiptChargeInput {
  /** As the vendor's bill names it: "Freight", "Fuel surcharge", "Hazmat fee". */
  description: string;
  amount: string;
}

/**
 * Receive a delivery against an order, with what came on the truck and what
 * the truck cost.
 *
 * LANDED COST. Freight and fees on this delivery are spread over the lines
 * that arrived on it, by value or by quantity, and folded into each line's
 * cost layer, so a part bought for forty dollars with three dollars of
 * freight on it is issued to the job at forty three. Each share is kept on
 * its movement as well, so the receipt can still say what was the goods and
 * what was the carrier. Only this delivery's lines carry this delivery's
 * freight: the second drop of a split shipment paid its own.
 *
 * A TRACKED LINE names its serials or lots, and the line's landed cost is
 * allocated across them.
 */
export async function receivePurchaseOrder(
  ctx: ServiceContext,
  input: {
    purchaseOrderId: string;
    lines: { lineId: string; quantity: string; units?: readonly UnitInput[] | undefined }[];
    charges?: readonly ReceiptChargeInput[] | undefined;
    basis?: inv.LandedCostBasis | undefined;
  },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const seen = await once.replayed<{ status: string; receiptId: string; chargesTotal: string }>(tx, ctx, "purchase_order_receipt");
    if (seen) return seen;

    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(and(
        eq(schema.purchaseOrder.id, input.purchaseOrderId),
        isNull(schema.purchaseOrder.deletedAt),
      )).limit(1);
    if (!order) throw new NotFoundError("Purchase order");

    const rows = await tx.select().from(schema.purchaseOrderLine)
      .where(eq(schema.purchaseOrderLine.purchaseOrderId, order.id));

    const charges = (input.charges ?? []).map((charge) => ({
      description: charge.description.trim(), amount: m.money(charge.amount, "USD"),
    }));
    for (const charge of charges) {
      if (charge.description === "") throw new ConflictError("Say what each charge on the delivery is for, as the vendor's bill names it.");
      if (m.isNegative(charge.amount)) {
        throw new ConflictError("A charge on a delivery cannot be negative. A credit from the vendor is a return or a credit note, not freight.");
      }
    }
    const chargesTotal = m.sum(charges.map((c) => c.amount), "USD");

    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();

    /**
     * Every receipt line carries its own stamp, because each one becomes a
     * movement and every movement needs its own place in the total order.
     * Sharing one stamp across a delivery would give three arriving parts the
     * same sequence number and make the history unorderable. Restamped below
     * when a tracked line is cut into one movement per unit.
     */
    const decision = inv.receivePurchaseOrder({
      purchaseOrder: toCore(order, rows),
      receipts: input.lines.map((line, index) => ({
        lineId: line.lineId,
        quantity: inv.quantity(line.quantity),
        movement: { id: crypto.randomUUID(), sequence: sequence + index, occurredAt },
      })),
      now: occurredAt,
    });
    if (!decision.ok) throw new ConflictError(inv.explainRefusal(decision));

    const [receipt] = await tx.insert(schema.purchaseOrderReceipt).values({
      organizationId: ctx.actor.organizationId,
      purchaseOrderId: order.id,
      receivedAt: occurredAt,
      receivedByUserId: ctx.actor.userId,
      basis: input.basis ?? "value",
      chargesTotal: m.toString(chargesTotal),
    }).returning({ id: schema.purchaseOrderReceipt.id });
    if (charges.length > 0) {
      await tx.insert(schema.purchaseOrderReceiptCharge).values(charges.map((charge) => ({
        organizationId: ctx.actor.organizationId,
        receiptId: receipt!.id,
        description: charge.description,
        amount: m.toString(charge.amount),
      })));
    }

    /** The freight, spread over exactly the movements this delivery made. */
    const shares = inv.allocateLandedCost(
      chargesTotal,
      decision.movements.map((mv) => ({ lineId: mv.id, value: mv.totalCost ?? m.zero("USD"), quantity: mv.quantity })),
      input.basis ?? "value",
    );
    const shareOf = new Map(shares.map((s) => [s.lineId, s.share]));
    const landed = decision.movements.map((mv) => ({
      ...mv,
      totalCost: m.add(mv.totalCost ?? m.zero("USD"), shareOf.get(mv.id) ?? m.zero("USD")),
    }));

    /** Tracked lines cut into one movement per unit, then the whole delivery restamped in order. */
    const pieces: { movement: inv.Movement; landed: m.Money }[] = [];
    const deliveredUnits = new Set<string>();
    for (const movement of landed) {
      const line = input.lines.find((l) => l.lineId === movement.purchaseOrderLineId);
      const mode = await trackingOf(tx, movement.itemId);
      const share = shareOf.get(movement.id) ?? m.zero("USD");
      if (!mode) {
        await refuseUnitsOnUntracked(tx, movement.itemId, line?.units);
        pieces.push({ movement, landed: share });
        continue;
      }
      const picks = await arrivingUnits(tx, ctx, {
        itemId: movement.itemId, mode, quantity: movement.quantity, units: line?.units ?? [],
        movements: await history(tx, movement.itemId),
      });
      for (const pick of picks) {
        if (deliveredUnits.has(pick.lotId)) {
          throw new ConflictError("The same serial number is on two lines of this delivery. Each unit arrives once.");
        }
        deliveredUnits.add(pick.lotId);
      }
      const split = inv.splitAcrossUnits(movement, picks, stampsFrom(0, picks.length, occurredAt));
      const splitShares = m.allocate(share, picks.map((p) => inv.quantityToString(p.quantity)), 4);
      split.forEach((piece, i) => pieces.push({ movement: piece, landed: splitShares[i] ?? m.zero("USD") }));
    }
    const stamped = pieces.map((piece, i) => ({
      ...piece,
      movement: { ...piece.movement, id: crypto.randomUUID(), sequence: sequence + i },
    }));
    const extras: MovementExtras = new Map(stamped.map((piece) => [piece.movement.id, {
      receiptId: receipt!.id,
      ...(m.isZero(piece.landed) ? {} : { landedCost: m.toString(piece.landed) }),
    }]));

    await writeMovements(tx, ctx, stamped.map((p) => p.movement), extras);

    /**
     * The received totals and the status are written from the order core
     * returned, never accumulated here. A partial receipt is the case that
     * goes wrong: three of five arrive, two are still owed, and a service
     * that closed the order on any receipt loses the other two forever.
     */
    for (const line of decision.purchaseOrder.lines) {
      await tx.update(schema.purchaseOrderLine)
        .set({ quantityReceived: inv.quantityToString(line.quantityReceived), updatedAt: new Date() })
        .where(eq(schema.purchaseOrderLine.id, line.id));
    }
    await tx.update(schema.purchaseOrder)
      .set({ status: decision.purchaseOrder.status, updatedAt: new Date() })
      .where(eq(schema.purchaseOrder.id, order.id));

    await audit(tx, ctx, "purchase_order.received", "purchase_order", order.id, order, {
      status: decision.purchaseOrder.status, receiptId: receipt!.id, chargesTotal: m.toString(chargesTotal),
    });
    const answer = {
      status: decision.purchaseOrder.status as string,
      receiptId: receipt!.id,
      chargesTotal: m.toString(m.round(chargesTotal, 2)),
    };
    await once.remember(tx, ctx, "purchase_order_receipt", receipt!.id, answer);
    return answer;
  });
}

/** Unwrapped, for a caller already inside a tenant transaction. */
export async function levelsIn(tx: Database, itemId: string) {
  return inv.deriveLevels(await history(tx, itemId));
}

export { inTenant };

/**
 * WHO WE BUY FROM, AND THE ORDER WE SEND THEM.
 *
 * `vendor`, `purchase_order` and `purchase_order_line` were written by
 * nothing. `receivePurchaseOrder` above updates a line and an order, and
 * `toOrder` suggests what to buy, and there was no way to turn a suggestion
 * into an order or to name anybody to send it to. The purchasing screen was
 * permanently empty and the receiving path updated rows that could not exist.
 *
 * I wrote those three tables myself, in the commit that added this module,
 * and did not give them a create path. That is the defect this codebase
 * treats as its most serious, committed by the person most recently complaining
 * about it.
 *
 * `inv.LEGAL_TRANSITIONS` and `inv.canTransition` were exported and called by
 * nothing for the same reason: there was no order whose status could move.
 */
export async function createVendor(
  ctx: ServiceContext,
  input: { name: string; accountNumber?: string; email?: string; phone?: string },
) {
  return guardedWrite(ctx, "vendor:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A vendor needs a name.");

    /**
     * One vendor per name, because a purchase order and a bill both find a
     * supplier by it, and two rows for "Ferguson" split a company's spend in
     * half on every report. `services/duplicates.ts`.
     */
    const [row] = await refusingDuplicate(
      "vendor_name_idx",
      `${name} is already a vendor here. Two rows for one supplier split their spend across every `
      + `report, so open the one that exists rather than adding a second.`,
      () => tx.insert(schema.vendor).values({
        organizationId: ctx.actor.organizationId,
        name,
        accountNumber: input.accountNumber?.trim() || null,
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
      }).returning(),
    );

    await audit(tx, ctx, "vendor.created", "vendor", row!.id, null, row!);
    return { id: row!.id, name: row!.name };
  });
}

export async function vendors(ctx: ServiceContext) {
  return guardedRead(ctx, "vendor:read", async (tx) => {
    const rows = await tx.select({
      id: schema.vendor.id,
      name: schema.vendor.name,
      accountNumber: schema.vendor.accountNumber,
      email: schema.vendor.email,
      phone: schema.vendor.phone,
      active: schema.vendor.active,
    }).from(schema.vendor)
      .where(isNull(schema.vendor.deletedAt))
      .orderBy(asc(schema.vendor.name));
    return rows;
  });
}

/** A line as a person or a client writes it: our item or their part number, how many of ours, and a price. */
export interface OrderLineInput {
  /** Our item. Either this or the vendor's part number. */
  itemId?: string | undefined;
  /** The vendor's own number for the part, or our item code, looked up for this vendor. */
  partNumber?: string | undefined;
  locationId?: string | undefined;
  /** How many of OUR units: 250 wire nuts, never "10 boxes". */
  quantity: string;
  /** What the vendor charges for one of ours. Their price on record, at the break the order reaches, when left out. */
  unitPrice?: string | undefined;
}

interface ResolvedLine {
  itemId: string;
  vendorPartNumber: string | null;
  locationId: string;
  quantityOrdered: string;
  unitPrice: string;
  packQuantity: string;
  purchaseUnit: string | null;
  packPrice: string | null;
}

/**
 * EACH LINE IS LOOKED UP, NOT TYPED, and priced as the vendor sells it.
 *
 * A line names our item or the vendor's part number, and either way it is
 * resolved against what this vendor calls the part, so the order carries
 * THEIR number (which is what their counter reads) and their price on
 * record unless somebody gives another. A part nobody can find is refused
 * in words rather than sent to the vendor as a guess.
 *
 * A VENDOR THAT SELLS BY THE PACK is sent whole packs. Thirty wire nuts
 * from a supplier who sells boxes of 25 is refused with the two quantities
 * that would go, rather than rounded up into money nobody chose to spend.
 * The price is their price for the pack at the break the order reaches,
 * and our unit price is that over the pack.
 */
async function resolveLines(
  tx: Database, vendorId: string, defaultLocationId: string, lines: readonly OrderLineInput[],
): Promise<ResolvedLine[]> {
  if (lines.length === 0) throw new ConflictError("An order with no lines is not an order.");
  for (const line of lines) {
    if (inv.quantity(line.quantity) <= inv.quantity("0")) {
      throw new ConflictError("Every line needs a positive quantity.");
    }
  }
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const part = await resolvePart(tx, vendorId, {
      ...(line.itemId ? { itemId: line.itemId } : {}),
      ...(line.partNumber ? { partNumber: line.partNumber } : {}),
    });
    const quantity = inv.quantityToString(inv.quantity(line.quantity));
    const pack = part.packQuantity;
    const byPack = m.compare(m.money(pack), m.money("1")) !== 0;
    const named = part.partNumber ?? line.partNumber ?? "that part";
    let packs = quantity;
    if (byPack) {
      const whole = catalogue.packsIn(quantity, pack);
      if (!whole.ok) {
        const unit = part.purchaseUnit ?? "pack";
        throw new ConflictError(
          `This vendor sells ${named} by the ${unit} of ${inv.quantityLabel(inv.quantity(pack))}. `
          + `Order ${whole.below === "0" ? whole.above : `${whole.below} or ${whole.above}`}, not ${inv.quantityLabel(inv.quantity(quantity))}.`,
        );
      }
      packs = whole.packs;
    }
    const typed = line.unitPrice?.trim();
    let unitPrice: string;
    let packPrice: string | null = null;
    if (typed) {
      unitPrice = typed;
      if (byPack) packPrice = m.toString(m.multiply(m.money(typed), pack));
    } else {
      if (!part.cost) {
        throw new ConflictError(
          `There is no price on record from this vendor for ${named}. Give the price they quoted for one.`,
        );
      }
      const priced = catalogue.packPriceFor(part.cost, part.priceBreaks, packs);
      unitPrice = catalogue.eachCost(priced.cost, pack);
      if (byPack) packPrice = priced.cost;
    }
    resolved.push({
      itemId: part.itemId,
      vendorPartNumber: part.partNumber,
      /**
       * Per line, falling back to the order's default. A vendor drops the
       * condensers at the shop and the filters straight onto a van more
       * often than it sounds, and one location on the order means somebody
       * receives the whole thing to the warehouse and then transfers half
       * of it, or simply does not.
       */
      locationId: line.locationId ?? defaultLocationId,
      quantityOrdered: quantity,
      unitPrice,
      packQuantity: pack,
      purchaseUnit: byPack ? part.purchaseUnit : null,
      packPrice,
    });
  }
  return resolved;
}

async function insertLines(tx: Database, ctx: ServiceContext, orderId: string, lines: readonly ResolvedLine[]) {
  await tx.insert(schema.purchaseOrderLine).values(lines.map((line, index) => ({
    organizationId: ctx.actor.organizationId,
    purchaseOrderId: orderId,
    itemId: line.itemId,
    /** As it stands today, copied: the order says what it said when it went out. */
    vendorPartNumber: line.vendorPartNumber,
    locationId: line.locationId,
    quantityOrdered: line.quantityOrdered,
    unitPrice: line.unitPrice,
    packQuantity: line.packQuantity,
    purchaseUnit: line.purchaseUnit,
    packPrice: line.packPrice,
    sortOrder: index,
  })));
}

/**
 * Turn what the shelf says into an order somebody can send.
 *
 * Lines are supplied rather than taken wholesale from `toOrder`, because the
 * suggestion is advice and the order is a commitment. A person decides which
 * of the suggestions to act on and at what price, and a system that placed
 * them automatically would be buying stock on the strength of a reorder point
 * nobody has revisited since the day it was typed.
 *
 * An order an approval step applies to tells that step's approvers by email
 * that it waits for them, when the company's email is connected.
 */
export async function createPurchaseOrder(
  ctx: ServiceContext,
  input: {
    vendorId: string;
    defaultLocationId: string;
    expectedAt?: Date;
    notes?: string;
    lines: OrderLineInput[];
  },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const seen = await once.replayed<{ id: string; number: number; status: string }>(tx, ctx, "purchase_order");
    if (seen) return seen;

    const [vendor] = await tx.select({ id: schema.vendor.id })
      .from(schema.vendor)
      .where(and(eq(schema.vendor.id, input.vendorId), isNull(schema.vendor.deletedAt)))
      .limit(1);
    if (!vendor) throw new NotFoundError("Vendor");

    const resolved = await resolveLines(tx, input.vendorId, input.defaultLocationId, input.lines);

    /**
     * The number is per organization and sequential, like an invoice's. A
     * vendor asking "which PO was that" needs an answer shorter than a uuid,
     * and the uuid is not something a person reads down a phone.
     */
    const number = await nextNumber(tx, ctx.actor.organizationId, "purchase_order");

    const [order] = await tx.insert(schema.purchaseOrder).values({
      organizationId: ctx.actor.organizationId,
      number,
      vendorId: input.vendorId,
      defaultLocationId: input.defaultLocationId,
      status: "draft",
      expectedAt: input.expectedAt ?? null,
      notes: input.notes ?? null,
      createdByUserId: ctx.actor.userId,
    }).returning();

    await insertLines(tx, ctx, order!.id, resolved);

    await audit(tx, ctx, "purchase_order.created", "purchase_order", order!.id, null,
      { number, vendorId: input.vendorId, lines: input.lines.length });
    await approvals.tellApproversWithin(tx, ctx, order!.id);

    const answer = { id: order!.id, number, status: order!.status };
    await once.remember(tx, ctx, "purchase_order", order!.id, answer);
    return answer;
  });
}

/**
 * CHANGE AN ORDER BEFORE IT GOES TO THE VENDOR.
 *
 * Only a draft: once the vendor has it, a change is a phone call and a new
 * order, because the one they hold is what they will ship. The lines are
 * replaced whole, through the same lookup and pack rules as a new order.
 *
 * AN EDIT THAT RAISES THE TOTAL ABOVE WHAT WAS APPROVED SENDS IT BACK. Each
 * approval copied the total it said yes to; any approval the new total is
 * above is set aside (kept as the record that it was given) and the step
 * asks again, and its approvers are told. An edit at or under every
 * approved total leaves the approvals standing. A rejected order is not
 * edited back to life: it is cancelled and a corrected one raised, as a
 * rejection says.
 */
export async function editPurchaseOrder(
  ctx: ServiceContext,
  input: {
    id: string;
    defaultLocationId?: string | undefined;
    expectedAt?: Date | null | undefined;
    notes?: string | null | undefined;
    lines: readonly OrderLineInput[];
  },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    type Edited = { id: string; total: string; askedAgain: number[]; approval: string };
    const seen = await once.replayed<Edited>(tx, ctx, "purchase_order.edited");
    if (seen) return seen;

    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(and(eq(schema.purchaseOrder.id, input.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
    if (!order) throw new NotFoundError("Purchase order");
    if (order.status !== "draft") {
      throw new ConflictError(
        `This order is ${inv.PURCHASE_ORDER_STATUS[order.status as inv.PurchaseOrderStatus].label.toLowerCase()}, so the vendor already has it. `
        + "Ring them with the change, and raise a new order for anything extra.",
      );
    }
    const before = await approvals.planWithin(tx, order.id);
    if (before.plan.state === "rejected") throw new ConflictError(before.plan.sentence);

    const defaultLocationId = input.defaultLocationId ?? order.defaultLocationId;
    const resolved = await resolveLines(tx, order.vendorId, defaultLocationId, input.lines);
    await tx.delete(schema.purchaseOrderLine).where(eq(schema.purchaseOrderLine.purchaseOrderId, order.id));
    await insertLines(tx, ctx, order.id, resolved);
    await tx.update(schema.purchaseOrder).set({
      defaultLocationId,
      ...(input.expectedAt !== undefined ? { expectedAt: input.expectedAt } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.purchaseOrder.id, order.id));

    const askedAgain = await approvals.setAsideAbove(tx, order.id);
    const after = await approvals.planWithin(tx, order.id);
    await audit(tx, ctx, "purchase_order.edited", "purchase_order", order.id,
      { total: m.toString(before.total) },
      { total: m.toString(after.total), lines: resolved.length, askedAgain });
    await approvals.tellApproversWithin(tx, ctx, order.id);

    const answer: Edited = {
      id: order.id, total: m.toString(after.total), askedAgain, approval: after.plan.sentence,
    };
    await once.remember(tx, ctx, "purchase_order.edited", order.id, answer);
    return answer;
  });
}

/**
 * One order, line by line, as it would be read to the vendor: their part
 * number, our item, how many, at what, where it is going, and how much has
 * arrived.
 */
export async function purchaseOrder(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "po:read", async (tx) => {
    const [order] = await tx.select({
      order: schema.purchaseOrder,
      vendorName: schema.vendor.name,
      vendorAccount: schema.vendor.accountNumber,
    })
      .from(schema.purchaseOrder)
      .innerJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseOrder.vendorId))
      .where(and(eq(schema.purchaseOrder.id, input.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
    if (!order) throw new NotFoundError("Purchase order");

    const lines = await tx.select({
      line: schema.purchaseOrderLine,
      itemCode: schema.priceBookItem.code,
      locationName: schema.location.name,
    })
      .from(schema.purchaseOrderLine)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.purchaseOrderLine.itemId))
      .innerJoin(schema.location, eq(schema.location.id, schema.purchaseOrderLine.locationId))
      .where(eq(schema.purchaseOrderLine.purchaseOrderId, input.id))
      .orderBy(asc(schema.purchaseOrderLine.sortOrder));

    const names = await itemNames(tx, lines.map((l) => l.line.itemId));
    const total = approvals.totalOf(lines.map((l) => l.line));

    /**
     * What arrived, delivery by delivery, with the freight that came on each
     * and the serials or lots each line brought. The freight spread onto a
     * line is shown beside what the goods cost, because "the parts were four
     * hundred and the truck was twelve" is what a buyer checks against the
     * vendor's bill.
     */
    const receipts = await tx.select().from(schema.purchaseOrderReceipt)
      .where(eq(schema.purchaseOrderReceipt.purchaseOrderId, input.id))
      .orderBy(asc(schema.purchaseOrderReceipt.receivedAt));
    const charges = receipts.length === 0 ? [] : await tx.select().from(schema.purchaseOrderReceiptCharge)
      .where(inArray(schema.purchaseOrderReceiptCharge.receiptId, receipts.map((r) => r.id)));
    /** Freight and duty billed after each delivery, with where it went. */
    const bills = receipts.length === 0 ? [] : await tx.select().from(schema.landedCostBill)
      .where(inArray(schema.landedCostBill.receiptId, receipts.map((r) => r.id)))
      .orderBy(asc(schema.landedCostBill.createdAt));
    const billCharges = bills.length === 0 ? [] : await tx.select().from(schema.landedCostBillCharge)
      .where(inArray(schema.landedCostBillCharge.billId, bills.map((b) => b.id)));
    const cents = (v: string) => m.toString(m.round(m.money(v), 2));
    const arrived = await tx.select({
      lineId: schema.stockMovement.purchaseOrderLineId,
      landedCost: schema.stockMovement.landedCost,
      lotNumber: schema.stockLot.number,
      lotId: schema.stockLot.id,
    }).from(schema.stockMovement)
      .leftJoin(schema.stockLot, eq(schema.stockLot.id, schema.stockMovement.lotId))
      .where(and(eq(schema.stockMovement.purchaseOrderId, input.id), eq(schema.stockMovement.kind, "receipt")));
    const tracked = lines.length === 0 ? [] : await tx.select({ itemId: schema.stockTracking.itemId, mode: schema.stockTracking.mode })
      .from(schema.stockTracking)
      .where(inArray(schema.stockTracking.itemId, lines.map((l) => l.line.itemId)));
    const modeOf = new Map(tracked.map((t) => [t.itemId, t.mode]));

    return {
      id: order.order.id,
      number: order.order.number,
      status: order.order.status,
      vendorId: order.order.vendorId,
      vendorName: order.vendorName,
      vendorAccount: order.vendorAccount,
      expectedAt: order.order.expectedAt?.toISOString() ?? null,
      submittedAt: order.order.submittedAt?.toISOString() ?? null,
      notes: order.order.notes,
      total: m.toString(m.round(total, 2)),
      lines: lines.map((l) => ({
        id: l.line.id,
        itemId: l.line.itemId,
        itemCode: l.itemCode,
        itemName: names.get(l.line.itemId) ?? l.itemCode,
        vendorPartNumber: l.line.vendorPartNumber,
        locationId: l.line.locationId,
        locationName: l.locationName,
        quantityOrdered: inv.quantityToString(inv.quantity(l.line.quantityOrdered)),
        quantityReceived: inv.quantityToString(inv.quantity(l.line.quantityReceived)),
        unitPrice: l.line.unitPrice,
        lineTotal: cents(m.toString(approvals.totalOf([l.line]))),
        /** Sold by the pack: how many packs of how many, called what, at what each. Null when by our unit. */
        packs: l.line.packPrice && inv.quantity(l.line.packQuantity) !== inv.quantity("1")
          ? {
            count: inv.quantityLabel(inv.quantity(l.line.quantityOrdered) / inv.quantity(l.line.packQuantity) * inv.quantity("1")),
            size: inv.quantityLabel(inv.quantity(l.line.packQuantity)),
            unit: l.line.purchaseUnit,
            price: cents(l.line.packPrice),
          }
          : null,
        tracking: modeOf.get(l.line.itemId) ?? null,
        landedCost: m.toString(m.round(m.sum(arrived
          .filter((a) => a.lineId === l.line.id && a.landedCost !== null)
          .map((a) => m.money(a.landedCost!))), 2)),
        units: arrived.filter((a) => a.lineId === l.line.id && a.lotId !== null)
          .map((a) => ({ id: a.lotId!, number: a.lotNumber! })),
      })),
      receipts: receipts.map((r) => ({
        id: r.id,
        receivedAt: r.receivedAt.toISOString(),
        basis: r.basis,
        chargesTotal: m.toString(m.round(m.money(r.chargesTotal), 2)),
        charges: charges.filter((c) => c.receiptId === r.id)
          .map((c) => ({ description: c.description, amount: m.toString(m.round(m.money(c.amount), 2)) })),
        lateBills: bills.filter((b) => b.receiptId === r.id).map((b) => ({
          id: b.id,
          recordedAt: b.createdAt.toISOString(),
          reference: b.reference,
          basis: b.basis,
          total: cents(b.total),
          onShelf: cents(b.onShelf),
          onJobs: cents(b.onJobs),
          onGone: cents(b.onGone),
          charges: billCharges.filter((c) => c.billId === b.id)
            .map((c) => ({ description: c.description, amount: cents(c.amount) })),
        })),
      })),
      approval: (await approvals.planWithin(tx, input.id)).view,
      approvalNotices: await approvals.noticesWithin(tx, input.id),
      sends: await sendsWithin(tx, input.id),
    };
  });
}

/** Each item's name as it stands today, from the version in force. */
async function itemNames(tx: Database, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
    .from(schema.priceBookItemVersion)
    .where(and(inArray(schema.priceBookItemVersion.itemId, [...new Set(itemIds)]), inForceAt()));
  return new Map(rows.map((r) => [r.itemId, r.name] as const));
}

/**
 * Moving an order along, through the transitions core already declares.
 *
 * `inv.canTransition` existed and was called by nothing, because nothing
 * could create an order whose status could move. A received order cannot go
 * back to draft, and a cancelled one is finished: both are absorbing states,
 * and letting somebody reopen one is how stock gets received twice against
 * the same promise.
 */
export async function setPurchaseOrderStatus(
  ctx: ServiceContext,
  input: { id: string; status: inv.PurchaseOrderStatus },
) {
  /**
   * SENDING IT TO THE VENDOR IS WHERE APPROVAL IS CHECKED. Everything else on
   * this function is bookkeeping about an order that already exists.
   *
   * Guarding the whole transition on `po:approve` would stop a buyer
   * cancelling their own draft, which makes the permission something people
   * work around. Guarding it all on `po:write` would let anybody who can
   * type an order commit the company to paying for it, which is the thing
   * approval exists to prevent.
   *
   * Where the company has declared approval steps and one applies to this
   * order's total, the steps ARE the approval: once every one has said yes,
   * the buyer who wrote it may send it. Where no step applies, it is the
   * sender's own `po:approve`, as it always was. `submitWithin` decides which.
   */
  const permission = input.status === "submitted" && !can(ctx.actor, "po:write") ? "po:approve" as const : "po:write" as const;
  return guardedWrite(ctx, permission, async (tx) => {
    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, input.id)).limit(1);
    if (!order) throw new NotFoundError("Purchase order");

    const from = order.status as inv.PurchaseOrderStatus;
    if (from === input.status) return { id: order.id, status: from };

    if (!inv.canTransition(from, input.status)) {
      throw new ConflictError(
        `A ${inv.PURCHASE_ORDER_STATUS[from].label.toLowerCase()} order cannot become `
        + `${inv.PURCHASE_ORDER_STATUS[input.status].label.toLowerCase()}.`,
      );
    }
    if (input.status === "submitted") {
      await submitWithin(tx, ctx, order);
      return { id: order.id, status: "submitted" as const };
    }

    await tx.update(schema.purchaseOrder).set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.purchaseOrder.id, input.id));
    await audit(tx, ctx, "purchase_order.status", "purchase_order", input.id,
      { status: from }, { status: input.status });
    return { id: order.id, status: input.status };
  });
}

/**
 * May this draft go to the vendor, and on whose say so. Refuses an order
 * whose approval steps are waiting or rejected, and an order no step applies
 * to unless the sender holds `po:approve`.
 */
export async function assertSubmittable(
  tx: Database, ctx: ServiceContext, order: typeof schema.purchaseOrder.$inferSelect,
): Promise<inv.ApprovalPlan> {
  if (order.status !== "draft") {
    throw new ConflictError(
      `A ${inv.PURCHASE_ORDER_STATUS[order.status as inv.PurchaseOrderStatus].label.toLowerCase()} order has already gone to the vendor.`,
    );
  }
  const { plan } = await approvals.planWithin(tx, order.id);
  if (plan.state === "waiting" || plan.state === "rejected") throw new ConflictError(plan.sentence);
  if (plan.state === "not_needed") assertCan(ctx.actor, "po:approve");
  return plan;
}

/**
 * A draft becomes an order the vendor has: approval checked, stamped as sent.
 * Shared by the status call and by emailing, so the two cannot disagree about
 * what approval means.
 */
export async function submitWithin(
  tx: Database, ctx: ServiceContext, order: typeof schema.purchaseOrder.$inferSelect,
): Promise<void> {
  const plan = await assertSubmittable(tx, ctx, order);

  await tx.update(schema.purchaseOrder).set({
    status: "submitted",
    /**
     * Stamped once, when it actually goes out. The question a buyer asks a
     * week later is "when did we send this", and a status alone cannot
     * answer it.
     */
    ...(!order.submittedAt ? { submittedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.purchaseOrder.id, order.id));
  await audit(tx, ctx, "purchase_order.status", "purchase_order", order.id,
    { status: order.status }, { status: "submitted", approval: plan.state });
}

/**
 * GIVE BACK WHAT A JOB NO LONGER NEEDS.
 *
 * `inv.planRelease` is the third member of the commit / issue / release trio
 * and was called by nothing. The other two are wired; this one was not, and
 * the gap is not cosmetic.
 *
 * A reservation is a `commit` movement with a job on it, and `deriveLevels`
 * subtracts every OPEN commitment from available. Without a release there is
 * no way to close one, so a cancelled job holds its parts forever: the shelf
 * shows them, the available figure does not, and the reorder engine keeps
 * buying against a shortfall that only exists because of a job nobody is
 * going to do. Nothing in the product detects it, because the numbers are
 * all internally consistent.
 */
export async function release(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; jobId: string; quantity: string },
) {
  return (await decide(ctx, "inventory:adjust", ({ level, stamp, movements }) => {
    /**
     * Never more than the job is actually holding.
     *
     * `planRelease` clamps nothing and says so: it refuses only a
     * non-positive quantity. Releasing four against a reservation of one
     * writes a release the fold then subtracts, and the commitment goes
     * NEGATIVE, which reads as the job having lent stock to the shelf.
     */
    const held = inv.commitmentFor(movements, input.itemId, input.locationId, input.jobId);
    const want = inv.quantity(input.quantity);
    if (want > held) {
      throw new ConflictError(
        `That job is holding ${inv.quantityLabel(held)}, not ${inv.quantityLabel(want)}.`,
      );
    }

    return inv.planRelease({ level, quantity: want, jobId: input.jobId, stamp });
  }, input, "inventory.released")).rows;
}

/**
 * Everything a job is still holding, released in one go.
 *
 * Called when a job is cancelled. Returns what it gave back rather than
 * nothing, because "we freed four parts" is the sentence a dispatcher needs
 * and "done" is not.
 */
export async function releaseAllFor(
  ctx: ServiceContext, input: { jobId: string },
): Promise<{ released: Array<{ itemId: string; locationId: string; quantity: string }> }> {
  const open = await guardedRead(ctx, "inventory:read", async (tx) =>
    inv.deriveCommitments(await history(tx)).filter((c) => c.jobId === input.jobId));

  const released: Array<{ itemId: string; locationId: string; quantity: string }> = [];
  /**
   * Without the caller's idempotency key: one key across several releases
   * would make the second one replay the first and free nothing.
   */
  const { idempotencyKey: _key, ...each } = ctx;
  for (const commitment of open) {
    /**
     * One at a time, each through the same path a person would use. Writing
     * the movements directly would be a second way to release stock, and the
     * second way written is the one that forgets the clamp above.
     */
    await release(each, {
      itemId: commitment.itemId,
      locationId: commitment.locationId,
      jobId: input.jobId,
      quantity: inv.quantityToString(commitment.quantity),
    });
    released.push({
      itemId: commitment.itemId,
      locationId: commitment.locationId,
      quantity: inv.quantityLabel(commitment.quantity),
    });
  }

  return { released };
}

/* --------------------------------------------------------------- handlers */

/**
 * The contract shapes.
 *
 * Thin on purpose: every one of these is a rename or an envelope, and the
 * deciding is all above. A handler layer that did arithmetic would be a
 * second place where a quantity could be misread, and the whole point of the
 * scaled integer is that there is only one.
 */
/**
 * A movement, cut down to what the contract publishes.
 *
 * The row carries `organizationId`, `recordedByUserId` and the soft delete
 * columns, and none of them belong on the wire: the organization is the
 * caller's own, so it is noise, and the other two are this database's
 * bookkeeping rather than facts about the part that moved. Shaping here
 * rather than letting zod strip them on the way out keeps the document
 * EXACT, which is the only version of it worth generating a client from.
 */
export interface MovementOnTheWire {
  id: string;
  itemId: string;
  locationId: string;
  kind: string;
  quantity: string;
  totalCost: string | null;
  jobId: string | null;
  transferId: string | null;
  reasonCode: string | null;
  lotId: string | null;
  sequence: number;
  occurredAt: Date;
}

const onTheWire = (rows: readonly (typeof schema.stockMovement.$inferSelect)[]): MovementOnTheWire[] =>
  rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    locationId: row.locationId,
    kind: row.kind,
    quantity: row.quantity,
    totalCost: row.totalCost,
    jobId: row.jobId,
    transferId: row.transferId,
    reasonCode: row.reasonCode,
    lotId: row.lotId,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
  }));

export const handlers = {
  listStockLevels: async (ctx: ServiceContext) => ({ levels: await levels(ctx) }),

  listCommitments: async (ctx: ServiceContext) => ({ commitments: await commitments(ctx) }),

  /**
   * Spelled out because core's suggestion type would otherwise name its own
   * module path in this table's inferred type. Every quantity is already a
   * label by the time it gets here: core works in scaled integers and the
   * wire never sees one.
   */
  listReorderSuggestions: async (ctx: ServiceContext): Promise<{
    suggestions: {
      itemId: string; itemName: string; locationId: string; locationName: string;
      suggested: string; position: string; availableNow: string;
      onOrder: string; reorderPoint: string; preferredVendorId?: string | undefined;
    }[];
  }> => ({ suggestions: await toOrder(ctx) }),

  getJobMaterialCost: async (ctx: ServiceContext, input: { jobId: string }) => ({
    cost: await costOfJob(ctx, input),
  }),

  reserveStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; jobId: string; quantity: string;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await reserve(ctx, input)) }),

  releaseStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; jobId: string; quantity: string;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await release(ctx, input)) }),

  issueStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; jobId: string; quantity: string;
    units?: readonly UnitInput[] | undefined;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await issue(ctx, input)) }),

  receiveStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; quantity: string; totalCost: string;
    units?: readonly UnitInput[] | undefined;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await receive(ctx, input)) }),

  countStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; counted: string;
    reasonCode?: string | undefined; foundAtCost?: string | undefined;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({
    movements: onTheWire(await count(ctx, {
      itemId: input.itemId,
      locationId: input.locationId,
      counted: input.counted,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.foundAtCost ? { foundAtCost: input.foundAtCost } : {}),
    })),
  }),

  transferStock: async (ctx: ServiceContext, input: {
    itemId: string; fromLocationId: string; toLocationId: string; quantity: string;
    units?: readonly UnitInput[] | undefined;
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await transfer(ctx, input)) }),

  listVendors: async (ctx: ServiceContext) => ({ vendors: await vendors(ctx) }),

  createVendor: (ctx: ServiceContext, input: {
    name: string; accountNumber?: string | undefined;
    email?: string | undefined; phone?: string | undefined;
  }) => createVendor(ctx, {
    name: input.name,
    ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
  }),

  listPurchaseOrders: async (ctx: ServiceContext) => ({
    purchaseOrders: await purchaseOrders(ctx),
  }),

  createPurchaseOrder: (ctx: ServiceContext, input: {
    vendorId: string; defaultLocationId: string;
    expectedAt?: string | undefined; notes?: string | undefined;
    lines: readonly {
      itemId?: string | undefined; partNumber?: string | undefined; locationId?: string | undefined;
      quantity: string; unitPrice?: string | undefined;
    }[];
  }) => createPurchaseOrder(ctx, {
    vendorId: input.vendorId,
    defaultLocationId: input.defaultLocationId,
    ...(input.expectedAt ? { expectedAt: new Date(input.expectedAt) } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    lines: input.lines.map((line) => ({
      ...(line.itemId ? { itemId: line.itemId } : {}),
      ...(line.partNumber ? { partNumber: line.partNumber } : {}),
      ...(line.locationId ? { locationId: line.locationId } : {}),
      quantity: line.quantity,
      ...(line.unitPrice ? { unitPrice: line.unitPrice } : {}),
    })),
  }),

  getPurchaseOrder: (ctx: ServiceContext, input: { id: string }) => purchaseOrder(ctx, input),

  editPurchaseOrder: (ctx: ServiceContext, input: {
    id: string; defaultLocationId?: string | undefined; expectedAt?: string | null | undefined;
    notes?: string | null | undefined;
    lines: readonly {
      itemId?: string | undefined; partNumber?: string | undefined; locationId?: string | undefined;
      quantity: string; unitPrice?: string | undefined;
    }[];
  }): Promise<{ id: string; total: string; askedAgain: number[]; approval: string }> => editPurchaseOrder(ctx, {
    id: input.id,
    ...(input.defaultLocationId ? { defaultLocationId: input.defaultLocationId } : {}),
    ...(input.expectedAt !== undefined ? { expectedAt: input.expectedAt === null ? null : new Date(input.expectedAt) } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    /** Passed as given, so the guard is the first thing the edit meets. */
    lines: input.lines,
  }),

  /**
   * The status union is written out rather than imported from core, so this
   * table's inferred type does not name core's internal module path. The
   * cast is checked by the contract's own enum on the way in.
   */
  setPurchaseOrderStatus: (ctx: ServiceContext, input: {
    id: string;
    status: "draft" | "submitted" | "acknowledged" | "partially_received" | "received" | "cancelled";
  }): Promise<{ id: string; status: string }> => setPurchaseOrderStatus(ctx, input),

  receivePurchaseOrder: (ctx: ServiceContext, input: {
    id: string;
    lines: readonly { lineId: string; quantity: string; units?: readonly UnitInput[] | undefined }[];
    charges?: readonly ReceiptChargeInput[] | undefined;
    basis?: "value" | "quantity" | undefined;
  }): Promise<{ status: string; receiptId: string; chargesTotal: string }> => receivePurchaseOrder(ctx, {
    purchaseOrderId: input.id,
    lines: input.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, units: l.units })),
    charges: input.charges,
    basis: input.basis,
  }),

  listReorderPolicies: async (ctx: ServiceContext): Promise<{ policies: ReorderPolicyView[] }> =>
    ({ policies: await reorderPolicies(ctx) }),

  setReorderPolicy: async (ctx: ServiceContext, input: ReorderPolicyInput): Promise<{
    id: string; itemId: string; locationId: string;
    reorderPoint: string; reorderQuantity: string;
    targetLevel: string | null; preferredVendorId: string | null;
  }> => {
    const row = await setReorderPolicy(ctx, input);
    return {
      id: row.id, itemId: row.itemId, locationId: row.locationId,
      reorderPoint: row.reorderPoint, reorderQuantity: row.reorderQuantity,
      targetLevel: row.targetLevel, preferredVendorId: row.preferredVendorId,
    };
  },

  clearReorderPolicy: (ctx: ServiceContext, input: { itemId: string; locationId: string }): Promise<{
    itemId: string; locationId: string; cleared: boolean;
  }> => clearReorderPolicy(ctx, input),
} as const;
