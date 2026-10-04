import { and, asc, eq, desc, gte, lt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { permissionsFor, estimate as est, membership, money as m, time } from "@opentradesos/core";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
  scopeOf, timezoneOf,
} from "./context";
import { listFilter } from "./custom-fields";
import { layoutForNew } from "./proposal-templates";
import { admitDate, requireImport } from "./history";
import { estimateScopeFilter, estimateBranchFilter } from "./scope";
import { claimNumber, nextNumber } from "./jobs";
import { assertUnclaimed, byExternal, provenance } from "./provenance";
import { inForceAt } from "./pricebook";
import { memberPricingWithin } from "./agreements";
import { emit } from "./events";
import * as marketing from "./marketing";
import type {
  createEstimate, getEstimate, listEstimates, sendEstimate,
  approveEstimate, declineEstimate, convertEstimate,
} from "../contracts/estimates";
import { portalBase } from "../lib/portal-base";
import {
  deliveriesWithin, identityOf, transport, withdraw, type EstimateDeliveryView,
} from "./estimate-delivery";

const usd = (v: string) => m.money(v, "USD");

/**
 * Statuses an estimate can still be decided from.
 *
 * `expired` is deliberately in this set. An expiry date is a nudge, not a
 * cliff, and a company that would happily honour a three week old quote should
 * not have to rebuild it because a timestamp passed on a Sunday. What expiry
 * does is stop the estimate counting as open pipeline.
 *
 * `draft` is in it for the sale that happens at the kitchen table. A
 * technician builds the options on a tablet, turns it around, and the customer
 * says yes; nothing was ever sent, and requiring a send first would mean
 * recording a fake one. The portal cannot reach a draft in any case, because
 * sending is what issues the grant, so this only widens the office path.
 */
const DECIDABLE = ["draft", "sent", "viewed", "expired"] as const;

/**
 * Creating an estimate.
 *
 * Prices come from the price book VERSION whenever an item id is given, for
 * the same reason they do on an invoice: a client that can name its own price
 * is a client that will, and the version reference is what keeps a document
 * saying what it said after a price rise.
 */
export async function create(ctx: ServiceContext, input: z.infer<typeof createEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const seen = await seenBefore(tx, ctx.idempotencyKey, "estimate");
      if (seen) return loadEstimate(tx, ctx, seen);
    }
    return createIn(tx, ctx, input);
  });
}

/**
 * AN ESTIMATE WRITTEN ON A PHONE, which brings two things an office estimate
 * does not.
 *
 * Its ids. The phone made the estimate's, each option's and each line's, so
 * that the customer's choice and signature, taken on the same phone with no
 * signal, can name the option they chose before the server has heard of it.
 *
 * The prices it was shown at. The phone priced each line from the price book
 * it carries, which can be a day old, and the customer may sign on that
 * figure before the phone finds a signal. So each line names the version it
 * was priced from, and that version is used when it was in force at some
 * point in the week before the estimate was written: a price rise the phone
 * had not heard of does not change what the customer was shown. A version
 * older than that is refused, because a week old quote is the line the rest
 * of this product draws between late entry and history.
 */
export interface WrittenOnSite {
  estimateId: string;
  /** By option, in the order sent. */
  optionIds: string[];
  /** By option, then by line. */
  lineIds: string[][];
  /** The price book version each line was priced from on the phone, or null for a line typed by hand. */
  versionIds: Array<Array<string | null>>;
  /** When the phone wrote it, which is the day it was issued and the instant it was priced at. */
  pricedAt: Date;
}

/** How stale the phone's price book may be. The same week `admitDate` calls late entry rather than history. */
const STALE_PRICES_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Creating an estimate inside a caller's transaction: the office's route
 * (`create`, with its permission and idempotency key) and a phone's sync
 * (`field.ts`, with the ids and prices it brings) are the same estimate.
 */
export async function createIn(
  tx: Database, ctx: ServiceContext, input: z.infer<typeof createEstimate.input>, onSite?: WrittenOnSite,
) {
  {
    if (onSite) {
      const [already] = await tx.select({ id: schema.estimate.id }).from(schema.estimate)
        .where(eq(schema.estimate.id, onSite.estimateId)).limit(1);
      if (already) return loadEstimate(tx, ctx, already.id);
    }

    const itemIds = input.options
      .flatMap((o) => o.lines.map((l) => l.priceBookItemId))
      .filter((x): x is string => Boolean(x));

    const versions = itemIds.length
      ? await tx.select({
          itemId: schema.priceBookItemVersion.itemId,
          versionId: schema.priceBookItemVersion.id,
          name: schema.priceBookItemVersion.name,
          price: schema.priceBookItemVersion.price,
          cost: schema.priceBookItemVersion.cost,
          taxable: schema.priceBookItemVersion.taxable,
          kind: schema.priceBookItem.kind,
          feeRole: schema.priceBookItem.feeRole,
        })
        .from(schema.priceBookItemVersion)
        .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
        .where(and(
          inArray(schema.priceBookItemVersion.itemId, itemIds),
          /**
           * The version IN FORCE, not the open ended one. `isNull(effectiveTo)`
           * picks a revision dated ahead, so a price increase scheduled for
           * next month applied today and the price actually in force became
           * invisible. The reasoning is on `inForceAt`.
           */
          inForceAt(onSite?.pricedAt),
        ))
      : [];
    const byItem = new Map(versions.map((v) => [v.itemId, v]));

    /** The versions the phone priced from, held to the week before it wrote the estimate. */
    const pinnedIds = (onSite?.versionIds ?? []).flat().filter((x): x is string => Boolean(x));
    const pinned = pinnedIds.length
      ? await tx.select({
          itemId: schema.priceBookItemVersion.itemId,
          versionId: schema.priceBookItemVersion.id,
          name: schema.priceBookItemVersion.name,
          price: schema.priceBookItemVersion.price,
          cost: schema.priceBookItemVersion.cost,
          taxable: schema.priceBookItemVersion.taxable,
          kind: schema.priceBookItem.kind,
          feeRole: schema.priceBookItem.feeRole,
          effectiveFrom: schema.priceBookItemVersion.effectiveFrom,
          effectiveTo: schema.priceBookItemVersion.effectiveTo,
        })
        .from(schema.priceBookItemVersion)
        .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
        .where(inArray(schema.priceBookItemVersion.id, pinnedIds))
      : [];
    const byVersion = new Map(pinned.map((v) => [v.versionId, v]));
    const versionFor = (optionIndex: number, lineIndex: number, itemId: string | undefined) => {
      const pin = onSite?.versionIds[optionIndex]?.[lineIndex] ?? null;
      if (!pin || !itemId) return itemId ? byItem.get(itemId) : undefined;
      const version = byVersion.get(pin);
      const at = onSite!.pricedAt.getTime();
      if (!version || version.itemId !== itemId
        || version.effectiveFrom.getTime() > at
        || (version.effectiveTo !== null && version.effectiveTo.getTime() <= at - STALE_PRICES_MS)) {
        throw new ConflictError(
          "A price on this estimate came from a price book more than a week old, so it was not written. "
          + "Open the day with a signal to fetch the prices, and build it again.",
        );
      }
      return version;
    };

    /**
     * The day it was written. A migrated estimate from 2021 written on the
     * day of the cutover makes close rate by month meaningless for every
     * month before it.
     */
    const issuedOn = input.issuedOn
      ?? time.dateIn(onSite?.pricedAt ?? new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const historical = input.issuedOn
      ? (await admitDate(tx, ctx, input.issuedOn, "issuedOn")).historical
      : false;

    /**
     * MEMBER PRICING, decided once for the document.
     *
     * The customer's best active agreement at this address on the day the
     * estimate is written, if its plan carries a discount. Not for history: an
     * estimate recorded from another system says what it said, and a member
     * discount applied to it today would make it disagree with the copy the
     * customer was sent.
     */
    const member = historical || input.externalRef
      ? null
      : await memberPricingWithin(tx, {
        customerId: input.customerId, propertyId: input.propertyId, on: issuedOn,
      });

    /**
     * HOW IT ENDED, FOR AN ESTIMATE FROM ANOTHER SYSTEM.
     *
     * History, so `data:import`, and checked in core: a date, not in the
     * future and not before it was written, and a win that names the option
     * that won. Written straight onto the row and NOT through `decide`: no
     * signature is recorded because nobody signed anything here, and no
     * `estimate.approved` is emitted, because a migration loading four
     * thousand won estimates must not start four thousand automations that
     * text customers about work finished in 2022.
     */
    if (input.outcome) {
      requireImport(ctx);
      const verdict = est.checkHistory(input.outcome, {
        optionCount: input.options.length,
        issuedOn,
        today: time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId)),
      });
      if (!verdict.ok) throw new ConflictError(verdict.message);
    }

    /**
     * The small print, copied now. The company's own terms unless the
     * request brings its own; none for an estimate recorded from another
     * system, which said whatever it said there and was never shown ours.
     */
    const terms = input.terms !== undefined
      ? (input.terms.trim() === "" ? null : input.terms.trim())
      : historical || input.externalRef ? null : await termsWithin(tx, ctx.actor.organizationId);

    await assertUnclaimed(tx, "estimate", input.externalRef);
    const number = await claimNumber(tx, ctx, "estimate", input.number);

    const [row] = await tx.insert(schema.estimate).values({
      ...(onSite ? { id: onSite.estimateId } : {}),
      organizationId: ctx.actor.organizationId,
      number,
      customerId: input.customerId,
      propertyId: input.propertyId,
      jobId: input.jobId ?? null,
      title: input.title ?? null,
      issuedOn,
      expiresOn: input.expiresOn ?? (input.outcome?.status === "expired" ? input.outcome.on : null),
      status: "draft",
      terms,
      /**
       * The layout its job type starts with, or the company's default,
       * copied on like the terms. See `proposal-templates.ts`.
       */
      ...(await layoutForNew(tx, input.jobId ?? null)),
      ...provenance(input.externalRef),
    }).returning({ id: schema.estimate.id });

    const estimateId = row!.id;
    const optionIds: string[] = [];

    for (const [index, option] of input.options.entries()) {
      const resolved = option.lines.map((line, lineIndex) => {
        const version = versionFor(index, lineIndex, line.priceBookItemId);
        return {
          versionId: version?.versionId ?? null,
          name: version?.name ?? line.name,
          description: line.description ?? null,
          quantity: line.quantity,
          unitPrice: version?.price ?? line.unitPrice,
          unitCost: version?.cost ?? line.unitCost ?? null,
          discountAmount: line.discountAmount,
          taxable: version?.taxable ?? line.taxable,
          taxRate: (version?.taxable ?? line.taxable) ? (line.taxRate ?? input.taxRate) : "0",
          isOptional: line.isOptional,
          isSelected: line.isSelected,
          costCode: line.costCode ?? null,
          kind: version?.kind ?? null,
          feeRole: version?.feeRole ?? null,
          memberDiscountAmount: "0",
          memberAgreementId: null as string | null,
        };
      });

      /**
       * A PER LINE DISCOUNT, NOT A DISCOUNT LINE, and the reason is the
       * pricing code that already exists. A line's `discount_amount` is
       * carried through every total, onto the invoice on conversion, and into
       * the ledger as a debit to the discounts account, so a member discount
       * written there is posted correctly by code that has posted every other
       * discount. A separate negative line would be a price below zero, would
       * reduce revenue rather than show the discount, and would have to be
       * kept in step with the lines it was computed from on every edit.
       *
       * Each line says how much of its discount was the plan and which
       * agreement, so the screen and the customer can see it, and nothing is
       * taken off silently.
       */
      if (member) {
        const off = membership.memberDiscounts(resolved.map((l) => ({
          quantity: l.quantity,
          unitPrice: usd(l.unitPrice),
          discountAmount: usd(l.discountAmount),
          eligible: membership.eligibleForMemberPricing({ unitPrice: usd(l.unitPrice), itemKind: l.kind }),
          feeRole: l.feeRole,
        })), member.rate, { diagnostic: member.waivesDiagnosticFee, afterHours: member.waivesAfterHoursRate });
        for (const [i, line] of resolved.entries()) {
          const amount = off[i]!;
          if (!m.isPositive(amount)) continue;
          line.memberDiscountAmount = m.toString(amount);
          line.memberAgreementId = member.agreementId;
          line.discountAmount = m.toString(m.add(usd(line.discountAmount), amount));
        }
      }

      const computed = est.computeOption(resolved.map((l) => ({
        quantity: l.quantity,
        unitPrice: usd(l.unitPrice),
        discountAmount: usd(l.discountAmount),
        taxable: l.taxable,
        taxRate: l.taxRate,
        isOptional: l.isOptional,
        isSelected: l.isSelected,
        unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
      })));

      /**
       * THE DISCOUNT AUTHORITY, CHECKED ONCE PER OPTION AND NOT PER LINE.
       *
       * Per option because that is the unit a customer chooses and the unit
       * a company means when it says ten per cent.
       *
       * The two readings agree on a proportional discount, so this is not
       * about closing a loophole: ten per cent off every line is ten per cent
       * off the option either way. Where they differ is a CONCENTRATED
       * discount, and the option is the right answer there. One line thrown
       * in inside a big scope is a hundred per cent of that line and nine per
       * cent of what the customer is buying, which is a normal thing to do
       * and which a per line cap would refuse.
       *
       * `estimate:write` is the permission on this whole call and it stays:
       * writing an estimate is not the same decision as giving money away,
       * and a technician who may quote must be able to quote.
       */
      await assertDiscountAllowed(tx, ctx, {
        /**
         * The member discount is the company's own standing decision, made
         * when it set the plan's rate, so it is not checked against what this
         * person may give away. Only what they typed is.
         */
        discount: m.subtract(
          computed.totals.discountTotal,
          m.round(m.sum(resolved.filter((l) => !l.isOptional || l.isSelected)
            .map((l) => usd(l.memberDiscountAmount)), "USD"), 2),
        ),
        subtotal: computed.totals.subtotal,
      });

      const [optionRow] = await tx.insert(schema.estimateOption).values({
        ...(onSite?.optionIds[index] ? { id: onSite.optionIds[index] } : {}),
        organizationId: ctx.actor.organizationId,
        estimateId,
        name: option.name,
        description: option.description ?? null,
        sortOrder: index,
        isRecommended: option.isRecommended,
        subtotal: m.toString(computed.totals.subtotal),
        taxTotal: m.toString(computed.totals.taxTotal),
        total: m.toString(computed.totals.total),
      }).returning({ id: schema.estimateOption.id });
      optionIds.push(optionRow!.id);

      await tx.insert(schema.estimateLine).values(resolved.map((line, i) => ({
        ...(onSite?.lineIds[index]?.[i] ? { id: onSite.lineIds[index]![i]! } : {}),
        organizationId: ctx.actor.organizationId,
        optionId: optionRow!.id,
        priceBookItemVersionId: line.versionId,
        sortOrder: i,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unitCost: line.unitCost,
        discountAmount: line.discountAmount,
        memberAgreementId: line.memberAgreementId,
        memberDiscountAmount: line.memberDiscountAmount,
        taxable: line.taxable,
        taxRate: line.taxRate,
        taxAmount: m.toString(computed.lines[i]!.taxAmount),
        lineTotal: m.toString(computed.lines[i]!.lineTotal),
        isOptional: line.isOptional,
        isSelected: line.isSelected,
        costCode: line.costCode,
      })));
    }

    if (input.outcome) {
      const { start } = time.dayBoundsIn(input.outcome.on, await timezoneOf(tx, ctx.actor.organizationId));
      await tx.update(schema.estimate).set({
        status: input.outcome.status,
        decidedAt: input.outcome.status === "expired" ? null : start,
        selectedOptionId: input.outcome.status === "approved"
          ? optionIds[input.outcome.chosenOption!] ?? null : null,
        signerName: input.outcome.status === "approved" ? input.outcome.signerName ?? null : null,
        declineReason: input.outcome.status === "declined" ? input.outcome.reason ?? null : null,
        updatedAt: new Date(),
      }).where(eq(schema.estimate.id, estimateId));
      await audit(tx, ctx, "estimate.outcome_imported", "estimate", estimateId, null, {
        status: input.outcome.status, on: input.outcome.on,
      });
    }

    await recordIdempotency(tx, ctx, "estimate", estimateId);
    await audit(tx, ctx, "estimate.created", "estimate", estimateId, null,
      onSite ? { number, writtenOnSite: true } : { number });
    return loadEstimate(tx, ctx, estimateId);
  }
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getEstimate.input>) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    await assertEstimateVisible(tx, ctx, input.id);
    return loadEstimate(tx, ctx, input.id);
  });
}

/**
 * In scope, as the estimate list is: one out of the reader's scope reads as
 * not found, so a technician cannot open another's estimate by its id.
 */
export async function assertEstimateVisible(tx: Database, ctx: ServiceContext, id: string): Promise<void> {
  const [visible] = await tx.select({ id: schema.estimate.id }).from(schema.estimate)
    .where(and(eq(schema.estimate.id, id), estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor)))
    .limit(1);
  if (!visible) throw new NotFoundError("Estimate");
}

export async function list(ctx: ServiceContext, input: z.infer<typeof listEstimates.input>) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    const after = decodeCursor(input.cursor);
    const rows = await tx.select({
      id: schema.estimate.id,
      number: schema.estimate.number,
      status: schema.estimate.status,
      customerId: schema.estimate.customerId,
      customerName: schema.customer.name,
      propertyId: schema.estimate.propertyId,
      jobId: schema.estimate.jobId,
      title: schema.estimate.title,
      issuedOn: schema.estimate.issuedOn,
      expiresOn: schema.estimate.expiresOn,
      sentAt: schema.estimate.sentAt,
      viewedAt: schema.estimate.viewedAt,
      decidedAt: schema.estimate.decidedAt,
      declineReason: schema.estimate.declineReason,
      selectedOptionId: schema.estimate.selectedOptionId,
      signerName: schema.estimate.signerName,
      currency: schema.estimate.currency,
      sourceSystem: schema.estimate.sourceSystem,
      sourceId: schema.estimate.sourceId,
      customFields: schema.estimate.customFields,
      createdAt: schema.estimate.createdAt,
      updatedAt: schema.estimate.updatedAt,
    })
      .from(schema.estimate)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.estimate.customerId))
      .where(and(
        // A technician sees estimates for work they did. See services/scope.ts.
        estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor),
        input.status ? inArray(schema.estimate.status, input.status) : undefined,
        input.customerId ? eq(schema.estimate.customerId, input.customerId) : undefined,
        input.jobId ? eq(schema.estimate.jobId, input.jobId) : undefined,
        input.businessUnitId ? estimateBranchFilter(input.businessUnitId) : undefined,
        byExternal(schema.estimate, input),
        await listFilter(tx, ctx.actor.organizationId, "estimate", input, sql`${schema.estimate.customFields}`),
        after ? lt(schema.estimate.id, after) : undefined,
      ))
      .orderBy(desc(schema.estimate.id))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.id);

    // One query for every option total on the page rather than one per row.
    const ids = page.data.map((r) => r.id);
    const options = ids.length
      ? await tx.select({
          estimateId: schema.estimateOption.estimateId,
          total: schema.estimateOption.total,
        }).from(schema.estimateOption).where(inArray(schema.estimateOption.estimateId, ids))
      : [];

    /**
     * The headline figure for a multi option estimate is the recommended one
     * where there is one, and otherwise the largest. A list that showed the
     * cheapest option would read as a pipeline half the size of the real one.
     */
    const byEstimate = new Map<string, string[]>();
    for (const o of options) {
      byEstimate.set(o.estimateId, [...(byEstimate.get(o.estimateId) ?? []), o.total]);
    }

    return {
      ...page,
      data: page.data.map((r) => {
        const totals = byEstimate.get(r.id) ?? [];
        const top = totals.reduce((acc, t) => (usd(t).amount > usd(acc).amount ? t : acc), "0");
        return clean(ctx, "estimate", { ...r, total: top, optionCount: totals.length });
      }),
    };
  });
}

/**
 * The figure an estimate is worth if the customer says yes.
 *
 * The recommended option where there is one, otherwise the largest: the same
 * rule the list uses, so the unsold total and the list cannot disagree about
 * one estimate.
 */
export function headlineTotal(options: { total: string; isRecommended: boolean }[]): string {
  const recommended = options.find((o) => o.isRecommended);
  if (recommended) return recommended.total;
  return options.reduce((acc, o) => (usd(o.total).amount > usd(acc).amount ? o.total : acc), "0");
}

export interface UnsoldEstimate {
  id: string;
  number: number;
  title: string | null;
  customerId: string;
  customerName: string;
  status: string;
  sentAt: Date;
  viewedAt: Date | null;
  /** Whole days since it went out. */
  ageDays: number;
  value: string;
}

/**
 * UNSOLD ESTIMATES: sent, not decided, by age or by value.
 *
 * The pipeline a company can still close, which is a different list from
 * every estimate ever written. An expired one is left off, because expiry is
 * what stops an estimate counting as open, and a draft never reached anybody.
 *
 * The value is the recommended option, or the largest, which is what the work
 * is worth if they say yes. Summing every option would count the same job two
 * or three times.
 */
export async function unsold(
  ctx: ServiceContext,
  input: { sort?: "age" | "value"; limit?: number } = {},
): Promise<UnsoldEstimate[]> {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    /**
     * THE DATE IS READ HERE AS WELL AS BY THE WORKER. The worker marks an
     * estimate `expired` once its date has passed in the company's calendar
     * (`estimate-expiry.ts`), but it goes round once a minute and may not be
     * running, and a pipeline that listed a quote as closable until the next
     * pass would be wrong in a way nobody could see. So an open estimate whose
     * date has passed is left off whether or not it has been marked yet.
     */
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const rows = await tx.select({
      id: schema.estimate.id,
      number: schema.estimate.number,
      title: schema.estimate.title,
      customerId: schema.estimate.customerId,
      customerName: schema.customer.name,
      status: schema.estimate.status,
      sentAt: schema.estimate.sentAt,
      viewedAt: schema.estimate.viewedAt,
    })
      .from(schema.estimate)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.estimate.customerId))
      .where(and(
        estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor),
        inArray(schema.estimate.status, ["sent", "viewed"]),
        or(isNull(schema.estimate.expiresOn), gte(schema.estimate.expiresOn, today)),
      ))
      .orderBy(asc(schema.estimate.sentAt))
      .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));

    const ids = rows.map((r) => r.id);
    const options = ids.length
      ? await tx.select({
          estimateId: schema.estimateOption.estimateId,
          total: schema.estimateOption.total,
          isRecommended: schema.estimateOption.isRecommended,
        }).from(schema.estimateOption).where(inArray(schema.estimateOption.estimateId, ids))
      : [];

    const now = Date.now();
    const out = rows
      .filter((r): r is typeof r & { sentAt: Date } => r.sentAt !== null)
      .map((r) => ({
        ...r,
        ageDays: Math.max(0, Math.floor((now - r.sentAt.getTime()) / 86_400_000)),
        value: headlineTotal(options.filter((o) => o.estimateId === r.id)),
      }));

    return input.sort === "value"
      ? out.sort((a, b) => Number(usd(b.value).amount - usd(a.value).amount) || b.ageDays - a.ageDays)
      : out.sort((a, b) => b.ageDays - a.ageDays || Number(usd(b.value).amount - usd(a.value).amount));
  });
}

/** The unsold list as the API publishes it: instants as strings. */
export async function unsoldHandler(
  ctx: ServiceContext, input: { sort?: "age" | "value" | undefined; limit?: number | undefined },
) {
  const rows = await unsold(ctx, {
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  });
  return {
    estimates: rows.map((e) => ({
      ...e, sentAt: e.sentAt.toISOString(), viewedAt: e.viewedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Sending.
 *
 * Two things happen together or neither is worth anything: the document is
 * frozen by hashing what will be rendered, and the customer is issued a single
 * use grant to approve it. An approval that cannot be tied to the document the
 * customer saw settles nothing later.
 *
 * The plaintext token exists exactly once, in the return value. Only its hash
 * is written down, so a leaked database backup contains no working links.
 */
export async function send(ctx: ServiceContext, input: z.infer<typeof sendEstimate.input>) {
  return guardedWrite(ctx, "estimate:send", async (tx) => {
    /**
     * A retry is the same send, not a second message to the customer. It
     * gets the attempt back WITHOUT the link: only the link's hash was ever
     * stored, and minting another for a retry would put two live links to
     * one document into the world.
     */
    if (ctx.idempotencyKey) {
      const seen = await seenBefore(tx, ctx.idempotencyKey, "estimate_delivery");
      if (seen) {
        const all = await deliveriesWithin(tx, input.id);
        const delivery = all.find((d) => d.id === seen);
        if (delivery) {
          /** A send by email and text at once is two rows sharing one link; both come back. */
          const together = await sameSend(tx, seen);
          return {
            estimate: await loadEstimate(tx, ctx, input.id), approvalUrl: null, expiresAt: null, delivery,
            deliveries: all.filter((d) => together.includes(d.id)),
          };
        }
      }
    }

    const current = await loadEstimate(tx, ctx, input.id);

    if (current.status === "approved" || current.status === "converted") {
      throw new ConflictError(
        `Estimate ${current.number} has already been approved. Create a revision rather than resending it.`,
      );
    }

    const [customer] = await tx.select({
      name: schema.customer.name, email: schema.customer.email, phone: schema.customer.phone,
    }).from(schema.customer).where(eq(schema.customer.id, current.customerId)).limit(1);

    /**
     * WHERE IT GOES. The address or number typed for this send, otherwise the
     * one on the customer. No address is thrown rather than recorded: there is
     * no attempt to record, and the fix is a detail on the customer.
     *
     * BY BOTH AT ONCE is the email and the text together, carrying ONE link,
     * so the customer approving from either is approving the one document and
     * the link still works once. Each goes to the customer's own address and
     * number: a typed `to` would be one address for two channels, so it is
     * refused rather than guessed at. A customer missing either is refused
     * before anything is sent, because half of "by email and text" going out
     * silently is the outcome nobody asked for.
     */
    const channel = input.channel;
    const channels: ("email" | "sms")[] = channel === "both" ? ["email", "sms"] : channel === "link" ? [] : [channel];
    if (channel === "both" && input.to?.trim()) {
      throw new ConflictError(
        "Sending by email and text at once goes to the customer's own email address and mobile number. "
        + "To use a different address or number, send by one channel at a time.",
      );
    }
    const destinations = new Map<"email" | "sms", string>();
    for (const one of channels) {
      const to = (channel === "both" ? undefined : input.to)
        ?? (one === "email" ? customer?.email : customer?.phone) ?? "";
      if (to.trim() === "") {
        throw new ConflictError(
          `${customer?.name ?? "This customer"} has no ${one === "email" ? "email address" : "mobile number"} `
          + "on file and none was given. Add one to the customer, "
          + (channel === "both" ? "or send by the other channel alone." : "or hand them the link another way."),
        );
      }
      destinations.set(one, to.trim());
    }
    const to = channels.length === 1 ? destinations.get(channels[0]!)! : null;

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + input.expiresInDays * 864e5);

    const [grant] = await tx.insert(schema.portalGrant).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      scope: "estimate",
      subjectId: input.id,
      tokenHash,
      expiresAt,
      // One approval per link. A forwarded link cannot approve a second time
      // or switch the chosen option after the fact.
      maxUses: 1,
    }).returning({ id: schema.portalGrant.id });
    const url = approvalUrl(token);

    /**
     * The attempts are written before the transport is called, in the same
     * transaction, so there is no ordering in which a message exists and the
     * row that says which estimate it carried does not. One row per channel,
     * each with its own outcome, all naming the same link.
     */
    const attempts = await tx.insert(schema.estimateDelivery).values(
      (channels.length === 0 ? ["link" as const] : channels).map((one) => ({
        organizationId: ctx.actor.organizationId,
        estimateId: input.id,
        channel: one,
        destination: one === "link" ? null : destinations.get(one)!,
        portalGrantId: grant!.id,
        sentByUserId: ctx.portalGrantId ? null : ctx.actor.userId,
      })),
    ).returning({ id: schema.estimateDelivery.id, channel: schema.estimateDelivery.channel });
    const deliveryId = attempts[0]!.id;
    const deliveryIds = attempts.map((a) => a.id);

    if (channels.length > 0) {
      const identity = await identityOf(tx, ctx.actor.organizationId);
      const refused: { channel: string; to: string; reason: string }[] = [];
      for (const attempt of attempts) {
        const one = attempt.channel as "email" | "sms";
        const outcome = await transport(tx, ctx, {
          channel: one,
          to: destinations.get(one)!,
          customerId: current.customerId,
          identity,
          estimate: {
            number: current.number,
            title: current.title,
            customerName: customer?.name ?? "",
            totals: current.options.map((o) => o.total as string),
          },
          url,
          note: input.message?.trim() ? input.message.trim() : null,
        });
        if (outcome.sent) {
          await tx.update(schema.estimateDelivery)
            .set({ messageId: outcome.messageId, updatedAt: new Date() })
            .where(eq(schema.estimateDelivery.id, attempt.id));
        } else {
          await tx.update(schema.estimateDelivery)
            .set({ error: outcome.explanation, updatedAt: new Date() })
            .where(eq(schema.estimateDelivery.id, attempt.id));
          refused.push({ channel: one, to: destinations.get(one)!, reason: outcome.reason });
        }
      }

      if (refused.length === attempts.length) {
        /**
         * NOT SENT IS RECORDED, NOT THROWN, AND CHANGES NOTHING ELSE.
         *
         * The link this send minted is withdrawn, the estimate keeps the
         * status it had, any link the customer already holds still works,
         * and nothing is emitted: an estimate the customer never received
         * must not start the clock an "unanswered estimate" follow up waits
         * on. What remains is the attempt with the reason in words, on the
         * estimate's own screen.
         *
         * Only when EVERY channel was refused. By both at once with the
         * text refused (they replied STOP) and the email gone, the customer
         * has the estimate, and the refused text is a row with its reason
         * beside the one that went.
         */
        await withdraw(tx, grant!.id);
        await audit(tx, ctx, "estimate.delivery_refused", "estimate", input.id, null, {
          deliveryId, channel, to, refused,
        });
        await recordIdempotency(tx, ctx, "estimate_delivery", deliveryId);
        const all = await deliveriesWithin(tx, input.id);
        return {
          estimate: current,
          approvalUrl: null,
          expiresAt: null,
          delivery: all.find((d) => d.id === deliveryId)!,
          deliveries: all.filter((d) => deliveryIds.includes(d.id)),
        };
      }
      if (refused.length > 0) {
        await audit(tx, ctx, "estimate.delivery_refused", "estimate", input.id, null, { deliveryId, channel, refused });
      }
    }

    /**
     * Any other link outstanding on this estimate is withdrawn, now that this
     * one has gone. A revised estimate sent twice would otherwise leave the
     * first link live, and a customer approving through it would be
     * approving numbers that no longer exist. After the transport rather than
     * before it, so a send that was refused takes nothing away.
     */
    await tx.update(schema.portalGrant)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.portalGrant.scope, "estimate"),
        eq(schema.portalGrant.subjectId, input.id),
        isNull(schema.portalGrant.revokedAt),
        ne(schema.portalGrant.id, grant!.id),
      ));

    /**
     * AN ESTIMATE SENT AFTER ITS DATE GOES OUT AS EXPIRED. Marking it `sent`
     * would put it back in the unsold pipeline for the worker to take out
     * again within the minute, a status that was true for as long as it took
     * to read. It is still sent, and the customer can still approve it (an
     * expiry date is a nudge, not a cliff); it just never counts as open.
     */
    const sentAt = new Date();
    const today = time.dateIn(sentAt, await timezoneOf(tx, ctx.actor.organizationId));
    const pastItsDate = current.expiresOn !== null && current.expiresOn !== undefined && current.expiresOn < today;
    await tx.update(schema.estimate)
      .set({ status: pastItsDate ? "expired" : "sent", sentAt, updatedAt: sentAt })
      .where(eq(schema.estimate.id, input.id));

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      estimateId: input.id,
      kind: "estimate_sent",
      headline: `Estimate #${current.number} sent`,
      detail: input.message
        ?? (channel === "email" ? `By email to ${to}` : channel === "sms" ? `By text to ${to}`
          : channel === "both" ? `By email to ${destinations.get("email")} and by text to ${destinations.get("sms")}` : null),
    });

    /**
     * WHEN THE CLOCK ON "THEY HAVE NOT ANSWERED" STARTS.
     *
     * The catalogue has carried this event since the engine was written,
     * marked as owed by this module, and nothing emitted it. So an automation
     * that waits from the moment an estimate went out could not be written,
     * and the follow up every office wants had to be the dwell sweep, which
     * chases every old estimate in the book the day it is turned on.
     *
     * The link itself is not on the event. It exists once, in the return
     * value, and the event log is not the place for a working credential; an
     * automation that sends the link again mints its own.
     */
    await emit(tx, ctx, {
      name: "estimate.sent",
      entityType: "estimate",
      entityId: input.id,
      payload: {
        estimate: {
          id: input.id,
          number: current.number,
          title: current.title,
          customerId: current.customerId,
          sentAt: sentAt.toISOString(),
          total: headlineTotal(current.options.map((o) => ({
            total: o.total as string, isRecommended: o.isRecommended as boolean,
          }))),
        },
        customer: { id: current.customerId, name: customer?.name ?? "" },
        channel,
      },
      previous: { estimate: { status: current.status } },
    });

    await audit(tx, ctx, "estimate.sent", "estimate", input.id,
      { status: current.status }, { status: pastItsDate ? "expired" : "sent", channel, deliveryId });
    await recordIdempotency(tx, ctx, "estimate_delivery", deliveryId);

    const all = await deliveriesWithin(tx, input.id);
    return {
      estimate: await loadEstimate(tx, ctx, input.id),
      approvalUrl: url,
      expiresAt: expiresAt.toISOString(),
      delivery: all.find((d) => d.id === deliveryId)!,
      deliveries: all.filter((d) => deliveryIds.includes(d.id)),
    };
  });
}

/** The attempts one send made: every delivery row carrying the same link as this one. */
async function sameSend(tx: Database, deliveryId: string): Promise<string[]> {
  const [first] = await tx.select({ grantId: schema.estimateDelivery.portalGrantId })
    .from(schema.estimateDelivery).where(eq(schema.estimateDelivery.id, deliveryId)).limit(1);
  if (!first?.grantId) return [deliveryId];
  const rows = await tx.select({ id: schema.estimateDelivery.id }).from(schema.estimateDelivery)
    .where(eq(schema.estimateDelivery.portalGrantId, first.grantId));
  return rows.map((row) => row.id);
}

/** Every attempt to send this estimate, with what became of each. */
export async function deliveries(ctx: ServiceContext, input: { id: string }): Promise<EstimateDeliveryView[]> {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    await loadEstimate(tx, ctx, input.id);
    return deliveriesWithin(tx, input.id);
  });
}

/**
 * Recording an approval that happened somewhere else: at the kitchen table, on
 * the phone, in a reply to an email.
 *
 * `capturedVia` is asked for rather than inferred, because "the customer said
 * yes on the phone" and "the customer clicked approve" are different evidence
 * and a company deserves to know which one it has.
 */
export async function approve(ctx: ServiceContext, input: z.infer<typeof approveEstimate.input>) {
  return guardedWrite(ctx, "estimate:approve", async (tx) => {
    return decide(tx, ctx, {
      estimateId: input.id,
      optionId: input.optionId,
      selectedLineIds: input.selectedLineIds,
      signerName: input.signerName,
      capturedVia: input.capturedVia,
    });
  });
}

export async function decline(ctx: ServiceContext, input: z.infer<typeof declineEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const current = await loadEstimate(tx, ctx, input.id);

    // A retry from a bad connection is a no-op, not a second decline.
    if (current.status === "declined") return current;

    if (!(DECIDABLE as readonly string[]).includes(current.status)) {
      throw new ConflictError(
        `Estimate ${current.number} is ${current.status} and cannot be declined.`,
      );
    }

    await tx.update(schema.estimate).set({
      status: "declined",
      decidedAt: new Date(),
      declineReason: input.reason ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, input.id));

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      estimateId: input.id,
      kind: "estimate_declined",
      headline: `Estimate #${current.number} declined`,
      detail: input.reason ?? null,
      isCustomerVisible: false,
    });

    await emitDeclined(tx, ctx, {
      estimateId: input.id, previousStatus: current.status, reason: input.reason ?? null, by: "office",
    });

    await audit(tx, ctx, "estimate.declined", "estimate", input.id,
      { status: current.status }, { status: "declined", reason: input.reason ?? null });
    return loadEstimate(tx, ctx, input.id);
  });
}

/**
 * `estimate.declined`, from the office or from the customer's own link.
 *
 * One function for both, so an automation built on "when an estimate is
 * declined" fires the same way whichever side said no, and its payload says
 * which side it was. The reason rides along because it is the whole of what
 * a win back step would say.
 */
export async function emitDeclined(
  tx: Database, ctx: ServiceContext,
  input: { estimateId: string; previousStatus: string; reason: string | null; by: "office" | "customer" },
): Promise<void> {
  const [row] = await tx.select({
    number: schema.estimate.number, title: schema.estimate.title,
    customerId: schema.estimate.customerId, customerName: schema.customer.name,
  }).from(schema.estimate)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.estimate.customerId))
    .where(eq(schema.estimate.id, input.estimateId)).limit(1);
  if (!row) throw new NotFoundError("Estimate");
  await emit(tx, ctx, {
    name: "estimate.declined",
    entityType: "estimate",
    entityId: input.estimateId,
    payload: {
      estimate: {
        id: input.estimateId, number: row.number, title: row.title, customerId: row.customerId,
        reason: input.reason,
      },
      customer: { id: row.customerId, name: row.customerName },
      declinedBy: input.by,
    },
    previous: { estimate: { status: input.previousStatus } },
  });
}

/**
 * Turning an approved option into work and a bill.
 *
 * The conversion is a COPY, not a re-price. Every line carries its frozen
 * price book version and the tax rate as applied straight onto the invoice,
 * and nothing is looked up again. An invoice that disagrees with the approved
 * quote, even by a cent from a rate that changed overnight, is the fastest way
 * to lose a customer who was, a moment ago, happy.
 *
 * Only the lines the customer actually took are copied. An optional line they
 * left unticked was priced and shown and declined, and billing it is the worst
 * version of this mistake.
 */
export async function convert(ctx: ServiceContext, input: z.infer<typeof convertEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const seen = await seenBefore(tx, ctx.idempotencyKey, "estimate_conversion");
      if (seen) return loadConversion(tx, ctx, input.id);
    }
    return convertIn(tx, ctx, input);
  });
}

/**
 * The conversion inside a caller's transaction. The office's route is this
 * with its permissions and key; an invoice raised on site (`field-invoices`)
 * is this, onto the visit's job, with the invoice's id the phone made, and
 * then issued.
 */
export async function convertIn(
  tx: Database, ctx: ServiceContext, input: z.infer<typeof convertEstimate.input>,
  options: { invoiceId?: string | undefined } = {},
) {
  {
    const current = await loadEstimate(tx, ctx, input.id);

    if (current.status === "converted") return loadConversion(tx, ctx, input.id);
    if (current.status !== "approved") {
      throw new ConflictError(
        `Estimate ${current.number} is ${current.status}. Only an approved estimate converts.`,
      );
    }

    const optionId = current.selectedOptionId as string | null;
    if (!optionId) throw new ConflictError("No option was selected on this estimate.");

    const option = (current.options as Array<Record<string, unknown>>)
      .find((o) => o["id"] === optionId);
    if (!option) throw new NotFoundError("Estimate option");

    const lines = (option["lines"] as Array<Record<string, unknown>>)
      .filter((l) => !l["isOptional"] || l["isSelected"] === true);

    let jobId: string | null = current.jobId as string | null;
    if (input.createJob && !jobId) {
      const number = await nextNumber(tx, ctx.actor.organizationId, "job");

      const [job] = await tx.insert(schema.job).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: current.customerId as string,
        propertyId: current.propertyId as string,
        jobTypeId: input.jobTypeId ?? null,
        status: "scheduled",
        summary: (current.title as string | null) ?? `${option["name"]}`,
      }).returning({ id: schema.job.id });

      /**
       * CREDITED like any other new work, and the lead source is not copied
       * from the paperwork. An estimate is a stage, not a source: this used
       * to write the word "estimate" and then the customer's own source, and
       * either way the touches behind the job were never tagged, so the
       * Google ad that produced the lead got no credit in any report for the
       * job it turned into. `creditWork` tags the customer's touches with
       * this job and fills the source from them, marked `derived`; with
       * nothing recorded it stays blank, which is honest.
       */
      await marketing.creditWork(tx, ctx.actor.organizationId, { jobId: job!.id });
      jobId = job!.id;
    }

    let invoiceId: string | null = null;
    if (input.createInvoice) {
      const number = await nextNumber(tx, ctx.actor.organizationId, "invoice");
      const [invoice] = await tx.insert(schema.invoice).values({
        ...(options.invoiceId ? { id: options.invoiceId } : {}),
        organizationId: ctx.actor.organizationId,
        number,
        customerId: current.customerId as string,
        propertyId: current.propertyId as string,
        jobId,
        status: "draft",
        subtotal: option["subtotal"] as string,
        /**
         * THE DISCOUNT HAS TO COME ACROSS AS WELL AS THE TOTAL.
         *
         * The option stores its subtotal before discount and its total after,
         * and this used to copy only those two, leaving the invoice's discount
         * at zero. An invoice whose subtotal less its discount plus its tax is
         * not its total cannot be posted: issuing it builds the posting from
         * these columns, and a receivable smaller than the revenue it credits
         * is refused as unbalanced. Every estimate converted with a discount
         * on it, a member's above all, became a draft that could never be
         * issued. Summed from the lines being copied, the same way the option
         * total was computed from them.
         */
        discountTotal: m.toString(m.round(
          m.sum(lines.map((l) => usd(l["discountAmount"] as string)), "USD"), 2,
        )),
        taxTotal: option["taxTotal"] as string,
        total: option["total"] as string,
        balance: option["total"] as string,
      }).returning({ id: schema.invoice.id });
      invoiceId = invoice!.id;

      await tx.insert(schema.invoiceLine).values(lines.map((l, i) => ({
        organizationId: ctx.actor.organizationId,
        invoiceId: invoiceId!,
        origin: "job" as const,
        originId: jobId,
        // Frozen on the estimate, carried across untouched.
        priceBookItemVersionId: (l["priceBookItemVersionId"] ?? null) as string | null,
        sortOrder: i,
        name: l["name"] as string,
        description: (l["description"] ?? null) as string | null,
        quantity: l["quantity"] as string,
        unitPrice: l["unitPrice"] as string,
        unitCost: (l["unitCost"] ?? null) as string | null,
        discountAmount: l["discountAmount"] as string,
        /** The member discount and its agreement travel with the line, as priced. */
        memberAgreementId: (l["memberAgreementId"] ?? null) as string | null,
        memberDiscountAmount: (l["memberDiscountAmount"] ?? "0") as string,
        taxable: l["taxable"] as boolean,
        taxRate: l["taxRate"] as string,
        taxAmount: l["taxAmount"] as string,
        lineTotal: l["lineTotal"] as string,
        costCode: (l["costCode"] ?? null) as string | null,
      })));
    }

    await tx.update(schema.estimate).set({
      status: "converted",
      jobId,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, input.id));

    const [deposit] = await tx.select({ id: schema.deposit.id })
      .from(schema.deposit).where(eq(schema.deposit.estimateId, input.id)).limit(1);

    // The deposit follows the work, so it can be applied to the invoice that
    // comes out of it without anyone hunting for the original estimate.
    if (deposit && jobId) {
      await tx.update(schema.deposit).set({ jobId, updatedAt: new Date() })
        .where(eq(schema.deposit.id, deposit.id));
    }

    await recordIdempotency(tx, ctx, "estimate_conversion", input.id);
    await audit(tx, ctx, "estimate.converted", "estimate", input.id,
      { status: "approved" }, { status: "converted", jobId, invoiceId });

    return {
      estimate: await loadEstimate(tx, ctx, input.id),
      jobId,
      invoiceId,
      depositId: deposit?.id ?? null,
    };
  }
}

/** The result of a conversion that already happened, for a retry. */
async function loadConversion(tx: Database, ctx: ServiceContext, estimateId: string) {
  const estimate = await loadEstimate(tx, ctx, estimateId);
  const [invoice] = await tx.select({ id: schema.invoice.id })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.jobId, (estimate.jobId ?? "") as string),
      eq(schema.invoice.organizationId, ctx.actor.organizationId),
    )).limit(1);
  const [deposit] = await tx.select({ id: schema.deposit.id })
    .from(schema.deposit).where(eq(schema.deposit.estimateId, estimateId)).limit(1);

  return {
    estimate,
    jobId: (estimate.jobId ?? null) as string | null,
    invoiceId: invoice?.id ?? null,
    depositId: deposit?.id ?? null,
  };
}

/**
 * The shared body of an approval, whichever side it came from.
 *
 * Exported so the portal service can reuse it without going through a
 * permission check the customer could never satisfy. Callers are responsible
 * for authorizing; this function only enforces that the estimate is in a state
 * where a decision means something.
 */
export async function decide(
  tx: Database,
  ctx: ServiceContext,
  input: {
    estimateId: string;
    optionId: string;
    selectedLineIds: string[];
    signerName: string;
    capturedVia: string;
    signatureImage?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
    /**
     * When the customer signed, for a signature taken on a phone that synced
     * later. The signature is evidence of a moment, and the moment is when
     * the finger left the glass, not when the van found a signal.
     */
    signedAt?: Date | undefined;
    /** The drawn signature's id on the phone, which its image arrives under. */
    uploadId?: string | undefined;
  },
) {
  const current = await loadEstimate(tx, ctx, input.estimateId);

  // A retry is a no-op, but only when it agrees with what was already decided.
  // A second approval choosing a DIFFERENT option is not a retry, it is a
  // contradiction, and silently ignoring it would lose a real disagreement.
  if (current.status === "approved" || current.status === "converted") {
    if (current.selectedOptionId === input.optionId) return current;
    throw new ConflictError(
      `Estimate ${current.number} was already approved on a different option.`,
    );
  }

  if (!(DECIDABLE as readonly string[]).includes(current.status)) {
    throw new ConflictError(
      `Estimate ${current.number} is ${current.status} and cannot be approved.`,
    );
  }

  const option = current.options.find((o) => o.id === input.optionId);
  if (!option) throw new NotFoundError("Estimate option");

  /**
   * Optional lines the customer took are marked before the totals are
   * recomputed, because the total the customer agreed to includes them. Any
   * optional line NOT in the list is explicitly unticked rather than left
   * alone, so a second pass through this function cannot accumulate choices
   * from an earlier attempt.
   */
  const optionalIds = option.lines.filter((l) => l.isOptional).map((l) => l.id);
  if (optionalIds.length) {
    await tx.update(schema.estimateLine)
      .set({ isSelected: false })
      .where(inArray(schema.estimateLine.id, optionalIds));
  }
  const taken = input.selectedLineIds.filter((id) => optionalIds.includes(id));
  if (taken.length) {
    await tx.update(schema.estimateLine)
      .set({ isSelected: true })
      .where(inArray(schema.estimateLine.id, taken));
  }

  const totals = await recomputeOption(tx, ctx, input.optionId);

  await tx.insert(schema.documentSignature).values({
    organizationId: ctx.actor.organizationId,
    subject: "estimate",
    subjectId: input.estimateId,
    signerName: input.signerName,
    imageUrl: input.signatureImage ?? null,
    documentHash: hashDocument({ ...current, approvedTotal: m.toString(totals.total) }),
    selectedOptionId: input.optionId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    uploadId: input.uploadId ?? null,
    ...(input.signedAt ? { signedAt: input.signedAt } : {}),
  });

  await tx.update(schema.estimate).set({
    status: "approved",
    decidedAt: input.signedAt ?? new Date(),
    selectedOptionId: input.optionId,
    signerName: input.signerName,
    updatedAt: new Date(),
  }).where(eq(schema.estimate.id, input.estimateId));

  await tx.insert(schema.portalEvent).values({
    organizationId: ctx.actor.organizationId,
    customerId: current.customerId,
    estimateId: input.estimateId,
    kind: "estimate_approved",
    headline: `Estimate #${current.number} approved`,
    detail: `${option.name}, ${m.toString(totals.total)}`,
  });

  /**
   * `estimate.approved`, from the office and from the portal alike, since
   * both arrive here. The catalogue had it as owed with "the portal records
   * the signature; nothing emits", so the commonest automation a sales team
   * wants (a yes books the job, texts a thank you, tells the installer) could
   * not be built. The total is what they approved, after the optional lines
   * they ticked, and `capturedVia` says whether the customer clicked it or
   * somebody recorded a yes given on the phone.
   */
  const [customer] = await tx.select({ name: schema.customer.name })
    .from(schema.customer).where(eq(schema.customer.id, current.customerId)).limit(1);
  await emit(tx, ctx, {
    name: "estimate.approved",
    entityType: "estimate",
    entityId: input.estimateId,
    payload: {
      estimate: {
        id: input.estimateId,
        number: current.number,
        title: current.title,
        customerId: current.customerId,
        optionId: input.optionId,
        optionName: option.name,
        total: m.toString(totals.total),
        signerName: input.signerName,
      },
      customer: { id: current.customerId, name: customer?.name ?? "" },
      capturedVia: input.capturedVia,
    },
    previous: { estimate: { status: current.status } },
  });

  await audit(tx, ctx, "estimate.approved", "estimate", input.estimateId,
    { status: current.status },
    {
      status: "approved",
      optionId: input.optionId,
      total: m.toString(totals.total),
      capturedVia: input.capturedVia,
      signerName: input.signerName,
    });

  return loadEstimate(tx, ctx, input.estimateId);
}

/**
 * Recomputes and rewrites one option's totals from its current lines.
 *
 * Called after the customer changes which optional lines they are taking. The
 * totals are not recomputed on read anywhere, so this is the only place the
 * stored figures can change, and the document keeps saying what it said.
 */
export async function recomputeOption(tx: Database, ctx: ServiceContext, optionId: string) {
  const lines = await tx.select().from(schema.estimateLine)
    .where(eq(schema.estimateLine.optionId, optionId))
    .orderBy(schema.estimateLine.sortOrder);

  const computed = est.computeOption(lines.map((l) => ({
    quantity: l.quantity,
    unitPrice: usd(l.unitPrice),
    discountAmount: usd(l.discountAmount),
    taxable: l.taxable,
    taxRate: l.taxRate,
    isOptional: l.isOptional,
    isSelected: l.isSelected,
    unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
  })));

  await tx.update(schema.estimateOption).set({
    subtotal: m.toString(computed.totals.subtotal),
    taxTotal: m.toString(computed.totals.taxTotal),
    total: m.toString(computed.totals.total),
    updatedAt: new Date(),
  }).where(eq(schema.estimateOption.id, optionId));

  return computed.totals;
}

/**
 * Reads the whole estimate on an open transaction.
 *
 * Takes `tx` rather than opening its own, because a service method that calls
 * another service method through a second connection cannot see its own
 * uncommitted writes: creating an estimate and then reading it back would
 * report that the estimate does not exist.
 */
export async function loadEstimate(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.estimate)
    .where(eq(schema.estimate.id, id)).limit(1);
  if (!row) throw new NotFoundError("Estimate");

  const options = await tx.select().from(schema.estimateOption)
    .where(eq(schema.estimateOption.estimateId, id))
    .orderBy(schema.estimateOption.sortOrder);

  const lines = options.length
    ? await tx.select().from(schema.estimateLine)
        .where(inArray(schema.estimateLine.optionId, options.map((o) => o.id)))
        .orderBy(schema.estimateLine.sortOrder)
    : [];

  const shaped = options.map((option) => {
    const own = lines.filter((l) => l.optionId === option.id);
    const computed = est.computeOption(own.map((l) => ({
      quantity: l.quantity,
      unitPrice: usd(l.unitPrice),
      discountAmount: usd(l.discountAmount),
      taxable: l.taxable,
      taxRate: l.taxRate,
      isOptional: l.isOptional,
      isSelected: l.isSelected,
      unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
    })));

    return clean(ctx, "estimateOption", {
      id: option.id,
      name: option.name,
      description: option.description,
      sortOrder: option.sortOrder,
      isRecommended: option.isRecommended,
      subtotal: option.subtotal,
      taxTotal: option.taxTotal,
      total: option.total,
      baseTotal: m.toString(computed.totals.baseTotal),
      optionalTotal: m.toString(computed.totals.optionalTotal),
      cost: computed.totals.cost === null ? null : m.toString(computed.totals.cost),
      margin: computed.totals.margin,
      lines: own.map((l) => clean(ctx, "estimateLine", l)),
    });
  });

  return clean(ctx, "estimate", {
    ...row,
    // Most expensive first, recommended pulled up. Cheapest-first anchors the
    // customer on the cheapest, which defeats the point of offering options.
    options: est.presentationOrder(
      shaped.map((o) => ({ ...o, total: usd(o.total as string) })),
    ).map((o) => ({ ...o, total: m.toString(o.total) })),
  });
}

/**
 * What the customer agreed to, reduced to a hash.
 *
 * Deliberately excludes anything the office can change afterwards without the
 * customer seeing it, and deliberately includes every figure they were shown.
 * A disagreement later about what was agreed is answerable from this and
 * unanswerable from a picture of a name.
 */
function hashDocument(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");
}

const approvalUrl = (token: string) => `${portalBase()}/e/${token}`;

async function seenBefore(tx: Database, key: string, entityType: string): Promise<string | null> {
  const [row] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, key),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return row?.entityId ?? null;
}

async function recordIdempotency(tx: Database, ctx: ServiceContext, entityType: string, entityId: string) {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    idempotencyKey: ctx.idempotencyKey,
    entityType,
    entityId,
    direction: "outbound",
    provider: "internal",
    eventType: `${entityType}.created`,
  });
}

/* ------------------------------------------------------- proposal terms */

/**
 * THE COMPANY'S OWN SMALL PRINT, printed under the options on every
 * proposal: what the price includes, how long it holds, the warranty, the
 * payment terms. Kept in the company's settings and COPIED onto each estimate
 * when it is written, because a change in March must not change what a
 * customer signed in February. See `estimate.terms`.
 */
const MAX_TERMS = 10_000;

export async function termsWithin(tx: Database, organizationId: string): Promise<string | null> {
  const [row] = await tx.execute<{ terms: string | null }>(sql`
    select settings ->> 'proposalTerms' as terms from public.organization where id = ${organizationId} limit 1`);
  const terms = row?.terms?.trim();
  return terms ? terms : null;
}

export async function proposalTerms(ctx: ServiceContext): Promise<{ terms: string | null }> {
  return guardedRead(ctx, "estimate:read", async (tx) => ({ terms: await termsWithin(tx, ctx.actor.organizationId) }));
}

/**
 * `settings:write`, like the discount limit beside it: what every proposal
 * the company sends promises is a company decision, not something everybody
 * who writes an estimate gets to rewrite for everybody else. One estimate's
 * own terms can still be given when it is written.
 */
export async function setProposalTerms(ctx: ServiceContext, input: { terms: string }): Promise<{ terms: string | null }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const terms = input.terms.trim();
    if (terms.length > MAX_TERMS) {
      throw new ConflictError(`Terms are at most ${MAX_TERMS.toLocaleString("en-US")} characters. Link to a longer document instead.`);
    }
    const before = await termsWithin(tx, ctx.actor.organizationId);
    await tx.execute(sql`
      update public.organization
      set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{proposalTerms}', to_jsonb(${terms}::text))
      where id = ${ctx.actor.organizationId}`);
    await audit(tx, ctx, "proposal_terms.set", "organization", ctx.actor.organizationId,
      { terms: before }, { terms: terms === "" ? null : terms });
    return { terms: terms === "" ? null : terms };
  });
}

/* ------------------------------------------------- who may give money away */

/**
 * `estimate:discount` AND `estimate.discount.unlimited` WERE GRANTED TO ROLES
 * AND CHECKED BY NOTHING.
 *
 * `estimate_line.discount_amount` has existed since the first migration and
 * anybody holding `estimate:write` could set it to anything: a technician
 * standing in a kitchen could take a forty thousand dollar re-pipe to zero,
 * and the two permissions a company thought gated that were a restriction the
 * owner believed they had applied.
 *
 * The decision itself is `estimate.checkDiscount` in core, for the reason the
 * overtime policy gives: a rule about money with several edges, written
 * inside a database transaction, is a rule nobody can test without one. What
 * is here is the asking.
 */

export interface DiscountPolicyView {
  maxPercent: string;
  maxAmount: string | null;
  note: string | null;
}

export async function discountPolicy(ctx: ServiceContext): Promise<DiscountPolicyView | null> {
  return guardedRead(ctx, "estimate:read", async (tx) =>
    policyWithin(tx, ctx.actor.organizationId));
}

async function policyWithin(
  tx: Database, organizationId: string,
): Promise<DiscountPolicyView | null> {
  const [row] = await tx.select().from(schema.discountPolicy)
    .where(and(
      eq(schema.discountPolicy.organizationId, organizationId),
      isNull(schema.discountPolicy.deletedAt),
    ));
  if (!row) return null;
  return { maxPercent: row.maxPercent, maxAmount: row.maxAmount, note: row.note };
}

/**
 * Declare the limit.
 *
 * ON THE PERMISSION. `settings:write`, not `estimate:discount`. Holding the
 * authority to apply a discount is not the authority to decide how large a
 * discount anybody may apply, and letting the two be one permission means
 * every person who can discount can raise their own ceiling, which is the
 * same as having no ceiling.
 */
export async function setDiscountPolicy(
  ctx: ServiceContext,
  input: { maxPercent: string; maxAmount?: string | null | undefined; note?: string | null | undefined },
): Promise<DiscountPolicyView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const percent = Number(input.maxPercent);
    if (!Number.isFinite(percent) || percent < 0) {
      throw new ConflictError("A discount limit cannot be negative.");
    }
    /**
     * A FRACTION, NOT A PERCENTAGE POINT COUNT, and refused above one.
     *
     * The column is `numeric(9,6)` and every rate in this product is a
     * fraction: 0.1 is ten per cent. Somebody typing 10 means ten per cent
     * and would be authorising a thousand, which is a discount ten times the
     * price of the work. Refused rather than divided by a hundred on their
     * behalf, because guessing which of the two they meant is how a limit
     * ends up a hundred times too small instead.
     */
    if (percent > 1) {
      throw new ConflictError(
        `A discount limit is a fraction rather than a percentage: 0.1 is ten per cent. `
        + `${input.maxPercent} would authorise a discount ${input.maxPercent} times the price `
        + "of the work.",
      );
    }
    if (input.maxAmount !== undefined && input.maxAmount !== null) {
      const amount = Number(input.maxAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new ConflictError("A discount ceiling cannot be negative.");
      }
    }

    const before = await policyWithin(tx, ctx.actor.organizationId);

    const [row] = await tx.insert(schema.discountPolicy).values({
      organizationId: ctx.actor.organizationId,
      maxPercent: input.maxPercent,
      maxAmount: input.maxAmount ?? null,
      note: input.note?.trim() || null,
    })
      /**
       * One per company. `targetWhere` is required because the index is
       * partial on `deleted_at is null`, and Postgres refuses to match an ON
       * CONFLICT specification to a partial index without the predicate: it
       * fails at runtime rather than at compile time.
       */
      .onConflictDoUpdate({
        target: [schema.discountPolicy.organizationId],
        targetWhere: isNull(schema.discountPolicy.deletedAt),
        set: {
          maxPercent: input.maxPercent,
          maxAmount: input.maxAmount ?? null,
          note: input.note?.trim() || null,
          updatedAt: new Date(),
        },
      })
      .returning();

    await audit(tx, ctx, "discount_policy.set", "discount_policy", row!.id, before, row!);
    return { maxPercent: row!.maxPercent, maxAmount: row!.maxAmount, note: row!.note };
  });
}

/**
 * Refuse a discount this caller may not apply.
 *
 * Reads the two permissions off the actor rather than through a second
 * `guarded` call, because this runs inside a transaction that has already
 * been authorised for `estimate:write`, and a nested guard would open its own
 * connection and could not see the estimate being written.
 */
async function assertDiscountAllowed(
  tx: Database, ctx: ServiceContext,
  input: { discount: m.Money; subtotal: m.Money },
): Promise<void> {
  const held = permissionsFor(ctx.actor);
  const policy = await policyWithin(tx, ctx.actor.organizationId);

  const verdict = est.checkDiscount({
    discount: input.discount,
    subtotal: input.subtotal,
    mayDiscount: held.has("estimate:discount"),
    uncapped: held.has("estimate.discount.unlimited" as never),
    policy: policy === null
      ? null
      : {
        maxPercent: policy.maxPercent,
        ...(policy.maxAmount === null ? {} : { maxAmount: usd(policy.maxAmount) }),
      },
  });

  if (!verdict.allowed) throw new ConflictError(est.discountRefusal(verdict));
}

/**
 * Take the limit away again, which puts the company back to nobody being
 * authorised to discount.
 *
 * Soft deleted rather than removed, and that is what makes the partial unique
 * index on `deleted_at is null` load bearing rather than decorative: the
 * previous limit stays readable as the record of what was authorised when an
 * old estimate was written, and the index still allows exactly one live row.
 */
export async function clearDiscountPolicy(ctx: ServiceContext): Promise<{ cleared: boolean }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.update(schema.discountPolicy)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.discountPolicy.organizationId, ctx.actor.organizationId),
        isNull(schema.discountPolicy.deletedAt),
      )).returning();
    if (!row) throw new NotFoundError("Discount policy");

    await audit(tx, ctx, "discount_policy.cleared", "discount_policy", row.id, row, null);
    return { cleared: true };
  });
}

export const discountHandlers = {
  getDiscountPolicy: async (ctx: ServiceContext): Promise<{ policy: DiscountPolicyView | null }> =>
    ({ policy: await discountPolicy(ctx) }),
  setDiscountPolicy: (ctx: ServiceContext, input: {
    maxPercent: string; maxAmount?: string | null | undefined; note?: string | null | undefined;
  }): Promise<DiscountPolicyView> => setDiscountPolicy(ctx, input),
  clearDiscountPolicy: (ctx: ServiceContext): Promise<{ cleared: boolean }> =>
    clearDiscountPolicy(ctx),
} as const;
