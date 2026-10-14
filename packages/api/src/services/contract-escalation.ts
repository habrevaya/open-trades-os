import { createHash } from "node:crypto";
import { and, asc, eq, exists, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, rates, time, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
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
 *
 * RISES THAT DIFFER. A contract may also say "year two 3%, year three 4%",
 * or "the plumbing labour rate rises 5%", or "the emergency card is fixed".
 * Those are rows of their own (`contract_escalation_rise`), set with the
 * contract's terms under `contract:write`, and each price rises by the most
 * specific one that applies (`core/rates.riseFor`); the contract's own rate
 * is every year's rise for what nothing more specific covers. A year nothing
 * rises in is passed over rather than applied as a rise of nothing. Because
 * one rate no longer says what was shown, the preview carries a `key` over
 * the rate and every rise that applies that year, and applying is refused
 * unless it is told the key the person saw.
 *
 * DUE, THIRTY DAYS AHEAD. The worker (`noticePass`) looks at every contract
 * with a rate each pass, and from thirty days before an anniversary (or any
 * time after, for one that was missed) it prepares next year's cards as
 * drafts and raises one task in the office queue, due on the anniversary,
 * saying a person has to apply them. Once per contract per anniversary,
 * under a unique index. It never applies anything: a draft is never active,
 * prices nothing, and is removed when a person applies the escalation, which
 * writes the cards afresh from the ones in force exactly as the preview
 * shows, and closes the task.
 */

const usd = (value: string) => m.money(value, "USD");
/** How early an anniversary's prices may be prepared. */
const PREPARE_DAYS = 60;
/** How early the worker tells the office, with the drafts prepared. */
export const NOTICE_DAYS = 30;

type CardRow = typeof schema.rateCard.$inferSelect;
type ContractRow = typeof schema.serviceContract.$inferSelect;
type RiseRow = typeof schema.contractEscalationRise.$inferSelect;

/** One of the contract's rises, with what it names in words. */
export interface RiseView {
  id: string;
  contractYear: number | null;
  rateCardId: string | null;
  rateCardName: string | null;
  jobTypeId: string | null;
  jobTypeName: string | null;
  rate: string;
}

/** What one price rises by on the preview: the rate, and where it came from in words. */
interface PriceRise {
  /** The rate, or "0" for a price kept as it is. */
  rate: string;
  /** "Year 3", "Plumbing hourly rates", "Emergency card", "The contract's yearly rate", or "Nothing rises it". */
  because: string;
}

export interface EscalationPreview {
  contractId: string;
  /** The draft cards the worker prepared for this anniversary, when it has. Never in force. */
  drafts?: Array<{ rateCardId: string; name: string; preparedAt: string }>;
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
    lines: Array<{ id: string; description: string; before: string; after: string } & PriceRise>;
    labourRates: Array<{ id: string; band: string; jobTypeName: string | null; before: string; after: string } & PriceRise>;
    tripCharge: ({ before: string; after: string } & PriceRise) | null;
  }>;
  /** Every rise the contract carries beyond its own rate, whichever year it is for. */
  rises: RiseView[];
  /**
   * What applying has to be told: the anniversary, the rate and every rise
   * that applies that year, in one string. Null while there is nothing to apply.
   */
  key: string | null;
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

async function risesOf(tx: Database, contractId: string): Promise<RiseRow[]> {
  return tx.select().from(schema.contractEscalationRise)
    .where(eq(schema.contractEscalationRise.contractId, contractId))
    .orderBy(asc(schema.contractEscalationRise.contractYear), asc(schema.contractEscalationRise.createdAt));
}

const asRise = (row: RiseRow): rates.Rise => ({
  contractYear: row.contractYear, rateCardId: row.rateCardId, jobTypeId: row.jobTypeId, rate: row.rate,
});

/** The contract's own rate when it is one a price can rise by, otherwise null. */
const baseOf = (contract: ContractRow): string | null =>
  rates.escalationRateProblem(contract.escalationRate) ? null : contract.escalationRate;

/** A rate as a per cent in words: "0.035000" is "3.5%". */
function percent(rate: string): string {
  return `${String(Number((Number(rate) * 100).toFixed(4)))}%`;
}

/** A rate written the same however many noughts it carries, for comparing and for the key. */
function normRate(v: string): string {
  const [whole = "0", frac = ""] = v.trim().split(".");
  const tail = frac.replace(/0+$/, "");
  return tail ? `${String(Number(whole))}.${tail}` : String(Number(whole));
}

/**
 * The key over what an anniversary's rise is made of: the anniversary, the
 * contract's rate and every rise that applies that year. A rise for another
 * year changing does not change it, so a person is not sent back to look
 * again at a preview that shows the same prices.
 */
function keyOf(anniversary: string, base: string | null, rises: readonly RiseRow[], year: number): string {
  const applying = rises
    .filter((r) => r.contractYear === null || r.contractYear === year)
    .map((r) => `${r.contractYear ?? "*"}|${r.rateCardId ?? "*"}|${r.jobTypeId ?? "*"}|${normRate(r.rate)}`)
    .sort();
  const body = JSON.stringify([anniversary, base === null ? null : normRate(base), applying]);
  return createHash("sha256").update(body).digest("hex").slice(0, 24);
}

/**
 * The first anniversary from the next one on which anything rises. With a
 * yearly rate, the next one. With only rises for some years, a year none of
 * them names is passed over: a rise of nothing written as new cards is a
 * price list nobody changed, and a task to apply it is noise.
 */
function anniversaryFrom(contract: ContractRow, rises: readonly RiseRow[]): string | null {
  const base = baseOf(contract);
  let after = contract.escalatedThrough;
  for (let n = 0; n < 60; n += 1) {
    const anniversary = rates.nextAnniversary(contract.startsOn!, after);
    if (rates.risesIn(rises.map(asRise), base, rates.contractYear(contract.startsOn!, anniversary))) return anniversary;
    after = anniversary;
  }
  return null;
}

async function previewIn(
  tx: Database, organizationId: string, contract: ContractRow, on?: string,
): Promise<EscalationPreview> {
  const riseRows = await risesOf(tx, contract.id);
  const named = await nameRises(tx, contract.id, riseRows);
  const empty = {
    contractId: contract.id, rate: contract.escalationRate, escalatedThrough: contract.escalatedThrough,
    anniversary: null, contractYear: null, daysAway: null, ready: false, cards: [], rises: named, key: null,
  };
  /** With rises of its own, a contract needs no yearly rate; one it has must still be one a price can rise by. */
  const rateProblem = riseRows.length === 0 || (contract.escalationRate !== null && contract.escalationRate !== undefined)
    ? rates.escalationRateProblem(contract.escalationRate)
    : null;
  if (rateProblem) return { ...empty, problem: rateProblem };
  if (!contract.startsOn) {
    return { ...empty, problem: "This contract has no start date, so it has no anniversary to rise on." };
  }
  const anniversary = anniversaryFrom(contract, riseRows);
  if (!anniversary) {
    return { ...empty, problem: "None of this contract's rises is for a year still to come, so nothing rises." };
  }
  const today = on ?? time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const daysAway = Math.round((Date.parse(`${anniversary}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
  const year = rates.contractYear(contract.startsOn, anniversary);
  const base = {
    ...empty, anniversary, contractYear: year, daysAway,
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
  const riseOf = pricer(contract, riseRows, named, year);
  const priced = (price: string, card: CardRow, jobTypeId: string | null) => {
    const found = riseOf(card.id, jobTypeId);
    return { before: price, after: risen(price, found.rate), ...found };
  };

  return {
    ...base,
    ready: daysAway <= PREPARE_DAYS,
    problem: daysAway <= PREPARE_DAYS
      ? null
      : `Year ${base.contractYear} prices can be prepared from ${time.addDays(anniversary, -PREPARE_DAYS)}, sixty days before the anniversary.`,
    key: keyOf(anniversary, baseOf(contract), riseRows, year),
    cards: cards.map((card) => ({
      rateCardId: card.id,
      name: card.name,
      effectiveFrom: card.effectiveFrom,
      effectiveTo: card.effectiveTo,
      lines: lines.filter((l) => l.rateCardId === card.id)
        .map((l) => ({ id: l.id, description: l.description, ...priced(l.price, card, null) })),
      labourRates: labour.filter((r) => r.rate.rateCardId === card.id).map((r) => ({
        id: r.rate.id, band: r.rate.band, jobTypeName: r.jobTypeName, ...priced(r.rate.hourlyRate, card, r.rate.jobTypeId),
      })),
      tripCharge: card.tripCharge ? priced(card.tripCharge, card, null) : null,
    })),
  };
}

/** A price risen by a rate to the cent, or kept exactly as it is when nothing rises it. */
function risen(price: string, rate: string): string {
  return Number(rate) === 0 ? price : m.toString(rates.escalate(usd(price), rate));
}

/**
 * What each price on a card rises by in a year, and why, in words: the most
 * specific of the contract's rises, its own rate, or nothing.
 */
function pricer(contract: ContractRow, rises: readonly RiseRow[], named: readonly RiseView[], year: number) {
  const base = baseOf(contract);
  const list = rises.map(asRise);
  return (rateCardId: string, jobTypeId: string | null): PriceRise => {
    const found = rates.riseFor({ rises: list, baseRate: base, year, rateCardId, jobTypeId });
    if (!found) return { rate: "0", because: "Nothing rises it" };
    if (!found.rise) return { rate: found.rate, because: "The contract's yearly rate" };
    return { rate: found.rate, because: riseWords(named[list.indexOf(found.rise)]) };
  };
}

/** "Year 3, plumbing hourly rates on the Emergency card", in the words the page uses. */
function riseWords(rise: RiseView | undefined): string {
  if (!rise) return "A rise on the contract";
  const what = [
    rise.jobTypeName ? `${rise.jobTypeName} hourly rates` : null,
    rise.rateCardName ? `${rise.jobTypeName ? "on " : ""}${rise.rateCardName}` : null,
  ].filter(Boolean).join(" ");
  const when = rise.contractYear === null ? "Every year" : `Year ${rise.contractYear}`;
  return what ? `${when}, ${what}` : when;
}

/** The contract's rises with the card and trade each names, for the page and the API. */
async function nameRises(tx: Database, contractId: string, rows: readonly RiseRow[]): Promise<RiseView[]> {
  if (rows.length === 0) return [];
  const cardIds = rows.map((r) => r.rateCardId).filter((id): id is string => id !== null);
  const typeIds = rows.map((r) => r.jobTypeId).filter((id): id is string => id !== null);
  const [cards, types] = await Promise.all([
    cardIds.length > 0
      ? tx.select({ id: schema.rateCard.id, name: schema.rateCard.name }).from(schema.rateCard)
        .where(and(eq(schema.rateCard.contractId, contractId), inArray(schema.rateCard.id, cardIds)))
      : Promise.resolve([]),
    typeIds.length > 0
      ? tx.select({ id: schema.jobType.id, name: schema.jobType.name }).from(schema.jobType).where(inArray(schema.jobType.id, typeIds))
      : Promise.resolve([]),
  ]);
  const cardName = new Map(cards.map((c) => [c.id, c.name]));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  return rows.map((r) => ({
    id: r.id,
    contractYear: r.contractYear,
    rateCardId: r.rateCardId,
    rateCardName: r.rateCardId ? cardName.get(r.rateCardId) ?? null : null,
    jobTypeId: r.jobTypeId,
    jobTypeName: r.jobTypeId ? typeName.get(r.jobTypeId) ?? null : null,
    rate: r.rate,
  }));
}

/** What the contract's next anniversary would do to its cards, and the drafts prepared for it. Writes nothing. */
export function preview(ctx: ServiceContext, input: { contractId: string }): Promise<EscalationPreview> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const shown = await previewIn(tx, ctx.actor.organizationId, await loadContract(tx, input.contractId));
    if (!shown.anniversary) return { ...shown, drafts: [] };
    const drafts = await tx.select({ id: schema.rateCard.id, name: schema.rateCard.name, createdAt: schema.rateCard.createdAt })
      .from(schema.rateCard)
      .where(and(eq(schema.rateCard.contractId, input.contractId), eq(schema.rateCard.draftFor, shown.anniversary)))
      .orderBy(asc(schema.rateCard.createdAt));
    return {
      ...shown,
      drafts: drafts.map((d) => ({ rateCardId: d.id, name: d.name, preparedAt: d.createdAt.toISOString() })),
    };
  });
}

export interface EscalationResult {
  contractId: string;
  anniversary: string;
  /** The contract's own yearly rate, when it has one; the rises are on the preview and the audit line. */
  rate: string | null;
  cards: Array<{ fromRateCardId: string; rateCardId: string; name: string; effectiveFrom: string }>;
}

/** Two rates as the same decimal, whatever trailing noughts each was written with. */
function sameRate(a: string, b: string): boolean {
  return normRate(a) === normRate(b);
}

/** "Meridian schedule" for year three, from "Meridian schedule (year 2)". */
function nameFor(name: string, year: number): string {
  return `${name.replace(/ \(year \d+\)$/, "")} (year ${year})`;
}

/**
 * Apply the escalation a person saw in the preview: a new version of each
 * card in force, every price risen by the rate, from the anniversary.
 *
 * Told the anniversary and the preview's key (or, on a contract whose rise is
 * its one yearly rate, that rate), and refused if either is not what the
 * preview would now show. A retry after it went answers with what it made.
 */
export function apply(
  ctx: ServiceContext, input: { contractId: string; anniversary: string; rate?: string | undefined; key?: string | undefined },
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
        contractId: locked.id, anniversary: input.anniversary, rate: locked.escalationRate ?? input.rate ?? null,
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
    const riseRows = await risesOf(tx, locked.id);
    const year = shown.contractYear!;
    const differs = riseRows.some((r) => r.contractYear === null || r.contractYear === year);
    if (input.key !== undefined) {
      if (input.key !== shown.key) {
        throw new ConflictError("The contract's rises have changed since the preview was shown. Look at the preview again.");
      }
    } else if (differs) {
      throw new ConflictError(
        `Year ${year}'s rise differs by year, card or trade, so one rate does not say what was shown. Apply it from the preview, which names each rise.`,
      );
    } else if (input.rate === undefined || !locked.escalationRate || !sameRate(locked.escalationRate, input.rate)) {
      throw new ConflictError(
        `The contract's rate is now ${locked.escalationRate ?? "nothing"}, not the ${input.rate ?? "nothing"} that was shown. Look at the preview again.`,
      );
    }
    if (!shown.ready) throw new ConflictError(shown.problem ?? "It cannot be applied yet.");

    const anniversary = input.anniversary;
    const rate = baseOf(locked);
    const riseOf = pricer(locked, riseRows, shown.rises, year);
    /**
     * The drafts the worker prepared for this anniversary go: the cards in
     * force are written afresh from the ones they rise from, which is what
     * the preview showed and what the person confirmed, so a price changed
     * on the old card since the draft was prepared is risen too.
     */
    await removeDrafts(tx, locked.id, anniversary);
    const made: EscalationResult["cards"] = [];
    for (const card of await cardsAt(tx, locked.id, anniversary)) {
      const next = await writeRisen(tx, ctx.actor.organizationId, card, {
        anniversary, year, riseOf: (jobTypeId) => riseOf(card.id, jobTypeId).rate, draft: false,
      });
      /** The old card ends the day before, so exactly one is in force on any day. */
      await tx.update(schema.rateCard).set({ effectiveTo: time.addDays(anniversary, -1), updatedAt: new Date() })
        .where(eq(schema.rateCard.id, card.id));
      /** A rise naming the card follows it to next year's version, so it still applies the year after. */
      await tx.update(schema.contractEscalationRise).set({ rateCardId: next.id, updatedAt: new Date() })
        .where(and(eq(schema.contractEscalationRise.contractId, locked.id), eq(schema.contractEscalationRise.rateCardId, card.id)));
      made.push({ fromRateCardId: card.id, rateCardId: next.id, name: next.name, effectiveFrom: anniversary });
    }

    await tx.update(schema.serviceContract).set({ escalatedThrough: anniversary, updatedAt: new Date() })
      .where(eq(schema.serviceContract.id, locked.id));
    await closeNotice(tx, ctx, locked.id, anniversary);
    await audit(tx, ctx, "contract.escalated", "service_contract", locked.id,
      { escalatedThrough: locked.escalatedThrough },
      {
        escalatedThrough: anniversary, rate, cards: made,
        rises: shown.rises.filter((r) => r.contractYear === null || r.contractYear === year),
      });
    return { contractId: locked.id, anniversary, rate, cards: made };
  });
}

/**
 * One card risen, from the anniversary: in force, or as a draft that is never
 * active. Its lines and labour rates risen with it, each by what `riseOf`
 * says for its trade (listed prices and the trip charge by the card's own);
 * markups are fractions of our cost and are kept.
 */
async function writeRisen(
  tx: Database, organizationId: string, card: CardRow,
  input: { anniversary: string; year: number; riseOf: (jobTypeId: string | null) => string; draft: boolean },
): Promise<CardRow> {
  const cardRate = input.riseOf(null);
  const up = (price: string) => risen(price, cardRate);
  const [next] = await tx.insert(schema.rateCard).values({
    organizationId,
    name: nameFor(card.name, input.year),
    contractId: card.contractId,
    authority: card.authority,
    effectiveFrom: input.anniversary,
    effectiveTo: card.effectiveTo,
    active: !input.draft,
    draftFor: input.draft ? input.anniversary : null,
    tripCharge: card.tripCharge ? up(card.tripCharge) : null,
    materialMarkup: card.materialMarkup,
    standardDays: card.standardDays,
    standardStartMinute: card.standardStartMinute,
    standardEndMinute: card.standardEndMinute,
    holidays: card.holidays,
    escalatedFromId: card.id,
    /** The card's own rise, what its listed prices rose by; a trade's rise on its hourly rates is on the audit line. */
    escalationRate: cardRate,
  }).returning();

  const lines = await tx.select().from(schema.rateCardLine).where(eq(schema.rateCardLine.rateCardId, card.id));
  if (lines.length > 0) {
    await tx.insert(schema.rateCardLine).values(lines.map((line) => ({
      organizationId,
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
      organizationId,
      rateCardId: next!.id,
      jobTypeId: row.jobTypeId,
      band: row.band,
      hourlyRate: risen(row.hourlyRate, input.riseOf(row.jobTypeId)),
      minimumMinutes: row.minimumMinutes,
      incrementMinutes: row.incrementMinutes,
    })));
  }
  return next!;
}

/** A contract's draft cards for one anniversary, gone. Their lines go with them. */
async function removeDrafts(tx: Database, contractId: string, anniversary: string): Promise<void> {
  await tx.delete(schema.rateCard).where(and(
    eq(schema.rateCard.contractId, contractId),
    eq(schema.rateCard.draftFor, anniversary),
  ));
}

/**
 * The anniversary's notice marked applied and its task closed, by whoever
 * applied it. Nothing to do when the worker never raised one (applied more
 * than thirty days ahead).
 */
async function closeNotice(tx: Database, ctx: ServiceContext, contractId: string, anniversary: string): Promise<void> {
  const [notice] = await tx.update(schema.contractEscalationNotice).set({ appliedAt: new Date() })
    .where(and(
      eq(schema.contractEscalationNotice.contractId, contractId),
      eq(schema.contractEscalationNotice.anniversary, anniversary),
      isNull(schema.contractEscalationNotice.appliedAt),
    )).returning();
  if (!notice?.taskId) return;
  const person = ctx.actor.userId !== SYSTEM_USER_ID && !ctx.actor.userId.startsWith("portal:");
  await tx.update(schema.task).set({
    status: "done", completedAt: new Date(), completedByUserId: person ? ctx.actor.userId : null,
    outcome: "Applied on the contract.", updatedAt: new Date(),
  }).where(and(eq(schema.task.id, notice.taskId), inArray(schema.task.status, ["open", "in_progress"])));
}

/* ------------------------------------------------------------ the worker */

/** What the worker acts as: it reads contracts and cards, writes drafts and raises a task. Never `pricebook:write`. */
const noticeActor = (organizationId: string): Actor => ({
  userId: SYSTEM_USER_ID, organizationId, roles: [],
  grants: ["pricebook:read", "contract:read", "task:write"],
  agentId: "contract-escalation",
});

export interface NoticeResult {
  organizationId: string;
  /** Contracts whose task was raised on this pass. */
  raised: string[];
  /** Contracts whose drafts were prepared again because the rate changed. */
  refreshed: string[];
  error: string | null;
}

/**
 * One company's contracts: for each anniversary due within thirty days (or
 * missed), the drafts prepared and the task raised, once.
 */
export async function noticesFor(
  db: Database, organizationId: string, options: { now?: Date | undefined } = {},
): Promise<NoticeResult> {
  const ctx: ServiceContext = { actor: noticeActor(organizationId), db };
  const result: NoticeResult = { organizationId, raised: [], refreshed: [], error: null };
  try {
    await inTenant(ctx, async (tx) => {
      const zone = await timezoneOf(tx, organizationId);
      const today = time.dateIn(options.now ?? new Date(), zone);
      const contracts = await tx.select().from(schema.serviceContract).where(and(
        eq(schema.serviceContract.organizationId, organizationId),
        eq(schema.serviceContract.active, true),
        isNull(schema.serviceContract.deletedAt),
        or(
          isNotNull(schema.serviceContract.escalationRate),
          exists(tx.select({ one: sql`1` }).from(schema.contractEscalationRise)
            .where(eq(schema.contractEscalationRise.contractId, schema.serviceContract.id))),
        ),
        isNotNull(schema.serviceContract.startsOn),
      ));
      for (const contract of contracts) {
        const shown = await previewIn(tx, organizationId, contract, today);
        /**
         * Only an anniversary a person could apply today, within thirty days
         * or past: a contract with nothing to rise (no card in force, next
         * year's card already loaded by hand, ending first) is left alone,
         * because a task with nothing behind its button is noise.
         */
        if (!shown.ready || !shown.anniversary || shown.daysAway === null || shown.daysAway > NOTICE_DAYS) continue;
        const outcome = await noticeOne(tx, ctx, contract, shown, zone);
        if (outcome === "raised") result.raised.push(contract.id);
        if (outcome === "refreshed") result.refreshed.push(contract.id);
      }
    });
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}

async function noticeOne(
  tx: Database, ctx: ServiceContext, contract: ContractRow, shown: EscalationPreview, zone: string,
): Promise<"raised" | "refreshed" | "unchanged"> {
  const anniversary = shown.anniversary!;
  /** The notice keeps the contract's own rate, or nothing when only its rises say what rises; the key says the rest. */
  const rate = baseOf(contract) ?? "0";
  const key = shown.key!;
  const year = shown.contractYear!;
  const riseRows = await risesOf(tx, contract.id);
  const riseOf = pricer(contract, riseRows, shown.rises, year);
  const body = taskBody(shown, year, anniversary);
  const prepare = async () => {
    await removeDrafts(tx, contract.id, anniversary);
    for (const card of await cardsAt(tx, contract.id, anniversary)) {
      await writeRisen(tx, ctx.actor.organizationId, card, {
        anniversary, year, riseOf: (jobTypeId) => riseOf(card.id, jobTypeId).rate, draft: true,
      });
    }
  };

  const [claimed] = await tx.insert(schema.contractEscalationNotice).values({
    organizationId: ctx.actor.organizationId, contractId: contract.id, anniversary, rate, key,
  }).onConflictDoNothing().returning();

  if (!claimed) {
    const [notice] = await tx.select().from(schema.contractEscalationNotice).where(and(
      eq(schema.contractEscalationNotice.contractId, contract.id),
      eq(schema.contractEscalationNotice.anniversary, anniversary),
    )).limit(1);
    if (!notice || notice.appliedAt) return "unchanged";
    /** A notice from before rises differed knows only the rate it was prepared at. */
    const same = notice.key !== null ? notice.key === key : sameRate(notice.rate, rate);
    if (same) return "unchanged";
    /** The rate or a rise on the contract changed since: the drafts are of a rise nobody now means. */
    await prepare();
    await tx.update(schema.contractEscalationNotice).set({ rate, key, preparedAt: new Date() })
      .where(eq(schema.contractEscalationNotice.id, notice.id));
    if (notice.taskId) {
      await tx.update(schema.task).set({ body, updatedAt: new Date() })
        .where(eq(schema.task.id, notice.taskId));
    }
    return "refreshed";
  }

  await prepare();
  const [task] = await tx.insert(schema.task).values({
    organizationId: ctx.actor.organizationId,
    title: `Year ${year} prices for ${contract.name} are due on ${anniversary}`,
    body,
    priority: "normal",
    queue: "office",
    entityType: "service_contract",
    entityId: contract.id,
    dueAt: time.startOfDayIn(anniversary, zone),
  }).returning({ id: schema.task.id });
  await tx.update(schema.contractEscalationNotice).set({ taskId: task!.id })
    .where(eq(schema.contractEscalationNotice.id, claimed.id));
  await audit(tx, ctx, "contract.escalation_due", "service_contract", contract.id, null, {
    anniversary, rate, taskId: task!.id,
  });
  return "raised";
}

/**
 * What the task says. The rise as a percentage, or each rise that applies
 * that year when they differ, the day, and that nothing happens until
 * somebody acts.
 */
function taskBody(shown: EscalationPreview, year: number, anniversary: string): string {
  const applying = shown.rises.filter((r) => r.contractYear === null || r.contractYear === year);
  const base = shown.rate && !rates.escalationRateProblem(shown.rate) ? shown.rate : null;
  const says = applying.length === 0
    ? `rates rise by ${percent(base ?? "0")} on ${anniversary}`
    : `rates rise on ${anniversary}: ${[
      ...applying.map((r) => `${riseWords(r).toLowerCase()} by ${percent(r.rate)}`),
      ...(base ? [`everything else by ${percent(base)}`] : []),
    ].join(", ")}`;
  return `The contract says ${says}. Year ${year}'s cards are prepared as a draft `
    + `on the contract. Look them over and press Apply year ${year} prices. Nothing changes until somebody does.`;
}

let lastNoticePass: number | null = null;

/**
 * Every company with a contract that rises, once a minute at most per
 * process. An anniversary is a date, and nothing gains from asking more often.
 */
export async function noticePass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<NoticeResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastNoticePass !== null && at - lastNoticePass < 60_000 && at >= lastNoticePass) return [];
  lastNoticePass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.contract_escalation_organizations(${options.limit ?? 200})`,
  );
  const results: NoticeResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    results.push(await noticesFor(db, row.organization_id, options.now ? { now: options.now } : {}));
  }
  return results;
}

/* ------------------------------------------------------- the rises themselves */

export interface RiseInput {
  contractYear?: number | null | undefined;
  rateCardId?: string | null | undefined;
  jobTypeId?: string | null | undefined;
  rate: string;
}

/** The contract's rises, with the card and trade each names. */
export function listRises(ctx: ServiceContext, input: { contractId: string }): Promise<RiseView[]> {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const contract = await loadContract(tx, input.contractId);
    return nameRises(tx, contract.id, await risesOf(tx, contract.id));
  });
}

/**
 * Replace the contract's rises with these.
 *
 * `contract:write`, because how a contract's prices rise is one of its terms,
 * like its yearly rate. A card named has to be one of this contract's own,
 * and not a draft; a trade has to be one of the company's job types. Nothing
 * rises because of this: it changes what the preview shows, and the worker
 * prepares the draft again if it had already, as a changed rate does.
 */
export function setRises(ctx: ServiceContext, input: { contractId: string; rises: RiseInput[] }): Promise<RiseView[]> {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const contract = await loadContract(tx, input.contractId);
    const rows: rates.Rise[] = input.rises.map((r) => ({
      contractYear: r.contractYear ?? null,
      rateCardId: r.rateCardId ?? null,
      jobTypeId: r.jobTypeId ?? null,
      rate: r.rate.trim(),
    }));
    const problem = rates.risesProblem(rows);
    if (problem) throw new ConflictError(problem);
    const cardIds = [...new Set(rows.map((r) => r.rateCardId).filter((id): id is string => id !== null))];
    if (cardIds.length > 0) {
      const found = await tx.select({ id: schema.rateCard.id }).from(schema.rateCard).where(and(
        eq(schema.rateCard.contractId, contract.id), inArray(schema.rateCard.id, cardIds),
        isNull(schema.rateCard.deletedAt), isNull(schema.rateCard.draftFor),
      ));
      if (found.length !== cardIds.length) throw new ConflictError("A rise names a card that is not one of this contract's.");
    }
    const typeIds = [...new Set(rows.map((r) => r.jobTypeId).filter((id): id is string => id !== null))];
    if (typeIds.length > 0) {
      const found = await tx.select({ id: schema.jobType.id }).from(schema.jobType).where(inArray(schema.jobType.id, typeIds));
      if (found.length !== typeIds.length) throw new ConflictError("A rise names a kind of work this company does not have.");
    }
    const before = await risesOf(tx, contract.id);
    await tx.delete(schema.contractEscalationRise).where(eq(schema.contractEscalationRise.contractId, contract.id));
    if (rows.length > 0) {
      await tx.insert(schema.contractEscalationRise).values(rows.map((r) => ({
        organizationId: ctx.actor.organizationId,
        contractId: contract.id,
        contractYear: r.contractYear,
        rateCardId: r.rateCardId,
        jobTypeId: r.jobTypeId,
        rate: r.rate,
      })));
    }
    const after = await risesOf(tx, contract.id);
    await audit(tx, ctx, "contract.rises_set", "service_contract", contract.id,
      { rises: before.map(asRise) }, { rises: after.map(asRise) });
    return nameRises(tx, contract.id, after);
  });
}

export const handlers = {
  previewContractEscalation: (ctx: ServiceContext, input: { contractId: string }) => preview(ctx, input),
  applyContractEscalation: (
    ctx: ServiceContext, input: { contractId: string; anniversary: string; rate?: string | undefined; key?: string | undefined },
  ) => apply(ctx, input),
  listContractRises: (ctx: ServiceContext, input: { contractId: string }) => listRises(ctx, input),
  setContractRises: (ctx: ServiceContext, input: { contractId: string; rises: RiseInput[] }) => setRises(ctx, input),
} as const;
