import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, rates, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, UnprocessableError,
  type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";

/**
 * THE RULES ON A RATE CARD, AND FINDING THE CARD THAT APPLIES
 *
 * `contracts.ts` writes a card's item list. This file writes the rest of
 * it, which is most of what a commercial schedule is: hourly rates by trade
 * and time band, markup bands on materials, a trip charge, and the client's
 * own definition of standard hours. And it answers the question every
 * pricing path asks first: whose cards apply to this payer, today, on this
 * job.
 *
 * The decision about WHICH rule prices a line is not here. It is pure, it is
 * in `core/rates`, and it is tested without a database; this file only loads
 * what it needs.
 */

const usd = (value: string) => m.money(value, "USD");

/* --------------------------------------------------------------- terms */

export interface LabourRateInput {
  jobTypeId?: string | null | undefined;
  band: rates.LabourBand;
  hourlyRate: string;
  minimumMinutes?: number | null | undefined;
  incrementMinutes?: number | null | undefined;
}

export interface CardTermsInput {
  rateCardId: string;
  labourRates: LabourRateInput[];
  materialMarkup: Array<{ upToCost?: string | null | undefined; percent: string }>;
  tripCharge?: string | null | undefined;
  standardDays?: number[] | undefined;
  standardStartMinute?: number | undefined;
  standardEndMinute?: number | undefined;
  holidays?: string[] | undefined;
}

export interface CardTermsView {
  rateCardId: string;
  name: string;
  authority: string;
  contractId: string | null;
  labourRates: Array<{
    id: string; jobTypeId: string | null; jobTypeName: string | null; band: rates.LabourBand;
    hourlyRate: string; minimumMinutes: number | null; incrementMinutes: number | null;
  }>;
  materialMarkup: Array<{ upToCost: string | null; percent: string }>;
  tripCharge: string | null;
  standardDays: number[];
  standardStartMinute: number;
  standardEndMinute: number;
  holidays: string[];
}

async function loadCard(tx: Database, organizationId: string, id: string) {
  const [card] = await tx.select().from(schema.rateCard)
    .where(and(
      eq(schema.rateCard.id, id),
      eq(schema.rateCard.organizationId, organizationId),
      isNull(schema.rateCard.deletedAt),
    )).limit(1);
  if (!card) throw new NotFoundError("Rate card");
  return card;
}

async function viewOf(tx: Database, card: typeof schema.rateCard.$inferSelect): Promise<CardTermsView> {
  const labour = await tx.select({
    rate: schema.rateCardLabourRate,
    jobTypeName: schema.jobType.name,
  }).from(schema.rateCardLabourRate)
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.rateCardLabourRate.jobTypeId))
    .where(eq(schema.rateCardLabourRate.rateCardId, card.id))
    .orderBy(asc(schema.rateCardLabourRate.band), asc(schema.jobType.name));
  return {
    rateCardId: card.id,
    name: card.name,
    authority: card.authority,
    contractId: card.contractId,
    labourRates: labour.map(({ rate, jobTypeName }) => ({
      id: rate.id,
      jobTypeId: rate.jobTypeId,
      jobTypeName,
      band: rate.band,
      hourlyRate: rate.hourlyRate,
      minimumMinutes: rate.minimumMinutes,
      incrementMinutes: rate.incrementMinutes,
    })),
    materialMarkup: card.materialMarkup,
    tripCharge: card.tripCharge,
    standardDays: card.standardDays,
    standardStartMinute: card.standardStartMinute,
    standardEndMinute: card.standardEndMinute,
    holidays: card.holidays,
  };
}

export async function terms(ctx: ServiceContext, input: { rateCardId: string }): Promise<CardTermsView> {
  return guardedRead(ctx, "pricebook:read", async (tx) =>
    viewOf(tx, await loadCard(tx, ctx.actor.organizationId, input.rateCardId)));
}

/**
 * Set a card's rules, all of them at once.
 *
 * Replaced rather than merged, for the reason the item list is: a schedule
 * arrives as a document, and merging next year's rates into last year's
 * leaves every rate the client dropped still charged. Every rule is checked
 * before anything is written, so a card is never half updated.
 */
export async function setTerms(ctx: ServiceContext, input: CardTermsInput): Promise<CardTermsView> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const seen = await replayed<CardTermsView>(tx, ctx, "rate_card_terms");
    if (seen) return seen;

    const card = await loadCard(tx, ctx.actor.organizationId, input.rateCardId);

    const labour: rates.LabourRate[] = [];
    for (const [index, rate] of input.labourRates.entries()) {
      let hourly: m.Money;
      try {
        hourly = usd(rate.hourlyRate);
      } catch {
        throw new UnprocessableError("An hourly rate is not an amount", [{
          path: `labourRates.${index}.hourlyRate`, message: `"${rate.hourlyRate}" is not an amount.`,
        }]);
      }
      labour.push({
        jobTypeId: rate.jobTypeId ?? null,
        band: rate.band,
        hourlyRate: hourly,
        minimumMinutes: rate.minimumMinutes ?? null,
        incrementMinutes: rate.incrementMinutes ?? null,
      });
    }
    const labourProblem = rates.labourRatesProblem(labour);
    if (labourProblem) throw new ConflictError(labourProblem);

    const jobTypeIds = [...new Set(labour.map((r) => r.jobTypeId).filter((x): x is string => x !== null))];
    if (jobTypeIds.length > 0) {
      const found = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
        .where(inArray(schema.jobType.id, jobTypeIds));
      if (found.length !== jobTypeIds.length) throw new NotFoundError("Job type");
    }

    const markup: rates.MarkupTier[] = input.materialMarkup.map((tier) => ({
      upToCost: tier.upToCost ? usd(tier.upToCost) : null,
      percent: tier.percent,
    }));
    const markupProblem = rates.markupTiersProblem(markup);
    if (markupProblem) throw new ConflictError(markupProblem);

    const bands = {
      standardDays: input.standardDays ?? card.standardDays,
      standardStartMinute: input.standardStartMinute ?? card.standardStartMinute,
      standardEndMinute: input.standardEndMinute ?? card.standardEndMinute,
      holidays: input.holidays ?? card.holidays,
    };
    const bandProblem = rates.bandRulesProblem(bands);
    if (bandProblem) throw new ConflictError(bandProblem);

    const trip = input.tripCharge ? usd(input.tripCharge) : null;
    if (trip && m.isNegative(trip)) throw new ConflictError("A negative trip charge is not a charge.");

    const before = await viewOf(tx, card);
    await tx.delete(schema.rateCardLabourRate).where(eq(schema.rateCardLabourRate.rateCardId, card.id));
    if (labour.length > 0) {
      await tx.insert(schema.rateCardLabourRate).values(labour.map((rate) => ({
        organizationId: ctx.actor.organizationId,
        rateCardId: card.id,
        jobTypeId: rate.jobTypeId,
        band: rate.band,
        hourlyRate: m.toString(rate.hourlyRate),
        minimumMinutes: rate.minimumMinutes,
        incrementMinutes: rate.incrementMinutes,
      })));
    }
    const [updated] = await tx.update(schema.rateCard).set({
      tripCharge: trip ? m.toString(trip) : null,
      materialMarkup: rates.sortTiers(markup).map((tier) => ({
        upToCost: tier.upToCost ? m.toString(tier.upToCost) : null,
        percent: tier.percent,
      })),
      standardDays: [...new Set(bands.standardDays)].sort(),
      standardStartMinute: bands.standardStartMinute,
      standardEndMinute: bands.standardEndMinute,
      holidays: [...new Set(bands.holidays)].sort(),
      updatedAt: new Date(),
    }).where(eq(schema.rateCard.id, card.id)).returning();

    const after = await viewOf(tx, updated!);
    await audit(tx, ctx, "rate_card.terms_set", "rate_card", card.id, before, after);
    await remember(tx, ctx, "rate_card_terms", card.id, after);
    return after;
  });
}

/* --------------------------------------------- the cards that apply */

/**
 * The cards in force for one payer on one day, with everything on them.
 *
 * Through the payer's contracts, because a card is an agreement with
 * somebody: a warranty network's schedule applies to the work that network
 * pays for, and not to the homeowner's part of the same job. When the job
 * names its contract and that contract is this payer's, only its cards
 * apply, so a client with a contract per region is priced by the right one.
 *
 * In force is read from the dates, never from the active flag alone, for
 * the reason `contracts.priceFor` gives: a card that expired on the 31st is
 * not the authority on the 1st, whatever anybody remembered to untick.
 */
export async function cardsFor(
  tx: Database,
  organizationId: string,
  input: { customerId: string; contractId?: string | null | undefined; on: string; timeZone: string },
): Promise<rates.CardTerms[]> {
  const rows = await tx.select({ card: schema.rateCard, contract: schema.serviceContract })
    .from(schema.rateCard)
    .innerJoin(schema.serviceContract, eq(schema.serviceContract.id, schema.rateCard.contractId))
    .where(and(
      eq(schema.rateCard.organizationId, organizationId),
      eq(schema.rateCard.active, true),
      isNull(schema.rateCard.deletedAt),
      eq(schema.serviceContract.customerId, input.customerId),
      eq(schema.serviceContract.active, true),
      isNull(schema.serviceContract.deletedAt),
      or(isNull(schema.rateCard.effectiveFrom), lte(schema.rateCard.effectiveFrom, input.on)),
      or(isNull(schema.rateCard.effectiveTo), gte(schema.rateCard.effectiveTo, input.on)),
      or(isNull(schema.serviceContract.startsOn), lte(schema.serviceContract.startsOn, input.on)),
      or(isNull(schema.serviceContract.endsOn), gte(schema.serviceContract.endsOn, input.on)),
    ))
    .orderBy(asc(schema.serviceContract.createdAt), asc(schema.rateCard.createdAt));

  const named = input.contractId ? rows.filter((r) => r.contract.id === input.contractId) : [];
  const chosen = named.length > 0 ? named : rows;
  if (chosen.length === 0) return [];

  const ids = chosen.map((r) => r.card.id);
  const [lines, labour] = await Promise.all([
    tx.select().from(schema.rateCardLine).where(inArray(schema.rateCardLine.rateCardId, ids)),
    tx.select().from(schema.rateCardLabourRate).where(inArray(schema.rateCardLabourRate.rateCardId, ids)),
  ]);

  return chosen.map(({ card }) => ({
    id: card.id,
    name: card.name,
    authority: card.authority as rates.CardAuthority,
    lines: lines.filter((l) => l.rateCardId === card.id).map((l) => ({
      id: l.id,
      priceBookItemId: l.priceBookItemId,
      externalCode: l.externalCode,
      description: l.description,
      price: usd(l.price),
      allowedMinutes: l.allowedMinutes,
    })),
    labourRates: labour.filter((r) => r.rateCardId === card.id).map((r) => ({
      jobTypeId: r.jobTypeId,
      band: r.band,
      hourlyRate: usd(r.hourlyRate),
      minimumMinutes: r.minimumMinutes,
      incrementMinutes: r.incrementMinutes,
    })),
    markup: card.materialMarkup.map((tier) => ({
      upToCost: tier.upToCost ? usd(tier.upToCost) : null,
      percent: tier.percent,
    })),
    tripCharge: card.tripCharge ? usd(card.tripCharge) : null,
    bands: {
      standardDays: card.standardDays,
      standardStartMinute: card.standardStartMinute,
      standardEndMinute: card.standardEndMinute,
      holidays: card.holidays,
      timeZone: input.timeZone,
    },
  }));
}

/** Today in the company's calendar, which is the day a card has to be in force on. */
export async function todayFor(tx: Database, organizationId: string): Promise<{ on: string; timeZone: string }> {
  const timeZone = await timezoneOf(tx, organizationId);
  return { on: time.dateIn(new Date(), timeZone), timeZone };
}

/* ------------------------------------------------ work as a card sees it */

export type JobLineRow = typeof schema.jobLine.$inferSelect;

/** A price book item's kind, as the kind of work a card's rules apply to. */
export function workKindOfItem(kind: string | null | undefined): rates.WorkKind {
  if (kind === "labor") return "labor";
  if (kind === "material") return "part";
  if (kind === "equipment") return "equipment";
  return "other";
}

/**
 * The job lines named, with when the work happened and the item behind
 * each, for pricing.
 *
 * When the work happened is the visit's arrival where there is one, rather
 * than the moment the line was written down: labour recorded at six for a
 * visit that started at three was done in the afternoon, and charging it at
 * the after hours rate because the paperwork was late is a premium the card
 * never agreed.
 */
export async function jobLinesFor(tx: Database, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { line: JobLineRow; itemId: string | null; kind: rates.WorkKind; at: Date }>();
  const rows = await tx.select({
    line: schema.jobLine,
    itemId: schema.priceBookItemVersion.itemId,
    itemKind: schema.priceBookItem.kind,
    arrivedAt: schema.visit.arrivedAt,
  }).from(schema.jobLine)
    .leftJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.jobLine.priceBookItemVersionId))
    .leftJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
    .leftJoin(schema.visit, eq(schema.visit.id, schema.jobLine.visitId))
    .where(inArray(schema.jobLine.id, [...ids]));
  return new Map(rows.map((row) => [row.line.id, {
    line: row.line,
    itemId: row.itemId ?? null,
    /**
     * The item's own kind when there is one. A job line records a service
     * from the price book as a part, and a card would then mark up a drain
     * flush as if it were a fitting off the van.
     */
    kind: row.itemKind ? workKindOfItem(row.itemKind) : row.line.kind,
    at: row.arrivedAt ?? row.line.occurredAt,
  }]));
}

/* ------------------------------------------- the contract on a job */

export type ContractRow = typeof schema.serviceContract.$inferSelect;

/**
 * The contract that governs what one payer is charged on one job, with the
 * site the job is at when the contract lists it.
 *
 * The job's own contract when it names one and it is this payer's. Otherwise
 * the payer's contract in force today that lists the job's address as a
 * site, and failing that the payer's oldest contract in force: a warranty
 * network's agreement covers every address it sends work to, and has no
 * site list at all.
 */
export async function contractFor(
  tx: Database,
  organizationId: string,
  input: { customerId: string; jobId: string; on?: string | undefined },
): Promise<{ contract: ContractRow; site: typeof schema.contractSite.$inferSelect | null } | null> {
  const [job] = await tx.select({ contractId: schema.job.contractId, propertyId: schema.job.propertyId })
    .from(schema.job).where(eq(schema.job.id, input.jobId)).limit(1);
  if (!job) return null;
  const on = input.on ?? (await todayFor(tx, organizationId)).on;

  const contracts = await tx.select().from(schema.serviceContract)
    .where(and(
      eq(schema.serviceContract.organizationId, organizationId),
      eq(schema.serviceContract.customerId, input.customerId),
      eq(schema.serviceContract.active, true),
      isNull(schema.serviceContract.deletedAt),
      or(isNull(schema.serviceContract.startsOn), lte(schema.serviceContract.startsOn, on)),
      or(isNull(schema.serviceContract.endsOn), gte(schema.serviceContract.endsOn, on)),
    ))
    .orderBy(asc(schema.serviceContract.createdAt));
  if (contracts.length === 0) return null;

  const sites = await tx.select().from(schema.contractSite)
    .where(and(
      inArray(schema.contractSite.contractId, contracts.map((c) => c.id)),
      eq(schema.contractSite.propertyId, job.propertyId),
    ));
  const named = contracts.find((c) => c.id === job.contractId);
  const sited = contracts.find((c) => sites.some((site) => site.contractId === c.id));
  const contract = named ?? sited ?? contracts[0]!;
  return { contract, site: sites.find((site) => site.contractId === contract.id) ?? null };
}

/** What the live invoices on a job addressed to this payer already charge. */
export async function billedTo(tx: Database, jobId: string, customerId: string): Promise<m.Money> {
  const rows = await tx.select({ total: schema.invoice.total }).from(schema.invoice)
    .where(and(
      eq(schema.invoice.jobId, jobId),
      eq(schema.invoice.customerId, customerId),
      inArray(schema.invoice.status, ["open", "partially_paid", "paid", "written_off"]),
      isNull(schema.invoice.deletedAt),
    ));
  return m.sum(rows.map((r) => usd(r.total)), "USD");
}

/**
 * The contract's not to exceed, as a verdict on billing this much more.
 *
 * The site's own limit wins over the contract default, for the reason
 * `contracts.ceilingForProperty` gives. Null when no contract or no limit
 * applies, which is not a limit of zero.
 */
export async function contractCeilingFor(
  tx: Database,
  organizationId: string,
  input: { jobId: string; customerId: string; amount: m.Money },
): Promise<rates.CeilingVerdict | null> {
  const found = await contractFor(tx, organizationId, { customerId: input.customerId, jobId: input.jobId });
  if (!found) return null;
  const limit = found.site?.notToExceed ?? found.contract.defaultNotToExceed;
  if (!limit) return null;
  const verdict = rates.ceilingVerdict({
    amount: input.amount,
    alreadyBilled: await billedTo(tx, input.jobId, input.customerId),
    ceiling: usd(limit),
    action: found.contract.notToExceedAction === "warn" ? "warn" : "hold",
    source: found.site?.notToExceed
      ? `The not to exceed for ${found.site.siteNumber ? `site ${found.site.siteNumber}` : "this site"} under ${found.contract.name}`
      : `The not to exceed under ${found.contract.name}`,
  });
  return verdict.state === "none" ? null : verdict;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getRateCardTerms: (ctx: ServiceContext, input: { rateCardId: string }) => terms(ctx, input),
  setRateCardTerms: (ctx: ServiceContext, input: CardTermsInput) => setTerms(ctx, input),
} as const;
