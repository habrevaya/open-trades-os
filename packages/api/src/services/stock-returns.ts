import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, inventory as inv, ledger, money as m, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import {
  history, itemLabel, leavingUnits, nextSequence, placeLabel, relieveLateFreight, stampsFrom, trackingOf,
  writeMovements, type MovementExtras, type UnitInput,
} from "./inventory";
import { writePosting } from "./ledger";
import * as once from "./once";
import { inForceAt } from "./pricebook";

/**
 * UNITS COMING BACK: OFF A JOB, AND TO THE VENDOR
 *
 * Two ways a numbered part goes back the way it came, both by its number.
 *
 * BACK OFF A JOB. The compressor that went to job 1042 was the wrong
 * voltage and is on the shelf again. It comes back as the part it left as:
 * the use it undoes is named on the return, so the costing replay puts it
 * back on the shelf at exactly the cost it left at (late freight included),
 * as the same receipt's part, and takes it off the job's material cost. The
 * ledger reverses what the use posted, which in this product is only late
 * freight: using stock does not post to the ledger (job costing reads
 * material from the job's lines), so a use carries a posting only when a
 * freight bill reached it, and the return takes exactly that back off the
 * job and into stock. The customer's equipment record it became stays on
 * their register, because the office has to say whether it came out, and
 * its link to our serial is cleared and said so.
 *
 * TO THE VENDOR. Units sent back against a credit: the stock leaves on
 * `return_to_vendor` movements that name a `vendor_return`, which holds the
 * credit expected and, when the credit memo arrives, the credit received.
 * The credit expected is what the goods cost on the order they came on, not
 * the freight, because a supplier refunds the part and not the truck; the
 * buyer can say another figure (a restocking fee). A unit that arrived on
 * another vendor's order is refused for this one. Nothing about the credit
 * posts to the ledger, for the reason receiving stock does not: there is no
 * payable in this product for it to come off. Late freight the units carried
 * leaves stock as for any loss.
 *
 * Both are by number only, so only for items tracked by serial (a return off
 * a job) or by serial or lot (to the vendor). A counted part coming back is
 * a count, and a counted part going back is not built.
 */

/* ----------------------------------------------------- back off a job */

export interface JobReturnResult {
  returned: { number: string; jobId: string | null; jobNumber: number | null }[];
  /** Serials whose customer's equipment record is still on the register, for the office to check. */
  equipmentStillOnRecord: { number: string; equipmentId: string }[];
}

export function returnFromJob(ctx: ServiceContext, input: {
  itemId: string; locationId: string; numbers: readonly string[]; note?: string | null | undefined;
}): Promise<JobReturnResult> {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await once.replayed<JobReturnResult>(tx, ctx, "inventory.returned_from_job");
    if (seen) return seen;

    const label = await itemLabel(tx, input.itemId);
    const mode = await trackingOf(tx, input.itemId);
    if (mode !== "serial") {
      throw new ConflictError(
        mode === "lot"
          ? `${label} is tracked by lot, and a lot coming back off a job is not taken back by number. Receive what came back as found stock, with its lot and cost.`
          : `${label} is not tracked by serial number, so there is no number to take it back by. Record a count with what is on the shelf instead.`,
      );
    }
    const numbers = input.numbers.map((n) => n.trim()).filter((n) => n !== "");
    if (numbers.length === 0) throw new ConflictError("Give the serial number of each unit that came back.");
    if (new Set(numbers.map((n) => n.toLowerCase())).size !== numbers.length) {
      throw new ConflictError("A serial is named twice. Each unit comes back once.");
    }
    const [place] = await tx.select({ id: schema.location.id }).from(schema.location)
      .where(eq(schema.location.id, input.locationId)).limit(1);
    if (!place) throw new NotFoundError("Location");

    const movements = await history(tx, input.itemId);
    const run = inv.costMovements({ movements, method: "fifo", currency: "USD" });
    if (!run.ok) throw new ConflictError(inv.explainRefusal(run));

    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();
    const planned: inv.Movement[] = [];
    const lots: (typeof schema.stockLot.$inferSelect)[] = [];
    for (const [index, number] of numbers.entries()) {
      const [lot] = await tx.select().from(schema.stockLot)
        .where(and(eq(schema.stockLot.itemId, input.itemId), sql`lower(${schema.stockLot.number}) = lower(${number})`))
        .limit(1);
      if (!lot) throw new ConflictError(`No serial ${number} of ${label} has ever been received. Check the number on the label.`);
      const state = inv.serialState(movements, lot.id);
      if (state.state === "in_stock") {
        throw new ConflictError(`Serial ${lot.number} of ${label} is in stock at ${await placeLabel(tx, state.locationId)}, so it cannot come back off a job.`);
      }
      if (state.state === "gone") {
        throw new ConflictError(`Serial ${lot.number} of ${label} was written off or sent back to the vendor, not used on a job. If it is on the shelf again, receive it with its cost.`);
      }
      /** The use it undoes: its last issue, which is the reason it is "used". */
      const use = [...movements].reverse().find((mv) => mv.lotId === lot.id && mv.kind === "issue");
      const costed = use ? run.consumptions.find((c) => c.movementId === use.id) : undefined;
      if (!use || !costed) {
        throw new ConflictError(`The use of serial ${lot.number} cannot be found in the history, so the cost it left at is unknown. Nothing was changed.`);
      }
      planned.push({
        id: crypto.randomUUID(), sequence: sequence + index, occurredAt,
        itemId: input.itemId, locationId: input.locationId, kind: "return_to_stock",
        quantity: use.quantity, lotId: lot.id,
        /** The cost it left at, late freight included, which is what goes back on the shelf. */
        totalCost: costed.cost,
        ...(m.isZero(costed.late) ? {} : { lateCost: costed.late }),
        ...(use.jobId ? { jobId: use.jobId } : {}),
        revaluesMovementId: use.id,
        reasonCode: (input.note?.trim() || "back_from_job").slice(0, 200),
      });
      lots.push(lot);
    }

    await writeMovements(tx, ctx, planned);
    /** The ledger reverses what the use posted: the late freight on it, off the job and back into stock. */
    for (const back of planned) {
      if (!back.lateCost || !back.jobId) continue;
      await writePosting(tx, ctx, ledger.postLateCostReturn({
        movementId: back.id, occurredAt, amount: back.lateCost, jobId: back.jobId,
      }));
    }

    const equipmentStillOnRecord: JobReturnResult["equipmentStillOnRecord"] = [];
    for (const lot of lots) {
      if (!lot.equipmentId) continue;
      equipmentStillOnRecord.push({ number: lot.number, equipmentId: lot.equipmentId });
      await tx.update(schema.stockLot).set({ equipmentId: null, updatedAt: new Date() }).where(eq(schema.stockLot.id, lot.id));
      await audit(tx, ctx, "stock_lot.uninstalled", "stock_lot", lot.id, { equipmentId: lot.equipmentId }, { equipmentId: null });
    }

    const jobIds = [...new Set(planned.map((p) => p.jobId).filter((id): id is string => !!id))];
    const jobs = jobIds.length === 0 ? [] : await tx.select({ id: schema.job.id, number: schema.job.number })
      .from(schema.job).where(inArray(schema.job.id, jobIds));
    const numberOf = new Map(jobs.map((j) => [j.id, j.number]));
    const answer: JobReturnResult = {
      returned: planned.map((p, i) => ({ number: lots[i]!.number, jobId: p.jobId ?? null, jobNumber: p.jobId ? numberOf.get(p.jobId) ?? null : null })),
      equipmentStillOnRecord,
    };
    await audit(tx, ctx, "inventory.returned_from_job", "price_book_item", input.itemId, null, {
      locationId: input.locationId, units: numbers,
    });
    await once.remember(tx, ctx, "inventory.returned_from_job", planned[0]?.id ?? null, answer);
    return answer;
  });
}

/* ------------------------------------------------------- to the vendor */

export interface VendorReturnView {
  id: string;
  number: number;
  vendorId: string;
  vendorName: string;
  status: "awaiting_credit" | "credited";
  reason: string;
  reference: string | null;
  creditExpected: string;
  creditReceived: string | null;
  creditReceivedAt: string | null;
  creditReference: string | null;
  createdAt: string;
  units: { itemId: string; itemName: string; number: string; quantity: string; locationName: string }[];
}

/** The next return number, under a lock, as an order's is. */
async function nextReturnNumber(tx: Database, organizationId: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`number:vendor_return:${organizationId}`}))`);
  const [row] = await tx.select({ max: sql<number | null>`max(${schema.vendorReturn.number})` }).from(schema.vendorReturn)
    .where(eq(schema.vendorReturn.organizationId, organizationId));
  return (row?.max ?? 0) + 1;
}

export function createVendorReturn(ctx: ServiceContext, input: {
  vendorId: string; itemId: string; locationId: string; units: readonly UnitInput[];
  reason: string; reference?: string | null | undefined; creditExpected?: string | null | undefined;
}): Promise<VendorReturnView> {
  return guardedWrite(ctx, "po:write", async (tx) => {
    /** Stock leaves the shelf, so it is a statement about the shelf as well as about the vendor. */
    assertCan(ctx.actor, "inventory:adjust");
    const seen = await once.replayed<VendorReturnView>(tx, ctx, "vendor_return");
    if (seen) return seen;

    const reason = input.reason.trim();
    if (reason === "") throw new ConflictError("Say why it is going back: wrong part, arrived damaged, failed under warranty.");
    const [vendor] = await tx.select({ id: schema.vendor.id, name: schema.vendor.name }).from(schema.vendor)
      .where(eq(schema.vendor.id, input.vendorId)).limit(1);
    if (!vendor) throw new NotFoundError("Vendor");
    const label = await itemLabel(tx, input.itemId);
    const mode = await trackingOf(tx, input.itemId);
    if (!mode) {
      throw new ConflictError(`${label} is not tracked by serial or lot. Sending counted stock back to a vendor is not built: write it off with a count, and record the credit with the vendor.`);
    }

    const movements = await history(tx, input.itemId);
    const quantity = input.units.reduce((total, unit) =>
      total + (unit.quantity?.trim() ? inv.quantity(unit.quantity) : mode === "serial" ? inv.quantity("1") : inv.ZERO_QUANTITY), inv.ZERO_QUANTITY);
    if (mode === "lot" && input.units.some((u) => !u.quantity?.trim())) {
      throw new ConflictError("Say how much of each lot is going back.");
    }
    const { picks, numbers } = await leavingUnits(tx, {
      itemId: input.itemId, mode, quantity, locationId: input.locationId, units: input.units, movements,
    });
    const level = inv.deriveLevel(movements, input.itemId, input.locationId);
    if (quantity > level.onHand) {
      throw new ConflictError(inv.explainRefusal({
        ok: false, reason: "insufficient_on_hand", itemId: label, locationId: await placeLabel(tx, input.locationId),
        requested: quantity, onHand: level.onHand, shortfall: quantity - level.onHand,
      }));
    }

    /**
     * WHAT THE VENDOR OWES. Each unit's goods cost on the receipt it came on,
     * without the freight: a supplier credits the part, not the truck. A unit
     * that came on another vendor's order is refused, because the credit is
     * owed by whoever sold it.
     */
    let expected = m.zero("USD");
    let known = true;
    for (const pick of picks) {
      const receipt = [...movements].reverse().find((mv) => mv.lotId === pick.lotId && mv.kind === "receipt");
      if (!receipt) { known = false; continue; }
      const [row] = await tx.select({
        landedCost: schema.stockMovement.landedCost, orderVendor: schema.purchaseOrder.vendorId,
        orderNumber: schema.purchaseOrder.number, vendorName: schema.vendor.name,
      }).from(schema.stockMovement)
        .leftJoin(schema.purchaseOrder, eq(schema.purchaseOrder.id, schema.stockMovement.purchaseOrderId))
        .leftJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseOrder.vendorId))
        .where(eq(schema.stockMovement.id, receipt.id)).limit(1);
      if (row?.orderVendor && row.orderVendor !== vendor.id) {
        throw new ConflictError(
          `${numbers.get(pick.lotId) ?? "That unit"} arrived from ${row.vendorName ?? "another vendor"} on order ${row.orderNumber}, not from ${vendor.name}. The credit is owed by whoever sold it.`,
        );
      }
      const goods = m.subtract(receipt.totalCost ?? m.zero("USD"), m.money(row?.landedCost ?? "0", "USD"));
      const share = pick.quantity >= receipt.quantity
        ? goods
        : m.allocate(goods, [inv.quantityToString(pick.quantity), inv.quantityToString(receipt.quantity - pick.quantity)])[0]!;
      expected = m.add(expected, share);
    }
    const stated = input.creditExpected?.trim();
    if (stated) {
      const amount = m.money(stated, "USD");
      if (m.isNegative(amount)) throw new ConflictError("A credit expected cannot be below nothing.");
      expected = amount;
    } else if (!known) {
      throw new ConflictError("Some of these units were numbered on the shelf rather than received by number, so what they cost is not on record. Say what credit the vendor is giving.");
    }

    const number = await nextReturnNumber(tx, ctx.actor.organizationId);
    const [row] = await tx.insert(schema.vendorReturn).values({
      organizationId: ctx.actor.organizationId,
      number,
      vendorId: vendor.id,
      reason: reason.slice(0, 500),
      reference: input.reference?.trim() || null,
      creditExpected: m.toString(m.round(expected, 2)),
      createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning({ id: schema.vendorReturn.id });

    const sequence = await nextSequence(tx, ctx.actor.organizationId);
    const occurredAt = new Date();
    const planned: inv.Movement[] = picks.map((pick, i) => ({
      ...stampsFrom(sequence + i, 1, occurredAt)[0]!,
      itemId: input.itemId, locationId: input.locationId, kind: "return_to_vendor" as const,
      quantity: pick.quantity, lotId: pick.lotId, reasonCode: reason.slice(0, 200),
    }));
    const extras: MovementExtras = new Map(planned.map((mv) => [mv.id, { vendorReturnId: row!.id }]));
    await writeMovements(tx, ctx, planned, extras);
    await relieveLateFreight(tx, ctx, input.itemId, planned.map((p) => p.id), occurredAt);

    await audit(tx, ctx, "vendor_return.created", "vendor_return", row!.id, null, {
      number, vendorId: vendor.id, units: [...numbers.values()], creditExpected: m.toString(m.round(expected, 2)),
    });
    const view = (await returnsWithin(tx, { id: row!.id }))[0]!;
    await once.remember(tx, ctx, "vendor_return", row!.id, view);
    return view;
  });
}

async function returnsWithin(tx: Database, filter: { id?: string | undefined; status?: string | undefined } = {}): Promise<VendorReturnView[]> {
  const rows = await tx.select({ ret: schema.vendorReturn, vendorName: schema.vendor.name })
    .from(schema.vendorReturn)
    .innerJoin(schema.vendor, eq(schema.vendor.id, schema.vendorReturn.vendorId))
    .where(and(
      filter.id ? eq(schema.vendorReturn.id, filter.id) : undefined,
      filter.status === "awaiting_credit" || filter.status === "credited" ? eq(schema.vendorReturn.status, filter.status) : undefined,
    ))
    .orderBy(desc(schema.vendorReturn.number));
  if (rows.length === 0) return [];
  const units = await tx.select({
    returnId: schema.stockMovement.vendorReturnId, itemId: schema.stockMovement.itemId,
    quantity: schema.stockMovement.quantity, number: schema.stockLot.number, locationName: schema.location.name,
    itemName: schema.priceBookItem.code,
  }).from(schema.stockMovement)
    .innerJoin(schema.location, eq(schema.location.id, schema.stockMovement.locationId))
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.stockMovement.itemId))
    .leftJoin(schema.stockLot, eq(schema.stockLot.id, schema.stockMovement.lotId))
    .where(inArray(schema.stockMovement.vendorReturnId, rows.map((r) => r.ret.id)))
    .orderBy(asc(schema.stockMovement.sequence));
  const itemIds = [...new Set(units.map((u) => u.itemId))];
  const names = itemIds.length === 0 ? [] : await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
    .from(schema.priceBookItemVersion)
    .where(and(inArray(schema.priceBookItemVersion.itemId, itemIds), inForceAt()));
  const nameOf = new Map(names.map((n) => [n.itemId, n.name]));
  const cents = (v: string | null) => (v === null ? null : m.toString(m.round(m.money(v), 2)));
  return rows.map(({ ret, vendorName }) => ({
    id: ret.id,
    number: ret.number,
    vendorId: ret.vendorId,
    vendorName,
    status: ret.status,
    reason: ret.reason,
    reference: ret.reference,
    creditExpected: cents(ret.creditExpected)!,
    creditReceived: cents(ret.creditReceived),
    creditReceivedAt: ret.creditReceivedAt?.toISOString() ?? null,
    creditReference: ret.creditReference,
    createdAt: ret.createdAt.toISOString(),
    units: units.filter((u) => u.returnId === ret.id).map((u) => ({
      itemId: u.itemId, itemName: nameOf.get(u.itemId) ?? u.itemName, number: u.number ?? "",
      quantity: inv.quantityLabel(inv.quantity(u.quantity)), locationName: u.locationName,
    })),
  }));
}

export function vendorReturns(ctx: ServiceContext, input: { status?: string | undefined } = {}) {
  return guardedRead(ctx, "po:read", (tx) => returnsWithin(tx, input));
}

/**
 * The vendor's credit memo arrived. Recorded as what they gave, beside what
 * was expected, because a credit short by a restocking fee nobody agreed to
 * is the thing a buyer rings them about.
 */
export function recordVendorCredit(ctx: ServiceContext, input: {
  id: string; amount: string; reference?: string | null | undefined;
}): Promise<VendorReturnView> {
  return guardedWrite(ctx, "po:write", async (tx) => {
    const seen = await once.replayed<VendorReturnView>(tx, ctx, "vendor_return.credited");
    if (seen) return seen;
    const [ret] = await tx.select().from(schema.vendorReturn).where(eq(schema.vendorReturn.id, input.id)).limit(1);
    if (!ret) throw new NotFoundError("Return to vendor");
    if (ret.status === "credited") {
      throw new ConflictError(`Return ${ret.number} already has its credit recorded. A second credit from the vendor is a separate memo for the accountant.`);
    }
    const amount = m.money(input.amount, "USD");
    if (m.isNegative(amount)) throw new ConflictError("A credit cannot be below nothing.");
    if (m.compare(m.round(amount, 2), amount) !== 0) throw new ConflictError("Give the credit to the cent, as the memo shows it.");
    await tx.update(schema.vendorReturn).set({
      status: "credited",
      creditReceived: m.toString(amount),
      creditReceivedAt: new Date(),
      creditReference: input.reference?.trim() || null,
      updatedAt: new Date(),
    }).where(eq(schema.vendorReturn.id, ret.id));
    await audit(tx, ctx, "vendor_return.credited", "vendor_return", ret.id, { status: ret.status }, {
      status: "credited", creditReceived: m.toString(amount), creditExpected: ret.creditExpected,
    });
    const view = (await returnsWithin(tx, { id: ret.id }))[0]!;
    await once.remember(tx, ctx, "vendor_return.credited", ret.id, view);
    return view;
  });
}

export const handlers = {
  returnStockFromJob: (ctx: ServiceContext, input: {
    itemId: string; locationId: string; numbers: readonly string[]; note?: string | null | undefined;
  }): Promise<JobReturnResult> => returnFromJob(ctx, input),
  listVendorReturns: async (ctx: ServiceContext, input: { status?: "awaiting_credit" | "credited" | undefined }):
    Promise<{ returns: VendorReturnView[] }> => ({ returns: await vendorReturns(ctx, input) }),
  createVendorReturn: (ctx: ServiceContext, input: {
    vendorId: string; itemId: string; locationId: string; reason: string;
    units: readonly { number: string; quantity?: string | undefined }[];
    reference?: string | null | undefined; creditExpected?: string | null | undefined;
  }): Promise<VendorReturnView> => createVendorReturn(ctx, input),
  recordVendorCredit: (ctx: ServiceContext, input: { id: string; amount: string; reference?: string | null | undefined }):
    Promise<VendorReturnView> => recordVendorCredit(ctx, input),
} as const;
