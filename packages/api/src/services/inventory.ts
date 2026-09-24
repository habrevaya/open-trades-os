import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";
import { nextNumber } from "./jobs";

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
async function history(tx: Database, itemId?: string): Promise<inv.Movement[]> {
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
async function nextSequence(tx: Database, organizationId: string): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${schema.stockMovement.sequence})` })
    .from(schema.stockMovement)
    .where(eq(schema.stockMovement.organizationId, organizationId));
  return (row?.max ?? 0) + 1;
}

async function writeMovements(
  tx: Database, ctx: ServiceContext, movements: readonly inv.Movement[],
) {
  if (movements.length === 0) return [];
  return tx.insert(schema.stockMovement).values(movements.map((movement) => ({
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
    sequence: movement.sequence,
    occurredAt: movement.occurredAt,
    recordedByUserId: ctx.actor.userId,
  }))).returning();
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
    })),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Every write takes the same shape: fold the history, ask core, write what it
 * said. The decision is never made here, so a refusal always carries the
 * sentence core wrote for it rather than one invented at the edge.
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
) {
  return guardedWrite(ctx, permission, async (tx) => {
    const movements = await history(tx, where.itemId);
    const level = inv.deriveLevel(movements, where.itemId, where.locationId);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);

    const decision = plan({
      tx,
      level,
      stamp: { id: crypto.randomUUID(), sequence, occurredAt: new Date() },
      movements,
    });
    if (!decision.ok) throw new ConflictError(inv.explainRefusal(decision));

    const written = await writeMovements(tx, ctx, decision.movements);
    await audit(tx, ctx, event, "price_book_item", where.itemId, null, {
      locationId: where.locationId,
      movements: decision.movements.map((mv) => mv.kind),
    });
    return written;
  });
}

export async function reserve(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; jobId: string; quantity: string },
) {
  return decide(ctx, "inventory:adjust", ({ level, stamp }) =>
    inv.planCommitment({ level, quantity: inv.quantity(input.quantity), jobId: input.jobId, stamp }),
    input, "inventory.reserved");
}

/**
 * Stock onto a job.
 *
 * A job is required, by core and therefore here. An issue with no job is
 * stock leaving the shelf for nobody, which is a real thing that happens and
 * is an ADJUSTMENT rather than an issue: the difference is whether anybody
 * can be told later what the part was for.
 */
export async function issue(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; quantity: string; jobId: string },
) {
  return decide(ctx, "inventory:adjust", ({ level, stamp, movements }) =>
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
    input, "inventory.issued");
}

/**
 * Stock arriving outside a purchase order.
 *
 * Core has no planner for this and does not need one: a receipt refuses
 * nothing, because stock that has physically arrived has arrived whatever the
 * system thinks. The one rule is that it carries what it COST, since a
 * receipt is the only movement that establishes a cost layer, and a receipt
 * with no cost is stock that will be issued at nothing and quietly overstate
 * every job's margin.
 */
export async function receive(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; quantity: string; totalCost: string },
) {
  const quantity = inv.quantity(input.quantity);
  if (quantity <= inv.ZERO_QUANTITY) throw new ConflictError("A receipt has to be for something.");

  return decide(ctx, "inventory:adjust", ({ level, stamp }) => ({
    ok: true,
    movements: [{
      ...stamp,
      itemId: level.itemId,
      locationId: level.locationId,
      kind: "receipt" as const,
      quantity,
      totalCost: m.money(input.totalCost, "USD"),
    }],
  }),
    input, "inventory.received");
}

/**
 * A count, recorded as the correction it is.
 *
 * The counted number is not written anywhere. What is written is the
 * DIFFERENCE, as an adjustment with a reason, so the history still explains
 * every number it produces. A count that overwrote the level would be the one
 * write in this module that destroys evidence.
 */
export async function count(
  ctx: ServiceContext,
  input: { itemId: string; locationId: string; counted: string; reasonCode?: string; foundAtCost?: string },
) {
  return decide(ctx, "inventory:adjust", ({ level, stamp }) =>
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
    input, "inventory.counted");
}

export async function transfer(
  ctx: ServiceContext,
  input: { itemId: string; fromLocationId: string; toLocationId: string; quantity: string },
) {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const movements = await history(tx, input.itemId);
    const from = inv.deriveLevel(movements, input.itemId, input.fromLocationId);
    const sequence = await nextSequence(tx, ctx.actor.organizationId);

    /**
     * Both halves or neither, and core returns them as one array so there is
     * no shape of the return value that lets this write one leg. One leg of a
     * transfer is stock that left a van and arrived nowhere.
     */
    const decision = inv.planTransfer({
      from,
      toLocationId: input.toLocationId,
      quantity: inv.quantity(input.quantity),
      out: { id: crypto.randomUUID(), sequence, occurredAt: new Date() },
      in: { id: crypto.randomUUID(), sequence: sequence + 1, occurredAt: new Date() },
      transferId: crypto.randomUUID(),
    });
    if (!decision.ok) throw new ConflictError(inv.explainRefusal(decision));

    const written = await writeMovements(tx, ctx, decision.movements);
    await audit(tx, ctx, "inventory.transferred", "price_book_item", input.itemId, null, {
      from: input.fromLocationId, to: input.toLocationId, quantity: input.quantity,
    });
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

    const byJob = inv.cogsByJob(costed.issues, "USD");
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
        total: m.toString(m.sum(
          mine.map((l) => m.multiply(m.money(l.unitPrice, "USD"), inv.quantityToString(inv.quantity(l.quantityOrdered)))),
          "USD",
        )),
        outstanding: mine.some((l) =>
          inv.quantity(l.quantityReceived) < inv.quantity(l.quantityOrdered)),
      };
    });
  });
}

export async function receivePurchaseOrder(
  ctx: ServiceContext,
  input: { purchaseOrderId: string; lines: { lineId: string; quantity: string }[] },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(and(
        eq(schema.purchaseOrder.id, input.purchaseOrderId),
        isNull(schema.purchaseOrder.deletedAt),
      )).limit(1);
    if (!order) throw new NotFoundError("Purchase order");

    const rows = await tx.select().from(schema.purchaseOrderLine)
      .where(eq(schema.purchaseOrderLine.purchaseOrderId, order.id));

    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();

    /**
     * Every receipt line carries its own stamp, because each one becomes a
     * movement and every movement needs its own place in the total order.
     * Sharing one stamp across a delivery would give three arriving parts the
     * same sequence number and make the history unorderable.
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

    await writeMovements(tx, ctx, decision.movements);

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

    await audit(tx, ctx, "purchase_order.received", "purchase_order", order.id, order,
      { status: decision.purchaseOrder.status });
    return { status: decision.purchaseOrder.status };
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

    const [row] = await tx.insert(schema.vendor).values({
      organizationId: ctx.actor.organizationId,
      name,
      accountNumber: input.accountNumber?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
    }).returning();

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

/**
 * Turn what the shelf says into an order somebody can send.
 *
 * Lines are supplied rather than taken wholesale from `toOrder`, because the
 * suggestion is advice and the order is a commitment. A person decides which
 * of the suggestions to act on and at what price, and a system that placed
 * them automatically would be buying stock on the strength of a reorder point
 * nobody has revisited since the day it was typed.
 */
export async function createPurchaseOrder(
  ctx: ServiceContext,
  input: {
    vendorId: string;
    defaultLocationId: string;
    expectedAt?: Date;
    notes?: string;
    lines: Array<{
      itemId: string;
      locationId?: string;
      quantity: string;
      unitPrice: string;
    }>;
  },
) {
  return guardedWrite(ctx, "po:write", async (tx) => {
    if (input.lines.length === 0) {
      throw new ConflictError("An order with no lines is not an order.");
    }

    const [vendor] = await tx.select({ id: schema.vendor.id })
      .from(schema.vendor)
      .where(and(eq(schema.vendor.id, input.vendorId), isNull(schema.vendor.deletedAt)))
      .limit(1);
    if (!vendor) throw new NotFoundError("Vendor");

    for (const line of input.lines) {
      if (inv.quantity(line.quantity) <= inv.quantity("0")) {
        throw new ConflictError("Every line needs a positive quantity.");
      }
    }

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

    await tx.insert(schema.purchaseOrderLine).values(
      input.lines.map((line, index) => ({
        organizationId: ctx.actor.organizationId,
        purchaseOrderId: order!.id,
        itemId: line.itemId,
        /**
         * Per line, falling back to the order's default. A vendor drops the
         * condensers at the shop and the filters straight onto a van more
         * often than it sounds, and one location on the order means somebody
         * receives the whole thing to the warehouse and then transfers half
         * of it, or simply does not.
         */
        locationId: line.locationId ?? input.defaultLocationId,
        quantityOrdered: inv.quantityToString(inv.quantity(line.quantity)),
        unitPrice: line.unitPrice,
        sortOrder: index,
      })),
    );

    await audit(tx, ctx, "purchase_order.created", "purchase_order", order!.id, null,
      { number, vendorId: input.vendorId, lines: input.lines.length });

    return { id: order!.id, number, status: order!.status };
  });
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
   * SUBMITTING IS THE APPROVAL. Everything else on this function is
   * bookkeeping about an order that already exists.
   *
   * Guarding the whole transition on `po:approve` would stop a buyer
   * cancelling their own draft, which makes the permission something people
   * work around. Guarding it all on `po:write` would let anybody who can
   * type an order commit the company to paying for it, which is the thing
   * `po:approve` exists to prevent and the reason the two are separate
   * entries in the catalogue at all.
   */
  const permission = input.status === "submitted" ? "po:approve" as const : "po:write" as const;
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

    await tx.update(schema.purchaseOrder).set({
      status: input.status,
      /**
       * Stamped once, when it actually goes out. The question a buyer asks a
       * week later is "when did we send this", and a status alone cannot
       * answer it.
       */
      ...(input.status === "submitted" && !order.submittedAt
        ? { submittedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.purchaseOrder.id, input.id));

    await audit(tx, ctx, "purchase_order.status", "purchase_order", input.id,
      { status: from }, { status: input.status });

    return { id: order.id, status: input.status };
  });
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
  return decide(ctx, "inventory:adjust", ({ level, stamp, movements }) => {
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
  }, input, "inventory.released");
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
  for (const commitment of open) {
    /**
     * One at a time, each through the same path a person would use. Writing
     * the movements directly would be a second way to release stock, and the
     * second way written is the one that forgets the clamp above.
     */
    await release(ctx, {
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
  }): Promise<{ movements: MovementOnTheWire[] }> => ({ movements: onTheWire(await issue(ctx, input)) }),

  receiveStock: async (ctx: ServiceContext, input: {
    itemId: string; locationId: string; quantity: string; totalCost: string;
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
    lines: readonly { itemId: string; locationId?: string | undefined; quantity: string; unitPrice: string }[];
  }) => createPurchaseOrder(ctx, {
    vendorId: input.vendorId,
    defaultLocationId: input.defaultLocationId,
    ...(input.expectedAt ? { expectedAt: new Date(input.expectedAt) } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    lines: input.lines.map((line) => ({
      itemId: line.itemId,
      ...(line.locationId ? { locationId: line.locationId } : {}),
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
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
    id: string; lines: readonly { lineId: string; quantity: string }[];
  }): Promise<{ status: string }> => receivePurchaseOrder(ctx, {
    purchaseOrderId: input.id,
    lines: input.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity })),
  }),
} as const;
