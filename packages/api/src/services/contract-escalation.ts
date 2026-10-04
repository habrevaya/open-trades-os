import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, rates, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * A CONTRACT'S ANNUAL ESCALATION, APPLIED
 *
 * "Rates rise three per cent on each anniversary" is in most commercial
 * agreements, and the contract has stored the rate since it was first
 * written. Nothing applied it: next year's prices were loaded as next year's
 * card by hand, or not at all, and a client billed at year one prices in year
 * three is money the company never asks for.
 *
 * THE CARD IS A PRICE LIST, AND A PRICE LIST IS VERSIONED. Escalating does
 * not edit a card. It writes a new version of every card in force on the
 * anniversary, each price risen by the rate to the cent (`rates.escalate`),
 * in force from the anniversary, and ends the old one the day before, so an
 * invoice for work done last month is still priced by last month's card and
 * the invoice that went out last year still says what it said.
 *
 * SHOWN, THEN CONFIRMED. `preview` says what every price becomes, and
 * `apply` is refused unless it is told the anniversary and the rate the
 * person saw: a rate changed on the contract between the two is a different
 * rise from the one somebody agreed to. It can be applied from sixty days
 * before the anniversary, so the new prices are ready the morning they are
 * owed, and any time after, for one that was missed; one anniversary at a
 * time, oldest first.
 *
 * `pricebook:write` to apply, because it writes prices, and
 * `pricebook:read` to look.
 */

const usd = (value: string) => m.money(value, "USD");
/** How early an anniversary's prices may be prepared. */
const PREPARE_DAYS = 60;

type CardRow = typeof schema.rateCard.$inferSelect;
type ContractRow = typeof schema.serviceContract.$inferSelect;

export interface EscalationPreview {
  contractId: string;
  rate: string | null;
  anniversary: string | null;
  /** The year of the contract the anniversary opens: the first anniversary opens year two. */
  contractYear: number | null;
  /** Days from today to the anniversary; negative once it has passed. */
  daysAway: number | null;
  /** True when it can be applied today. */
  ready: boolean;
  /** Why it cannot, in words, when it cannot. */
  problem: string | null;
  escalatedThrough: string | null;
  cards: Array<{
    rateCardId: string;
    name: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    lines: Array<{ id: string; description: string; before: string; after: string }>;
    labourRates: Array<{ id: string; band: string; jobTypeName: string | null; before: string; after: string }>;
    tripCharge: { before: string; after: string } | null;
  }>;
}

async function loadContract(tx: Database, id: string): Promise<ContractRow> {
  const [row] = await tx.select().from(schema.serviceContract)
    .where(and(eq(schema.serviceContract.id, id), isNull(schema.serviceContract.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Contract");
  return row;
}

/** The contract's cards in force on the day before the anniversary: the ones that rise. */
async function cardsAt(tx: Database, contractId: string, anniversary: string): Promise<CardRow[]> {
  const eve = time.addDays(anniversary, -1);
  return tx.select().from(schema.rateCard)
    .where(and(
      eq(schema.rateCard.contractId, contractId),
      eq(schema.rateCard.active, true),
      isNull(schema.rateCard.deletedAt),
      or(isNull(schema.rateCard.effectiveFrom), lte(schema.rateCard.effectiveFrom, eve)),
      or(isNull(schema.rateCard.effectiveTo), gte(schema.rateCard.effectiveTo, anniversary)),
    ))
    .orderBy(asc(schema.rateCard.createdAt));
}

async function previewIn(tx: Database, organizationId: string, contract: ContractRow): Promise<EscalationPreview> {
  const empty = {
    contractId: contract.id, rate: contract.escalationRate, escalatedThrough: contract.escalatedThrough,
    anniversary: null, contractYear: null, daysAway: null, ready: false, cards: [],
  };
  const rateProblem = rates.escalationRateProblem(contract.escalationRate);
  if (rateProblem) return { ...empty, problem: rateProblem };
  if (!contract.startsOn) {
    return { ...empty, problem: "This contract has no start date, so it has no anniversary to rise on." };
  }
  const anniversary = rates.nextAnniversary(contract.startsOn, contract.escalatedThrough);
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const daysAway = Math.round((Date.parse(`${anniversary}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
  const base = {
    ...empty, anniversary, contractYear: rates.contractYear(contract.startsOn, anniversary), daysAway,
  };

  if (contract.endsOn && contract.endsOn < anniversary) {
    return { ...base, problem: `The contract ends on ${contract.endsOn}, before its next anniversary.` };
  }
  const later = await tx.select({ name: schema.rateCard.name, effectiveFrom: schema.rateCard.effectiveFrom })
    .from(schema.rateCard)
    .where(and(
      eq(schema.rateCard.contractId, contract.id),
      eq(schema.rateCard.active, true),
      isNull(schema.rateCard.deletedAt),
      gte(schema.rateCard.effectiveFrom, anniversary),
    )).limit(1);
  if (later[0]) {
    return {
      ...base,
      problem: `"${later[0].name}" is already loaded from ${later[0].effectiveFrom}. Rising the cards as well would put two price lists in force at once; end or remove it first.`,
    };
  }

  const cards = await cardsAt(tx, contract.id, anniversary);
  if (cards.length === 0) {
    return { ...base, problem: `No card of this contract is in force on ${time.addDays(anniversary, -1)}, so there are no prices to rise.` };
  }
  const rate = contract.escalationRate!;
  const ids = cards.map((c) => c.id);
  const [lines, labour] = await Promise.all([
    tx.select().from(schema.rateCardLine).where(inArray(schema.rateCardLine.rateCardId, ids))
      .orderBy(asc(schema.rateCardLine.description)),
    tx.select({ rate: schema.rateCardLabourRate, jobTypeName: schema.jobType.name })
      .from(schema.rateCardLabourRate)
      .leftJoin(schema.jobType, eq(schema.jobType.id, schema.rateCardLabourRate.jobTypeId))
      .where(inArray(schema.rateCardLabourRate.rateCardId, ids))
      .orderBy(asc(schema.rateCardLabourRate.band)),
  ]);
  const up = (price: string) => m.toString(rates.escalate(usd(price), rate));

  return {
    ...base,
    ready: daysAway <= PREPARE_DAYS,
    problem: daysAway <= PREPARE_DAYS
      ? null
      : `Year ${base.contractYear} prices can be prepared from ${time.addDays(anniversary, -PREPARE_DAYS)}, sixty days before the anniversary.`,
    cards: cards.map((card) => ({
      rateCardId: card.id,
      name: card.name,
      effectiveFrom: card.effectiveFrom,
      effectiveTo: card.effectiveTo,
      lines: lines.filter((l) => l.rateCardId === card.id)
        .map((l) => ({ id: l.id, description: l.description, before: l.price, after: up(l.price) })),
      labourRates: labour.filter((r) => r.rate.rateCardId === card.id).map((r) => ({
        id: r.rate.id, band: r.rate.band, jobTypeName: r.jobTypeName,
        before: r.rate.hourlyRate, after: up(r.rate.hourlyRate),
      })),
      tripCharge: card.tripCharge ? { before: card.tripCharge, after: up(card.tripCharge) } : null,
    })),
  };
}

/** What the contract's next anniversary would do to its cards. Writes nothing. */
export function preview(ctx: ServiceContext, input: { contractId: string }): Promise<EscalationPreview> {
  return guardedRead(ctx, "pricebook:read", async (tx) =>
    previewIn(tx, ctx.actor.organizationId, await loadContract(tx, input.contractId)));
}

export interface EscalationResult {
  contractId: string;
  anniversary: string;
  rate: string;
  cards: Array<{ fromRateCardId: string; rateCardId: string; name: string; effectiveFrom: string }>;
}

/** Two rates as the same decimal, whatever trailing noughts each was written with. */
function sameRate(a: string, b: string): boolean {
  const norm = (v: string) => {
    const [whole = "0", frac = ""] = v.trim().split(".");
    return `${String(Number(whole))}.${frac.replace(/0+$/, "")}`;
  };
  return norm(a) === norm(b);
}

/** "Meridian schedule" for year three, from "Meridian schedule (year 2)". */
function nameFor(name: string, year: number): string {
  return `${name.replace(/ \(year \d+\)$/, "")} (year ${year})`;
}

/**
 * Apply the escalation a person saw in the preview: a new version of each
 * card in force, every price risen by the rate, from the anniversary.
 *
 * Told the anniversary and the rate, and refused if either is not what the
 * preview would now show. A retry after it went answers with what it made.
 */
export function apply(
  ctx: ServiceContext, input: { contractId: string; anniversary: string; rate: string },
): Promise<EscalationResult> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const [locked] = await tx.select().from(schema.serviceContract)
      .where(and(eq(schema.serviceContract.id, input.contractId), isNull(schema.serviceContract.deletedAt)))
      .for("update").limit(1);
    if (!locked) throw new NotFoundError("Contract");

    if (locked.escalatedThrough && locked.escalatedThrough >= input.anniversary) {
      const made = await tx.select().from(schema.rateCard)
        .where(and(eq(schema.rateCard.contractId, locked.id), eq(schema.rateCard.effectiveFrom, input.anniversary)))
        .orderBy(asc(schema.rateCard.createdAt));
      return {
        contractId: locked.id, anniversary: input.anniversary, rate: locked.escalationRate ?? input.rate,
        cards: made.filter((c) => c.escalatedFromId).map((c) => ({
          fromRateCardId: c.escalatedFromId!, rateCardId: c.id, name: c.name, effectiveFrom: c.effectiveFrom!,
        })),
      };
    }

    const shown = await previewIn(tx, ctx.actor.organizationId, locked);
    if (shown.anniversary !== input.anniversary) {
      throw new ConflictError(
        shown.anniversary
          ? `The contract's next anniversary is ${shown.anniversary}, not ${input.anniversary}. Look at the preview again.`
          : shown.problem ?? "There is no anniversary to rise on.",
      );
    }
    if (!locked.escalationRate || !sameRate(locked.escalationRate, input.rate)) {
      throw new ConflictError(
        `The contract's rate is now ${locked.escalationRate ?? "nothing"}, not the ${input.rate} that was shown. Look at the preview again.`,
      );
    }
    if (!shown.ready) throw new ConflictError(shown.problem ?? "It cannot be applied yet.");

    const anniversary = input.anniversary;
    const year = shown.contractYear!;
    const rate = locked.escalationRate;
    const made: EscalationResult["cards"] = [];
    for (const card of await cardsAt(tx, locked.id, anniversary)) {
      const up = (price: string) => m.toString(rates.escalate(usd(price), rate));
      const [next] = await tx.insert(schema.rateCard).values({
        organizationId: ctx.actor.organizationId,
        name: nameFor(card.name, year),
        contractId: card.contractId,
        authority: card.authority,
        effectiveFrom: anniversary,
        effectiveTo: card.effectiveTo,
        active: true,
        tripCharge: card.tripCharge ? up(card.tripCharge) : null,
        materialMarkup: card.materialMarkup,
        standardDays: card.standardDays,
        standardStartMinute: card.standardStartMinute,
        standardEndMinute: card.standardEndMinute,
        holidays: card.holidays,
        escalatedFromId: card.id,
        escalationRate: rate,
      }).returning();

      const lines = await tx.select().from(schema.rateCardLine).where(eq(schema.rateCardLine.rateCardId, card.id));
      if (lines.length > 0) {
        await tx.insert(schema.rateCardLine).values(lines.map((line) => ({
          organizationId: ctx.actor.organizationId,
          rateCardId: next!.id,
          externalCode: line.externalCode,
          priceBookItemId: line.priceBookItemId,
          description: line.description,
          unit: line.unit,
          price: up(line.price),
          allowedMinutes: line.allowedMinutes,
        })));
      }
      const labour = await tx.select().from(schema.rateCardLabourRate)
        .where(eq(schema.rateCardLabourRate.rateCardId, card.id));
      if (labour.length > 0) {
        await tx.insert(schema.rateCardLabourRate).values(labour.map((row) => ({
          organizationId: ctx.actor.organizationId,
          rateCardId: next!.id,
          jobTypeId: row.jobTypeId,
          band: row.band,
          hourlyRate: up(row.hourlyRate),
          minimumMinutes: row.minimumMinutes,
          incrementMinutes: row.incrementMinutes,
        })));
      }
      /** The old card ends the day before, so exactly one is in force on any day. */
      await tx.update(schema.rateCard).set({ effectiveTo: time.addDays(anniversary, -1), updatedAt: new Date() })
        .where(eq(schema.rateCard.id, card.id));
      made.push({ fromRateCardId: card.id, rateCardId: next!.id, name: next!.name, effectiveFrom: anniversary });
    }

    await tx.update(schema.serviceContract).set({ escalatedThrough: anniversary, updatedAt: new Date() })
      .where(eq(schema.serviceContract.id, locked.id));
    await audit(tx, ctx, "contract.escalated", "service_contract", locked.id,
      { escalatedThrough: locked.escalatedThrough },
      { escalatedThrough: anniversary, rate, cards: made });
    return { contractId: locked.id, anniversary, rate, cards: made };
  });
}

export const handlers = {
  previewContractEscalation: (ctx: ServiceContext, input: { contractId: string }) => preview(ctx, input),
  applyContractEscalation: (ctx: ServiceContext, input: { contractId: string; anniversary: string; rate: string }) =>
    apply(ctx, input),
} as const;
