import { and, asc, eq, isNull, lte, gte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError, timezoneOf,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * CONTRACTS AND RATE CARDS: THE PRICE AUTHORITY PROBLEM
 *
 * The schema names it exactly: "our price book is not the price authority in
 * five segments. A rate card is a price authority that is not ours: a client
 * contract, a warranty network schedule, a manufacturer labour allowance, an
 * insurance price list."
 *
 * `service_contract`, `contract_site`, `rate_card` and `rate_card_line` all
 * existed and none of them had a single writer or reader. So a company doing
 * commercial work priced every job off their own book, which is the one
 * thing the contract says they may not do, and found out at invoice time
 * when the client rejected it.
 *
 * COST TRACKING STAYS OURS IN EVERY CASE. That is the sentence the whole
 * design turns on: the price comes from somebody else's card, the cost comes
 * from our own records, and the margin is therefore still true on work we
 * did not price. A system that took the card's price as both would report
 * every contract job at zero margin.
 *
 * WHAT A RESOLUTION IS, AND WHAT IT IS NOT
 *
 * `priceFor` answers "what may we charge for this item, for this customer,
 * on this day". It is a lookup with an effective date and an explicit
 * refusal, never a fallback: an item that is not on the card comes back as
 * NOT COVERED rather than as the price book price. Falling back is the
 * defect that makes a contract job invoice at list, which the client
 * rejects, which is a month of somebody's time to re-bill.
 */

/* ------------------------------------------------------------- contracts */

export interface ContractInput {
  customerId: string;
  name: string;
  contractNumber?: string | null | undefined;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  autoRenews?: boolean | undefined;
  escalationRate?: string | null | undefined;
  defaultNotToExceed?: string | null | undefined;
  purchaseOrderNumber?: string | null | undefined;
  coveredScope?: string | null | undefined;
}

export async function createContract(ctx: ServiceContext, input: ContractInput) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
      throw new ConflictError("That contract ends before it starts.");
    }

    const [customer] = await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const [row] = await tx.insert(schema.serviceContract).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      name: input.name,
      contractNumber: input.contractNumber ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      autoRenews: input.autoRenews ?? false,
      escalationRate: input.escalationRate ?? null,
      defaultNotToExceed: input.defaultNotToExceed ?? null,
      purchaseOrderNumber: input.purchaseOrderNumber ?? null,
      coveredScope: input.coveredScope ?? null,
    }).returning();

    await audit(tx, ctx, "contract.created", "service_contract", row!.id, null, row!);
    return row!;
  });
}

export async function listContracts(ctx: ServiceContext, input: { customerId?: string } = {}) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const rows = await tx.select({
      contract: schema.serviceContract,
      customerName: schema.customer.name,
    }).from(schema.serviceContract)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.serviceContract.customerId))
      .where(and(
        eq(schema.serviceContract.organizationId, ctx.actor.organizationId),
        isNull(schema.serviceContract.deletedAt),
        ...(input.customerId ? [eq(schema.serviceContract.customerId, input.customerId)] : []),
      ))
      .orderBy(asc(schema.serviceContract.name));

    return rows.map(({ contract, customerName }) => ({
      id: contract.id,
      customerId: contract.customerId,
      customerName,
      name: contract.name,
      contractNumber: contract.contractNumber,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
      autoRenews: contract.autoRenews,
      escalationRate: contract.escalationRate,
      defaultNotToExceed: contract.defaultNotToExceed,
      purchaseOrderNumber: contract.purchaseOrderNumber,
      coveredScope: contract.coveredScope,
      active: contract.active,
    }));
  });
}

/**
 * Put a property on a contract, with its own ceiling.
 *
 * `notToExceed` per SITE rather than only per contract, because that is how
 * facilities clients actually write them: a thousand dollars at the
 * distribution centre and two hundred at the retail unit, under one
 * agreement. A single contract level ceiling would have somebody approving
 * work at the wrong limit for whichever site it was.
 */
export async function addSite(
  ctx: ServiceContext,
  input: { contractId: string; propertyId: string; siteNumber?: string | null; notToExceed?: string | null },
) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const contract = await loadContract(tx, ctx.actor.organizationId, input.contractId);

    const [property] = await tx.select({ id: schema.property.id })
      .from(schema.property)
      .where(and(eq(schema.property.id, input.propertyId), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!property) throw new NotFoundError("Property");

    const [row] = await tx.insert(schema.contractSite).values({
      organizationId: ctx.actor.organizationId,
      contractId: contract.id,
      propertyId: input.propertyId,
      siteNumber: input.siteNumber ?? null,
      notToExceed: input.notToExceed ?? null,
    }).returning();

    await audit(tx, ctx, "contract.site_added", "contract_site", row!.id, null, row!);
    return { id: row!.id, propertyId: row!.propertyId, notToExceed: row!.notToExceed };
  });
}

async function loadContract(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.serviceContract)
    .where(and(
      eq(schema.serviceContract.id, id),
      eq(schema.serviceContract.organizationId, organizationId),
      isNull(schema.serviceContract.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Contract");
  return row;
}

/* ------------------------------------------------------------ rate cards */

export interface RateCardInput {
  name: string;
  contractId?: string | null | undefined;
  /** contract | warranty_network | manufacturer_allowance | insurance | brand */
  authority?: string | undefined;
  effectiveFrom?: string | null | undefined;
  effectiveTo?: string | null | undefined;
}

export const AUTHORITIES = [
  "contract", "warranty_network", "manufacturer_allowance", "insurance", "brand",
] as const;

export async function createRateCard(ctx: ServiceContext, input: RateCardInput) {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const authority = input.authority ?? "contract";
    if (!(AUTHORITIES as readonly string[]).includes(authority)) {
      throw new ConflictError(
        `"${authority}" is not a price authority this product knows. One of: ${AUTHORITIES.join(", ")}.`,
      );
    }
    if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new ConflictError("That card expires before it takes effect.");
    }
    if (authority === "contract" && !input.contractId) {
      throw new ConflictError(
        "A contract rate card needs the contract it belongs to. Without one there is no customer it applies to, "
        + "so it would never be found when a price is resolved.",
      );
    }
    if (input.contractId) await loadContract(tx, ctx.actor.organizationId, input.contractId);

    const [row] = await tx.insert(schema.rateCard).values({
      organizationId: ctx.actor.organizationId,
      name: input.name,
      contractId: input.contractId ?? null,
      authority,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    }).returning();

    await audit(tx, ctx, "rate_card.created", "rate_card", row!.id, null, row!);
    return row!;
  });
}

export interface RateCardLineInput {
  externalCode?: string | null | undefined;
  priceBookItemId?: string | null | undefined;
  description: string;
  unit?: string | null | undefined;
  price: string;
  /** Allowance schedules pay a fixed time, not the time actually taken. */
  allowedMinutes?: number | null | undefined;
}

/**
 * Load the lines of a card.
 *
 * Replaces rather than appends, because a rate card arrives as a document:
 * the client sends next year's schedule as one spreadsheet, and merging it
 * into last year's leaves every line they DELETED still priced and still
 * quotable. A card is a version of a price list, not a growing pile.
 */
export async function setRateCardLines(
  ctx: ServiceContext,
  input: { rateCardId: string; lines: RateCardLineInput[] },
) {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const [card] = await tx.select().from(schema.rateCard)
      .where(and(
        eq(schema.rateCard.id, input.rateCardId),
        eq(schema.rateCard.organizationId, ctx.actor.organizationId),
        isNull(schema.rateCard.deletedAt),
      )).limit(1);
    if (!card) throw new NotFoundError("Rate card");

    const refused: { row: number; reason: string }[] = [];
    const accepted: RateCardLineInput[] = [];

    for (const [index, line] of input.lines.entries()) {
      if (!line.externalCode && !line.priceBookItemId) {
        /**
         * A line that maps to neither their code nor our item can never be
         * found when a price is resolved. It is a row in a table and
         * nothing else, and it would sit there looking like coverage.
         */
        refused.push({
          row: index + 1,
          reason: "Neither their code nor one of our items, so nothing could ever match it.",
        });
        continue;
      }
      try {
        const price = m.money(line.price, "USD");
        if (m.isNegative(price)) {
          refused.push({ row: index + 1, reason: "A negative price is not a price." });
          continue;
        }
      } catch {
        refused.push({ row: index + 1, reason: `"${line.price}" is not an amount.` });
        continue;
      }
      accepted.push(line);
    }

    await tx.delete(schema.rateCardLine)
      .where(eq(schema.rateCardLine.rateCardId, card.id));

    if (accepted.length > 0) {
      await tx.insert(schema.rateCardLine).values(accepted.map((line) => ({
        organizationId: ctx.actor.organizationId,
        rateCardId: card.id,
        externalCode: line.externalCode ?? null,
        priceBookItemId: line.priceBookItemId ?? null,
        description: line.description,
        unit: line.unit ?? null,
        price: line.price,
        allowedMinutes: line.allowedMinutes ?? null,
      })));
    }

    await audit(tx, ctx, "rate_card.lines_set", "rate_card", card.id, null, {
      accepted: accepted.length, refused: refused.length,
    });

    return { rateCardId: card.id, accepted: accepted.length, refused };
  });
}

export async function rateCardLines(ctx: ServiceContext, rateCardId: string) {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const rows = await tx.select().from(schema.rateCardLine)
      .where(and(
        eq(schema.rateCardLine.organizationId, ctx.actor.organizationId),
        eq(schema.rateCardLine.rateCardId, rateCardId),
      ))
      .orderBy(asc(schema.rateCardLine.description));

    return rows.map((row) => ({
      id: row.id,
      externalCode: row.externalCode,
      priceBookItemId: row.priceBookItemId,
      description: row.description,
      unit: row.unit,
      price: row.price,
      allowedMinutes: row.allowedMinutes,
    }));
  });
}

/* ------------------------------------------------------- the resolution */

export type PriceResolution =
  | {
      covered: true;
      price: string;
      /** Which card said so, and under whose authority. */
      rateCardId: string;
      rateCardName: string;
      authority: string;
      contractId: string | null;
      /** An allowance schedule pays a fixed time, not the time taken. */
      allowedMinutes: number | null;
      description: string;
    }
  | {
      covered: false;
      /** Why, in words somebody can act on. */
      reason: string;
      /** True when a card applies and this item is simply not on it. */
      cardApplies: boolean;
    };

/**
 * What may we charge for this item, for this customer, on this day.
 *
 * NOT COVERED IS A REFUSAL, NOT A FALLBACK, and this is the most important
 * line in the file. An item that is not on the client's card comes back as
 * not covered rather than as our list price. Falling back is what makes a
 * contract job invoice at list, which the client rejects, which is a month
 * of somebody's time to re-bill and a conversation about whether we read the
 * agreement.
 *
 * The refusal distinguishes "no card applies to this customer", where the
 * price book is the right answer, from "a card applies and this item is not
 * on it", where somebody has to ring the client before doing the work. Those
 * are completely different situations and a single false would collapse
 * them.
 *
 * MATCHED ON OUR ITEM FIRST, then on their code. A line mapped to our price
 * book item is a mapping somebody made deliberately; an external code match
 * is a string comparison against whatever was in a spreadsheet.
 */
export async function priceFor(
  ctx: ServiceContext,
  input: { customerId: string; priceBookItemId?: string; externalCode?: string; on?: string },
): Promise<PriceResolution> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    if (!input.priceBookItemId && !input.externalCode) {
      throw new ConflictError("Name an item or a code. There is nothing to look up otherwise.");
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);

    /**
     * Cards that apply to this customer today, through an active contract.
     * The effective dates are checked here rather than by reading `active`
     * alone: a card that expired on the 31st is not the authority on the
     * 1st, whatever anybody remembered to untick.
     */
    const cards = await tx.select({
      card: schema.rateCard,
      contractId: schema.serviceContract.id,
    }).from(schema.rateCard)
      .innerJoin(
        schema.serviceContract,
        eq(schema.serviceContract.id, schema.rateCard.contractId),
      )
      .where(and(
        eq(schema.rateCard.organizationId, ctx.actor.organizationId),
        eq(schema.rateCard.active, true),
        isNull(schema.rateCard.deletedAt),
        eq(schema.serviceContract.customerId, input.customerId),
        eq(schema.serviceContract.active, true),
        isNull(schema.serviceContract.deletedAt),
        or(isNull(schema.rateCard.effectiveFrom), lte(schema.rateCard.effectiveFrom, on)),
        or(isNull(schema.rateCard.effectiveTo), gte(schema.rateCard.effectiveTo, on)),
        or(isNull(schema.serviceContract.startsOn), lte(schema.serviceContract.startsOn, on)),
        or(isNull(schema.serviceContract.endsOn), gte(schema.serviceContract.endsOn, on)),
      ));

    if (cards.length === 0) {
      return {
        covered: false,
        cardApplies: false,
        reason: "No contract rate card applies to this customer today, so our own price book is the authority.",
      };
    }

    for (const { card, contractId } of cards) {
      const [line] = await tx.select().from(schema.rateCardLine)
        .where(and(
          eq(schema.rateCardLine.rateCardId, card.id),
          input.priceBookItemId
            ? eq(schema.rateCardLine.priceBookItemId, input.priceBookItemId)
            : eq(schema.rateCardLine.externalCode, input.externalCode!),
        )).limit(1);

      if (line) {
        return {
          covered: true,
          price: line.price,
          rateCardId: card.id,
          rateCardName: card.name,
          authority: card.authority,
          contractId,
          allowedMinutes: line.allowedMinutes,
          description: line.description,
        };
      }
    }

    return {
      covered: false,
      /**
       * The distinction that matters. A card applies and this is not on it,
       * so somebody has to ring the client before doing the work rather
       * than quietly charging list.
       */
      cardApplies: true,
      reason:
        `${cards.length === 1 ? "A rate card applies" : `${cards.length} rate cards apply`} to this customer `
        + "and this item is not on any of them. It is out of scope until the client agrees a price: "
        + "invoicing it at our list price is what gets a contract invoice rejected.",
    };
  });
}

/**
 * The ceiling for work at a property, under a contract.
 *
 * The site's own limit wins over the contract's default, because that is how
 * facilities clients write them: a thousand at the distribution centre, two
 * hundred at the retail unit, under one agreement. Reading only the contract
 * default would have somebody approving work at the wrong limit for
 * whichever site it was.
 */
export async function ceilingForProperty(
  ctx: ServiceContext,
  input: { customerId: string; propertyId: string },
) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const [row] = await tx.select({
      contractId: schema.serviceContract.id,
      contractName: schema.serviceContract.name,
      contractDefault: schema.serviceContract.defaultNotToExceed,
      siteLimit: schema.contractSite.notToExceed,
      siteNumber: schema.contractSite.siteNumber,
    }).from(schema.contractSite)
      .innerJoin(
        schema.serviceContract,
        eq(schema.serviceContract.id, schema.contractSite.contractId),
      )
      .where(and(
        eq(schema.contractSite.organizationId, ctx.actor.organizationId),
        eq(schema.contractSite.propertyId, input.propertyId),
        eq(schema.serviceContract.customerId, input.customerId),
        eq(schema.serviceContract.active, true),
        isNull(schema.serviceContract.deletedAt),
      )).limit(1);

    if (!row) return null;

    const limit = row.siteLimit ?? row.contractDefault;
    if (!limit) return null;

    return {
      contractId: row.contractId,
      contractName: row.contractName,
      siteNumber: row.siteNumber,
      notToExceed: limit,
      /** True when the site overrode the contract's default. Shown, because the two differ by design. */
      fromSite: row.siteLimit !== null,
    };
  });
}

/**
 * Every contract, with the cards on it and how many lines each card carries.
 *
 * THE LINE COUNT IS ON THE SCREEN BECAUSE ZERO IS THE DANGEROUS NUMBER. A
 * contract with a card and no lines looks exactly like a contract with a
 * card: work gets quoted, every item resolves as out of scope, and the
 * person quoting reads that as "the client is fussy" rather than "nobody
 * loaded the schedule". An empty card is worse than no card at all, because
 * no card at least means the price book is the honest answer.
 */
export async function overview(ctx: ServiceContext) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);

    const rows = await tx.select({
      contract: schema.serviceContract,
      customerName: schema.customer.name,
    }).from(schema.serviceContract)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.serviceContract.customerId))
      .where(and(
        eq(schema.serviceContract.organizationId, ctx.actor.organizationId),
        isNull(schema.serviceContract.deletedAt),
      ))
      .orderBy(asc(schema.customer.name), asc(schema.serviceContract.name));

    const cards = await tx.select({
      card: schema.rateCard,
      lines: sql<number>`(
        select count(*)::int from ${schema.rateCardLine}
        where ${schema.rateCardLine.rateCardId} = ${schema.rateCard.id}
      )`,
    }).from(schema.rateCard)
      .where(and(
        eq(schema.rateCard.organizationId, ctx.actor.organizationId),
        isNull(schema.rateCard.deletedAt),
      ))
      .orderBy(asc(schema.rateCard.name));

    const sites = await tx.select({
      site: schema.contractSite,
      line1: schema.property.addressLine1,
      city: schema.property.city,
    }).from(schema.contractSite)
      .innerJoin(schema.property, eq(schema.property.id, schema.contractSite.propertyId))
      .where(eq(schema.contractSite.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.property.addressLine1));

    return rows.map((row) => {
      const contract = row.contract;
      /**
       * "In force" is read from the dates, never from the flag alone. A
       * contract nobody remembered to untick is not still the authority on
       * the day after it ended.
       */
      const started = !contract.startsOn || contract.startsOn <= today;
      const ended = Boolean(contract.endsOn && contract.endsOn < today);
      const cardsOn = cards
        .filter((c) => c.card.contractId === contract.id)
        .map((c) => ({
          id: c.card.id,
          name: c.card.name,
          authority: c.card.authority,
          effectiveFrom: c.card.effectiveFrom,
          effectiveTo: c.card.effectiveTo,
          lines: c.lines,
          inForce: c.card.active
            && (!c.card.effectiveFrom || c.card.effectiveFrom <= today)
            && (!c.card.effectiveTo || c.card.effectiveTo >= today),
        }));

      return {
        id: contract.id,
        name: contract.name,
        customerId: contract.customerId,
        customerName: row.customerName,
        contractNumber: contract.contractNumber,
        startsOn: contract.startsOn,
        endsOn: contract.endsOn,
        autoRenews: contract.autoRenews,
        purchaseOrderNumber: contract.purchaseOrderNumber,
        coveredScope: contract.coveredScope,
        defaultNotToExceed: contract.defaultNotToExceed,
        inForce: contract.active && started && !ended,
        ended,
        cards: cardsOn,
        /** A card with no lines prices nothing. Counted separately so the screen can say so. */
        pricedLines: cardsOn.reduce((total, card) => total + card.lines, 0),
        sites: sites
          .filter((s) => s.site.contractId === contract.id)
          .map((s) => ({
            id: s.site.id,
            propertyId: s.site.propertyId,
            siteNumber: s.site.siteNumber,
            address: [s.line1, s.city].filter(Boolean).join(", "),
            notToExceed: s.site.notToExceed ?? contract.defaultNotToExceed,
            fromSite: s.site.notToExceed !== null,
          })),
      };
    });
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listContracts: async (ctx: ServiceContext, input: { customerId?: string | undefined }): Promise<{
    contracts: Awaited<ReturnType<typeof listContracts>>;
  }> => ({
    contracts: await listContracts(ctx, input.customerId ? { customerId: input.customerId } : {}),
  }),

  createContract: async (ctx: ServiceContext, input: ContractInput): Promise<{
    id: string; name: string;
  }> => {
    const row = await createContract(ctx, input);
    return { id: row.id, name: row.name };
  },

  addContractSite: (ctx: ServiceContext, input: {
    contractId: string; propertyId: string;
    siteNumber?: string | null | undefined;
    notToExceed?: string | null | undefined;
  }) => addSite(ctx, {
    contractId: input.contractId,
    propertyId: input.propertyId,
    siteNumber: input.siteNumber ?? null,
    notToExceed: input.notToExceed ?? null,
  }),

  createRateCard: async (ctx: ServiceContext, input: RateCardInput): Promise<{
    id: string; name: string; authority: string;
  }> => {
    const row = await createRateCard(ctx, input);
    return { id: row.id, name: row.name, authority: row.authority };
  },

  setRateCardLines: (ctx: ServiceContext, input: {
    rateCardId: string; lines: RateCardLineInput[];
  }) => setRateCardLines(ctx, input),

  listRateCardLines: async (ctx: ServiceContext, input: { rateCardId: string }): Promise<{
    lines: Awaited<ReturnType<typeof rateCardLines>>;
  }> => ({ lines: await rateCardLines(ctx, input.rateCardId) }),

  resolveContractPrice: (ctx: ServiceContext, input: {
    customerId: string;
    priceBookItemId?: string | undefined;
    externalCode?: string | undefined;
    on?: string | undefined;
  }) => priceFor(ctx, {
    customerId: input.customerId,
    ...(input.priceBookItemId ? { priceBookItemId: input.priceBookItemId } : {}),
    ...(input.externalCode ? { externalCode: input.externalCode } : {}),
    ...(input.on ? { on: input.on } : {}),
  }),

  getPropertyCeiling: async (ctx: ServiceContext, input: {
    customerId: string; propertyId: string;
  }): Promise<{
    contractId: string | null; contractName: string | null;
    siteNumber: string | null; notToExceed: string | null; fromSite: boolean | null;
  }> => {
    const ceiling = await ceilingForProperty(ctx, input);
    /**
     * A flat null-filled shape rather than a null body, so a client reads
     * `notToExceed === null` for "no limit" instead of having to tell an
     * absent object from one with no limit on it.
     */
    return ceiling ?? {
      contractId: null, contractName: null, siteNumber: null,
      notToExceed: null, fromSite: null,
    };
  },
} as const;
