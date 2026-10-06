import { and, asc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { holidays as holidayRules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { inForceAt } from "./pricebook";
import { loadHolidays } from "./holidays";

/**
 * AFTER HOURS AND HOLIDAY RATES
 *
 * Which price book item is charged for work booked outside the company's
 * hours, and which for work on a holiday, and the offer of it on an invoice.
 *
 * THE ITEMS ARE THE ONES ALREADY MARKED. A membership plan that waives the
 * after hours rate waives the item marked `after_hours` (M08 finds it by that
 * mark and by nothing else), so both rates here are items with that mark,
 * and choosing one that is not marked yet marks it. A holiday rate on an
 * unmarked item would be charged in full to a member whose plan says they
 * never pay the after hours rate, which is the conservative reading of what
 * that member was told.
 *
 * OFFERED, NEVER ADDED. A visit booked at seven in the evening or on
 * Christmas Day is a reason to ask, not an answer: the customer's emergency
 * and the company running late look the same in the data. The invoice
 * screens show the offer with the sentence that says why, and the office
 * adds the line or does not.
 *
 * Read with `pricebook:read`, changed with `pricebook:write`, because which
 * item a company charges is a pricing decision.
 */

interface ItemView { id: string; code: string; name: string; price: string; taxable: boolean }

async function itemsByIds(tx: Database, ids: string[]): Promise<Map<string, ItemView>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({
    id: schema.priceBookItem.id,
    code: schema.priceBookItem.code,
    name: schema.priceBookItemVersion.name,
    price: schema.priceBookItemVersion.price,
    taxable: schema.priceBookItemVersion.taxable,
  }).from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id), inForceAt()))
    .where(and(inArray(schema.priceBookItem.id, ids), isNull(schema.priceBookItem.deletedAt)));
  return new Map(rows.map((row) => [row.id, row]));
}

async function settingsRow(tx: Database) {
  const [row] = await tx.select().from(schema.afterHoursRate).limit(1);
  return row ?? null;
}

export interface RatesView {
  afterHoursItem: ItemView | null;
  holidayItem: ItemView | null;
  /** Items already marked as the after hours rate, which either may be. */
  marked: ItemView[];
}

export async function rates(ctx: ServiceContext): Promise<RatesView> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const row = await settingsRow(tx);
    const markedIds = (await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
      .where(and(
        eq(schema.priceBookItem.feeRole, "after_hours"),
        eq(schema.priceBookItem.active, true),
        isNull(schema.priceBookItem.deletedAt),
      ))).map((r) => r.id);
    const items = await itemsByIds(tx, [...new Set([
      ...markedIds, ...(row?.afterHoursItemId ? [row.afterHoursItemId] : []), ...(row?.holidayItemId ? [row.holidayItemId] : []),
    ])]);
    return {
      afterHoursItem: row?.afterHoursItemId ? items.get(row.afterHoursItemId) ?? null : null,
      holidayItem: row?.holidayItemId ? items.get(row.holidayItemId) ?? null : null,
      marked: markedIds.map((id) => items.get(id)).filter((i): i is ItemView => Boolean(i))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * An item that may be a rate: live, and not the diagnostic fee. Marked as the
 * after hours rate here when it is not already, with the same audit line the
 * item's own screen writes, so the item's page says what it is.
 */
async function markable(tx: Database, ctx: ServiceContext, id: string, which: string): Promise<void> {
  const [item] = await tx.select().from(schema.priceBookItem)
    .where(and(eq(schema.priceBookItem.id, id), isNull(schema.priceBookItem.deletedAt))).limit(1);
  if (!item) throw new NotFoundError("Price book item");
  if (!item.active) throw new ConflictError(`That item is retired, so it cannot be the ${which}. Sell it again first.`);
  if (item.feeRole === "diagnostic") {
    throw new ConflictError(`${item.code} is marked as the diagnostic fee, so it cannot also be the ${which}.`);
  }
  if (item.feeRole === "after_hours") return;
  await tx.update(schema.priceBookItem).set({ feeRole: "after_hours", updatedAt: new Date() })
    .where(eq(schema.priceBookItem.id, id));
  await audit(tx, ctx, "pricebook.item_updated", "price_book_item", id,
    { kind: item.kind, code: item.code, categoryId: item.categoryId, feeRole: item.feeRole },
    { kind: item.kind, code: item.code, categoryId: item.categoryId, feeRole: "after_hours" });
}

export async function setRates(
  ctx: ServiceContext, input: { afterHoursItemId: string | null; holidayItemId: string | null },
): Promise<RatesView> {
  await guardedWrite(ctx, "pricebook:write", async (tx) => {
    if (input.afterHoursItemId) await markable(tx, ctx, input.afterHoursItemId, "after hours rate");
    if (input.holidayItemId) await markable(tx, ctx, input.holidayItemId, "holiday rate");
    const before = await settingsRow(tx);
    const values = {
      afterHoursItemId: input.afterHoursItemId,
      holidayItemId: input.holidayItemId,
      updatedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    };
    const [after] = await tx.insert(schema.afterHoursRate)
      .values({ organizationId: ctx.actor.organizationId, ...values })
      .onConflictDoUpdate({ target: [schema.afterHoursRate.organizationId], set: values })
      .returning();
    await audit(tx, ctx, "after_hours_rate.set", "organization", ctx.actor.organizationId,
      before ? { afterHoursItemId: before.afterHoursItemId, holidayItemId: before.holidayItemId } : null,
      { afterHoursItemId: after!.afterHoursItemId, holidayItemId: after!.holidayItemId });
  });
  return rates(ctx);
}

/* ------------------------------------------------------------- the offer */

export interface RateOffer {
  kind: "after_hours" | "holiday";
  item: ItemView;
  /** How many of the job's visits it is for, which is the quantity offered. */
  quantity: number;
  /** One sentence per visit, saying when it was booked and why that counts. */
  because: string[];
}

/** The week's hours from the rows online booking keeps, or null when none are declared. */
async function weekOf(tx: Database): Promise<holidayRules.WeekHours | null> {
  const rows = await tx.select().from(schema.businessHours);
  if (rows.length === 0) return null;
  return Array.from({ length: 7 }, (_, dow) => {
    const row = rows.find((r) => r.dayOfWeek === dow && r.businessUnitId === null) ?? rows.find((r) => r.dayOfWeek === dow);
    const open = holidayRules.minutesOf(row?.opensAt);
    const close = holidayRules.minutesOf(row?.closesAt);
    return !row || row.closed || open === null || close === null ? null : { openMinute: open, closeMinute: close };
  });
}

/**
 * What to offer on an invoice for this job: the holiday rate for each visit
 * booked on a date in the holiday list, and the after hours rate for each
 * booked outside the hours kept that day (on a holiday only when there is no
 * holiday rate, so one visit is never offered both).
 *
 * A visit counts by the start of the window it was booked into, because that
 * is what the customer was promised. Cancelled visits are not counted. An
 * item already on another of the job's invoices that was not voided is not
 * offered again; the invoice being edited is left out of that, because its
 * own lines are on the screen.
 */
export async function offersForJob(
  ctx: ServiceContext, input: { jobId: string; exceptInvoiceId?: string | undefined },
): Promise<RateOffer[]> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const row = await settingsRow(tx);
    if (!row || (!row.afterHoursItemId && !row.holidayItemId)) return [];
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job).where(eq(schema.job.id, input.jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");

    const visits = await tx.select({ windowStart: schema.visit.windowStart }).from(schema.visit)
      .where(and(eq(schema.visit.jobId, input.jobId), ne(schema.visit.status, "cancelled")))
      .orderBy(asc(schema.visit.windowStart));
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const week = await weekOf(tx);
    const holidays = await loadHolidays(tx, ctx.actor.organizationId);

    const found = { after_hours: [] as string[], holiday: [] as string[] };
    for (const visit of visits) {
      if (!visit.windowStart) continue;
      const booked = holidayRules.bookedAt({
        week, holidays, date: time.dateIn(visit.windowStart, zone), minute: time.minutesInDay(visit.windowStart, zone),
      });
      if (booked.holiday && row.holidayItemId) found.holiday.push(booked.why);
      else if (booked.outsideHours && row.afterHoursItemId) found.after_hours.push(booked.why);
    }

    const billed = await billedItems(tx, input.jobId, input.exceptInvoiceId);
    const items = await itemsByIds(tx, [row.afterHoursItemId, row.holidayItemId].filter((id): id is string => id !== null));
    const offers: RateOffer[] = [];
    for (const kind of ["holiday", "after_hours"] as const) {
      const itemId = kind === "holiday" ? row.holidayItemId : row.afterHoursItemId;
      const item = itemId ? items.get(itemId) : undefined;
      if (!item || found[kind].length === 0 || billed.has(item.id)) continue;
      const existing = offers.find((o) => o.item.id === item.id);
      /** One item for both, when the company charges the same rate: one offer, every visit under it. */
      if (existing) {
        existing.quantity += found[kind].length;
        existing.because.push(...found[kind]);
        continue;
      }
      offers.push({ kind, item, quantity: found[kind].length, because: found[kind] });
    }
    return offers;
  });
}

/** The price book items already billed on this job's invoices that were not voided. */
async function billedItems(tx: Database, jobId: string, exceptInvoiceId: string | undefined): Promise<Set<string>> {
  const rows = await tx.select({ itemId: schema.priceBookItemVersion.itemId })
    .from(schema.invoiceLine)
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.invoiceLine.invoiceId))
    .innerJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.invoiceLine.priceBookItemVersionId))
    .where(and(
      eq(schema.invoice.jobId, jobId),
      notInArray(schema.invoice.status, ["void"]),
      isNull(schema.invoice.deletedAt),
      exceptInvoiceId ? ne(schema.invoice.id, exceptInvoiceId) : undefined,
    ));
  return new Set(rows.map((r) => r.itemId));
}

/* -------------------------------------------------------------- handlers */

export const handlers = {
  getAfterHoursRates: (ctx: ServiceContext) => rates(ctx),
  setAfterHoursRates: (ctx: ServiceContext, input: { afterHoursItemId: string | null; holidayItemId: string | null }) =>
    setRates(ctx, input),
  getJobRateOffers: async (ctx: ServiceContext, input: { id: string; exceptInvoiceId?: string | undefined }) =>
    ({ offers: await offersForJob(ctx, { jobId: input.id, exceptInvoiceId: input.exceptInvoiceId }) }),
} as const;
