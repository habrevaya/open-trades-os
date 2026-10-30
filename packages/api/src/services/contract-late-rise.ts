import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, money as m, rates, time, type tax } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { invoiceScopeFilter } from "./scope";
import * as billing from "./billing";
import * as rateCards from "./rate-cards";
import { remember, replayed } from "./once";

/**
 * JOB WORK BILLED AT LAST YEAR'S CARD, BECAUSE THE RISE WAS APPLIED LATE
 *
 * A card prices the work billed on a day by the card in force that day. A
 * contract's rise is applied by a person, sometimes weeks after the
 * anniversary, and until then last year's card is still the one in force, so
 * a job billed in between was priced at last year's prices. Its invoice is
 * left as it is. What each of its lines is short is OFFERED on the contract's
 * page, rise by rise, and billed only when a person asks: on one draft
 * invoice per rise for the lines they tick (`draft`), never issued by this,
 * or written down as not billed (`waive`). The fixed fee does the same under
 * the schedule (`contract-billing.draftDifference`).
 *
 * WHICH LINES. A line priced by the card the rise replaced (its `rate_card_id`
 * is the old card), on an invoice that was issued, priced on or after the
 * anniversary and before the rise was applied. A line the card did not price
 * (our price book, a price typed in, a payer's share of a split line, a markup
 * on our cost, which a rise keeps) is left out and named, with why, and so is
 * a line a person has to decide about: one with a discount, one on an invoice
 * credited or written off, one on a draft not issued yet, whose price can
 * still change. What the new card makes a line is `core/rates.lateRiseOn`.
 *
 * ONCE PER LINE, under a unique index on the invoice line: the decision row is
 * claimed in the same transaction as the draft, so a line is never on two
 * drafts and a second press is refused in words. Deleting the draft deletes
 * its rows (the invoice cascades) and offers the lines again.
 *
 * `invoice:read` and `contract:read` to look, because it is both: invoices
 * and the lines on them, by contract. `invoice:write` to bill or waive,
 * because it writes an invoice, or decides not to. Invoices are read in the
 * actor's own scope, as the invoice list is.
 */

const usd = (value: string) => m.money(value, "USD");
const cents = (value: string) => m.edit(m.round(usd(value), 2));

type ContractRow = typeof schema.serviceContract.$inferSelect;

export interface WorkDifference {
  invoiceLineId: string;
  invoiceId: string;
  invoiceNumber: number;
  issuedOn: string | null;
  jobId: string | null;
  jobNumber: number | null;
  name: string;
  quantity: string;
  /** What each was billed at, and what the risen card charges for it. */
  billedPrice: string;
  risenPrice: string;
  /** The line's total billed, at the risen card, and the difference, all before tax. */
  billed: string;
  risen: string;
  difference: string;
  status: "offered" | "drafted" | "waived";
  draftInvoiceId: string | null;
  draftInvoiceNumber: number | null;
}

export interface LeftOut {
  invoiceLineId: string;
  invoiceId: string;
  invoiceNumber: number;
  name: string;
  reason: string;
}

export interface LateRise {
  /** The day the cards rose from. */
  anniversary: string;
  /** The day a person applied it, in the company's calendar. */
  appliedOn: string;
  /** Each card that rose: last year's and the one that replaced it. */
  cards: Array<{ fromRateCardId: string; fromName: string; rateCardId: string; name: string }>;
  /** Lines the risen cards price higher, with what a person decided. */
  lines: WorkDifference[];
  /** Lines billed in the window that are not offered, and why. */
  leftOut: LeftOut[];
}

export interface WorkDifferencesView {
  contractId: string;
  /** Each rise applied after the anniversary that left work billed at last year's card, newest first. */
  rises: LateRise[];
}

async function loadContract(tx: Database, id: string): Promise<ContractRow> {
  const [row] = await tx.select().from(schema.serviceContract)
    .where(and(eq(schema.serviceContract.id, id), isNull(schema.serviceContract.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Contract");
  return row;
}

/** Statuses of an invoice that was issued and still stands. */
const ISSUED = ["open", "partially_paid", "paid"] as const;

/** Every late rise on the contract and what it left, worked out now, with every decision made. */
async function differencesWithin(tx: Database, ctx: ServiceContext, contract: ContractRow): Promise<LateRise[]> {
  const risenCards = await tx.select().from(schema.rateCard).where(and(
    eq(schema.rateCard.contractId, contract.id),
    isNotNull(schema.rateCard.escalatedFromId),
    isNull(schema.rateCard.draftFor),
    isNull(schema.rateCard.deletedAt),
  )).orderBy(asc(schema.rateCard.effectiveFrom), asc(schema.rateCard.createdAt));
  if (risenCards.length === 0) return [];
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const fromIds = risenCards.map((c) => c.escalatedFromId!);
  const olderCards = await tx.select().from(schema.rateCard).where(inArray(schema.rateCard.id, fromIds));
  const older = new Map(olderCards.map((c) => [c.id, c]));
  const terms = new Map((await rateCards.termsOfCards(tx, risenCards, zone)).map((t) => [t.id, t]));

  const decided = await tx.select({ row: schema.contractWorkDifference, number: schema.invoice.number })
    .from(schema.contractWorkDifference)
    .leftJoin(schema.invoice, eq(schema.invoice.id, schema.contractWorkDifference.invoiceId))
    .where(eq(schema.contractWorkDifference.contractId, contract.id));
  const byLine = new Map(decided.map((d) => [d.row.invoiceLineId, d]));

  const byAnniversary = new Map<string, { rise: LateRise; risen: Map<string, { card: typeof risenCards[number]; terms: rates.CardTerms }> }>();
  for (const card of risenCards) {
    const old = older.get(card.escalatedFromId!);
    if (!old || !card.effectiveFrom) continue;
    const anniversary = card.effectiveFrom;
    const appliedOn = time.dateIn(card.createdAt, zone);
    const entry = byAnniversary.get(anniversary)
      ?? { rise: { anniversary, appliedOn, cards: [], lines: [], leftOut: [] } as LateRise, risen: new Map() };
    byAnniversary.set(anniversary, entry);
    if (appliedOn < entry.rise.appliedOn) entry.rise.appliedOn = appliedOn;
    entry.rise.cards.push({ fromRateCardId: old.id, fromName: old.name, rateCardId: card.id, name: card.name });
    entry.risen.set(old.id, { card, terms: terms.get(card.id)! });
  }

  const scoped = invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor);
  for (const { rise, risen } of byAnniversary.values()) {
    /**
     * The invoices last year's cards priced work on from the anniversary until
     * the rise was written, voided ones aside, in the caller's scope. Every line
     * on them is shown: the card's offered, and the rest named as left out.
     */
    const priced = await tx.select({ line: schema.invoiceLine, invoiceId: schema.invoice.id }).from(schema.invoiceLine)
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.invoiceLine.invoiceId))
      .where(and(
        inArray(schema.invoiceLine.rateCardId, [...risen.keys()]),
        ne(schema.invoice.status, "void"),
        isNull(schema.invoice.deletedAt),
        scoped,
      ));
    const inWindow = (line: typeof schema.invoiceLine.$inferSelect) => {
      const next = line.rateCardId ? risen.get(line.rateCardId) : undefined;
      return next !== undefined && line.createdAt < next.card.createdAt
        && time.dateIn(line.createdAt, zone) >= rise.anniversary;
    };
    const invoiceIds = [...new Set(priced.filter((p) => inWindow(p.line)).map((p) => p.invoiceId))];
    if (invoiceIds.length === 0) continue;
    const rows = await tx.select({ line: schema.invoiceLine, invoice: schema.invoice, jobNumber: schema.job.number })
      .from(schema.invoiceLine)
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.invoiceLine.invoiceId))
      .leftJoin(schema.job, eq(schema.job.id, schema.invoice.jobId))
      .where(inArray(schema.invoiceLine.invoiceId, invoiceIds))
      .orderBy(asc(schema.invoice.number), asc(schema.invoiceLine.sortOrder), asc(schema.invoiceLine.createdAt));
    await judge(tx, rise, rows.map((r) => ({
      ...r, risen: inWindow(r.line) ? risen.get(r.line.rateCardId!)!.terms : null,
    })), byLine, contract);
  }
  return [...byAnniversary.values()].map((e) => e.rise)
    .filter((r) => r.lines.length > 0 || r.leftOut.length > 0)
    .sort((a, b) => (a.anniversary < b.anniversary ? 1 : -1));
}

type WindowRow = {
  line: typeof schema.invoiceLine.$inferSelect;
  invoice: typeof schema.invoice.$inferSelect;
  jobNumber: number | null;
  /** The card that replaced the one that priced it, when last year's card priced it in the window. */
  risen: rates.CardTerms | null;
};

/** Each line in the window offered at the risen card's price, left out with a reason, or as a person decided it. */
async function judge(
  tx: Database, rise: LateRise, rows: readonly WindowRow[],
  byLine: Map<string, { row: typeof schema.contractWorkDifference.$inferSelect; number: number | null }>,
  contract: ContractRow,
): Promise<void> {
  const lineIds = rows.map((r) => r.line.id);
  const credited = new Set((await tx.select({ id: schema.creditNoteLine.invoiceLineId }).from(schema.creditNoteLine)
    .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNoteLine.creditNoteId))
    .where(and(inArray(schema.creditNoteLine.invoiceLineId, lineIds), ne(schema.creditNote.status, "void"))))
    .map((r) => r.id));
  const creditedInvoices = new Set((await tx.select({ id: schema.creditNote.invoiceId }).from(schema.creditNote)
    .where(and(inArray(schema.creditNote.invoiceId, [...new Set(rows.map((r) => r.invoice.id))]), ne(schema.creditNote.status, "void"))))
    .map((r) => r.id));
  const work = await tx.select({ id: schema.jobLine.id, invoiceLineId: schema.jobLine.invoiceLineId })
    .from(schema.jobLine).where(inArray(schema.jobLine.invoiceLineId, lineIds));
  const facts = await rateCards.jobLinesFor(tx, work.map((w) => w.id));
  const workOf = new Map(work.map((w) => [w.invoiceLineId!, facts.get(w.id)]));
  const jobTypes = new Map((await tx.select({ id: schema.job.id, jobTypeId: schema.job.jobTypeId }).from(schema.job)
    .where(inArray(schema.job.id, [...new Set(rows.map((r) => r.invoice.jobId).filter((x): x is string => x !== null))])))
    .map((j) => [j.id, j.jobTypeId]));
  const listedIds = rows.map((r) => r.line.rateCardLineId).filter((x): x is string => x !== null);
  const listed = new Map((listedIds.length === 0 ? [] : await tx.select().from(schema.rateCardLine)
    .where(inArray(schema.rateCardLine.id, listedIds))).map((l) => [l.id, l]));

  for (const { line, invoice, jobNumber, risen } of rows) {
    const base = { invoiceLineId: line.id, invoiceId: invoice.id, invoiceNumber: invoice.number, name: line.name };
    const made = byLine.get(line.id);
    if (made) {
      rise.lines.push({
        ...base, issuedOn: invoice.issuedOn, jobId: invoice.jobId, jobNumber,
        quantity: line.quantity, billedPrice: line.unitPrice,
        risenPrice: made.row.risenPrice,
        billed: made.row.billedAmount, risen: made.row.risenAmount, difference: made.row.amount,
        status: made.row.status, draftInvoiceId: made.row.invoiceId, draftInvoiceNumber: made.number,
      });
      continue;
    }
    const left = (reason: string) => { rise.leftOut.push({ ...base, reason }); };
    if (!risen) {
      left(rates.LATE_RISE_LEFT_OUT[line.priceBasis ?? ""] ?? "Not priced from the card that rose.");
      continue;
    }
    if (invoice.status === "draft") { left("Still a draft. Its prices can change before it is issued, so nothing is offered on it."); continue; }
    if (invoice.status === "written_off") { left("The invoice was written off."); continue; }
    if (!ISSUED.includes(invoice.status as typeof ISSUED[number])) { left("The invoice is not one that stands."); continue; }
    if (invoice.customerId !== contract.customerId) { left("Billed to somebody other than the contract's customer."); continue; }
    if (credited.has(line.id) || creditedInvoices.has(invoice.id)) {
      left("A credit note was given on the invoice, so what it still charges is for a person to work out.");
      continue;
    }
    const recorded = workOf.get(line.id);
    const cardLine = line.rateCardLineId ? listed.get(line.rateCardLineId) : undefined;
    const result = rates.lateRiseOn(risen, {
      basis: line.priceBasis ?? "entered",
      quantity: line.quantity,
      unitPrice: usd(line.unitPrice),
      discounted: m.isPositive(usd(line.discountAmount)) || m.isPositive(usd(line.memberDiscountAmount)),
      listed: cardLine
        ? { priceBookItemId: cardLine.priceBookItemId, externalCode: cardLine.externalCode, description: cardLine.description }
        : null,
      work: recorded ? {
        kind: recorded.kind, name: recorded.line.name, priceBookItemId: recorded.itemId,
        quantity: recorded.line.quantity, ourPrice: usd(recorded.line.unitPrice), ourPriceIsBook: false,
        unitCost: recorded.line.unitCost ? usd(recorded.line.unitCost) : null, at: recorded.at,
        jobTypeId: invoice.jobId ? jobTypes.get(invoice.jobId) ?? null : null,
      } : null,
    });
    if (result.kind === "left_out") { left(result.reason); continue; }
    rise.lines.push({
      ...base, issuedOn: invoice.issuedOn, jobId: invoice.jobId, jobNumber,
      quantity: line.quantity, billedPrice: line.unitPrice, risenPrice: m.toString(result.unitPrice),
      billed: m.toString(result.billed), risen: m.toString(result.risen), difference: m.toString(result.difference),
      status: "offered", draftInvoiceId: null, draftInvoiceNumber: null,
    });
  }
}

/** The lines picked, each offered now under the one rise named, or refused in words. */
async function pickOffered(
  tx: Database, ctx: ServiceContext, contract: ContractRow, anniversary: string, lineIds: readonly string[],
): Promise<{ rise: LateRise; picked: WorkDifference[] }> {
  const ids = [...new Set(lineIds)];
  if (ids.length === 0) throw new ConflictError("Pick at least one line.");
  const rise = (await differencesWithin(tx, ctx, contract)).find((r) => r.anniversary === anniversary);
  if (!rise) throw new ConflictError(`Nothing billed before the rise from ${anniversary} was applied is short by it.`);
  const picked = ids.map((id) => {
    const found = rise.lines.find((l) => l.invoiceLineId === id);
    if (!found) {
      const out = rise.leftOut.find((l) => l.invoiceLineId === id);
      throw new ConflictError(out
        ? `${out.name} on invoice ${out.invoiceNumber} is not offered: ${out.reason}`
        : `A line picked was not billed short by the rise from ${anniversary}. Pick lines from one rise at a time.`);
    }
    if (found.status !== "offered") {
      throw new ConflictError(`The difference on ${found.name}, invoice ${found.invoiceNumber}, has already been ${
        found.status === "drafted" ? `put on draft invoice ${found.draftInvoiceNumber ?? ""}`.trim() : "waived"}.`);
    }
    return found;
  });
  return { rise, picked };
}

/** The decisions claimed under the unique index on the line, or refused when somebody got there first. */
async function claim(
  tx: Database, ctx: ServiceContext, contractId: string, rise: LateRise, picked: readonly WorkDifference[],
  status: "drafted" | "waived",
): Promise<string[]> {
  const cardOf = await tx.select({ id: schema.invoiceLine.id, rateCardId: schema.invoiceLine.rateCardId })
    .from(schema.invoiceLine).where(inArray(schema.invoiceLine.id, picked.map((p) => p.invoiceLineId)));
  const risenFor = new Map(rise.cards.map((c) => [c.fromRateCardId, c.rateCardId]));
  const rows = await tx.insert(schema.contractWorkDifference).values(picked.map((d) => ({
    organizationId: ctx.actor.organizationId,
    contractId,
    invoiceLineId: d.invoiceLineId,
    rateCardId: risenFor.get(cardOf.find((c) => c.id === d.invoiceLineId)!.rateCardId!)!,
    anniversary: rise.anniversary,
    status,
    billedAmount: d.billed,
    risenPrice: d.risenPrice,
    risenAmount: d.risen,
    amount: d.difference,
  }))).onConflictDoNothing().returning({ id: schema.contractWorkDifference.id });
  if (rows.length !== picked.length) {
    throw new ConflictError("Somebody decided one of these lines a moment ago. Look at the contract again.");
  }
  return rows.map((r) => r.id);
}

/** What a late rise left short on the contract's job work, rise by rise. */
export async function view(ctx: ServiceContext, input: { contractId: string }): Promise<WorkDifferencesView> {
  assertCan(ctx.actor, "contract:read");
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const contract = await loadContract(tx, input.contractId);
    return { contractId: contract.id, rises: await differencesWithin(tx, ctx, contract) };
  });
}

export interface WorkDifferenceDrafted {
  contractId: string;
  anniversary: string;
  invoiceId: string;
  invoiceNumber: number;
  /** The draft's total, with tax on the lines that were taxed. */
  total: string;
  lines: number;
}

/**
 * The difference on the lines picked, from one rise, as ONE DRAFT INVOICE to
 * the contract's customer with its PO number: a line for each, saying what it
 * was, which invoice billed it at last year's price, and what the risen card
 * charges. A draft, because whether to ask a client for money after the fact
 * is a person's call: issuing it is the ordinary issue on the invoice. Each
 * line is taxed at the rate the line it adds to was taxed at, and no member
 * discount comes off it: the card's price is the client's agreed price.
 */
export function draft(
  ctx: ServiceContext, input: { contractId: string; anniversary: string; invoiceLineIds: string[] },
): Promise<WorkDifferenceDrafted> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<WorkDifferenceDrafted>(tx, ctx, "contract_work_difference");
    if (seen) return seen;
    const contract = await loadContract(tx, input.contractId);
    const { rise, picked } = await pickOffered(tx, ctx, contract, input.anniversary, input.invoiceLineIds);
    const claimed = await claim(tx, ctx, contract.id, rise, picked, "drafted");

    const originals = await tx.select().from(schema.invoiceLine)
      .where(inArray(schema.invoiceLine.id, picked.map((p) => p.invoiceLineId)));
    const original = new Map(originals.map((l) => [l.id, l]));
    const cardFor = new Map(rise.cards.map((c) => [c.fromRateCardId, c]));
    const risenCards = await tx.select().from(schema.rateCard)
      .where(inArray(schema.rateCard.id, rise.cards.map((c) => c.rateCardId)));
    const authority = new Map(risenCards.map((c) => [c.id, c.authority as rates.PriceAuthority]));
    const invoices = [...new Set(picked.map((p) => p.invoiceNumber))].sort((a, b) => a - b);

    const { idempotencyKey: _key, ...plain } = ctx;
    const shaped = picked.map((d) => {
      const line = original.get(d.invoiceLineId)!;
      const card = cardFor.get(line.rateCardId!)!;
      const job = d.jobNumber !== null ? ` for job ${d.jobNumber}` : "";
      return {
        input: {
          name: `${d.name}, card price rise from ${rise.anniversary}`,
          description: `${m.edit(usd(d.quantity))} at ${cents(d.risenPrice)} on ${card.name}, less ${cents(d.billedPrice)} `
            + `billed on invoice ${d.invoiceNumber}${job}`,
          quantity: "1",
          unitPrice: d.difference,
          discountAmount: "0",
          taxable: line.taxable,
        },
        prepared: {
          unitPrice: usd(d.difference),
          quantity: "1",
          authority: authority.get(card.rateCardId) ?? "contract",
          basis: (line.priceBasis ?? "card_line") as rates.PriceBasis,
          note: `${card.name}: ${cents(d.billedPrice)} rose to ${cents(d.risenPrice)} on ${rise.anniversary}, `
            + `applied after invoice ${d.invoiceNumber} was billed at last year's price.`,
          rateCardId: card.rateCardId,
          rateCardLineId: null,
          taxRate: line.taxable ? line.taxRate : "0",
          taxRateId: line.taxable ? line.taxRateId : null,
          taxSource: line.taxable ? (line.taxSource as tax.TaxSource | null) : null,
        } satisfies billing.PreparedLine,
      };
    });
    const invoice = await billing.createIn(tx, plain, {
      customerId: contract.customerId,
      ...(contract.purchaseOrderNumber ? { purchaseOrderNumber: contract.purchaseOrderNumber } : {}),
      draft: true,
      memo: `${contract.name}${contract.contractNumber ? `, contract ${contract.contractNumber}` : ""}: `
        + `the card prices rose from ${rise.anniversary}, applied on ${rise.appliedOn}, after invoice`
        + `${invoices.length === 1 ? "" : "s"} ${invoices.join(", ")} ${invoices.length === 1 ? "was" : "were"} billed at last year's prices.`,
      lines: shaped.map((s) => s.input),
    }, {
      prepared: shaped.map((s) => s.prepared),
      memberPricing: false,
    });
    await tx.update(schema.contractWorkDifference).set({ invoiceId: invoice.id as string, updatedAt: new Date() })
      .where(inArray(schema.contractWorkDifference.id, claimed));
    await audit(tx, ctx, "contract.work_difference_drafted", "service_contract", contract.id, null, {
      invoiceId: invoice.id, anniversary: rise.anniversary,
      lines: picked.map((d) => ({ invoiceLineId: d.invoiceLineId, invoiceNumber: d.invoiceNumber, amount: d.difference })),
    });
    const result: WorkDifferenceDrafted = {
      contractId: contract.id, anniversary: rise.anniversary, invoiceId: invoice.id as string,
      invoiceNumber: invoice.number as number, total: invoice.total as string, lines: picked.length,
    };
    await remember(tx, ctx, "contract_work_difference", contract.id, result);
    return result;
  });
}

/**
 * The difference on the lines picked written down as not billed: the company
 * has decided not to ask. Who decided is on the audit line, and the lines are
 * not offered again. `invoice:write`, because not billing money owed is the
 * same decision as billing it.
 */
export function waive(
  ctx: ServiceContext, input: { contractId: string; anniversary: string; invoiceLineIds: string[] },
): Promise<WorkDifferencesView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<WorkDifferencesView>(tx, ctx, "contract_work_difference_waive");
    if (seen) return seen;
    const contract = await loadContract(tx, input.contractId);
    const { rise, picked } = await pickOffered(tx, ctx, contract, input.anniversary, input.invoiceLineIds);
    await claim(tx, ctx, contract.id, rise, picked, "waived");
    await audit(tx, ctx, "contract.work_difference_waived", "service_contract", contract.id, null, {
      anniversary: rise.anniversary,
      lines: picked.map((d) => ({ invoiceLineId: d.invoiceLineId, invoiceNumber: d.invoiceNumber, amount: d.difference })),
    });
    const result: WorkDifferencesView = { contractId: contract.id, rises: await differencesWithin(tx, ctx, contract) };
    await remember(tx, ctx, "contract_work_difference_waive", contract.id, result);
    return result;
  });
}

type Picked = { contractId: string; anniversary: string; invoiceLineIds: string[] };

export const handlers = {
  getContractWorkDifferences: (ctx: ServiceContext, input: { contractId: string }) => view(ctx, input),
  draftContractWorkDifference: (ctx: ServiceContext, input: Picked) => draft(ctx, input),
  waiveContractWorkDifference: (ctx: ServiceContext, input: Picked) => waive(ctx, input),
} as const;
