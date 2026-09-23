import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

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
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
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
