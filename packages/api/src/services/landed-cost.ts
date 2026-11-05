import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, ledger, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { history, nextSequence, writeMovements, type MovementExtras } from "./inventory";
import { writePosting } from "./ledger";
import * as once from "./once";
import { inForceAt } from "./pricebook";

/**
 * FREIGHT AND DUTY BILLED AFTER THE DELIVERY
 *
 * The carrier's invoice for a delivery, or the customs broker's duty bill,
 * arrives a week after the truck. Freight typed at the receipt is spread
 * over that delivery's lines; this is the same bill arriving late, and by
 * then some of the parts have moved to a van, some went into a customer's
 * basement on a job that has already been costed, and one was dropped.
 *
 * The arithmetic is core's (`inventory.planLateLandedCost`): spread over the
 * delivery's lines by value or quantity, then each line's share over what
 * became of its parts, to the cent. This file reads the history, asks, and
 * writes what it said:
 *
 *   a revaluation movement for each piece, on the shelf where the parts
 *   still are (so their stock value rises and the next use of them costs
 *   more), or on the use or loss that already took them (so the replayed
 *   cost of that use, and of the job, includes it);
 *
 *   ONE balanced ledger posting through `ledger.postLateLandedCost`: the
 *   shelf share to Inventory, each job's share to cost of goods sold on that
 *   job (which job costing reads), the rest to cost of goods sold with no
 *   job, and the whole bill owed in accounts payable.
 *
 * `po:write`, because recording a vendor's bill against a delivery is the
 * buyer's work, the same as receiving the delivery with its freight.
 */

export interface LateBillInput {
  /** The delivery the bill is for: a receipt against a purchase order. */
  receiptId?: string | undefined;
  /** Or stock that arrived without an order (`stock_receipt`): exactly one of the two. */
  stockReceiptId?: string | undefined;
  /** As the bill shows them. Whole cents. */
  charges: readonly { description: string; amount: string }[];
  /** Spread by what each line cost, or by how many arrived. The delivery's own choice when left out. */
  basis?: inv.LandedCostBasis | undefined;
  /** The carrier's or broker's number for the bill. */
  reference?: string | null | undefined;
}

export interface LateBillView {
  id: string;
  /** Null on a bill for stock received without an order. */
  receiptId: string | null;
  purchaseOrderId: string | null;
  /** Set on a bill for stock received without an order. */
  stockReceiptId: string | null;
  total: string;
  onShelf: string;
  onJobs: string;
  onGone: string;
  /** Each job the bill reached, with its share. */
  jobs: { jobId: string; jobNumber: number | null; amount: string }[];
}

const cents = (value: m.Money) => m.toString(m.round(value, 2));

export function recordLateBill(ctx: ServiceContext, input: LateBillInput): Promise<LateBillView> {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const seen = await once.replayed<LateBillView>(tx, ctx, "landed_cost_bill");
    if (seen) return seen;

    if ((input.receiptId === undefined) === (input.stockReceiptId === undefined)) {
      throw new ConflictError("Name the delivery the bill is for: one against an order, or stock received without one.");
    }
    const receipt = input.receiptId !== undefined
      ? (await tx.select().from(schema.purchaseOrderReceipt)
        .where(eq(schema.purchaseOrderReceipt.id, input.receiptId)).limit(1))[0]
      : undefined;
    const stock = input.stockReceiptId !== undefined
      ? (await tx.select().from(schema.stockReceipt)
        .where(eq(schema.stockReceipt.id, input.stockReceiptId)).limit(1))[0]
      : undefined;
    if (!receipt && !stock) throw new NotFoundError("Delivery");

    if (input.charges.length === 0) throw new ConflictError("Give at least one charge from the bill: freight, duty, a fuel surcharge.");
    const charges = input.charges.map((charge) => ({ description: charge.description.trim(), amount: m.money(charge.amount, "USD") }));
    for (const charge of charges) {
      if (charge.description === "") throw new ConflictError("Say what each charge is for, as the bill names it.");
      if (!m.isPositive(charge.amount)) {
        throw new ConflictError("Each charge on a bill has to be more than nothing. A credit from the carrier is not freight.");
      }
      if (m.compare(m.round(charge.amount, 2), charge.amount) !== 0) {
        throw new ConflictError(`${charge.description} is ${m.toString(charge.amount)}. A bill is in dollars and cents: give it to the cent.`);
      }
    }
    const total = m.sum(charges.map((c) => c.amount), "USD");
    /** Stock received without an order was never spread by anything, so by value unless said. */
    const basis = input.basis ?? receipt?.basis ?? "value";

    /** What arrived on that truck, line by line (unit by unit for a tracked line), at what the goods cost. */
    const arrived = receipt
      ? await tx.select().from(schema.stockMovement)
        .where(and(eq(schema.stockMovement.receiptId, receipt.id), eq(schema.stockMovement.kind, "receipt")))
      : await tx.select({ m: schema.stockMovement }).from(schema.stockReceiptMovement)
        .innerJoin(schema.stockMovement, eq(schema.stockMovement.id, schema.stockReceiptMovement.movementId))
        .where(and(eq(schema.stockReceiptMovement.stockReceiptId, stock!.id), eq(schema.stockMovement.kind, "receipt")))
        .then((rows) => rows.map((r) => r.m));
    const lines: inv.LateReceiptLine[] = arrived.map((row) => ({
      movementId: row.id,
      itemId: row.itemId,
      value: m.subtract(m.money(row.totalCost ?? "0", "USD"), m.money(row.landedCost ?? "0", "USD")),
      quantity: inv.quantity(row.quantity),
    }));

    /** Where each line's parts went, read from a replay of each item's whole history. */
    const fates = new Map<string, inv.LandedFate[]>();
    for (const itemId of [...new Set(lines.map((l) => l.itemId))]) {
      const run = inv.costMovements({ movements: await history(tx, itemId), method: "fifo", currency: "USD" });
      if (!run.ok) throw new ConflictError(inv.explainRefusal(run));
      for (const [origin, found] of inv.fatesOf(run, lines.filter((l) => l.itemId === itemId).map((l) => l.movementId))) {
        fates.set(origin, found);
      }
    }

    const plan = inv.planLateLandedCost({ amount: total, basis, lines, fates });
    if (!plan.ok) throw new ConflictError(plan.message);

    const [bill] = await tx.insert(schema.landedCostBill).values({
      organizationId: ctx.actor.organizationId,
      purchaseOrderId: receipt?.purchaseOrderId ?? null,
      receiptId: receipt?.id ?? null,
      stockReceiptId: stock?.id ?? null,
      basis,
      total: m.toString(total),
      reference: input.reference?.trim() || null,
      onShelf: m.toString(plan.onShelf),
      onJobs: m.toString(plan.onJobs),
      onGone: m.toString(plan.onGone),
      recordedByUserId: ctx.actor.userId,
    }).returning({ id: schema.landedCostBill.id });
    await tx.insert(schema.landedCostBillCharge).values(charges.map((charge) => ({
      organizationId: ctx.actor.organizationId,
      billId: bill!.id,
      description: charge.description,
      amount: m.toString(charge.amount),
    })));

    const occurredAt = new Date();
    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const movements = inv.lateLandedMovements(plan.pieces, plan.pieces.map((_, i) => ({
      id: crypto.randomUUID(), sequence: sequence + i, occurredAt,
    })));
    const extras: MovementExtras = new Map(movements.map((mv) => [mv.id, { landedCostBillId: bill!.id }]));
    await writeMovements(tx, ctx, movements, extras);

    const transactionId = await writePosting(tx, ctx, ledger.postLateLandedCost({
      billId: bill!.id, occurredAt, total, onShelf: plan.onShelf, byJob: plan.byJob, onGone: plan.onGone,
    }));
    await tx.update(schema.landedCostBill).set({ ledgerTransactionId: transactionId, updatedAt: new Date() })
      .where(eq(schema.landedCostBill.id, bill!.id));

    const answer: LateBillView = {
      id: bill!.id,
      receiptId: receipt?.id ?? null,
      purchaseOrderId: receipt?.purchaseOrderId ?? null,
      stockReceiptId: stock?.id ?? null,
      total: cents(total),
      onShelf: cents(plan.onShelf),
      onJobs: cents(plan.onJobs),
      onGone: cents(plan.onGone),
      jobs: await jobNumbers(tx, plan.byJob),
    };
    await audit(tx, ctx, "landed_cost_bill.recorded", receipt ? "purchase_order" : "stock_receipt",
      receipt?.purchaseOrderId ?? stock!.id, null, {
      billId: bill!.id, receiptId: receipt?.id ?? null, stockReceiptId: stock?.id ?? null, total: answer.total, onShelf: answer.onShelf, onJobs: answer.onJobs, onGone: answer.onGone,
    });
    await once.remember(tx, ctx, "landed_cost_bill", bill!.id, answer);
    return answer;
  });
}

async function jobNumbers(tx: Database, byJob: readonly { jobId: string; amount: m.Money }[]) {
  if (byJob.length === 0) return [];
  const rows = await tx.select({ id: schema.job.id, number: schema.job.number }).from(schema.job)
    .where(inArray(schema.job.id, byJob.map((j) => j.jobId)));
  const numberOf = new Map(rows.map((r) => [r.id, r.number]));
  return byJob.map((j) => ({ jobId: j.jobId, jobNumber: numberOf.get(j.jobId) ?? null, amount: cents(j.amount) }));
}

/**
 * STOCK THAT CAME WITHOUT AN ORDER, as deliveries, newest first, each with
 * what arrived and the freight bills put on it since. Read with `po:read`,
 * the same as an order's page; recording a bill is `po:write`.
 */
export interface StockReceiptView {
  id: string;
  receivedAt: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  locationId: string;
  locationName: string;
  quantity: string;
  /** What the goods cost as typed when they were received. */
  cost: string;
  /** Freight and duty bills put on it since. */
  lateTotal: string;
  lateBills: { id: string; total: string; reference: string | null; onShelf: string; onJobs: string; onGone: string; recordedAt: string }[];
}

export function listStockReceipts(ctx: ServiceContext): Promise<StockReceiptView[]> {
  return guardedRead(ctx, "po:read", async (tx) => {
    const receipts = await tx.select({
      receipt: schema.stockReceipt, itemCode: schema.priceBookItem.code, locationName: schema.location.name,
    }).from(schema.stockReceipt)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.stockReceipt.itemId))
      .innerJoin(schema.location, eq(schema.location.id, schema.stockReceipt.locationId))
      .orderBy(desc(schema.stockReceipt.receivedAt)).limit(200);
    if (receipts.length === 0) return [];
    const ids = receipts.map((r) => r.receipt.id);
    const moved = await tx.select({
      stockReceiptId: schema.stockReceiptMovement.stockReceiptId, quantity: schema.stockMovement.quantity,
      totalCost: schema.stockMovement.totalCost,
    }).from(schema.stockReceiptMovement)
      .innerJoin(schema.stockMovement, eq(schema.stockMovement.id, schema.stockReceiptMovement.movementId))
      .where(and(inArray(schema.stockReceiptMovement.stockReceiptId, ids), eq(schema.stockMovement.kind, "receipt")));
    const bills = await tx.select().from(schema.landedCostBill)
      .where(inArray(schema.landedCostBill.stockReceiptId, ids)).orderBy(asc(schema.landedCostBill.createdAt));
    const names = await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
      .from(schema.priceBookItemVersion)
      .where(and(inArray(schema.priceBookItemVersion.itemId, [...new Set(receipts.map((r) => r.receipt.itemId))]), inForceAt()));
    const nameOf = new Map(names.map((n) => [n.itemId, n.name] as const));
    return receipts.map(({ receipt, itemCode, locationName }) => {
      const mine = moved.filter((x) => x.stockReceiptId === receipt.id);
      const theirs = bills.filter((b) => b.stockReceiptId === receipt.id);
      return {
        id: receipt.id,
        receivedAt: receipt.receivedAt.toISOString(),
        itemId: receipt.itemId, itemCode, itemName: nameOf.get(receipt.itemId) ?? itemCode,
        locationId: receipt.locationId, locationName,
        quantity: inv.quantityLabel(mine.reduce((sum, x) => sum + inv.quantity(x.quantity), inv.ZERO_QUANTITY)),
        cost: cents(m.sum(mine.map((x) => m.money(x.totalCost ?? "0", "USD")), "USD")),
        lateTotal: cents(m.sum(theirs.map((b) => m.money(b.total, "USD")), "USD")),
        lateBills: theirs.map((b) => ({
          id: b.id, total: cents(m.money(b.total, "USD")), reference: b.reference,
          onShelf: cents(m.money(b.onShelf, "USD")), onJobs: cents(m.money(b.onJobs, "USD")),
          onGone: cents(m.money(b.onGone, "USD")), recordedAt: b.createdAt.toISOString(),
        })),
      };
    });
  });
}

export const handlers = {
  listStockReceipts: async (ctx: ServiceContext) => ({ receipts: await listStockReceipts(ctx) }),
  recordStockLateLandedCost: (ctx: ServiceContext, input: {
    id: string; charges: readonly { description: string; amount: string }[];
    basis?: "value" | "quantity" | undefined; reference?: string | null | undefined;
  }): Promise<LateBillView> => recordLateBill(ctx, {
    stockReceiptId: input.id, charges: input.charges, basis: input.basis, reference: input.reference,
  }),
  recordLateLandedCost: (ctx: ServiceContext, input: {
    id: string; charges: readonly { description: string; amount: string }[];
    basis?: "value" | "quantity" | undefined; reference?: string | null | undefined;
  }): Promise<LateBillView & { receiptId: string; purchaseOrderId: string }> => recordLateBill(ctx, {
    receiptId: input.id, charges: input.charges, basis: input.basis, reference: input.reference,
  }).then((bill) => ({ ...bill, receiptId: bill.receiptId!, purchaseOrderId: bill.purchaseOrderId! })),
} as const;
