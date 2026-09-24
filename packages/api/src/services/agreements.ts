import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m, time, recurrence } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";
import { nextNumber } from "./jobs";
import { writePosting } from "./ledger";
import { emit } from "./events";
import { resolveIn } from "./entitlements";

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
  code?: string;
  description?: string;
  price: string;
  billingFrequency: "monthly" | "quarterly" | "semiannual" | "annual" | "one_time";
  termMonths: number;
  includedVisitsPerTerm: number;
  visitAnchorMonths?: number[];
  visitIntervalDays?: number;
  discountRate?: string;
  priorityDispatch?: boolean;
  waivesDiagnosticFee?: boolean;
  benefits?: string[];
  autoRenews?: boolean;
}

export async function createPlan(ctx: ServiceContext, input: PlanInput) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    if (input.name.trim() === "") throw new ConflictError("A plan needs a name.");
    if (input.termMonths < 1) throw new ConflictError("A term is at least one month.");
    if (input.includedVisitsPerTerm < 0) {
      throw new ConflictError("A plan cannot include a negative number of visits.");
    }

    const [plan] = await tx.insert(schema.agreementPlan).values({
      organizationId: ctx.actor.organizationId,
      name: input.name.trim(),
      code: input.code ?? null,
      description: input.description ?? null,
      price: m.toString(usd(input.price)),
      billingFrequency: input.billingFrequency,
      termMonths: input.termMonths,
      autoRenews: input.autoRenews ?? true,
      includedVisitsPerTerm: input.includedVisitsPerTerm,
      visitAnchorMonths: input.visitAnchorMonths ?? [],
      visitIntervalDays: input.visitIntervalDays ?? null,
      discountRate: input.discountRate ?? null,
      priorityDispatch: input.priorityDispatch ?? false,
      waivesDiagnosticFee: input.waivesDiagnosticFee ?? false,
      benefits: input.benefits ?? [],
    }).returning();

    await audit(tx, ctx, "agreement_plan.created", "agreement_plan", plan!.id, null, plan);
    return plan!;
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
      billingFrequency: plan.billingFrequency,
      autoRenews: plan.autoRenews,
      visitsIncludedThisTerm: plan.includedVisitsPerTerm,
    }).returning();

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
        agreementId: agreement!.id,
        sequence: index + 1,
        dueOn,
        recognitionAmount: m.toString(slices[index]!),
      }).returning();

      await tx.insert(schema.deferredRevenueEntry).values({
        organizationId: ctx.actor.organizationId,
        agreementId: agreement!.id,
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
        agreementId: agreement!.id,
        amount: m.toString(price),
        scheduledFor: endsOn,
      });
    }

    for (const [index, instalment] of billingSchedule({
      startedOn, termMonths: plan.termMonths,
      frequency: plan.billingFrequency, price,
    }).entries()) {
      await tx.insert(schema.agreementBilling).values({
        organizationId: ctx.actor.organizationId,
        agreementId: agreement!.id,
        sequence: index + 1,
        dueOn: instalment.dueOn,
        amount: m.toString(instalment.amount),
      });
    }

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

async function organizationTimezone(tx: Database, organizationId: string): Promise<string> {
  const [row] = await tx.execute<{ timezone: string | null }>(
    sql`select timezone from public.organization where id = ${organizationId} limit 1`,
  );
  return row?.timezone ?? "America/Chicago";
}

// ---------------------------------------------------------------------------
// Reading the book
// ---------------------------------------------------------------------------

export async function list(ctx: ServiceContext, input: { status?: string } = {}) {
  return guardedRead(ctx, "membership:read", async (tx) =>
    tx.select({
      agreement: schema.agreement,
      planName: schema.agreementPlan.name,
      customerName: schema.customer.name,
    })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.agreement.customerId))
      .where(input.status
        ? eq(schema.agreement.status, input.status as "active")
        : undefined)
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

    const [visits, billing, deferred] = await Promise.all([
      tx.select().from(schema.agreementVisit)
        .where(eq(schema.agreementVisit.agreementId, input.id))
        .orderBy(asc(schema.agreementVisit.sequence)),
      tx.select().from(schema.agreementBilling)
        .where(eq(schema.agreementBilling.agreementId, input.id))
        .orderBy(asc(schema.agreementBilling.sequence)),
      tx.select().from(schema.deferredRevenueEntry)
        .where(eq(schema.deferredRevenueEntry.agreementId, input.id)),
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

    return { ...row, visits, billing, unearned: m.toString(unearned) };
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
  return guardedWrite(ctx, "membership:write", async (tx) => {
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
  });
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
  return guardedWrite(ctx, "membership:write", async (tx) => {
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

    const amount = usd(row.visit.recognitionAmount ?? "0");
    if (m.isPositive(amount)) {
      await tx.update(schema.deferredRevenueEntry)
        .set({ recognizedOn: on, updatedAt: new Date() })
        .where(and(
          eq(schema.deferredRevenueEntry.agreementVisitId, input.agreementVisitId),
          isNull(schema.deferredRevenueEntry.recognizedOn),
        ));

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
  });
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
  return guardedWrite(ctx, "invoice:write", async (tx) => {
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
  });
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
export async function cancel(
  ctx: ServiceContext,
  input: { id: string; reason: string; keepThePrepayment?: boolean },
) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const [before] = await tx.select().from(schema.agreement)
      .where(eq(schema.agreement.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Agreement");
    if (before.status === "cancelled") throw new ConflictError("That agreement is already cancelled.");
    if (input.reason.trim() === "") {
      // A cancellation with no reason is indistinguishable from a mistake,
      // and the reason is the whole of a win-back campaign.
      throw new ConflictError("A cancellation needs a reason.");
    }

    const timezone = await organizationTimezone(tx, ctx.actor.organizationId);
    const on = time.dateIn(new Date(), timezone);

    const [after] = await tx.update(schema.agreement).set({
      status: "cancelled", cancelledOn: on,
      cancellationReason: input.reason.trim(), autoRenews: false,
      updatedAt: new Date(),
    }).where(eq(schema.agreement.id, input.id)).returning();

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
        releasedOn: on, releaseReason: input.reason.trim(), updatedAt: new Date(),
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
        reason: input.reason.trim(), released: m.toString(balance),
      },
    });

    await audit(tx, ctx, "agreement.cancelled", "agreement", input.id, before, after);
    return { ...after!, released: m.toString(balance) };
  });
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

