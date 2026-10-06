import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  ledger, membership, money as m, time, recurrence, SYSTEM_USER_ID, type Actor,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { sendTransactional } from "./comms-send";
import * as email from "./email";
import { refusingDuplicate } from "./duplicates";
import { nextNumber } from "./jobs";
import { writePosting } from "./ledger";
import { emit } from "./events";
import { resolveIn } from "./entitlements";
import * as once from "./once";
import { inForceAt } from "./pricebook";
import * as notices from "./agreement-notices";

/**
 * MAINTENANCE AGREEMENTS
 *
 * The single biggest lever on what a home services company is worth. A shop
 * with four hundred members on auto renew sells for a different multiple than
 * an identical shop doing the same revenue in one off calls, because one has
 * predictable revenue and a reason for the customer to call them first.
 *
 * The schema for this was designed carefully and then sat there with nothing
 * calling it, along with four ledger postings in core that were written,
 * tested, and reached by no product code at all. This is the door.
 *
 * Three things have to be right or the module is decorative, and the schema
 * says so at the top of its own file:
 *
 *   THE AGREEMENT GENERATES ITS OWN VISITS. A plan that includes two tune ups
 *   a year and relies on somebody remembering to book them is a plan that
 *   quietly does not get delivered, and the first anybody hears of it is at
 *   renewal when the customer says they never saw us. So the visits exist as
 *   rows the moment the term starts, and "who is owed a visit" is a query
 *   rather than an investigation.
 *
 *   BILLING AND DELIVERY ARE SEPARATE SCHEDULES. A customer can pay monthly
 *   and be visited twice a year. Tying the two together is the obvious
 *   shortcut and breaks the moment somebody prepays annually.
 *
 *   MONEY BILLED IS NOT MONEY EARNED. Twelve months collected up front is a
 *   liability that unwinds as visits are delivered. Recognising it on receipt
 *   overstates a good month and leaves nothing behind for the eleven months
 *   of obligation that follow.
 */

const usd = (value: string) => m.money(value, "USD");

const FREQUENCY_MONTHS: Record<string, number> = {
  monthly: 1, quarterly: 3, semiannual: 6, annual: 12, one_time: 0,
};

/** A calendar date `months` after an ISO date, clamped to the month's end. */
export function addMonths(date: string, months: number): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  /**
   * Clamped rather than rolled over. An agreement sold on the 31st of January
   * bills on the 28th of February, not the 3rd of March: rolling forward
   * drifts the whole schedule by three days every year and lands a customer's
   * billing date in a different month from the one they agreed to.
   */
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * When the visits a term owes should land.
 *
 * THIS USED TO BE A SECOND IMPLEMENTATION OF `recurrence.agreementVisitDates`.
 *
 * Core had one and this file had another, and they disagreed on every
 * seasonal case: a plan sold on 10 January with spring and autumn anchors
 * produced 10 April here and 15 April there. Neither was wrong in principle,
 * which is what made it dangerous. Core pins to a configurable day of the
 * anchor month; this walked forward from the sale date and kept the sale's
 * day of month. Both are defensible policies and the product held both at
 * once, so which one a company got depended on which function somebody
 * happened to call.
 *
 * There is one implementation now, in core, and this resolves the policy
 * question rather than re-deciding it: `anchorDay` comes from the plan when
 * the operator set one, and falls back to the day the agreement was sold,
 * which is exactly what this function did before. Nobody's existing plans
 * move, and a company that wants the 15th can now say so.
 *
 * The non-seasonal spread was already identical in both and stays in core.
 */
export function visitDueDates(input: {
  startedOn: string;
  termMonths: number;
  count: number;
  anchorMonths?: number[];
  anchorDay?: number | null;
  intervalDays?: number | null;
}): string[] {
  if (input.count < 1) return [];

  const anchors = input.anchorMonths ?? [];
  if (anchors.length > 0) {
    const dates = recurrence.agreementVisitDates({
      startsOn: input.startedOn,
      termMonths: input.termMonths,
      includedVisits: input.count,
      anchorMonths: anchors,
      /**
       * The plan's day when it has one, otherwise the sale's. Core clamps
       * it to the month's length, so a plan sold on the 31st gets 30 April
       * rather than rolling into May.
       */
      anchorDay: input.anchorDay ?? Number(input.startedOn.slice(8, 10)),
    });
    /**
     * Falling through when the term does not contain enough anchor months
     * is behaviour this file had and core does not: core returns what it
     * found. Owing fewer visits than the plan sold is a billing problem, so
     * the shortfall is spread instead.
     */
    if (dates.length === input.count) return dates;
  }

  if (input.intervalDays && input.intervalDays > 0) {
    return Array.from({ length: input.count }, (_, i) =>
      recurrence.addDays(input.startedOn, input.intervalDays! * (i + 1)));
  }

  return recurrence.agreementVisitDates({
    startsOn: input.startedOn,
    termMonths: input.termMonths,
    includedVisits: input.count,
  });
}

/** When each billing instalment falls due, and what each one is. */
export function billingSchedule(input: {
  startedOn: string;
  termMonths: number;
  frequency: string;
  price: m.Money;
}): { dueOn: string; amount: m.Money }[] {
  const every = FREQUENCY_MONTHS[input.frequency] ?? 0;
  if (every === 0) return [{ dueOn: input.startedOn, amount: input.price }];

  const count = Math.max(1, Math.floor(input.termMonths / every));
  /**
   * Allocated rather than divided, so the parts sum exactly to the term
   * price. Dividing and rounding each instalment independently leaves a cent
   * unbilled on most terms, and that cent sits in deferred revenue forever
   * with nothing to release it.
   */
  const amounts = m.allocate(input.price, Array.from({ length: count }, () => "1"), 2);
  return amounts.map((amount, i) => ({ dueOn: addMonths(input.startedOn, every * i), amount }));
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function plans(ctx: ServiceContext, input: { includeInactive?: boolean } = {}) {
  return guardedRead(ctx, "membership:read", async (tx) =>
    tx.select().from(schema.agreementPlan)
      .where(input.includeInactive ? undefined : eq(schema.agreementPlan.active, true))
      .orderBy(schema.agreementPlan.name));
}

export interface PlanInput {
  name: string;
  code?: string | undefined;
  description?: string | undefined;
  price: string;
  billingFrequency: "monthly" | "quarterly" | "semiannual" | "annual" | "one_time";
  termMonths: number;
  includedVisitsPerTerm: number;
  visitAnchorMonths?: number[] | undefined;
  /** Which day of an anchor month the visit falls on. Absent for the day the agreement was sold. */
  visitAnchorDay?: number | null | undefined;
  visitIntervalDays?: number | undefined;
  discountRate?: string | undefined;
  priorityDispatch?: boolean | undefined;
  waivesDiagnosticFee?: boolean | undefined;
  waivesAfterHoursRate?: boolean | undefined;
  benefits?: string[] | undefined;
  autoRenews?: boolean | undefined;
  /** Days before the end of a term that the member is told. Zero for no notice. */
  renewalNoticeDays?: number | undefined;
  /** Price book categories and items the discount leaves out. */
  discountExclusions?: { categoryIds: string[]; itemIds: string[] } | undefined;
  /** The share of each window held for this plan's members, a whole per cent. Null for the company's figure. */
  memberHoldPercent?: number | null | undefined;
}

/**
 * The rules a plan has to satisfy, for a new one and for an edit.
 *
 * One function rather than one copy in each, because an edit that skipped a
 * check a new plan has is how a rate typed as 15 gets onto a plan that was
 * created with 0.15.
 */
/** Some of a plan, for an edit: every field may be absent or explicitly undefined. */
export type PlanPatch = { [K in keyof PlanInput]?: PlanInput[K] | undefined };

function checkPlan(input: PlanPatch): void {
  if (input.name !== undefined && input.name.trim() === "") throw new ConflictError("A plan needs a name.");
  if (input.price !== undefined && !/^\d+(\.\d{1,4})?$/.test(input.price.trim())) {
    throw new ConflictError("A plan's price has to be an amount, like 228.00.");
  }
  if (input.termMonths !== undefined && (!Number.isInteger(input.termMonths) || input.termMonths < 1)) {
    throw new ConflictError("A term is at least one month.");
  }
  if (input.includedVisitsPerTerm !== undefined
      && (!Number.isInteger(input.includedVisitsPerTerm) || input.includedVisitsPerTerm < 0)) {
    throw new ConflictError("A plan cannot include a negative number of visits.");
  }
  if (input.renewalNoticeDays !== undefined
      && (!Number.isInteger(input.renewalNoticeDays) || input.renewalNoticeDays < 0 || input.renewalNoticeDays > 365)) {
    throw new ConflictError("The renewal notice is a number of days between none and a year.");
  }
  if (input.visitAnchorDay !== undefined && input.visitAnchorDay !== null
      && (!Number.isInteger(input.visitAnchorDay) || input.visitAnchorDay < 1 || input.visitAnchorDay > 31)) {
    throw new ConflictError("The visit day is a day of the month, from 1 to 31.");
  }
  if ((input.visitAnchorMonths ?? []).some((month) => !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new ConflictError("Visit months are numbered 1 for January to 12 for December.");
  }
  if (input.memberHoldPercent !== undefined && input.memberHoldPercent !== null
      && (!Number.isInteger(input.memberHoldPercent) || input.memberHoldPercent < 0 || input.memberHoldPercent > 90)) {
    throw new ConflictError("Hold between none and ninety per cent of each window for this plan's members, or leave it blank for the company's figure.");
  }
  if (input.discountRate !== undefined && input.discountRate !== ""
      && Number(input.discountRate) !== 0 && !membership.usableRate(input.discountRate)) {
    /**
     * A fraction, refused above one rather than divided by a hundred, for
     * the same reason the discount limit refuses it: guessing whether 15
     * meant fifteen per cent or fifteen hundred is how a member discount
     * ends up giving the work away.
     */
    throw new ConflictError(
      `A member discount is a fraction rather than a percentage: 0.15 is fifteen per cent, and ${input.discountRate} is not one.`,
    );
  }
}

/**
 * The exclusions as stored, every one checked to be this company's own.
 *
 * Read under row level security, so another company's category is simply not
 * found, and refused in words: a plan that silently ignored an id it could
 * not find would be a plan whose owner believes equipment is left out when
 * nothing is.
 */
async function checkedExclusions(
  tx: Database, value: { categoryIds: string[]; itemIds: string[] },
): Promise<{ categoryIds: string[]; itemIds: string[] }> {
  const exclusions = membership.readExclusions(value);
  if (exclusions.categoryIds.length > 0) {
    const found = await tx.select({ id: schema.priceBookCategory.id }).from(schema.priceBookCategory)
      .where(and(inArray(schema.priceBookCategory.id, [...exclusions.categoryIds]), isNull(schema.priceBookCategory.deletedAt)));
    if (found.length !== exclusions.categoryIds.length) {
      throw new ConflictError("A price book category the discount leaves out is not in your price book. Choose again from the list.");
    }
  }
  if (exclusions.itemIds.length > 0) {
    const found = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
      .where(inArray(schema.priceBookItem.id, [...exclusions.itemIds]));
    if (found.length !== exclusions.itemIds.length) {
      throw new ConflictError("A price book item the discount leaves out is not in your price book. Choose again from the list.");
    }
  }
  return { categoryIds: [...exclusions.categoryIds], itemIds: [...exclusions.itemIds] };
}

const rateOrNull = (rate: string | undefined): string | null =>
  rate === undefined || rate.trim() === "" || Number(rate) === 0 ? null : rate.trim();

export async function createPlan(ctx: ServiceContext, input: PlanInput) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    checkPlan(input);
    const exclusions = await checkedExclusions(tx, input.discountExclusions ?? { categoryIds: [], itemIds: [] });

    /**
     * The plan code is unique per company and is a thing somebody types. A
     * second plan on one code means which price a member is on is decided by
     * whichever row a query read first. `services/duplicates.ts`.
     */
    const [plan] = await refusingDuplicate(
      "agreement_plan_code_idx",
      `"${input.code ?? ""}" is already the code of another plan. One code is one plan, because `
      + `the code is what an invoice line and a renewal both look it up by.`,
      () => tx.insert(schema.agreementPlan).values({
        organizationId: ctx.actor.organizationId,
        name: input.name.trim(),
        code: input.code ?? null,
        description: input.description ?? null,
        price: m.toString(usd(input.price)),
        billingFrequency: input.billingFrequency,
        termMonths: input.termMonths,
        autoRenews: input.autoRenews ?? true,
        ...(input.renewalNoticeDays !== undefined ? { renewalNoticeDays: input.renewalNoticeDays } : {}),
        includedVisitsPerTerm: input.includedVisitsPerTerm,
        visitAnchorMonths: input.visitAnchorMonths ?? [],
        visitAnchorDay: input.visitAnchorDay ?? null,
        visitIntervalDays: input.visitIntervalDays ?? null,
        discountRate: rateOrNull(input.discountRate),
        priorityDispatch: input.priorityDispatch ?? false,
        waivesDiagnosticFee: input.waivesDiagnosticFee ?? false,
        waivesAfterHoursRate: input.waivesAfterHoursRate ?? false,
        benefits: (input.benefits ?? []).map((b) => b.trim()).filter(Boolean),
        discountExclusions: exclusions,
        memberHoldPercent: input.memberHoldPercent ?? null,
      }).returning(),
    );

    await audit(tx, ctx, "agreement_plan.created", "agreement_plan", plan!.id, null, plan);
    return plan!;
  });
}

export async function getPlan(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "membership:read", async (tx) => {
    const [plan] = await tx.select().from(schema.agreementPlan)
      .where(eq(schema.agreementPlan.id, input.id)).limit(1);
    if (!plan) throw new NotFoundError("Plan");
    /**
     * How many members are on it, said beside the form that edits it,
     * because that number is what tells somebody what an edit reaches.
     */
    const [counted] = await tx.select({ members: sql<number>`count(*)::int` })
      .from(schema.agreement)
      .where(and(eq(schema.agreement.planId, input.id), inArray(schema.agreement.status, ["active", "past_due", "paused"])));
    return { ...plan, members: Number(counted?.members ?? 0) };
  });
}

/**
 * EDITING A PLAN, and what an edit reaches.
 *
 * A plan is the thing hundreds of agreements point at, so the question is
 * never "can it change" but "who does the change reach", and the answer is
 * different per field and deliberate:
 *
 *   THE PRICE AND THE DISCOUNT are frozen on each agreement at sale, so an
 *   edit reaches the next sale and nobody already on the plan. What the
 *   discount leaves out is part of the discount and is frozen with it. A price rise
 *   for existing members is a renewal with a new price, which is a
 *   conversation, not a form.
 *
 *   THE TERM, THE VISITS AND THEIR MONTHS shape a term when one is written,
 *   so they reach new sales and each existing member's NEXT term when it
 *   renews. A term already written owes what it owed when it was written.
 *
 *   THE PERKS (priority and the share of each window it holds, the waived
 *   fees, the benefit list) are the
 *   company's standing promise to everybody on the plan and are read from
 *   the plan when they are used, so turning one off takes it from existing
 *   members from that moment. The screen says so beside the boxes.
 *
 *   HOW OFTEN IT BILLS reaches new sales only: each agreement keeps the
 *   frequency it was sold on, renewals included, because a member who
 *   agreed to pay annually does not start getting monthly invoices because
 *   somebody edited a form.
 */
export async function updatePlan(ctx: ServiceContext, input: { id: string; active?: boolean | undefined } & PlanPatch) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const [before] = await tx.select().from(schema.agreementPlan)
      .where(eq(schema.agreementPlan.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Plan");
    checkPlan(input);

    const set: Partial<typeof schema.agreementPlan.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.code !== undefined) set.code = input.code.trim() === "" ? null : input.code.trim();
    if (input.description !== undefined) set.description = input.description.trim() === "" ? null : input.description.trim();
    if (input.price !== undefined) set.price = m.toString(usd(input.price.trim()));
    if (input.billingFrequency !== undefined) set.billingFrequency = input.billingFrequency;
    if (input.termMonths !== undefined) set.termMonths = input.termMonths;
    if (input.includedVisitsPerTerm !== undefined) set.includedVisitsPerTerm = input.includedVisitsPerTerm;
    if (input.visitAnchorMonths !== undefined) set.visitAnchorMonths = input.visitAnchorMonths;
    if (input.visitAnchorDay !== undefined) set.visitAnchorDay = input.visitAnchorDay;
    if (input.visitIntervalDays !== undefined) set.visitIntervalDays = input.visitIntervalDays;
    if (input.discountRate !== undefined) set.discountRate = rateOrNull(input.discountRate);
    if (input.priorityDispatch !== undefined) set.priorityDispatch = input.priorityDispatch;
    if (input.waivesDiagnosticFee !== undefined) set.waivesDiagnosticFee = input.waivesDiagnosticFee;
    if (input.waivesAfterHoursRate !== undefined) set.waivesAfterHoursRate = input.waivesAfterHoursRate;
    if (input.benefits !== undefined) set.benefits = input.benefits.map((b) => b.trim()).filter(Boolean);
    if (input.autoRenews !== undefined) set.autoRenews = input.autoRenews;
    if (input.renewalNoticeDays !== undefined) set.renewalNoticeDays = input.renewalNoticeDays;
    if (input.discountExclusions !== undefined) set.discountExclusions = await checkedExclusions(tx, input.discountExclusions);
    if (input.memberHoldPercent !== undefined) set.memberHoldPercent = input.memberHoldPercent;
    if (input.active !== undefined) set.active = input.active;

    const [after] = await refusingDuplicate(
      "agreement_plan_code_idx",
      `"${input.code ?? ""}" is already the code of another plan. One code is one plan, because `
      + `the code is what an invoice line and a renewal both look it up by.`,
      () => tx.update(schema.agreementPlan).set(set)
        .where(eq(schema.agreementPlan.id, input.id)).returning(),
    );

    await audit(tx, ctx, "agreement_plan.updated", "agreement_plan", input.id, before, after);
    return after!;
  });
}

export async function retirePlan(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const [before] = await tx.select().from(schema.agreementPlan)
      .where(eq(schema.agreementPlan.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Plan");

    /**
     * Retired, not deleted, and existing members keep their price. A plan is
     * the thing hundreds of agreements point at and froze their price from;
     * deleting it would orphan them, and repricing them would be a price rise
     * nobody agreed to.
     */
    const [after] = await tx.update(schema.agreementPlan)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.agreementPlan.id, input.id)).returning();

    await audit(tx, ctx, "agreement_plan.retired", "agreement_plan", input.id, before, after);
    return after!;
  });
}

// ---------------------------------------------------------------------------
// Selling one
// ---------------------------------------------------------------------------

export interface SellInput {
  planId: string;
  customerId: string;
  propertyId?: string;
  equipmentId?: string;
  startedOn?: string;
  /** Overrides the plan price, for a deal somebody actually did. */
  price?: string;
}

/**
 * Sell an agreement, and write down everything it owes in the same
 * transaction.
 *
 * The visits, the billing instalments and the deferred revenue schedule all
 * exist before this returns. Generating any of them later, on a nightly job,
 * means a term that quietly owes nothing if the job never runs, and nothing
 * about that failure is visible until renewal.
 */
export async function sell(ctx: ServiceContext, input: SellInput) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const [plan] = await tx.select().from(schema.agreementPlan)
      .where(eq(schema.agreementPlan.id, input.planId)).limit(1);
    if (!plan) throw new NotFoundError("Plan");
    if (!plan.active) {
      // A retired plan keeps its existing members and takes no new ones.
      throw new ConflictError(`${plan.name} is retired and cannot be sold.`);
    }

    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(eq(schema.customer.id, input.customerId)).limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const timezone = await organizationTimezone(tx, ctx.actor.organizationId);
    const startedOn = input.startedOn ?? time.dateIn(new Date(), timezone);
    const price = usd(input.price ?? plan.price);
    const endsOn = addMonths(startedOn, plan.termMonths);

    const [agreement] = await tx.insert(schema.agreement).values({
      organizationId: ctx.actor.organizationId,
      planId: plan.id,
      customerId: input.customerId,
      propertyId: input.propertyId ?? null,
      equipmentId: input.equipmentId ?? null,
      status: "active",
      startedOn,
      endsOn,
      /** Frozen at sale. Raising the plan price must not reprice a member. */
      price: m.toString(price),
      /** Frozen at sale as well, for the same reason. See the column. */
      discountRate: plan.discountRate,
      /** And what it leaves out, which is part of what the discount is. */
      discountExclusions: membership.readExclusions(plan.discountExclusions) as { categoryIds: string[]; itemIds: string[] },
      billingFrequency: plan.billingFrequency,
      autoRenews: plan.autoRenews,
      visitsIncludedThisTerm: plan.includedVisitsPerTerm,
    }).returning();

    await writeTerm(tx, ctx, {
      agreementId: agreement!.id, plan, startedOn, endsOn, price, term: 1,
      billingFrequency: plan.billingFrequency,
    });

    await emit(tx, ctx, {
      name: "agreement.sold",
      entityType: "agreement",
      entityId: agreement!.id,
      payload: {
        agreement: {
          id: agreement!.id, customerId: input.customerId, planId: plan.id,
          planName: plan.name, price: m.toString(price), startedOn, endsOn,
        },
      },
    });

    await audit(tx, ctx, "agreement.sold", "agreement", agreement!.id, null, agreement);
    return agreement!;
  });
}

/**
 * Everything one term owes, written down: the visits, the deferred revenue
 * behind each, and the billing instalments.
 *
 * Shared by selling and renewing, because a renewal is a new term of the same
 * agreement and has to owe exactly what a sale owes. Two copies of this would
 * be a renewed member whose visits land on different days from a new one's,
 * or whose instalments do not sum to the price, and nothing would compare
 * them.
 *
 * Sequences carry on across terms rather than restarting at one, so "visit
 * 3" names one row for the life of the agreement and the term column says
 * which year it belongs to.
 */
async function writeTerm(
  tx: Database,
  ctx: ServiceContext,
  input: {
    agreementId: string;
    plan: typeof schema.agreementPlan.$inferSelect;
    startedOn: string;
    endsOn: string;
    price: m.Money;
    term: number;
    /**
     * The agreement's own, not the plan's. A plan's frequency can be edited
     * now, and a member sold annual billing keeps annual billing on every
     * renewal; reading the plan here would have changed how they are billed
     * on the night the worker renewed them.
     */
    billingFrequency: string;
  },
): Promise<{ visits: number; instalments: number }> {
  const { plan, startedOn, endsOn, price } = input;

  /** The term itself, with its dates, which is what its breakage is released against when it ends. */
  await tx.insert(schema.agreementTerm).values({
    organizationId: ctx.actor.organizationId,
    agreementId: input.agreementId,
    term: input.term,
    startsOn: startedOn,
    endsOn,
  }).onConflictDoNothing();

  const [counts] = await tx.execute<{ visits: number; billing: number }>(sql`
    select
      (select coalesce(max(sequence), 0) from public.agreement_visit
        where agreement_id = ${input.agreementId})::int as visits,
      (select coalesce(max(sequence), 0) from public.agreement_billing
        where agreement_id = ${input.agreementId})::int as billing`);
  const visitBase = Number(counts?.visits ?? 0);
  const billingBase = Number(counts?.billing ?? 0);

  const dues = visitDueDates({
    startedOn,
    termMonths: plan.termMonths,
    count: plan.includedVisitsPerTerm,
    anchorMonths: plan.visitAnchorMonths ?? [],
    anchorDay: plan.visitAnchorDay,
    intervalDays: plan.visitIntervalDays,
  });

  /**
   * What each visit is worth, allocated at cent precision so the slices sum
   * exactly to the term price. The alternative, dividing and rounding each
   * one, leaves a cent in deferred revenue that nothing will ever release.
   */
  const slices = ledger.recognitionSchedule(price, dues.length);

  for (const [index, dueOn] of dues.entries()) {
    const [visit] = await tx.insert(schema.agreementVisit).values({
      organizationId: ctx.actor.organizationId,
      agreementId: input.agreementId,
      sequence: visitBase + index + 1,
      term: input.term,
      dueOn,
      recognitionAmount: m.toString(slices[index]!),
    }).returning();

    await tx.insert(schema.deferredRevenueEntry).values({
      organizationId: ctx.actor.organizationId,
      agreementId: input.agreementId,
      agreementVisitId: visit!.id,
      amount: m.toString(slices[index]!),
      scheduledFor: dueOn,
    });
  }

  /**
   * A plan with no included visits still defers its price over the term.
   * Otherwise a discount-only membership would recognise a year of revenue
   * on the day it was sold, which is the exact error this module exists to
   * avoid.
   */
  if (dues.length === 0) {
    await tx.insert(schema.deferredRevenueEntry).values({
      organizationId: ctx.actor.organizationId,
      agreementId: input.agreementId,
      amount: m.toString(price),
      scheduledFor: endsOn,
    });
  }

  const instalments = billingSchedule({
    startedOn, termMonths: plan.termMonths,
    frequency: input.billingFrequency, price,
  });
  for (const [index, instalment] of instalments.entries()) {
    await tx.insert(schema.agreementBilling).values({
      organizationId: ctx.actor.organizationId,
      agreementId: input.agreementId,
      sequence: billingBase + index + 1,
      term: input.term,
      dueOn: instalment.dueOn,
      amount: m.toString(instalment.amount),
    });
  }

  return { visits: dues.length, instalments: instalments.length };
}

async function organizationTimezone(tx: Database, organizationId: string): Promise<string> {
  const [row] = await tx.execute<{ timezone: string | null }>(
    sql`select timezone from public.organization where id = ${organizationId} limit 1`,
  );
  return row?.timezone ?? "America/Chicago";
}

// ---------------------------------------------------------------------------
// Reading the book
// ---------------------------------------------------------------------------

export async function list(ctx: ServiceContext, input: { status?: string | undefined; customerId?: string | undefined } = {}) {
  return guardedRead(ctx, "membership:read", async (tx) =>
    tx.select({
      agreement: schema.agreement,
      planName: schema.agreementPlan.name,
      customerName: schema.customer.name,
    })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.agreement.customerId))
      .where(and(
        input.status ? eq(schema.agreement.status, input.status as "active") : undefined,
        input.customerId ? eq(schema.agreement.customerId, input.customerId) : undefined,
      ))
      .orderBy(desc(schema.agreement.startedOn)));
}

export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "membership:read", async (tx) => {
    const [row] = await tx.select({
      agreement: schema.agreement,
      plan: schema.agreementPlan,
      customerName: schema.customer.name,
    })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.agreement.customerId))
      .where(eq(schema.agreement.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Agreement");

    const [visits, billing, deferred, terms] = await Promise.all([
      tx.select().from(schema.agreementVisit)
        .where(eq(schema.agreementVisit.agreementId, input.id))
        .orderBy(asc(schema.agreementVisit.sequence)),
      tx.select().from(schema.agreementBilling)
        .where(eq(schema.agreementBilling.agreementId, input.id))
        .orderBy(asc(schema.agreementBilling.sequence)),
      tx.select().from(schema.deferredRevenueEntry)
        .where(eq(schema.deferredRevenueEntry.agreementId, input.id)),
      tx.select().from(schema.agreementTerm)
        .where(eq(schema.agreementTerm.agreementId, input.id))
        .orderBy(asc(schema.agreementTerm.term)),
    ]);

    /**
     * The balance sheet number for this one agreement: what has been billed
     * and not yet earned. Summed from the rows rather than recomputed from
     * the price, because the rows survive a plan price change, a partial
     * refund and a cancellation, and a formula does not.
     */
    const unearned = deferred
      .filter((d: typeof schema.deferredRevenueEntry.$inferSelect) => !d.recognizedOn && !d.releasedOn)
      .reduce((total: m.Money, d: typeof schema.deferredRevenueEntry.$inferSelect) =>
        m.add(total, usd(d.amount)), m.zero("USD"));

    /** What the discount leaves out, by name, for the screen that explains the discount. */
    const leavesOut = await exclusionNamesWithin(tx, membership.readExclusions(row.agreement.discountExclusions));
    return { ...row, visits, billing, terms, leavesOut, unearned: m.toString(unearned) };
  });
}

/**
 * THE REPORT THAT KEEPS AN AGREEMENT BOOK ALIVE.
 *
 * Visits the company owes and has not booked. An agreement whose visits
 * quietly do not get delivered is an agreement that does not renew, and the
 * first anybody hears of it is the customer saying they never saw us.
 */
export async function owed(ctx: ServiceContext, input: { through?: string } = {}) {
  return guardedRead(ctx, "membership:read", async (tx) => {
    const through = input.through
      ?? addMonths(time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId)), 1);

    return tx.select({
      visit: schema.agreementVisit,
      agreementId: schema.agreement.id,
      customerId: schema.agreement.customerId,
      customerName: schema.customer.name,
      propertyId: schema.agreement.propertyId,
      planName: schema.agreementPlan.name,
    })
      .from(schema.agreementVisit)
      .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.agreement.customerId))
      .where(and(
        isNull(schema.agreementVisit.jobId),
        isNull(schema.agreementVisit.skippedOn),
        /**
         * And not already delivered. A visit can be recorded as delivered
         * without ever having been booked, which is what happens when the
         * technician was there anyway and somebody ticks it off afterwards.
         * Without this it sits on the owed list forever, and a list with
         * permanent residents is a list people stop reading.
         */
        isNull(schema.agreementVisit.deliveredOn),
        lte(schema.agreementVisit.dueOn, through),
        // A cancelled agreement owes nothing, and a paused one owes it later.
        eq(schema.agreement.status, "active"),
      ))
      .orderBy(asc(schema.agreementVisit.dueOn));
  });
}

// ---------------------------------------------------------------------------
// Delivering it
// ---------------------------------------------------------------------------

/**
 * Turn an owed visit into a job.
 *
 * The job is the thing that gets dispatched, done and reported on, and the
 * agreement visit is the obligation it satisfies. Keeping them as two rows
 * with a link is what lets a visit be rebooked without losing the obligation,
 * and lets the obligation be skipped without deleting a job somebody did.
 */
export async function book(ctx: ServiceContext, input: { agreementVisitId: string; propertyId?: string }) {
  return guardedWrite(ctx, "membership:write", (tx) => bookWithin(tx, ctx, input));
}

async function bookWithin(tx: Database, ctx: ServiceContext, input: { agreementVisitId: string; propertyId?: string }) {
  const [row] = await tx.select({
    visit: schema.agreementVisit,
    agreement: schema.agreement,
    planName: schema.agreementPlan.name,
  })
    .from(schema.agreementVisit)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(eq(schema.agreementVisit.id, input.agreementVisitId)).limit(1);
  if (!row) throw new NotFoundError("Agreement visit");

  const propertyId = input.propertyId ?? row.agreement.propertyId;
  if (!propertyId) {
    throw new ConflictError("This agreement has no property, so the visit needs one.");
  }

  const number = await nextNumber(tx, ctx.actor.organizationId, "job");
  const [job] = await tx.insert(schema.job).values({
    organizationId: ctx.actor.organizationId,
    number,
    customerId: row.agreement.customerId,
    propertyId,
    status: "scheduled",
    summary: `${row.planName}: included visit ${row.visit.sequence}`,
    /**
     * Zero, and deliberately. The customer has already been billed for
     * this under the agreement; putting the plan price on the job would
     * bill them twice and overstate the month.
     */
    total: "0.0000",
  }).returning();

  /**
   * THE CLAIM IS THE ONLY DECISION.
   *
   * An earlier version read the row, checked whether it was already booked
   * or skipped, and then repeated both conditions in the update. Two copies
   * of one decision, and the read was the one the tests exercised: taking
   * the condition off the update changed nothing any test could see.
   *
   * Now the update decides, so two people working the owed list at the same
   * moment cannot both create a job for the same obligation. Throwing rolls
   * back the job this transaction just inserted, so the loser leaves
   * nothing behind.
   */
  const claimed = await tx.update(schema.agreementVisit)
    .set({ jobId: job!.id, updatedAt: new Date() })
    .where(and(
      eq(schema.agreementVisit.id, input.agreementVisitId),
      isNull(schema.agreementVisit.jobId),
      isNull(schema.agreementVisit.skippedOn),
    ))
    .returning({ id: schema.agreementVisit.id });

  if (claimed.length === 0) {
    // One read, only to say which of the two it was. Nothing branches on it.
    throw new ConflictError(
      row.visit.skippedOn ? "That visit was skipped." : "That visit is already booked.",
    );
  }

  /**
   * WHO IS PAYING FOR THIS, WRITTEN DOWN AT THE MOMENT IT IS BOOKED.
   *
   * Without it, a zero dollar job under a plan and a zero dollar job that
   * is our own rework are the same row on every revenue report, and they
   * mean opposite things about the business. Recorded rather than derived,
   * because a plan cancelled in June did not uncover a visit delivered in
   * March.
   */
  await resolveIn(tx, ctx.actor.organizationId, {
    jobId: job!.id,
    source: "agreement",
    grantingEntityType: "agreement",
    grantingEntityId: row.agreement.id,
    resolvedByUserId: ctx.actor.userId,
  });

  await audit(tx, ctx, "agreement_visit.booked", "agreement_visit", input.agreementVisitId,
    row.visit, { ...row.visit, jobId: job!.id });
  return { job: job!, agreementVisitId: input.agreementVisitId };
}

/**
 * Mark an included visit delivered, and earn its slice of the term price.
 *
 * This is where money billed becomes money earned. The liability comes down
 * and revenue goes up by exactly the slice this visit was allocated at sale,
 * which is why the slices were allocated once rather than recomputed: a
 * recomputation after a price change would recognise an amount that was never
 * deferred.
 */
export async function deliver(ctx: ServiceContext, input: { agreementVisitId: string; on?: string }) {
  return guardedWrite(ctx, "membership:write", (tx) => deliverWithin(tx, ctx, input));
}

async function deliverWithin(tx: Database, ctx: ServiceContext, input: { agreementVisitId: string; on?: string }) {
  const [row] = await tx.select({
    visit: schema.agreementVisit,
    agreement: schema.agreement,
  })
    .from(schema.agreementVisit)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
    .where(eq(schema.agreementVisit.id, input.agreementVisitId)).limit(1);
  if (!row) throw new NotFoundError("Agreement visit");
  if (row.visit.deliveredOn) {
    // Delivering twice would recognise the same slice twice, which is
    // revenue out of thin air.
    throw new ConflictError("That visit is already delivered.");
  }

  const on = input.on ?? time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId));

  const delivered = await tx.update(schema.agreementVisit)
    .set({ deliveredOn: on, recognizedOn: on, updatedAt: new Date() })
    .where(and(
      eq(schema.agreementVisit.id, input.agreementVisitId),
      isNull(schema.agreementVisit.deliveredOn),
    ))
    .returning({ id: schema.agreementVisit.id });
  if (delivered.length === 0) throw new ConflictError("That visit is already delivered.");

  await tx.update(schema.agreement).set({
    visitsDeliveredThisTerm: sql`${schema.agreement.visitsDeliveredThisTerm} + 1`,
    updatedAt: new Date(),
  }).where(eq(schema.agreement.id, row.agreement.id));

  /**
   * ONLY A SLICE STILL DEFERRED. A visit delivered after its term ended was
   * released to revenue with that term's breakage, so it is already earned:
   * delivering it now is the company keeping its word, and recognising it a
   * second time would be revenue out of thin air.
   */
  const open = await tx.update(schema.deferredRevenueEntry)
    .set({ recognizedOn: on, updatedAt: new Date() })
    .where(and(
      eq(schema.deferredRevenueEntry.agreementVisitId, input.agreementVisitId),
      isNull(schema.deferredRevenueEntry.recognizedOn),
      isNull(schema.deferredRevenueEntry.releasedOn),
    ))
    .returning({ amount: schema.deferredRevenueEntry.amount });
  const amount = open.length > 0 ? usd(row.visit.recognitionAmount ?? "0") : m.zero("USD");
  if (m.isPositive(amount)) {
    await writePosting(tx, ctx, ledger.postAgreementRecognition({
      agreementVisitId: input.agreementVisitId,
      occurredAt: new Date(),
      amount,
      customerId: row.agreement.customerId,
      ...(row.visit.jobId ? { jobId: row.visit.jobId } : {}),
    }));
  }

  await emit(tx, ctx, {
    name: "agreement.visit_delivered",
    entityType: "agreement",
    entityId: row.agreement.id,
    payload: {
      agreementId: row.agreement.id,
      agreementVisitId: input.agreementVisitId,
      customerId: row.agreement.customerId,
      recognized: m.toString(amount),
    },
  });

  await audit(tx, ctx, "agreement_visit.delivered", "agreement_visit",
    input.agreementVisitId, row.visit, { ...row.visit, deliveredOn: on });
  return { recognized: m.toString(amount) };
}

/**
 * SKIPPING A VISIT THE MEMBER DOES NOT WANT
 *
 * `skipped_on` and `skip_reason` have been on this table since the first
 * migrations, and the owed report and the booking guard both read them.
 * Nothing wrote either. So a member who rang up and said "not this spring,
 * we are away" had no path: the visit stayed owed, sat at the top of the
 * report forever, and somebody eventually booked it against their wishes or
 * the report stopped being read. Both of those happened for the same reason.
 *
 * A SKIP DOES NOT RECOGNISE THE REVENUE, and this is the decision the whole
 * function turns on.
 *
 * The temptation is obvious: the member declined, we were available, the
 * money is ours. It is also wrong twice over. The member did not buy four
 * visits, they bought a year of cover that includes four; an unused visit is
 * breakage, and breakage is earned at the end of the term, not on the day
 * somebody declined. And a skip is reversible, which recognised revenue is
 * not: recognising here would mean a phone call five minutes later
 * ("actually, can we do June?") needs a reversing entry against a closed
 * period.
 *
 * So the deferred slice stays exactly where it is, unrecognised and
 * unreleased, and the return value says so out loud. "Skipped" in a list
 * reads as finished with, and in the ledger this visit is not finished with
 * at all.
 *
 * A BOOKED VISIT IS NOT SKIPPABLE. It has a job on it, and a job is a
 * technician in a van on a morning. Skipping without touching the schedule
 * sends somebody to a house nobody is expecting them at, and the person
 * clicking skip in the office cannot see that. Unbook it first, which is a
 * decision about the schedule made where the schedule is.
 */
export async function skip(
  ctx: ServiceContext,
  input: { agreementVisitId: string; reason: string; on?: string },
) {
  return guardedWrite(ctx, "membership:write", (tx) => skipWithin(tx, ctx, input));
}

async function skipWithin(
  tx: Database, ctx: ServiceContext,
  input: { agreementVisitId: string; reason: string; on?: string },
) {
  const reason = input.reason.trim();
  if (reason === "") {
    /**
     * A skip with no reason is indistinguishable from a mistake, and this
     * is the field somebody reads a year later when the member says they
     * never agreed to it.
     */
    throw new ConflictError(
      "A skipped visit needs a reason. It is the only record of why the member did not get what they paid for.",
    );
  }

  const [row] = await tx.select({
    visit: schema.agreementVisit,
    agreement: schema.agreement,
  })
    .from(schema.agreementVisit)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
    .where(eq(schema.agreementVisit.id, input.agreementVisitId)).limit(1);
  if (!row) throw new NotFoundError("Agreement visit");

  if (row.visit.deliveredOn) {
    throw new ConflictError(
      "That visit was delivered. Work that happened cannot be skipped: it can be credited, which is a decision about money.",
    );
  }
  if (row.visit.skippedOn) throw new ConflictError("That visit is already skipped.");
  if (row.visit.jobId) {
    throw new ConflictError(
      "That visit is booked. Cancel or unbook the job first, so whoever is scheduled for it finds out.",
    );
  }

  const on = input.on ?? time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId));

  const [after] = await tx.update(schema.agreementVisit)
    .set({ skippedOn: on, skipReason: reason, updatedAt: new Date() })
    .where(and(
      eq(schema.agreementVisit.id, input.agreementVisitId),
      isNull(schema.agreementVisit.skippedOn),
      isNull(schema.agreementVisit.deliveredOn),
    ))
    .returning();
  if (!after) throw new ConflictError("That visit is already skipped.");

  await emit(tx, ctx, {
    name: "agreement.visit_skipped",
    entityType: "agreement",
    entityId: row.agreement.id,
    payload: {
      agreementId: row.agreement.id,
      agreementVisitId: input.agreementVisitId,
      customerId: row.agreement.customerId,
      reason,
      /**
       * Carried on the event so a workflow can act on the amount still
       * sitting deferred, rather than assuming a skip settled it.
       */
      stillDeferred: row.visit.recognitionAmount ?? "0",
    },
  });

  await audit(tx, ctx, "agreement_visit.skipped", "agreement_visit",
    input.agreementVisitId, row.visit, after);

  return {
    id: after.id,
    skippedOn: after.skippedOn,
    skipReason: after.skipReason,
    /** Unrecognised and unreleased. Skipped is not the same as settled. */
    stillDeferred: row.visit.recognitionAmount ?? "0",
  };
}

/**
 * Put a skipped visit back on the owed list.
 *
 * Here because `book` already refuses a skipped visit with "that visit was
 * skipped", which is only a sensible thing to say if there is a way back.
 * Without one that message is a dead end dressed as an explanation, and the
 * member who rings to reinstate the visit they cancelled gets told no by a
 * product rather than by a person.
 *
 * Nothing to undo in the ledger, which is the point of not having recognised
 * anything on the way in.
 */
export async function unskip(ctx: ServiceContext, input: { agreementVisitId: string }) {
  return guardedWrite(ctx, "membership:write", (tx) => unskipWithin(tx, ctx, input));
}

async function unskipWithin(tx: Database, ctx: ServiceContext, input: { agreementVisitId: string }) {
  const [row] = await tx.select({
    visit: schema.agreementVisit,
    agreement: schema.agreement,
  })
    .from(schema.agreementVisit)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
    .where(eq(schema.agreementVisit.id, input.agreementVisitId)).limit(1);
  if (!row) throw new NotFoundError("Agreement visit");
  if (!row.visit.skippedOn) throw new ConflictError("That visit is not skipped.");

  const [after] = await tx.update(schema.agreementVisit)
    .set({ skippedOn: null, skipReason: null, updatedAt: new Date() })
    .where(eq(schema.agreementVisit.id, input.agreementVisitId))
    .returning();

  await emit(tx, ctx, {
    name: "agreement.visit_unskipped",
    entityType: "agreement",
    entityId: row.agreement.id,
    payload: {
      agreementId: row.agreement.id,
      agreementVisitId: input.agreementVisitId,
      customerId: row.agreement.customerId,
      /** What it said before, because that is the part somebody disputes. */
      wasSkippedFor: row.visit.skipReason,
    },
  });

  await audit(tx, ctx, "agreement_visit.unskipped", "agreement_visit",
    input.agreementVisitId, row.visit, after!);

  return { id: after!.id, dueOn: after!.dueOn };
}

/**
 * Bill one instalment, as an invoice that is a LIABILITY rather than revenue.
 *
 * `postAgreementBilling` is what makes that true: the receivable moves
 * normally and what would have been revenue sits in deferred revenue until a
 * visit is delivered. A plain invoice here would recognise a year of revenue
 * on the day the customer paid.
 */
export async function bill(ctx: ServiceContext, input: { agreementBillingId: string }) {
  return guardedWrite(ctx, "invoice:write", (tx) => billWithin(tx, ctx, input));
}

async function billWithin(tx: Database, ctx: ServiceContext, input: { agreementBillingId: string }) {
  const [row] = await tx.select({
    billing: schema.agreementBilling,
    agreement: schema.agreement,
    planName: schema.agreementPlan.name,
  })
    .from(schema.agreementBilling)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementBilling.agreementId))
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(eq(schema.agreementBilling.id, input.agreementBillingId)).limit(1);
  if (!row) throw new NotFoundError("Instalment");
  if (row.billing.invoiceId) throw new ConflictError("That instalment is already invoiced.");

  const amount = usd(row.billing.amount);
  const number = await nextNumber(tx, ctx.actor.organizationId, "invoice");

  const [invoice] = await tx.insert(schema.invoice).values({
    organizationId: ctx.actor.organizationId,
    number,
    customerId: row.agreement.customerId,
    status: "open",
    issuedOn: row.billing.dueOn,
    dueOn: row.billing.dueOn,
    subtotal: m.toString(amount),
    discountTotal: "0.0000",
    taxTotal: "0.0000",
    total: m.toString(amount),
    balance: m.toString(amount),
    memo: `${row.planName}, instalment ${row.billing.sequence}`,
  }).returning();

  await tx.insert(schema.invoiceLine).values({
    organizationId: ctx.actor.organizationId,
    invoiceId: invoice!.id,
    origin: "manual",
    sortOrder: 0,
    name: row.planName,
    description: `Instalment ${row.billing.sequence}`,
    quantity: "1",
    unitPrice: m.toString(amount),
    discountAmount: "0.0000",
    taxable: false,
    taxAmount: "0.0000",
    lineTotal: m.toString(amount),
  });

  const claimed = await tx.update(schema.agreementBilling).set({
    invoiceId: invoice!.id, status: "invoiced", updatedAt: new Date(),
  }).where(and(
    eq(schema.agreementBilling.id, input.agreementBillingId),
    isNull(schema.agreementBilling.invoiceId),
  )).returning({ id: schema.agreementBilling.id });
  if (claimed.length === 0) throw new ConflictError("That instalment is already invoiced.");

  await writePosting(tx, ctx, ledger.postAgreementBilling({
    invoiceId: invoice!.id,
    occurredAt: new Date(),
    amount,
    customerId: row.agreement.customerId,
  }));

  await audit(tx, ctx, "agreement.billed", "invoice", invoice!.id, null, invoice);
  return invoice!;
}

/**
 * Cancel an agreement and release whatever has not been earned.
 *
 * `toRevenue` is the honest fork and it is a policy decision rather than a
 * technical one. A term the customer paid for and walked away from is earned;
 * one the company is refunding is credited back. Leaving the balance sitting
 * in deferred revenue forever, which is what doing nothing amounts to, is
 * the one answer that is wrong either way.
 */
export interface CancelInput {
  id: string;
  /**
   * Why, from the fixed list (`membership.CANCELLATION_CODES`). The screen and
   * the API ask for it; a caller inside the product that has only words is
   * recorded with no code, which the retention figures count as unknown.
   */
  reasonCode?: membership.CancellationCode | undefined;
  /** Words: required for "something else", and for a cancellation with no code. */
  reason?: string | undefined;
  keepThePrepayment?: boolean | undefined;
  /**
   * For a move or a sale: end the customer's link to the address the
   * agreement covers, today. It is the fact that tells a house sale from
   * churn in every retention figure, including for a plan that later
   * lapses rather than being cancelled.
   */
  endPropertyLink?: boolean | undefined;
}

export async function cancel(ctx: ServiceContext, input: CancelInput) {
  return guardedWrite(ctx, "membership:write", (tx) => cancelWithin(tx, ctx, input));
}

async function cancelWithin(tx: Database, ctx: ServiceContext, input: CancelInput) {
  const [before] = await tx.select().from(schema.agreement)
    .where(eq(schema.agreement.id, input.id)).limit(1);
  if (!before) throw new NotFoundError("Agreement");
  if (before.status === "cancelled") throw new ConflictError("That agreement is already cancelled.");
  /**
   * A cancellation with no reason is indistinguishable from a mistake, and
   * the reason is the whole of a win-back campaign. Coded, so the retention
   * figures can tell a house sale from a lost customer.
   */
  const problem = membership.cancellationProblem(input.reasonCode, input.reason);
  if (problem) throw new ConflictError(problem);
  const code = input.reasonCode ?? null;
  const words = (input.reason ?? "").trim();
  /** The words, or the reason's own name: what the agreement, the release and the event say. */
  const said = words !== "" ? words : membership.CANCELLATION_LABEL[code!];
  if (input.endPropertyLink && !membership.leftTheHome(code)) {
    throw new ConflictError("Only a move or a sale ends their link to the address. Choose one of those, or leave the link as it is.");
  }
  if (input.endPropertyLink && !before.propertyId) {
    throw new ConflictError(
      "This agreement covers them at any address, so there is no one address to end their link to. End it on the address itself.",
    );
  }

  const timezone = await organizationTimezone(tx, ctx.actor.organizationId);
  const on = time.dateIn(new Date(), timezone);

  const [after] = await tx.update(schema.agreement).set({
    status: "cancelled", cancelledOn: on,
    cancellationReason: said, cancellationCode: code, autoRenews: false,
    updatedAt: new Date(),
  }).where(eq(schema.agreement.id, input.id)).returning();

  /**
   * Their link to the address ends today, when they said they moved or sold
   * and the office ticked it. Only a link still open: one ended earlier keeps
   * the day it ended.
   */
  let endedLinks = 0;
  if (input.endPropertyLink && before.propertyId) {
    const ended = await tx.update(schema.customerProperty)
      .set({ endedOn: on, updatedAt: new Date() })
      .where(and(
        eq(schema.customerProperty.customerId, before.customerId),
        eq(schema.customerProperty.propertyId, before.propertyId),
        isNull(schema.customerProperty.endedOn),
      )).returning({ id: schema.customerProperty.id });
    endedLinks = ended.length;
    if (endedLinks > 0) {
      await audit(tx, ctx, "customer_property.ended", "property", before.propertyId, null, {
        customerId: before.customerId, endedOn: on, because: `agreement cancelled: ${said}`,
      });
    }
  }

  /**
   * Instalments not yet invoiced are cancelled. An invoiced one stands:
   * the customer owes it, and voiding an issued invoice is a different
   * decision made on the invoice.
   */
  await tx.update(schema.agreementBilling)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(schema.agreementBilling.agreementId, input.id),
      eq(schema.agreementBilling.status, "scheduled"),
    ));

  const open = await tx.select().from(schema.deferredRevenueEntry)
    .where(and(
      eq(schema.deferredRevenueEntry.agreementId, input.id),
      isNull(schema.deferredRevenueEntry.recognizedOn),
      isNull(schema.deferredRevenueEntry.releasedOn),
    ));

  const balance = open.reduce(
    (total: m.Money, e: typeof schema.deferredRevenueEntry.$inferSelect) => m.add(total, usd(e.amount)),
    m.zero("USD"),
  );

  if (m.isPositive(balance)) {
    await tx.update(schema.deferredRevenueEntry).set({
      releasedOn: on, releaseReason: said, updatedAt: new Date(),
    }).where(and(
      eq(schema.deferredRevenueEntry.agreementId, input.id),
      isNull(schema.deferredRevenueEntry.recognizedOn),
      isNull(schema.deferredRevenueEntry.releasedOn),
    ));

    await writePosting(tx, ctx, ledger.postDeferredRelease({
      agreementId: input.id,
      occurredAt: new Date(),
      amount: balance,
      toRevenue: input.keepThePrepayment ?? false,
      customerId: before.customerId,
    }));
  }

  await emit(tx, ctx, {
    name: "agreement.cancelled",
    entityType: "agreement",
    entityId: input.id,
    payload: {
      agreementId: input.id, customerId: before.customerId,
      reason: said, reasonCode: code, released: m.toString(balance),
    },
  });

  await audit(tx, ctx, "agreement.cancelled", "agreement", input.id, before, after);
  return { ...after!, released: m.toString(balance), endedLinks };
}

/**
 * The unearned balance across the whole book.
 *
 * The number that belongs on a balance sheet, and the one a company
 * recognising agreement revenue on receipt does not have.
 */
export async function unearned(ctx: ServiceContext) {
  return guardedRead(ctx, "membership:read", async (tx) => {
    const rows = await tx.select({ amount: schema.deferredRevenueEntry.amount })
      .from(schema.deferredRevenueEntry)
      .where(and(
        isNull(schema.deferredRevenueEntry.recognizedOn),
        isNull(schema.deferredRevenueEntry.releasedOn),
      ));
    return m.toString(rows.reduce(
      (total: m.Money, r: { amount: string }) => m.add(total, usd(r.amount)), m.zero("USD"),
    ));
  });
}


// ---------------------------------------------------------------------------
// Breakage: what a term owed and the member never took
// ---------------------------------------------------------------------------

/**
 * The current term's row, for an agreement sold before terms were recorded.
 *
 * Its end is the agreement's own end date, which is exact; its start is
 * known only for a first term. Earlier terms of such an agreement get no row
 * and so are never released by the pass: their end dates were never written
 * down, and a release on a guessed date is the one thing this must not do.
 */
async function ensureCurrentTerm(tx: Database, ctx: ServiceContext, agreement: typeof schema.agreement.$inferSelect) {
  if (!agreement.endsOn || agreement.status === "pending") return;
  const term = agreement.renewalCount + 1;
  await tx.insert(schema.agreementTerm).values({
    organizationId: ctx.actor.organizationId,
    agreementId: agreement.id,
    term,
    startsOn: term === 1 ? agreement.startedOn : null,
    endsOn: agreement.endsOn,
  }).onConflictDoNothing();
}

/**
 * RELEASE WHAT AN ENDED TERM STILL HOLDS DEFERRED, ONCE.
 *
 * ON THE DAY THE TERM ENDS, NEVER EARLIER. That is the accounting treatment,
 * and a deliberate one: a visit skipped in March can be put back in June, so
 * releasing its slice in March would be revenue that has to be reversed
 * against a closed month. By the end of the term the member has had the year
 * of cover they paid for and the company has stood ready all of it, so what
 * the visits never taken were worth is earned then. Not pro rata, not on a
 * guess about who will not call.
 *
 * WHAT IS RELEASED is every slice of this term still deferred: a visit owed
 * and never booked, one booked and not delivered, one skipped, and for a plan
 * with no visits the whole of the term's price. A slice already recognised or
 * already released (a cancellation) is left alone.
 *
 * CLAIMED FIRST, per term, by a conditional update, so two passes or a pass
 * and a renewal reaching the same term release it once; the ledger posting is
 * sourced to the term, and the term's row says what was released and when,
 * which is what the agreement's screen shows. A term with nothing left is
 * marked released at nothing, so the pass does not read it again.
 *
 * THE VISIT STAYS OWED. Releasing the revenue is a statement about the books,
 * not about the member: the visit is still on the agreement, and delivering
 * it later recognises nothing more, because it is already earned.
 */
export async function releaseEndedTerms(
  tx: Database, ctx: ServiceContext, input: { today: string; agreementId?: string | undefined },
): Promise<{ termId: string; agreementId: string; term: number; amount: string; visits: number }[]> {
  const ended = await tx.select({ term: schema.agreementTerm, customerId: schema.agreement.customerId })
    .from(schema.agreementTerm)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementTerm.agreementId))
    .where(and(
      isNull(schema.agreementTerm.breakageReleasedOn),
      lte(schema.agreementTerm.endsOn, input.today),
      input.agreementId ? eq(schema.agreementTerm.agreementId, input.agreementId) : undefined,
    ))
    .orderBy(asc(schema.agreementTerm.endsOn), asc(schema.agreementTerm.term));

  const released: { termId: string; agreementId: string; term: number; amount: string; visits: number }[] = [];
  for (const { term, customerId } of ended) {
    const claimed = await tx.update(schema.agreementTerm)
      .set({ breakageReleasedOn: input.today, updatedAt: new Date() })
      .where(and(eq(schema.agreementTerm.id, term.id), isNull(schema.agreementTerm.breakageReleasedOn)))
      .returning({ id: schema.agreementTerm.id });
    if (claimed.length === 0) continue;

    /** This term's slices still deferred: its visits', and a plan with no visits' single entry dated its end. */
    const open = await tx.select({
      id: schema.deferredRevenueEntry.id,
      amount: schema.deferredRevenueEntry.amount,
      visitId: schema.deferredRevenueEntry.agreementVisitId,
    }).from(schema.deferredRevenueEntry)
      .leftJoin(schema.agreementVisit, eq(schema.agreementVisit.id, schema.deferredRevenueEntry.agreementVisitId))
      .where(and(
        eq(schema.deferredRevenueEntry.agreementId, term.agreementId),
        isNull(schema.deferredRevenueEntry.recognizedOn),
        isNull(schema.deferredRevenueEntry.releasedOn),
        sql`(${schema.agreementVisit.term} = ${term.term}
          or (${schema.deferredRevenueEntry.agreementVisitId} is null and ${schema.deferredRevenueEntry.scheduledFor} = ${term.endsOn}))`,
      ));
    const amount = open.reduce((total: m.Money, e) => m.add(total, usd(e.amount)), m.zero("USD"));
    const visits = open.filter((e) => e.visitId !== null).length;

    if (open.length > 0) {
      await tx.update(schema.deferredRevenueEntry).set({
        releasedOn: input.today,
        releaseReason: `Term ${term.term} ended on ${term.endsOn} with this not taken.`,
        updatedAt: new Date(),
      }).where(inArray(schema.deferredRevenueEntry.id, open.map((e) => e.id)));
    }
    if (m.isPositive(amount)) {
      await writePosting(tx, ctx, ledger.postAgreementBreakage({
        agreementTermId: term.id, occurredAt: new Date(), amount, customerId,
      }));
    }
    const after = { breakageAmount: m.toString(amount), breakageVisits: visits };
    await tx.update(schema.agreementTerm).set({ ...after, updatedAt: new Date() })
      .where(eq(schema.agreementTerm.id, term.id));
    await audit(tx, ctx, "agreement.breakage_released", "agreement", term.agreementId, null, {
      term: term.term, endsOn: term.endsOn, releasedOn: input.today, ...after,
    });
    released.push({ termId: term.id, agreementId: term.agreementId, term: term.term, amount: m.toString(amount), visits });
  }
  return released;
}

// ---------------------------------------------------------------------------
// Renewing it
// ---------------------------------------------------------------------------

/**
 * A replayed request is the call that already happened, read back.
 *
 * Renewing and selling both write a term of obligations, so a retry from a
 * phone on one bar that ran them twice would owe the customer a second year
 * of visits and bill them for it. Same table and shape every other service
 * uses for this.
 */
async function replayed(tx: Database, ctx: ServiceContext, entityType: string): Promise<string | null> {
  if (!ctx.idempotencyKey) return null;
  const [row] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return row?.entityId ?? null;
}

async function remember(tx: Database, ctx: ServiceContext, entityType: string, entityId: string) {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    idempotencyKey: ctx.idempotencyKey,
    entityType,
    entityId,
    direction: "inbound",
    provider: "api",
    eventType: `${entityType}.created`,
    status: "succeeded",
  });
}

/** The statuses a person may renew from. A lapsed member renewing is the win back. */
const RENEWABLE = ["active", "lapsed"] as const;

/**
 * Add a term to an agreement, inside a transaction the caller holds.
 *
 * THE NEW TERM STARTS THE DAY THE OLD ONE ENDS, whenever it is renewed. A
 * member renewed a fortnight early keeps the fortnight they paid for, and one
 * renewed a fortnight late does not get a fortnight free: the anniversary is
 * the agreement's, not the day somebody got round to it.
 *
 * THE PRICE IS THE AGREEMENT'S unless a new one is given. Frozen at sale is
 * the rule this module is built on, and a renewal that quietly picked up the
 * plan's new price would be a price rise nobody agreed to, applied to four
 * hundred members on the same night by a worker. A person renewing by hand can
 * type a new price, which is the conversation with the customer having
 * happened.
 *
 * THE CLAIM IS THE UPDATE, on the end date the caller read. Two people
 * pressing renew, or a person and the worker on the same morning, cannot both
 * add a year: the second update matches nothing and is refused in words.
 *
 * THE EARLIER TERMS STAND. A visit the member was owed last year and never had
 * is still owed, still on the owed list and still deferred, and renewing does
 * not settle it by moving it into a new year or by writing it off.
 */
export async function renewWithin(
  tx: Database,
  ctx: ServiceContext,
  input: { agreementId: string; price?: string | undefined; by: "office" | "automatic"; today: string },
) {
  const [row] = await tx.select({ agreement: schema.agreement, plan: schema.agreementPlan })
    .from(schema.agreement)
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(eq(schema.agreement.id, input.agreementId)).limit(1);
  if (!row) throw new NotFoundError("Agreement");
  const { agreement: before, plan } = row;

  if (!(RENEWABLE as readonly string[]).includes(before.status)) {
    throw new ConflictError(
      before.status === "cancelled"
        ? "This agreement was cancelled. Sell them a new one rather than renewing a cancelled one, so the reason it was cancelled stays on the record."
        : `This agreement is ${before.status.replace(/_/g, " ")}, and only an active or lapsed agreement can be renewed.`,
    );
  }
  if (!before.endsOn) {
    throw new ConflictError("This agreement has no end date, so there is no next term to add.");
  }

  let price = usd(before.price);
  if (input.price !== undefined && input.price.trim() !== "") {
    const typed = input.price.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,4})?$/.test(typed)) {
      throw new ConflictError("The new price has to be an amount, like 228.00.");
    }
    price = usd(typed);
  }

  const term = membership.nextTerm(before.endsOn, plan.termMonths);
  const termNumber = before.renewalCount + 2;
  /** The term this renewal follows, written down if it predates terms being recorded, so its breakage has a row. */
  await ensureCurrentTerm(tx, ctx, before);

  const [after] = await tx.update(schema.agreement).set({
    status: "active",
    endsOn: term.endsOn,
    price: m.toString(price),
    renewalCount: sql`${schema.agreement.renewalCount} + 1`,
    lastRenewedOn: input.today,
    /** The next term owes its own notice, so this term's record is cleared. */
    renewalNoticeSentAt: null,
    renewalNoticeOutcome: null,
    visitsIncludedThisTerm: plan.includedVisitsPerTerm,
    visitsDeliveredThisTerm: 0,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.agreement.id, input.agreementId),
    eq(schema.agreement.endsOn, before.endsOn),
    eq(schema.agreement.status, before.status),
  )).returning();
  if (!after) throw new ConflictError("This agreement has just been renewed by somebody else.");

  const written = await writeTerm(tx, ctx, {
    agreementId: before.id, plan, startedOn: term.startsOn, endsOn: term.endsOn, price, term: termNumber,
    billingFrequency: before.billingFrequency,
  });

  /**
   * ON RENEWAL, the term that has ended gives up what it still holds. A
   * renewal on or after the end date is the end of that term; one made early
   * leaves it alone, and the pass releases it on the day it actually ends.
   */
  if (before.endsOn <= input.today) {
    await releaseEndedTerms(tx, ctx, { today: input.today, agreementId: before.id });
  }

  await emit(tx, ctx, {
    name: "agreement.renewed",
    entityType: "agreement",
    entityId: before.id,
    payload: {
      agreement: {
        id: before.id, customerId: before.customerId, planId: plan.id, planName: plan.name,
        price: m.toString(price), startedOn: term.startsOn, endsOn: term.endsOn, term: termNumber,
      },
      customer: { id: before.customerId },
      renewedBy: input.by,
    },
    previous: { agreement: { endsOn: before.endsOn, price: before.price, status: before.status } },
  });

  await audit(tx, ctx, input.by === "automatic" ? "agreement.auto_renewed" : "agreement.renewed",
    "agreement", before.id, before, after);

  return {
    id: after.id,
    term: termNumber,
    startsOn: term.startsOn,
    endsOn: term.endsOn,
    price: m.toString(price),
    visits: written.visits,
    instalments: written.instalments,
  };
}

/** Renew one from the agreement screen, or the API. */
export async function renew(ctx: ServiceContext, input: { id: string; price?: string | undefined }) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const seen = await replayed(tx, ctx, "agreement_renewal");
    if (seen) {
      const [row] = await tx.select().from(schema.agreement).where(eq(schema.agreement.id, seen)).limit(1);
      if (!row) throw new NotFoundError("Agreement");
      return {
        id: row.id, term: row.renewalCount + 1, startsOn: row.lastRenewedOn ?? row.startedOn,
        endsOn: row.endsOn!, price: row.price, visits: row.visitsIncludedThisTerm, instalments: 0,
      };
    }
    const today = time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId));
    const result = await renewWithin(tx, ctx, {
      agreementId: input.id, price: input.price, by: "office", today,
    });
    await remember(tx, ctx, "agreement_renewal", input.id);
    return result;
  });
}

export interface ExpiringAgreement {
  id: string;
  customerId: string;
  customerName: string;
  planName: string;
  status: string;
  endsOn: string;
  /** Negative when the end has passed and nothing renewed it. */
  daysLeft: number;
  price: string;
  billingFrequency: string;
  /** Both the plan's switch and the agreement's. */
  renewsAutomatically: boolean;
  renewalNoticeSentAt: Date | null;
  renewalNoticeOutcome: string | null;
  renewalCount: number;
}

/**
 * AGREEMENTS ENDING SOON, and the ones that ended and nobody renewed.
 *
 * The renewal conversation is the one this whole module exists for, and the
 * list that starts it is "who ends in the next thirty days". Ordered by the
 * end date, soonest first, because that is the order the calls get made in.
 *
 * Lapsed ones from the last thirty days are on it too, at the top. A member
 * whose plan ran out last week without anybody ringing is the most valuable
 * call on the list, and a list of only the future would have dropped them the
 * day after it mattered.
 */
export async function expiring(ctx: ServiceContext, input: { withinDays?: number } = {}) {
  return guardedRead(ctx, "membership:read", async (tx): Promise<ExpiringAgreement[]> => {
    const days = Math.min(Math.max(Math.trunc(input.withinDays ?? 30), 1), 366);
    const today = time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId));
    const until = recurrence.addDays(today, days);
    const since = recurrence.addDays(today, -30);

    const rows = await tx.select({
      agreement: schema.agreement,
      planName: schema.agreementPlan.name,
      planAutoRenews: schema.agreementPlan.autoRenews,
      customerName: schema.customer.name,
    })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.agreement.customerId))
      .where(and(
        inArray(schema.agreement.status, ["active", "past_due", "lapsed"]),
        sql`${schema.agreement.endsOn} is not null`,
        lte(schema.agreement.endsOn, until),
        gte(schema.agreement.endsOn, since),
      ))
      .orderBy(asc(schema.agreement.endsOn));

    return rows.map((r) => ({
      id: r.agreement.id,
      customerId: r.agreement.customerId,
      customerName: r.customerName,
      planName: r.planName,
      status: r.agreement.status,
      endsOn: r.agreement.endsOn!,
      daysLeft: membership.daysBetween(today, r.agreement.endsOn!),
      price: r.agreement.price,
      billingFrequency: r.agreement.billingFrequency,
      renewsAutomatically: r.agreement.autoRenews && r.planAutoRenews && r.agreement.status !== "lapsed",
      renewalNoticeSentAt: r.agreement.renewalNoticeSentAt,
      renewalNoticeOutcome: r.agreement.renewalNoticeOutcome,
      renewalCount: r.agreement.renewalCount,
    }));
  });
}

// ---------------------------------------------------------------------------
// Member pricing
// ---------------------------------------------------------------------------

/**
 * Which of this customer's agreements discounts work on a day, read inside a
 * transaction somebody already holds.
 *
 * Read by estimates and invoices as they are priced, which is why it takes a
 * transaction rather than a context: the estimate being written is not
 * visible to a second connection, and the authority to price it was settled
 * by the guard on the call that is writing it. The decision is core's.
 */
export async function memberPricingWithin(
  tx: Database,
  input: { customerId: string; propertyId?: string | null | undefined; on: string },
): Promise<membership.MemberPricing | null> {
  const rows = await memberCandidates(tx, [input.customerId]);
  return membership.memberPricingFor(rows, { on: input.on, propertyId: input.propertyId ?? null });
}

/**
 * Every running agreement these customers hold, as core's decisions read
 * them: the discount FROZEN ON THE AGREEMENT, and the perks from the plan.
 *
 * The rate is the agreement's because it was frozen at sale and an edit to
 * the plan must not reach a member mid term. The perks are the plan's,
 * because they are the company's standing promise and `updatePlan` says so.
 */
async function memberCandidates(tx: Database, customerIds: string[]): Promise<(membership.MemberCandidate & { customerId: string })[]> {
  if (customerIds.length === 0) return [];
  return tx.select({
    agreementId: schema.agreement.id,
    customerId: schema.agreement.customerId,
    planName: schema.agreementPlan.name,
    discountRate: schema.agreement.discountRate,
    status: schema.agreement.status,
    startedOn: schema.agreement.startedOn,
    endsOn: schema.agreement.endsOn,
    propertyId: schema.agreement.propertyId,
    waivesDiagnosticFee: schema.agreementPlan.waivesDiagnosticFee,
    waivesAfterHoursRate: schema.agreementPlan.waivesAfterHoursRate,
    priorityDispatch: schema.agreementPlan.priorityDispatch,
    exclusions: schema.agreement.discountExclusions,
    holdPercent: schema.agreementPlan.memberHoldPercent,
  })
    .from(schema.agreement)
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(and(
      inArray(schema.agreement.customerId, [...new Set(customerIds)]),
      eq(schema.agreement.status, "active"),
    ))
    .then((rows) => rows.map(({ exclusions, holdPercent, ...row }) => ({
      ...row,
      exclusions: membership.readExclusions(exclusions),
      holdShare: holdPercent === null ? null : holdPercent / 100,
    })));
}

/**
 * Which lines of a document the member's discount leaves out, read inside
 * the caller's transaction: by the line's price book item, or any category
 * that item is filed under. One read of the categories and one of the items
 * named, and none at all when the plan leaves nothing out.
 */
export async function exclusionTestWithin(
  tx: Database,
  exclusions: membership.DiscountExclusions | null | undefined,
  itemIds: readonly (string | null | undefined)[],
): Promise<(itemId: string | null | undefined) => boolean> {
  if (!membership.hasExclusions(exclusions)) return () => false;
  const ids = [...new Set(itemIds.filter((id): id is string => typeof id === "string"))];
  const [categories, items] = await Promise.all([
    tx.select({ id: schema.priceBookCategory.id, parentId: schema.priceBookCategory.parentId }).from(schema.priceBookCategory),
    ids.length === 0 ? [] : tx.select({ id: schema.priceBookItem.id, categoryId: schema.priceBookItem.categoryId })
      .from(schema.priceBookItem).where(inArray(schema.priceBookItem.id, ids)),
  ]);
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId] as const));
  const categoryOf = new Map(items.map((i) => [i.id, i.categoryId] as const));
  return (itemId) => (itemId ? membership.excludedFromDiscount(
    { itemId, categoryId: categoryOf.get(itemId) ?? null }, exclusions!, parentOf,
  ) : false);
}

/**
 * Every price book item the discount leaves out, as one list, for the phone,
 * which carries the price book without its categories.
 */
export async function excludedItemsWithin(
  tx: Database, exclusions: membership.DiscountExclusions | null | undefined,
): Promise<string[]> {
  if (!membership.hasExclusions(exclusions)) return [];
  const [categories, items] = await Promise.all([
    tx.select({ id: schema.priceBookCategory.id, parentId: schema.priceBookCategory.parentId }).from(schema.priceBookCategory),
    tx.select({ id: schema.priceBookItem.id, categoryId: schema.priceBookItem.categoryId }).from(schema.priceBookItem),
  ]);
  return membership.excludedItemIds(items, exclusions!, new Map(categories.map((c) => [c.id, c.parentId] as const)));
}

/**
 * What the discount leaves out, by name, for a sentence: "Equipment" and
 * "Permit fee". A category or item since removed from the price book is
 * still named, because the agreement still leaves it out.
 */
export async function exclusionNamesWithin(
  tx: Database, exclusions: membership.DiscountExclusions | null | undefined,
): Promise<string[]> {
  if (!membership.hasExclusions(exclusions)) return [];
  const [categories, items] = await Promise.all([
    exclusions!.categoryIds.length === 0 ? [] : tx.select({ name: schema.priceBookCategory.name })
      .from(schema.priceBookCategory).where(inArray(schema.priceBookCategory.id, [...exclusions!.categoryIds])),
    exclusions!.itemIds.length === 0 ? [] : tx.select({ name: schema.priceBookItemVersion.name })
      .from(schema.priceBookItemVersion)
      .where(and(
        inArray(schema.priceBookItemVersion.itemId, [...exclusions!.itemIds]),
        inForceAt(),
      )),
  ]);
  return [...categories.map((c) => c.name).sort(), ...[...new Set(items.map((i) => i.name))].sort()];
}

/**
 * Which pieces of work go to the front of the dispatch queue, and on whose
 * plan, read inside a transaction the caller holds.
 *
 * For the board, which asks for a whole day at once: one read for every
 * customer on it rather than one per visit. The decision is core's
 * `priorityFor`, the same cover rule the discount uses.
 */
export async function priorityWithin(
  tx: Database,
  work: readonly { key: string; customerId: string; propertyId: string | null; on: string }[],
): Promise<Map<string, string>> {
  const candidates = await memberCandidates(tx, work.map((w) => w.customerId));
  const out = new Map<string, string>();
  for (const piece of work) {
    const found = membership.priorityFor(
      candidates.filter((c) => c.customerId === piece.customerId),
      { on: piece.on, propertyId: piece.propertyId },
    );
    if (found) out.set(piece.key, found.planName);
  }
  return out;
}

/**
 * The member pricing that would apply to work for this customer today.
 *
 * For a screen writing an estimate, so it can say before the save that a
 * discount will be taken and why. `customer:read`, not `membership:read`: the
 * technician quoting at a kitchen table needs to know the customer is a member
 * and does not need to read the agreement book to find out.
 */
export async function memberPricing(
  ctx: ServiceContext, input: { customerId: string; propertyId?: string | undefined },
) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const today = time.dateIn(new Date(), await organizationTimezone(tx, ctx.actor.organizationId));
    const found = await memberPricingWithin(tx, { customerId: input.customerId, propertyId: input.propertyId, on: today });
    if (!found) {
      return {
        applies: false as const, agreementId: null, planName: null, rate: null, percent: null,
        waivesDiagnosticFee: false, waivesAfterHoursRate: false, leavesOut: [] as string[],
      };
    }
    const { exclusions, ...rest } = found;
    return {
      applies: true as const, ...rest, percent: percentOf(found.rate),
      /** What the discount does not touch, by name, so the screen can say so before the save. */
      leavesOut: await exclusionNamesWithin(tx, exclusions),
    };
  });
}

/**
 * The plan behind each agreement a priced line names, for a screen showing
 * why a line is cheaper.
 *
 * `customer:read` for the reason `memberPricing` gives: whoever can see the
 * estimate or invoice can see which membership priced it, without reading the
 * agreement book.
 */
export async function planNamesFor(ctx: ServiceContext, input: { agreementIds: string[] }) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const ids = [...new Set(input.agreementIds)];
    if (ids.length === 0) return new Map<string, string>();
    const rows = await tx.select({ id: schema.agreement.id, planName: schema.agreementPlan.name })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .where(inArray(schema.agreement.id, ids));
    return new Map(rows.map((r) => [r.id, r.planName] as const));
  });
}

/** "0.150000" as "15%", for a sentence. */
export const percentOf = (rate: string): string =>
  `${Number((Number(rate) * 100).toFixed(2))}%`;

// ---------------------------------------------------------------------------
// The worker's part: renewals, lapses and the notices before them
// ---------------------------------------------------------------------------

/**
 * The actor the renewal pass acts as.
 *
 * The system user, holding exactly the two things this pass does: add terms
 * to agreements and tell members about it. Nothing else, so a bug here cannot
 * reach a part of the product the pass has no business in.
 */
function renewalActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["membership:write", "message:send"],
    agentId: "renewals",
  };
}

const longDay = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

export interface RenewalPassResult {
  organizationId: string;
  renewed: string[];
  lapsed: string[];
  noticed: { agreementId: string; outcome: string }[];
  /** Terms that ended and gave up what they still held deferred, at what amount. */
  released: { agreementId: string; term: number; amount: string }[];
  failed: { agreementId: string; reason: string }[];
}

/**
 * One company's renewals, lapses and notices, each agreement in its own
 * transaction so one that fails does not undo the others.
 *
 * Exported so a test can run it for one company at a chosen date without
 * reaching across tenants.
 */
export async function renewalsFor(
  db: Database,
  organizationId: string,
  now: Date = new Date(),
): Promise<RenewalPassResult> {
  const ctx: ServiceContext = { actor: renewalActor(organizationId), db };
  const result: RenewalPassResult = { organizationId, renewed: [], lapsed: [], noticed: [], released: [], failed: [] };

  const { today, candidates } = await inTenant(ctx, async (tx) => {
    const zone = await organizationTimezone(tx, organizationId);
    const day = time.dateIn(now, zone);
    const rows = await tx.select({ agreement: schema.agreement, plan: schema.agreementPlan })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .where(and(
        eq(schema.agreement.status, "active"),
        sql`${schema.agreement.endsOn} is not null`,
        /**
         * Inside the longest notice window anybody could have set. The
         * decision is core's, per agreement; this only keeps the read from
         * being the whole book every pass.
         */
        lte(schema.agreement.endsOn, recurrence.addDays(day, 366)),
      ));
    return { today: day, candidates: rows };
  });

  for (const { agreement, plan } of candidates) {
    const state: membership.RenewalState = {
      status: agreement.status,
      endsOn: agreement.endsOn,
      autoRenews: agreement.autoRenews,
      planAutoRenews: plan.autoRenews,
      renewalNoticeDays: plan.renewalNoticeDays,
      renewalNoticeSentAt: agreement.renewalNoticeSentAt,
    };

    try {
      if (membership.renewalDue(state, today).renew) {
        await inTenant(ctx, (tx) => renewWithin(tx, ctx, { agreementId: agreement.id, by: "automatic", today }));
        result.renewed.push(agreement.id);
        continue;
      }

      /**
       * PAST ITS END AND NOT RENEWING: LAPSED.
       *
       * `lapsed` has been in the status list since the first migration, the
       * campaign audience "their plan lapsed" reads it, and nothing ever set
       * it, so that audience was always empty and every expired member read
       * as active in the book. The end date is the first day without cover,
       * so this is the day it becomes true.
       */
      if (agreement.endsOn && membership.daysBetween(today, agreement.endsOn) <= 0) {
        await inTenant(ctx, async (tx) => {
          const [after] = await tx.update(schema.agreement)
            .set({ status: "lapsed", updatedAt: new Date() })
            .where(and(eq(schema.agreement.id, agreement.id), eq(schema.agreement.status, "active")))
            .returning();
          if (after) await audit(tx, ctx, "agreement.lapsed", "agreement", agreement.id, agreement, after);
        });
        result.lapsed.push(agreement.id);
        continue;
      }

      if (membership.noticeDue(state, today)) {
        const outcome = await inTenant(ctx, (tx) => sendRenewalNotice(tx, ctx, {
          agreement, plan, renewsAutomatically: agreement.autoRenews && plan.autoRenews,
        }));
        if (outcome) result.noticed.push({ agreementId: agreement.id, outcome });
      }
    } catch (error) {
      result.failed.push({ agreementId: agreement.id, reason: (error as Error).message });
    }
  }

  /**
   * BREAKAGE, on every term that has ended and not been released: lapsed
   * ones, ones renewed early whose old term has now run out, cancelled ones
   * (with nothing left, because cancelling released it). Agreements sold
   * before terms were recorded have their current term written down first.
   * Each term in its own transaction, like each agreement above.
   */
  try {
    const ended = await inTenant(ctx, async (tx) => {
      const legacy = await tx.select().from(schema.agreement)
        .where(and(
          sql`${schema.agreement.endsOn} is not null`,
          lte(schema.agreement.endsOn, today),
          sql`not exists (select 1 from public.agreement_term t
                where t.agreement_id = ${schema.agreement.id} and t.term = ${schema.agreement.renewalCount} + 1)`,
        ));
      for (const row of legacy) await ensureCurrentTerm(tx, ctx, row);
      return tx.select({ agreementId: schema.agreementTerm.agreementId }).from(schema.agreementTerm)
        .where(and(isNull(schema.agreementTerm.breakageReleasedOn), lte(schema.agreementTerm.endsOn, today)));
    });
    for (const agreementId of [...new Set(ended.map((e) => e.agreementId))]) {
      try {
        const done = await inTenant(ctx, (tx) => releaseEndedTerms(tx, ctx, { today, agreementId }));
        result.released.push(...done.map((d) => ({ agreementId: d.agreementId, term: d.term, amount: d.amount })));
      } catch (error) {
        result.failed.push({ agreementId, reason: (error as Error).message });
      }
    }
  } catch (error) {
    result.failed.push({ agreementId: "", reason: (error as Error).message });
  }

  return result;
}

/**
 * Send this term's notice, once, and say what happened.
 *
 * CLAIMED FIRST. The notice's own column is set by a conditional update before
 * anything is queued, so two workers reaching the same agreement send one
 * notice, and the loser returns null having done nothing.
 *
 * THROUGH THE SAME GATES AS EVERYTHING ELSE. A text goes through
 * `sendTransactional`, which checks consent and the suppression list; with no
 * number, or no way to text it, an email goes through `email.queue`, which
 * does the same for mail. A notice is an account message rather than
 * marketing, and it still does not go to somebody who replied STOP.
 *
 * WHEN NOTHING CAN GO, A PERSON IS TOLD. The refusal is the outcome on the
 * agreement and a task in the office queue, because an automatic renewal the
 * member was never told about is the complaint, the chargeback and in some
 * states the refund.
 */
async function sendRenewalNotice(
  tx: Database,
  ctx: ServiceContext,
  input: {
    agreement: typeof schema.agreement.$inferSelect;
    plan: typeof schema.agreementPlan.$inferSelect;
    renewsAutomatically: boolean;
  },
): Promise<string | null> {
  const { agreement, plan } = input;
  const claimed = await tx.update(schema.agreement)
    .set({ renewalNoticeSentAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.agreement.id, agreement.id),
      isNull(schema.agreement.renewalNoticeSentAt),
      eq(schema.agreement.endsOn, agreement.endsOn!),
    ))
    .returning({ id: schema.agreement.id });
  if (claimed.length === 0) return null;

  const [customer] = await tx.select().from(schema.customer)
    .where(eq(schema.customer.id, agreement.customerId)).limit(1);
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, agreement.organizationId)).limit(1);

  /**
   * THE COMPANY'S WORDS, BY THE COMPANY'S CHOICE OF HOW. The text and the
   * email are its message templates (`agreement-notices.ts`), and whether it
   * goes by text first, email first or both is its setting. Whichever is
   * tried first, the other is tried when the first cannot go, because a
   * notice owed and not delivered is the complaint and in some states the
   * refund; "both" tries both.
   */
  const situation = input.renewsAutomatically ? "renews" as const : "ends" as const;
  const words = await notices.renderNotice(tx, agreement.organizationId, situation, notices.noticeScope({
    customerName: customer?.name ?? "",
    organizationName: org?.name ?? "",
    planName: plan.name,
    endsOn: agreement.endsOn!,
    price: agreement.price,
    termMonths: plan.termMonths,
  }));
  const channel = await notices.channelWithin(tx, agreement.organizationId);

  const byText = async (): Promise<{ sent: boolean; why: string }> => {
    if (!customer?.phone) return { sent: false, why: "Not texted: no mobile number on the customer." };
    const text = await sendTransactional(tx, {
      organizationId: agreement.organizationId,
      address: customer.phone,
      body: words.text,
      customerId: customer.id,
    });
    return text.sent ? { sent: true, why: "" } : { sent: false, why: `Not texted: ${text.explanation}` };
  };
  const byEmail = async (): Promise<{ sent: boolean; why: string }> => {
    if (!customer?.email) return { sent: false, why: "Not emailed: no email address on the customer." };
    const mail = await email.queue({ ...ctx, db: tx }, {
      to: customer.email,
      subject: words.email.subject,
      text: words.email.body,
      customerId: customer.id,
    });
    return mail.queued ? { sent: true, why: "" } : { sent: false, why: `Not emailed: ${mail.explanation}` };
  };

  let outcome: string;
  let sent: boolean;
  if (!customer?.phone && !customer?.email) {
    sent = false;
    outcome = "No phone number or email address on the customer, so there is nowhere to send it.";
  } else if (channel === "both") {
    const [text, mail] = [await byText(), await byEmail()];
    sent = text.sent || mail.sent;
    outcome = text.sent && mail.sent ? "queued"
      : sent ? `Sent by ${text.sent ? "text" : "email"}. ${text.sent ? mail.why : text.why}`
        : `${text.why} ${mail.why}`;
  } else {
    const [first, second] = channel === "email_first" ? [byEmail, byText] : [byText, byEmail];
    const tried = await first();
    if (tried.sent) {
      sent = true;
      outcome = "queued";
    } else {
      const fallback = await second();
      sent = fallback.sent;
      outcome = fallback.sent ? `Sent by ${channel === "email_first" ? "text" : "email"}. ${tried.why}` : `${tried.why} ${fallback.why}`;
    }
  }
  outcome = outcome.trim();

  await tx.update(schema.agreement)
    .set({ renewalNoticeOutcome: outcome, updatedAt: new Date() })
    .where(eq(schema.agreement.id, agreement.id));

  if (!sent) {
    await tx.insert(schema.task).values({
      organizationId: agreement.organizationId,
      title: `Tell ${customer?.name ?? "this member"} their ${plan.name} `
        + `${input.renewsAutomatically ? "renews" : "ends"} on ${longDay(agreement.endsOn!)}`,
      body: `The renewal notice the plan owes could not be sent. ${outcome}`,
      priority: "high",
      entityType: "agreement",
      entityId: agreement.id,
      queue: "office",
    });
  }

  /**
   * An event, and not only for automations. The outbox is flushed for the
   * companies whose log moved, so a notice queued with nothing written to the
   * log would sit in the outbox until that company next did something.
   */
  await emit(tx, ctx, {
    name: "agreement.renewal_noticed",
    entityType: "agreement",
    entityId: agreement.id,
    payload: {
      agreement: { id: agreement.id, customerId: agreement.customerId, endsOn: agreement.endsOn, planName: plan.name },
      customer: { id: agreement.customerId },
      sent,
      outcome,
    },
  });

  await audit(tx, ctx, "agreement.renewal_notice", "agreement", agreement.id, null, { outcome });
  return outcome;
}

/**
 * One pass over every company with an agreement ending inside a notice window.
 *
 * Finding them is a cross tenant read and goes through
 * `app.agreement_renewal_organizations`, which returns ids and nothing else,
 * exactly like the workflow sweeps beside it.
 */
export async function renewalsPass(
  db: Database,
  options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<RenewalPassResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.agreement_renewal_organizations(${options.limit ?? 100})`,
  );
  const results: RenewalPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await renewalsFor(db, row.organization_id, options.now));
    } catch (error) {
      results.push({
        organizationId: row.organization_id, renewed: [], lapsed: [], noticed: [], released: [],
        failed: [{ agreementId: "", reason: (error as Error).message }],
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// The API's shapes
// ---------------------------------------------------------------------------

const planView = (row: typeof schema.agreementPlan.$inferSelect) => ({
  id: row.id,
  name: row.name,
  code: row.code,
  description: row.description,
  price: row.price,
  billingFrequency: row.billingFrequency,
  termMonths: row.termMonths,
  includedVisitsPerTerm: row.includedVisitsPerTerm,
  visitAnchorMonths: row.visitAnchorMonths ?? [],
  visitAnchorDay: row.visitAnchorDay,
  autoRenews: row.autoRenews,
  renewalNoticeDays: row.renewalNoticeDays,
  discountRate: row.discountRate,
  priorityDispatch: row.priorityDispatch,
  waivesDiagnosticFee: row.waivesDiagnosticFee,
  waivesAfterHoursRate: row.waivesAfterHoursRate,
  benefits: row.benefits ?? [],
  discountExclusions: membership.readExclusions(row.discountExclusions) as { categoryIds: string[]; itemIds: string[] },
  memberHoldPercent: row.memberHoldPercent,
  active: row.active,
});

const agreementView = (row: typeof schema.agreement.$inferSelect) => ({
  id: row.id,
  planId: row.planId,
  customerId: row.customerId,
  propertyId: row.propertyId,
  status: row.status,
  startedOn: row.startedOn,
  endsOn: row.endsOn,
  price: row.price,
  discountRate: row.discountRate,
  discountExclusions: membership.readExclusions(row.discountExclusions) as { categoryIds: string[]; itemIds: string[] },
  billingFrequency: row.billingFrequency,
  autoRenews: row.autoRenews,
  renewalCount: row.renewalCount,
  cancelledOn: row.cancelledOn,
  cancellationReason: row.cancellationReason,
  cancellationCode: row.cancellationCode,
  visitsIncludedThisTerm: row.visitsIncludedThisTerm,
  visitsDeliveredThisTerm: row.visitsDeliveredThisTerm,
});

const visitView = (row: typeof schema.agreementVisit.$inferSelect) => ({
  id: row.id,
  sequence: row.sequence,
  term: row.term,
  dueOn: row.dueOn,
  jobId: row.jobId,
  deliveredOn: row.deliveredOn,
  skippedOn: row.skippedOn,
  skipReason: row.skipReason,
  recognitionAmount: row.recognitionAmount,
});

const instalmentView = (row: typeof schema.agreementBilling.$inferSelect) => ({
  id: row.id,
  sequence: row.sequence,
  term: row.term,
  dueOn: row.dueOn,
  amount: row.amount,
  status: row.status,
  invoiceId: row.invoiceId,
});

/**
 * A write from the API that a retry must not repeat, inside one transaction.
 *
 * Booking a visit twice is two jobs and two technicians at one door; billing
 * an instalment twice is two invoices; delivering twice would be refused, but
 * refused to the caller whose first attempt worked and whose response was
 * lost on a bad connection. So the answer is kept with the key, and a retry
 * gets the first answer back. The memory and the write commit together, so a
 * write that failed leaves nothing remembered and can be tried again.
 */
function onceOver<T extends object>(
  ctx: ServiceContext,
  permission: "membership:write" | "invoice:write",
  entityType: string,
  entityId: string,
  write: (tx: Database) => Promise<T>,
): Promise<T> {
  return guardedWrite(ctx, permission, async (tx) => {
    const seen = await once.replayed<T>(tx, ctx, entityType);
    if (seen) return seen;
    const answer = await write(tx);
    await once.remember(tx, ctx, entityType, entityId, answer);
    return answer;
  });
}

/**
 * A replay of either write reads back what the first call made rather than
 * defining a second plan or selling a second year. Recorded in a separate
 * transaction after the write, which leaves a sliver where a crash between
 * the two lets a retry write again; the same sliver every other idempotent
 * route here has, and a far smaller one than none.
 */
async function idempotently<T extends { id: string }>(
  ctx: ServiceContext,
  entityType: string,
  replay: (id: string) => Promise<T>,
  write: () => Promise<T>,
): Promise<T> {
  if (ctx.idempotencyKey) {
    const seen = await inTenant(ctx, (tx) => replayed(tx, ctx, entityType));
    if (seen) return replay(seen);
  }
  const made = await write();
  if (ctx.idempotencyKey) await inTenant(ctx, (tx) => remember(tx, ctx, entityType, made.id));
  return made;
}

export const handlers = {
  createAgreementPlan: (ctx: ServiceContext, input: PlanInput) =>
    idempotently(ctx, "agreement_plan",
      async (id) => planView((await plans(ctx, { includeInactive: true })).find((p) => p.id === id)!),
      async () => planView(await createPlan(ctx, input))),

  sellAgreement: (ctx: ServiceContext, input: {
    planId: string; customerId: string; propertyId?: string | undefined;
    startedOn?: string | undefined; price?: string | undefined;
  }) =>
    idempotently(ctx, "agreement",
      async (id) => agreementView((await get(ctx, { id })).agreement),
      async () => agreementView(await sell(ctx, {
        planId: input.planId,
        customerId: input.customerId,
        ...(input.propertyId ? { propertyId: input.propertyId } : {}),
        ...(input.startedOn ? { startedOn: input.startedOn } : {}),
        ...(input.price ? { price: input.price } : {}),
      }))),

  renewAgreement: (ctx: ServiceContext, input: { id: string; price?: string | undefined }) =>
    renew(ctx, input),

  listAgreementRenewals: async (ctx: ServiceContext, input: { withinDays?: number | undefined }) => ({
    agreements: (await expiring(ctx, input.withinDays ? { withinDays: input.withinDays } : {}))
      .map((row) => ({ ...row, renewalNoticeSentAt: row.renewalNoticeSentAt?.toISOString() ?? null })),
  }),

  getMemberPricing: (ctx: ServiceContext, input: { id: string; propertyId?: string | undefined }) =>
    memberPricing(ctx, { customerId: input.id, ...(input.propertyId ? { propertyId: input.propertyId } : {}) }),

  listAgreementPlans: async (ctx: ServiceContext, input: { includeRetired?: boolean | undefined }) => ({
    plans: (await plans(ctx, { includeInactive: input.includeRetired ?? false })).map(planView),
  }),

  getAgreementPlan: async (ctx: ServiceContext, input: { id: string }) => {
    const plan = await getPlan(ctx, input);
    return { ...planView(plan), members: plan.members };
  },

  updateAgreementPlan: async (ctx: ServiceContext, input: { id: string; active?: boolean | undefined } & PlanPatch) =>
    planView(await updatePlan(ctx, input)),

  /** Retiring twice is retired, so a retry needs no memory. */
  retireAgreementPlan: async (ctx: ServiceContext, input: { id: string }) =>
    planView(await retirePlan(ctx, input)),

  listAgreements: async (ctx: ServiceContext, input: { status?: string | undefined; customerId?: string | undefined }) => ({
    agreements: (await list(ctx, input)).map((row) => ({
      ...agreementView(row.agreement), planName: row.planName, customerName: row.customerName,
    })),
  }),

  getAgreement: async (ctx: ServiceContext, input: { id: string }) => {
    const found = await get(ctx, input);
    return {
      ...agreementView(found.agreement),
      planName: found.plan.name,
      customerName: found.customerName,
      unearned: found.unearned,
      visits: found.visits.map(visitView),
      instalments: found.billing.map(instalmentView),
      terms: found.terms.map((t) => ({
        term: t.term, startsOn: t.startsOn, endsOn: t.endsOn, breakageReleasedOn: t.breakageReleasedOn,
        breakageAmount: t.breakageAmount, breakageVisits: t.breakageVisits,
      })),
    };
  },

  listOwedAgreementVisits: async (ctx: ServiceContext, input: { through?: string | undefined }) => ({
    visits: (await owed(ctx, input.through ? { through: input.through } : {})).map((row) => ({
      ...visitView(row.visit),
      agreementId: row.agreementId,
      customerId: row.customerId,
      customerName: row.customerName,
      propertyId: row.propertyId,
      planName: row.planName,
    })),
  }),

  bookAgreementVisit: (ctx: ServiceContext, input: { id: string; propertyId?: string | undefined }) =>
    onceOver(ctx, "membership:write", "agreement_visit.book", input.id, async (tx) => {
      const booked = await bookWithin(tx, ctx, {
        agreementVisitId: input.id, ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      });
      return { agreementVisitId: input.id, jobId: booked.job.id, jobNumber: booked.job.number };
    }),

  deliverAgreementVisit: (ctx: ServiceContext, input: { id: string; on?: string | undefined }) =>
    onceOver(ctx, "membership:write", "agreement_visit.deliver", input.id, async (tx) => {
      const delivered = await deliverWithin(tx, ctx, {
        agreementVisitId: input.id, ...(input.on ? { on: input.on } : {}),
      });
      return { agreementVisitId: input.id, recognized: delivered.recognized };
    }),

  skipAgreementVisit: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    onceOver(ctx, "membership:write", "agreement_visit.skip", input.id, async (tx) => {
      const skipped = await skipWithin(tx, ctx, { agreementVisitId: input.id, reason: input.reason });
      return {
        agreementVisitId: input.id, skippedOn: skipped.skippedOn!, skipReason: skipped.skipReason!,
        stillDeferred: skipped.stillDeferred,
      };
    }),

  unskipAgreementVisit: (ctx: ServiceContext, input: { id: string }) =>
    onceOver(ctx, "membership:write", "agreement_visit.unskip", input.id, async (tx) => {
      const back = await unskipWithin(tx, ctx, { agreementVisitId: input.id });
      return { agreementVisitId: input.id, dueOn: back.dueOn };
    }),

  invoiceAgreementInstalment: (ctx: ServiceContext, input: { id: string }) =>
    onceOver(ctx, "invoice:write", "agreement_billing.invoice", input.id, async (tx) => {
      const invoice = await billWithin(tx, ctx, { agreementBillingId: input.id });
      return { instalmentId: input.id, invoiceId: invoice.id, number: invoice.number, total: invoice.total };
    }),

  cancelAgreement: (ctx: ServiceContext, input: {
    id: string; reasonCode?: membership.CancellationCode | undefined; reason?: string | undefined;
    keepThePrepayment?: boolean | undefined; endPropertyLink?: boolean | undefined;
  }) =>
    onceOver(ctx, "membership:write", "agreement.cancel", input.id, async (tx) => {
      const cancelled = await cancelWithin(tx, ctx, input);
      return { ...agreementView(cancelled), released: cancelled.released, endedLinks: cancelled.endedLinks };
    }),
} as const;
