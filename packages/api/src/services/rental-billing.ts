import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, money as m, rental as rt, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as once from "./once";
import * as jobs from "./jobs";
import * as billing from "./billing";
import { inForceAt } from "./pricebook";

/**
 * A HIRE AFTER THE CAN HAS GONE OUT
 *
 * `rentals.ts` puts a container on a site, swaps it and collects it. This is
 * the three things that happened by hand around that, each a place a roll off
 * company loses money without any screen saying so:
 *
 *   COLLECTIONS. A hire due back sat on the board marked "over" until
 *   somebody remembered to book the pickup. The scheduler puts each hire due
 *   by a date on the route as a collection stop, on the day it is due (or
 *   today when it is already late), linked to the hire so the driver's phone
 *   says it is a pickup and running it twice books nothing twice.
 *
 *   THE INVOICE. The overage call said what the meters read and somebody
 *   still typed the invoice. Raising one from a collected hire writes the
 *   period (when the hire is priced by the day), each meter that went over,
 *   and every charge found on the haul, as a draft for the office to check
 *   and issue. Once per hire.
 *
 *   CHARGES ON A HAUL. A mattress, a tire, a load the facility had to sort:
 *   recorded against the haul when found, priced from the pack's own fees,
 *   and invoiced with the hire.
 *
 *   THE FACILITY'S TICKETS. A month of scale tickets arrives as a file. It is
 *   previewed, each ticket matched to the haul it weighed, and applied,
 *   overwriting nothing anybody typed.
 */

/* --------------------------------------------------------------- collections */

/** A day's window for a collection: the working day, in the company's own clock. */
const COLLECTION_FROM_MINUTES = 8 * 60;
const COLLECTION_TO_MINUTES = 17 * 60;

export interface CollectionRunResult {
  through: string;
  scheduled: {
    rentalId: string; assetIdentifier: string | null; address: string | null;
    dueOn: string; collectOn: string; daysLate: number; jobId: string; jobNumber: number; visitId: string;
  }[];
  skipped: { rentalId: string; assetIdentifier: string | null; reason: string }[];
}

/**
 * Put every open hire due back by `through` on the board as a collection.
 *
 * A HIRE THAT CAME WITH A JOB gets the collection as a visit on that job,
 * because it is the same piece of work and its invoice is the same invoice.
 * A hire with no job behind it (the standing can on a commercial site) gets
 * a job of its own at the address, of the pack's "Final pickup" type when
 * the company has one. Either way the stop says it is a pickup and which
 * hire, which is what tells the driver to arrive with an empty truck.
 *
 * A collection that was cancelled on the board stops counting, so the hire
 * is offered again rather than forgotten. Needs `asset:write` to decide the
 * can comes back and `job:write` to put work on the board.
 */
export function scheduleCollections(ctx: ServiceContext, input: { through?: string | undefined }) {
  assertCan(ctx.actor, "job:write");
  return guardedWrite(ctx, "asset:write", async (tx): Promise<CollectionRunResult> => {
    const seen = await once.replayed<CollectionRunResult>(tx, ctx, "rental_collection_run");
    if (seen) return seen;

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    const through = input.through ?? time.nextDay(today);

    const hires = await tx.select().from(schema.rental)
      .where(and(eq(schema.rental.organizationId, ctx.actor.organizationId), isNull(schema.rental.pickedUpAt)));
    const booked = hires.map((h) => h.collectionVisitId).filter((id): id is string => id !== null);
    const live = booked.length === 0 ? new Set<string>() : new Set((await tx.select({ id: schema.visit.id })
      .from(schema.visit)
      .where(and(inArray(schema.visit.id, booked), sql`${schema.visit.status} <> 'cancelled'`))).map((v) => v.id));

    const plan = rt.collectionsDue({
      hires: hires.map((h) => ({
        id: h.id, deliveredAt: h.deliveredAt, includedDays: h.includedDays,
        collectionVisitId: h.collectionVisitId && live.has(h.collectionVisitId) ? h.collectionVisitId : null,
      })),
      through, today, zone,
    });

    const assetIds = [...new Set(hires.map((h) => h.assetId))];
    const assets = assetIds.length === 0 ? [] : await tx.select({ id: schema.rentableAsset.id, identifier: schema.rentableAsset.identifier })
      .from(schema.rentableAsset).where(inArray(schema.rentableAsset.id, assetIds));
    const numberOf = new Map(assets.map((a) => [a.id, a.identifier]));
    const byId = new Map(hires.map((h) => [h.id, h]));
    const [pickupType] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
      .where(and(eq(schema.jobType.code, "pickup"), eq(schema.jobType.active, true))).limit(1);

    /**
     * Without the caller's key: the job and visit creates below honour an
     * idempotency key, and one key across a dozen collections would make
     * every one after the first replay the first.
     */
    const { idempotencyKey: _key, ...plain } = ctx;
    const inner: ServiceContext = { ...plain, db: tx };

    const result: CollectionRunResult = { through, scheduled: [], skipped: [] };
    for (const skip of plan.skipped) {
      const hire = byId.get(skip.rentalId);
      if (skip.reason.startsWith("A collection is already")) continue;
      result.skipped.push({ rentalId: skip.rentalId, assetIdentifier: hire ? numberOf.get(hire.assetId) ?? null : null, reason: skip.reason });
    }

    for (const due of plan.schedule) {
      const hire = byId.get(due.rentalId)!;
      const identifier = numberOf.get(hire.assetId) ?? null;
      const window = {
        windowStart: time.instantOfLocal(due.collectOn, COLLECTION_FROM_MINUTES, zone).toISOString(),
        windowEnd: time.instantOfLocal(due.collectOn, COLLECTION_TO_MINUTES, zone).toISOString(),
      };
      const [place] = await tx.select({ line1: schema.property.addressLine1, city: schema.property.city })
        .from(schema.property).where(eq(schema.property.id, hire.propertyId)).limit(1);
      const address = place ? [place.line1, place.city].filter((p) => p).join(", ") : null;

      const [delivery] = await tx.select({ jobId: schema.visit.jobId }).from(schema.visit)
        .where(and(eq(schema.visit.rentalId, hire.id), eq(schema.visit.rentalEvent, "delivery"))).limit(1);
      const [deliveryJob] = delivery ? await tx.select({ id: schema.job.id, number: schema.job.number, status: schema.job.status })
        .from(schema.job).where(eq(schema.job.id, delivery.jobId)).limit(1) : [];

      let jobId: string;
      let jobNumber: number;
      let visitId: string;
      if (deliveryJob && deliveryJob.status !== "cancelled") {
        const visit = await jobs.addVisit(inner, {
          id: deliveryJob.id, ...window, estimatedDurationMinutes: 30, technicianIds: [],
        });
        jobId = deliveryJob.id; jobNumber = deliveryJob.number; visitId = visit.id;
      } else {
        const [owner] = await tx.select({ customerId: schema.customerProperty.customerId })
          .from(schema.customerProperty)
          .where(and(eq(schema.customerProperty.propertyId, hire.propertyId), isNull(schema.customerProperty.endedOn)))
          .orderBy(asc(schema.customerProperty.createdAt)).limit(1);
        if (!owner) {
          result.skipped.push({
            rentalId: hire.id, assetIdentifier: identifier,
            reason: "Nobody is recorded as the customer at that address, so there is nobody to book the collection for.",
          });
          continue;
        }
        const job = await jobs.create(inner, {
          customerId: owner.customerId,
          propertyId: hire.propertyId,
          ...(pickupType ? { jobTypeId: pickupType.id } : {}),
          summary: `Collect container ${identifier ?? ""}`.trim(),
          description: `Due back ${due.dueOn}${due.daysLate > 0 ? `, ${due.daysLate} ${due.daysLate === 1 ? "day" : "days"} late` : ""}.`,
          tags: [], customFields: {},
          visit: { ...window, estimatedDurationMinutes: 30, technicianIds: [] },
        });
        const visit = job.visits[0];
        if (!visit) throw new ConflictError("The collection job was made without its stop.");
        jobId = job.id; jobNumber = job.number; visitId = visit.id;
      }

      await tx.update(schema.visit).set({ rentalId: hire.id, rentalEvent: "pickup", updatedAt: new Date() })
        .where(eq(schema.visit.id, visitId));
      await tx.update(schema.rental).set({ collectionVisitId: visitId, updatedAt: new Date() })
        .where(eq(schema.rental.id, hire.id));
      await audit(tx, ctx, "rental.collection_scheduled", "rental", hire.id, null, {
        visitId, jobId, dueOn: due.dueOn, collectOn: due.collectOn,
      });
      result.scheduled.push({
        rentalId: hire.id, assetIdentifier: identifier, address, dueOn: due.dueOn, collectOn: due.collectOn,
        daysLate: due.daysLate, jobId, jobNumber, visitId,
      });
    }

    await once.remember(tx, ctx, "rental_collection_run", null, result);
    return result;
  });
}

/* --------------------------------------------------------- charges on a haul */

export type ChargeKind = typeof schema.rentalChargeKind.enumValues[number];

export interface ChargeView {
  id: string; rentalId: string; kind: ChargeKind; description: string;
  priceBookItemId: string | null; quantity: string; unitPrice: string; amount: string; taxable: boolean;
  note: string | null; recordedAt: string; invoiceId: string | null;
}

const chargeView = (row: typeof schema.rentalCharge.$inferSelect): ChargeView => ({
  id: row.id, rentalId: row.rentalId, kind: row.kind, description: row.description,
  priceBookItemId: row.priceBookItemId,
  quantity: trimQuantity(row.quantity),
  unitPrice: m.toString(m.round(m.money(row.unitPrice), 2)),
  amount: m.toString(m.round(m.multiply(m.money(row.unitPrice), row.quantity), 2)),
  taxable: row.taxable, note: row.note, recordedAt: row.createdAt.toISOString(), invoiceId: row.invoiceId,
});

const trimQuantity = (q: string) => q.includes(".") ? q.replace(/\.?0+$/, "") : q;

async function hireWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.rental)
    .where(and(eq(schema.rental.organizationId, ctx.actor.organizationId), eq(schema.rental.id, id))).limit(1);
  if (!row) throw new NotFoundError("Rental");
  return row;
}

/**
 * Record what a haul turned up. Priced from a price book fee when one is
 * named (the pack's FEE-CONTAM, FEE-PROH-TIRE and the rest), at the price
 * in force today unless another is given, taxed as that fee is; or priced by
 * hand with a description. A charge with no price is refused rather than
 * recorded at nothing, for the reason a missing overage rate is.
 */
export function recordCharge(ctx: ServiceContext, input: {
  rentalId: string; kind: ChargeKind;
  priceBookItemId?: string | null | undefined; description?: string | null | undefined;
  quantity?: string | undefined; unitPrice?: string | null | undefined; taxable?: boolean | undefined;
  note?: string | null | undefined;
}) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const seen = await once.replayed<ChargeView>(tx, ctx, "rental_charge");
    if (seen) return seen;
    const hire = await hireWithin(tx, ctx, input.rentalId);
    if (hire.invoiceId) {
      throw new ConflictError("This hire has already been invoiced. A charge found afterwards goes on an invoice of its own.");
    }
    let description = input.description?.trim() || "";
    let unitPrice = input.unitPrice?.trim() || "";
    let taxable = input.taxable;
    if (input.priceBookItemId) {
      const [fee] = await tx.select({ name: schema.priceBookItemVersion.name, price: schema.priceBookItemVersion.price, taxable: schema.priceBookItemVersion.taxable })
        .from(schema.priceBookItemVersion)
        .where(and(eq(schema.priceBookItemVersion.itemId, input.priceBookItemId), inForceAt())).limit(1);
      if (!fee) throw new NotFoundError("Price book item");
      description ||= fee.name;
      unitPrice ||= fee.price;
      taxable ??= fee.taxable;
    }
    if (description === "") throw new ConflictError("Say what was found, in the words that go on the invoice.");
    if (unitPrice === "") {
      throw new ConflictError("Give the charge a price, or choose the fee it is from. A charge at nothing is a charge given away.");
    }
    const price = m.money(unitPrice);
    if (m.isNegative(price)) throw new ConflictError("A charge cannot be negative. A credit belongs on the invoice.");
    const quantity = input.quantity?.trim() || "1";
    if (!/^\d+(\.\d{1,4})?$/.test(quantity) || Number(quantity) <= 0) {
      throw new ConflictError(`"${quantity}" is not a number of items.`);
    }

    const [row] = await tx.insert(schema.rentalCharge).values({
      organizationId: ctx.actor.organizationId,
      rentalId: hire.id,
      kind: input.kind,
      description,
      priceBookItemId: input.priceBookItemId ?? null,
      quantity,
      unitPrice: m.toString(price),
      taxable: taxable ?? true,
      note: input.note?.trim() || null,
      recordedByUserId: ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "rental.charge_recorded", "rental", hire.id, null, row!);
    const view = chargeView(row!);
    await once.remember(tx, ctx, "rental_charge", row!.id, view);
    return view;
  });
}

/**
 * The fees a charge can be priced from: the company's active fee items, with
 * today's price. The dumpster pack seeds the contamination, overfill,
 * overweight and prohibited item fees as these.
 */
export function chargeFees(ctx: ServiceContext) {
  return guardedRead(ctx, "asset:write", async (tx) => {
    const rows = await tx.select({
      id: schema.priceBookItem.id, code: schema.priceBookItem.code,
      name: schema.priceBookItemVersion.name, price: schema.priceBookItemVersion.price,
    }).from(schema.priceBookItem)
      .innerJoin(schema.priceBookItemVersion, and(eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id), inForceAt()))
      .where(and(eq(schema.priceBookItem.kind, "fee"), eq(schema.priceBookItem.active, true), isNull(schema.priceBookItem.deletedAt)))
      .orderBy(asc(schema.priceBookItem.code));
    return rows;
  });
}

/** Take back a charge recorded in error. Refused once it is on an invoice, where a credit note undoes it. */
export function removeCharge(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const [row] = await tx.select().from(schema.rentalCharge)
      .where(and(eq(schema.rentalCharge.id, input.id), isNull(schema.rentalCharge.deletedAt))).limit(1);
    if (!row) throw new NotFoundError("Charge");
    if (row.invoiceId) throw new ConflictError("That charge is on an invoice. Credit it there rather than deleting it here.");
    await tx.update(schema.rentalCharge).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.rentalCharge.id, row.id));
    await audit(tx, ctx, "rental.charge_removed", "rental", row.rentalId, row, null);
    return { id: row.id, removed: true as const };
  });
}

async function chargesWithin(tx: Database, rentalIds: string[]) {
  if (rentalIds.length === 0) return [];
  return tx.select().from(schema.rentalCharge)
    .where(and(inArray(schema.rentalCharge.rentalId, rentalIds), isNull(schema.rentalCharge.deletedAt)))
    .orderBy(asc(schema.rentalCharge.createdAt));
}

export function charges(ctx: ServiceContext, input: { rentalId?: string | undefined }) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const rows = input.rentalId
      ? await chargesWithin(tx, [input.rentalId])
      : await tx.select().from(schema.rentalCharge).where(isNull(schema.rentalCharge.deletedAt))
        .orderBy(asc(schema.rentalCharge.createdAt));
    return rows.map(chargeView);
  });
}

/* ------------------------------------------------------------------ invoicing */

export interface HireInvoiceResult {
  invoiceId: string;
  invoiceNumber: number;
  total: string;
  lines: { name: string; quantity: string; unitPrice: string; amount: string }[];
}

/**
 * Raise a draft invoice from a collected hire: its period when it is priced
 * by the day, each meter that went over, and every charge on the haul.
 *
 * REFUSED WHILE THE CAN IS ON SITE, for the reason the overage call is: the
 * period is not final until it is collected. REFUSED WHEN A METER HAS NO
 * RATE, with the meter's own sentence, rather than invoicing the rest and
 * leaving the days off. ONCE PER HIRE: a second invoice for the same extra
 * days is the double charge a customer remembers, so the hire carries the
 * invoice it went on, and only a voided or deleted one frees it again.
 *
 * A DRAFT, for the office to check and issue. The invoice is the customer's
 * at the address, through `billing.createIn`, so tax, numbering and every
 * rule an invoice follows are the same as for one typed by hand.
 */
export function invoiceHire(ctx: ServiceContext, input: { id: string }) {
  assertCan(ctx.actor, "asset:read");
  return guardedWrite(ctx, "invoice:write", async (tx): Promise<HireInvoiceResult> => {
    const seen = await once.replayed<HireInvoiceResult>(tx, ctx, "rental_invoice");
    if (seen) return seen;
    const hire = await hireWithin(tx, ctx, input.id);

    if (hire.invoiceId) {
      const [prior] = await tx.select({ number: schema.invoice.number, status: schema.invoice.status, deletedAt: schema.invoice.deletedAt })
        .from(schema.invoice).where(eq(schema.invoice.id, hire.invoiceId)).limit(1);
      if (prior && !prior.deletedAt && prior.status !== "void") {
        throw new ConflictError(`This hire is already on invoice ${prior.number}. Void that one first if it was wrong.`);
      }
    }
    if (hire.deliveredAt === null) throw new ConflictError("That hire has no delivery date, so there is no period to bill.");
    if (hire.pickedUpAt === null) {
      throw new ConflictError(
        "That container is still on site. The period is not final until it is collected, and a figure that changes every midnight is not something to invoice.",
      );
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const verdict = rt.bill({
      deliveredAt: hire.deliveredAt, pickedUpAt: hire.pickedUpAt, zone,
      period: { includedDays: hire.includedDays, overageRate: hire.overageRate },
      weight: { includedTons: hire.includedTons, perTonRate: hire.perTonRate },
      tons: hire.weightTons,
    });
    if (!verdict.ok) throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));

    const [asset] = await tx.select({ identifier: schema.rentableAsset.identifier, size: schema.rentableAsset.size })
      .from(schema.rentableAsset).where(eq(schema.rentableAsset.id, hire.assetId)).limit(1);
    const can = `Container ${asset?.identifier ?? ""}${asset?.size ? ` (${asset.size})` : ""}`;
    const from = time.dateIn(hire.deliveredAt, zone);
    const to = time.dateIn(hire.pickedUpAt, zone);

    const lines: { name: string; description?: string; quantity: string; unitPrice: string; taxable: boolean }[] = [];
    const period = rt.periodLine({ days: verdict.days, includedDays: hire.includedDays, dailyRate: hire.dailyRate });
    if (period) {
      lines.push({
        name: `${can}, rental ${from} to ${to}`,
        description: `${period.days} container ${period.days === 1 ? "day" : "days"} at the day rate`,
        quantity: String(period.days), unitPrice: m.toString(m.money(period.rate)), taxable: true,
      });
    }
    for (const meter of verdict.lines) {
      lines.push(meter.meter === "rental_days"
        ? { name: `${can}, extra days`, description: `${meter.overBy} beyond the ${hire.includedDays} included`, quantity: meter.overBy, unitPrice: m.toString(m.money(meter.rate)), taxable: true }
        : {
            name: `${can}, disposal over the included tonnage`,
            description: `${Number(meter.overBy)} tons over${hire.disposalTicketNumber ? `, scale ticket ${hire.disposalTicketNumber}` : ""}`,
            quantity: meter.overBy, unitPrice: m.toString(m.money(meter.rate)), taxable: true,
          });
    }
    const found = (await chargesWithin(tx, [hire.id])).filter((c) => c.invoiceId === null);
    for (const charge of found) {
      lines.push({
        name: charge.description,
        ...(charge.note ? { description: charge.note } : {}),
        quantity: charge.quantity, unitPrice: charge.unitPrice, taxable: charge.taxable,
      });
    }
    if (lines.length === 0) {
      throw new ConflictError(
        "Nothing on this hire to invoice: it is not priced by the day, neither meter went over, and nothing was charged on the haul. Its price is on the job.",
      );
    }

    const [owner] = await tx.select({ customerId: schema.customerProperty.customerId })
      .from(schema.customerProperty)
      .where(eq(schema.customerProperty.propertyId, hire.propertyId))
      .orderBy(asc(schema.customerProperty.createdAt)).limit(1);
    if (!owner) throw new ConflictError("Nobody is recorded as the customer at that address, so there is nobody to invoice.");

    const { idempotencyKey: _key, ...plain } = ctx;
    const invoice = await billing.createIn(tx, plain, {
      customerId: owner.customerId,
      draft: true,
      memo: `${can} at ${await addressOf(tx, hire.propertyId)}, ${from} to ${to}.`,
      lines: lines.map((l) => ({
        name: l.name, ...(l.description ? { description: l.description } : {}),
        quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: "0", taxable: l.taxable,
      })),
    });

    const now = new Date();
    await tx.update(schema.rental).set({ invoiceId: invoice.id, updatedAt: now }).where(eq(schema.rental.id, hire.id));
    if (found.length > 0) {
      await tx.update(schema.rentalCharge).set({ invoiceId: invoice.id, invoicedAt: now, updatedAt: now })
        .where(inArray(schema.rentalCharge.id, found.map((c) => c.id)));
    }
    await audit(tx, ctx, "rental.invoiced", "rental", hire.id, null, { invoiceId: invoice.id, lines: lines.length });

    const result: HireInvoiceResult = {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      total: String(invoice.total),
      lines: lines.map((l) => ({
        name: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
        amount: m.toString(m.round(m.multiply(m.money(l.unitPrice), l.quantity), 2)),
      })),
    };
    await once.remember(tx, ctx, "rental_invoice", invoice.id, result);
    return result;
  });
}

async function addressOf(tx: Database, propertyId: string): Promise<string> {
  const [place] = await tx.select({ line1: schema.property.addressLine1, city: schema.property.city })
    .from(schema.property).where(eq(schema.property.id, propertyId)).limit(1);
  return place ? [place.line1, place.city].filter((p) => p).join(", ") : "the site";
}

/* -------------------------------------------------------------- scale tickets */

export interface TicketPlanView {
  line: number;
  action: "attach" | "unchanged" | "skip";
  ticketNumber: string;
  date: string;
  container: string;
  netTons: string;
  rentalId: string | null;
  why: string;
}

export interface TicketImport {
  problems: { line: number; message: string }[];
  rows: TicketPlanView[];
  counts: { attach: number; unchanged: number; skip: number };
}

/**
 * Read a facility's file and match each ticket to a collected haul, inside
 * the caller's transaction, so the preview and the apply are the same
 * function run twice.
 */
async function planWithin(tx: Database, ctx: ServiceContext, csv: string) {
  const parsed = rt.parseScaleTickets(csv);
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const dates = parsed.rows.map((r) => r.date).sort();
  let hauls: rt.Haul[] = [];
  if (dates.length > 0) {
    const earliest = time.startOfDayIn(dates[0]!, zone);
    const start = new Date(earliest.getTime() - 2 * 864e5);
    const end = time.dayBoundsIn(dates.at(-1)!, zone).end;
    const rows = await tx.select({
      id: schema.rental.id, pickedUpAt: schema.rental.pickedUpAt, ticket: schema.rental.disposalTicketNumber,
      tons: schema.rental.weightTons, identifier: schema.rentableAsset.identifier,
    }).from(schema.rental)
      .innerJoin(schema.rentableAsset, eq(schema.rentableAsset.id, schema.rental.assetId))
      .where(and(
        eq(schema.rental.organizationId, ctx.actor.organizationId),
        isNotNull(schema.rental.pickedUpAt),
        sql`${schema.rental.pickedUpAt} >= ${start.toISOString()}::timestamptz`,
        sql`${schema.rental.pickedUpAt} < ${end.toISOString()}::timestamptz`,
      ));
    hauls = rows.map((r) => ({
      rentalId: r.id, container: r.identifier, collectedOn: time.dateIn(r.pickedUpAt!, zone),
      ticketNumber: r.ticket, weightTons: r.tons,
    }));
    /** A ticket number already on any haul, inside or outside the window, is never attached twice. */
    const numbers = [...new Set(parsed.rows.map((r) => r.ticketNumber))];
    const elsewhere = await tx.select({
      id: schema.rental.id, pickedUpAt: schema.rental.pickedUpAt, ticket: schema.rental.disposalTicketNumber,
      tons: schema.rental.weightTons, identifier: schema.rentableAsset.identifier,
    }).from(schema.rental)
      .innerJoin(schema.rentableAsset, eq(schema.rentableAsset.id, schema.rental.assetId))
      .where(and(eq(schema.rental.organizationId, ctx.actor.organizationId), inArray(schema.rental.disposalTicketNumber, numbers)));
    for (const r of elsewhere) {
      if (hauls.some((h) => h.rentalId === r.id) || !r.pickedUpAt) continue;
      hauls.push({ rentalId: r.id, container: r.identifier, collectedOn: time.dateIn(r.pickedUpAt, zone), ticketNumber: r.ticket, weightTons: r.tons });
    }
  }
  const plans = rt.planTickets(parsed.rows, hauls);
  return { parsed, plans };
}

const viewOf = (plans: rt.TicketPlan[], problems: { line: number; message: string }[]): TicketImport => ({
  problems,
  rows: plans.map((p) => ({
    line: p.line, action: p.action, ticketNumber: p.row.ticketNumber, date: p.row.date,
    container: p.row.container, netTons: p.row.netTons,
    rentalId: p.action === "skip" ? null : p.rentalId, why: p.why,
  })),
  counts: {
    attach: plans.filter((p) => p.action === "attach").length,
    unchanged: plans.filter((p) => p.action === "unchanged").length,
    skip: plans.filter((p) => p.action === "skip").length,
  },
});

/** What the file would do, with nothing written. */
export function previewTickets(ctx: ServiceContext, input: { csv: string }) {
  return guardedRead(ctx, "asset:write", async (tx) => {
    const { parsed, plans } = await planWithin(tx, ctx, input.csv);
    return viewOf(plans, parsed.problems);
  });
}

/**
 * Attach the matched tickets. Worked out again from the same file inside the
 * write rather than trusted from a preview a minute old, less any lines a
 * person unticked. Only empty fields are filled: the ticket number, the
 * weight when none was typed, and the facility, material and diverted tons
 * when the file has them and the haul does not.
 */
export function applyTickets(ctx: ServiceContext, input: { csv: string; skipLines?: readonly number[] | undefined }) {
  return guardedWrite(ctx, "asset:write", async (tx): Promise<TicketImport & { attached: number }> => {
    const seen = await once.replayed<TicketImport & { attached: number }>(tx, ctx, "scale_ticket_import");
    if (seen) return seen;
    const { parsed, plans } = await planWithin(tx, ctx, input.csv);
    const skip = new Set(input.skipLines ?? []);
    let attached = 0;
    for (const plan of plans) {
      if (plan.action !== "attach" || skip.has(plan.line)) continue;
      const [hire] = await tx.select().from(schema.rental).where(eq(schema.rental.id, plan.rentalId)).limit(1);
      if (!hire) continue;
      await tx.update(schema.rental).set({
        disposalTicketNumber: plan.row.ticketNumber,
        weightTons: hire.weightTons ?? plan.row.netTons,
        disposalFacility: hire.disposalFacility ?? (plan.row.facility || null),
        materialType: hire.materialType ?? (plan.row.material || null),
        divertedTons: hire.divertedTons ?? plan.row.divertedTons,
        updatedAt: new Date(),
      }).where(eq(schema.rental.id, hire.id));
      await audit(tx, ctx, "rental.ticket_imported", "rental", hire.id,
        { ticket: hire.disposalTicketNumber, tons: hire.weightTons },
        { ticket: plan.row.ticketNumber, tons: plan.row.netTons, line: plan.line });
      attached += 1;
    }
    const answer = { ...viewOf(plans, parsed.problems), attached };
    await once.remember(tx, ctx, "scale_ticket_import", null, answer);
    return answer;
  });
}

/* ------------------------------------------------------------------ handlers */

export const handlers = {
  scheduleRentalCollections: (ctx: ServiceContext, input: { through?: string | undefined }): Promise<CollectionRunResult> =>
    scheduleCollections(ctx, input),
  recordRentalCharge: (ctx: ServiceContext, input: {
    id: string; kind: ChargeKind; priceBookItemId?: string | null | undefined; description?: string | null | undefined;
    quantity?: string | undefined; unitPrice?: string | null | undefined; taxable?: boolean | undefined; note?: string | null | undefined;
  }): Promise<ChargeView> => recordCharge(ctx, { ...input, rentalId: input.id }),
  removeRentalCharge: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> => removeCharge(ctx, input),
  listRentalCharges: async (ctx: ServiceContext, input: { rentalId?: string | undefined }): Promise<{ charges: ChargeView[] }> =>
    ({ charges: await charges(ctx, input) }),
  invoiceRental: (ctx: ServiceContext, input: { id: string }): Promise<HireInvoiceResult> => invoiceHire(ctx, input),
  previewScaleTickets: (ctx: ServiceContext, input: { csv: string }): Promise<TicketImport> => previewTickets(ctx, input),
  applyScaleTickets: (ctx: ServiceContext, input: { csv: string; skipLines?: readonly number[] | undefined }):
    Promise<TicketImport & { attached: number }> => applyTickets(ctx, input),
} as const;
