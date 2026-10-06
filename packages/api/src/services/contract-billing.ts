import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { contractBilling as cb, money as m, time, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import { remember, replayed } from "./once";

/**
 * A CONTRACT BILLED ON A SCHEDULE
 *
 * A commercial maintenance contract often bills a fixed fee every month,
 * quarter or year whether or not anybody visited: "1,200.00 a month for the
 * planned maintenance at both sites". Before this, that invoice was typed by
 * hand every month by whoever remembered, and the month nobody remembered
 * was money the company never asked for.
 *
 * WHAT IT IS. A schedule on the contract (`contract_billing_schedule`): the
 * fee, how often, the billing day, the first day billed, whether a part
 * period at either end is prorated by day, whether the fee is taxed, and the
 * words on the invoice. Which periods it owes and what each costs is
 * `core/contract-billing`, pure and tested without a database.
 *
 * WHO PAYS, AND ON WHAT TERMS. The contract's customer, who is the party the
 * contract is with, on their own payment terms (the invoice is due that many
 * days after it is raised), with the contract's purchase order number on it.
 * The invoice goes through `billing.createIn` like any other, so it is
 * numbered, taxed and posted by the same rules: revenue follows the invoice,
 * on the day it is raised, exactly as the ledger posts any invoice. There is
 * no deferred revenue here. A fixed fee contract is billed for the period it
 * is in, and inventing a liability for it would be an accounting treatment
 * nobody chose (M08's agreements defer because they owe visits; this owes a
 * period of cover, billed as that period starts).
 *
 * ONCE PER PERIOD, under a unique index on the contract and the period's
 * first day. The period's row is inserted first, in the same transaction as
 * its invoice: the worker, a second worker, a restart and somebody pressing
 * "Raise what is due now" while the worker runs all meet the index, and only
 * one of them writes an invoice.
 *
 * PAUSED AND ENDED. A paused schedule raises nothing, and a period whose
 * billing day falls while it is paused is written down as skipped when it is
 * resumed, so it is never billed afterwards either: resuming does not send a
 * customer three months at once. An ended schedule bills the periods up to
 * its last day and none after. An invoice already raised for a period the
 * end cuts short is left as it is: crediting the difference is a decision
 * made on the invoice (a credit note), not one this makes for the office.
 */

const usd = (value: string) => m.money(value, "USD");

type ScheduleRow = typeof schema.contractBillingSchedule.$inferSelect;
type ContractRow = typeof schema.serviceContract.$inferSelect;

export interface ScheduleInput {
  contractId: string;
  amount: string;
  frequency: cb.Frequency;
  billingDay: number;
  startsOn?: string | undefined;
  prorate?: boolean | undefined;
  taxable?: boolean | undefined;
  description: string;
}

export interface PeriodView {
  id: string;
  start: string;
  end: string;
  billOn: string;
  amount: string;
  prorated: boolean;
  days: number;
  fullDays: number;
  status: "invoiced" | "skipped";
  invoiceId: string | null;
  invoiceNumber: number | null;
  note: string | null;
}

export interface ScheduleView {
  contractId: string;
  schedule: {
    id: string;
    amount: string;
    frequency: cb.Frequency;
    billingDay: number;
    startsOn: string;
    prorate: boolean;
    taxable: boolean;
    description: string;
    state: "active" | "paused" | "ended";
    pausedOn: string | null;
    endedOn: string | null;
    /** The last day it bills for: the contract's end or its own, whichever is first. */
    lastDay: string | null;
  } | null;
  /** The next period, when there is one still to come: what it covers, when it is billed and what for. */
  next: { start: string; end: string; billOn: string; amount: string; prorated: boolean; days: number; fullDays: number } | null;
  /** Periods owed now and not yet raised: the worker raises them on its next pass. */
  due: number;
  /** Every period written so far, newest first. */
  periods: PeriodView[];
  /** Why nothing is being billed, in words, when nothing is. */
  standing: string | null;
}

async function loadContract(tx: Database, id: string): Promise<ContractRow> {
  const [row] = await tx.select().from(schema.serviceContract)
    .where(and(eq(schema.serviceContract.id, id), sql`${schema.serviceContract.deletedAt} is null`)).limit(1);
  if (!row) throw new NotFoundError("Contract");
  return row;
}

async function scheduleOf(tx: Database, contractId: string): Promise<ScheduleRow | null> {
  const [row] = await tx.select().from(schema.contractBillingSchedule)
    .where(eq(schema.contractBillingSchedule.contractId, contractId)).limit(1);
  return row ?? null;
}

/** The schedule as core reads it, cut at whichever end comes first. */
function termsOf(schedule: ScheduleRow, contract: ContractRow): cb.Schedule {
  const ends = [contract.endsOn, schedule.state === "ended" ? schedule.endedOn : null]
    .filter((d): d is string => d !== null).sort();
  return {
    amount: usd(schedule.amount),
    frequency: schedule.frequency,
    billingDay: schedule.billingDay,
    startsOn: schedule.startsOn,
    endsOn: ends[0] ?? null,
    prorate: schedule.prorate,
  };
}

/** The first day of each period already written, so a period is raised once. */
async function writtenStarts(tx: Database, contractId: string): Promise<Set<string>> {
  const rows = await tx.select({ start: schema.contractBillingPeriod.periodStart })
    .from(schema.contractBillingPeriod).where(eq(schema.contractBillingPeriod.contractId, contractId));
  return new Set(rows.map((r) => r.start));
}

async function lastWrittenEnd(tx: Database, contractId: string): Promise<string | null> {
  const [row] = await tx.select({ end: schema.contractBillingPeriod.periodEnd })
    .from(schema.contractBillingPeriod).where(eq(schema.contractBillingPeriod.contractId, contractId))
    .orderBy(desc(schema.contractBillingPeriod.periodEnd)).limit(1);
  return row?.end ?? null;
}

/**
 * The periods owed today and not yet written.
 *
 * Owed means its billing day has come in the company's calendar, it begins
 * on or before the schedule's last day, and its billing day did not fall
 * while the schedule was paused. A schedule on a contract that is switched
 * off owes nothing.
 */
async function owed(tx: Database, schedule: ScheduleRow, contract: ContractRow, today: string): Promise<cb.Period[]> {
  if (!contract.active || contract.deletedAt) return [];
  if (schedule.state === "paused") return [];
  const written = await writtenStarts(tx, contract.id);
  return cb.periodsThrough(termsOf(schedule, contract), today, EVERY_PERIOD)
    .filter((p) => !written.has(p.start))
    .filter((p) => !(schedule.pausedOn && p.billOn >= schedule.pausedOn));
}

/**
 * Enough to walk any schedule from its first day: four hundred years of
 * months. Walking is date arithmetic and costs nothing; what is RAISED in one
 * go is capped separately, below.
 */
const EVERY_PERIOD = 5000;

/**
 * How many periods one schedule raises in one go. A schedule set up today
 * from a first day three years back owes thirty six invoices, and a person
 * should see the first year before the rest arrive, so it is caught up a
 * year at a time, one pass after another.
 */
const AT_ONCE = 12;

/* -------------------------------------------------------------- reading */

async function viewWithin(tx: Database, organizationId: string, contractId: string): Promise<ScheduleView> {
  const contract = await loadContract(tx, contractId);
  const schedule = await scheduleOf(tx, contractId);
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const periods = await tx.select({
    period: schema.contractBillingPeriod,
    number: schema.invoice.number,
  }).from(schema.contractBillingPeriod)
    .leftJoin(schema.invoice, eq(schema.invoice.id, schema.contractBillingPeriod.invoiceId))
    .where(eq(schema.contractBillingPeriod.contractId, contractId))
    .orderBy(desc(schema.contractBillingPeriod.periodStart));

  if (!schedule) {
    return { contractId, schedule: null, next: null, due: 0, periods: [], standing: null };
  }
  const terms = termsOf(schedule, contract);
  const due = await owed(tx, schedule, contract, today);
  /** Walked from the first day, so a schedule years old still finds its next period. */
  const coming = schedule.state === "paused" || !contract.active ? null : cb.nextPeriod(terms, today);
  const standing = !contract.active
    ? "The contract is switched off, so nothing is billed."
    : schedule.state === "paused"
      ? `Paused since ${schedule.pausedOn}. Nothing is billed while it is, and a period whose billing day falls in the pause is skipped.`
      : terms.endsOn && terms.endsOn < today
        ? `Ended. The last day billed for was ${terms.endsOn}.`
        : null;

  return {
    contractId,
    schedule: {
      id: schedule.id,
      amount: schedule.amount,
      frequency: schedule.frequency,
      billingDay: schedule.billingDay,
      startsOn: schedule.startsOn,
      prorate: schedule.prorate,
      taxable: schedule.taxable,
      description: schedule.description,
      state: schedule.state,
      pausedOn: schedule.pausedOn,
      endedOn: schedule.endedOn,
      lastDay: terms.endsOn,
    },
    next: coming ? {
      start: coming.start, end: coming.end, billOn: coming.billOn, amount: m.toString(coming.amount),
      prorated: coming.prorated, days: coming.days, fullDays: coming.fullDays,
    } : null,
    due: due.length,
    periods: periods.map(({ period, number }) => ({
      id: period.id,
      start: period.periodStart,
      end: period.periodEnd,
      billOn: period.billOn,
      amount: period.amount,
      prorated: period.prorated,
      days: period.days,
      fullDays: period.fullDays,
      status: period.status,
      invoiceId: period.invoiceId,
      invoiceNumber: number ?? null,
      note: period.note,
    })),
    standing,
  };
}

/** The contract's schedule, its next period and every period billed or skipped. */
export function view(ctx: ServiceContext, input: { contractId: string }): Promise<ScheduleView> {
  return guardedRead(ctx, "contract:read", (tx) => viewWithin(tx, ctx.actor.organizationId, input.contractId));
}

/* -------------------------------------------------------------- setting */

/**
 * Set the contract's schedule, or change it.
 *
 * `contract:write`, because how a contract bills is one of its terms, like
 * its limit and its clocks. The fee, the words, prorating and tax can change
 * at any time and reach the periods not yet billed. How often and on which
 * day are the pattern every period is counted from, so changing either once
 * something has been billed starts the new pattern the day after the last
 * period billed: a new pattern counted from the old first day would put
 * periods across ones already invoiced and bill those days twice. For the
 * same reason the first day can only move to after the last period billed.
 *
 * Saving an ended schedule starts it again, from the day after its last
 * period at the earliest.
 */
export function set(ctx: ServiceContext, input: ScheduleInput): Promise<ScheduleView> {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const seen = await replayed<ScheduleView>(tx, ctx, "contract_billing_schedule");
    if (seen) return seen;
    const contract = await loadContract(tx, input.contractId);
    const before = await scheduleOf(tx, contract.id);
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const description = input.description.trim();
    if (description === "") throw new ConflictError("Say what the invoice is for: the words the customer reads on the line.");

    const lastEnd = await lastWrittenEnd(tx, contract.id);
    const earliest = lastEnd ? time.addDays(lastEnd, 1) : null;
    const patternChanged = before !== null
      && (before.frequency !== input.frequency || before.billingDay !== input.billingDay);
    let startsOn = input.startsOn ?? before?.startsOn ?? contract.startsOn ?? today;
    if (earliest && startsOn < earliest) {
      /**
       * The same pattern from the same first day finds the periods already
       * billed by their first days, so nothing moves. Anything else would
       * count periods across ones already invoiced.
       */
      const same = before !== null && startsOn === before.startsOn && !patternChanged && before.state !== "ended";
      if (!same) {
        if (input.startsOn !== undefined && input.startsOn !== before?.startsOn) {
          throw new ConflictError(
            `This contract has been billed up to ${lastEnd}. The schedule can start again from ${earliest} at the earliest.`,
          );
        }
        startsOn = earliest;
      }
    }

    const problem = cb.scheduleProblem({
      amount: input.amount, frequency: input.frequency, billingDay: input.billingDay, startsOn, endsOn: contract.endsOn,
    });
    if (problem) throw new ConflictError(problem);

    const values = {
      amount: m.toString(usd(input.amount)),
      frequency: input.frequency,
      billingDay: input.billingDay,
      startsOn,
      prorate: input.prorate ?? before?.prorate ?? false,
      taxable: input.taxable ?? before?.taxable ?? false,
      description,
      updatedAt: new Date(),
    };
    if (before) {
      const restart = before.state === "ended" ? { state: "active" as const, endedOn: null, pausedOn: null } : {};
      const [after] = await tx.update(schema.contractBillingSchedule).set({ ...values, ...restart })
        .where(eq(schema.contractBillingSchedule.id, before.id)).returning();
      await audit(tx, ctx, "contract.billing_schedule_changed", "service_contract", contract.id, before, after);
    } else {
      const [after] = await tx.insert(schema.contractBillingSchedule).values({
        organizationId: ctx.actor.organizationId, contractId: contract.id, ...values,
      }).returning();
      await audit(tx, ctx, "contract.billing_schedule_set", "service_contract", contract.id, null, after);
    }
    const result = await viewWithin(tx, ctx.actor.organizationId, contract.id);
    await remember(tx, ctx, "contract_billing_schedule", contract.id, result);
    return result;
  });
}

async function scheduleOrRefuse(tx: Database, contractId: string): Promise<ScheduleRow> {
  const schedule = await scheduleOf(tx, contractId);
  if (!schedule) throw new ConflictError("This contract is not billed on a schedule. Set one up first.");
  return schedule;
}

/** Stop billing until it is resumed. Nothing is billed for a period whose billing day falls in between. */
export function pause(ctx: ServiceContext, input: { contractId: string }): Promise<ScheduleView> {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    await loadContract(tx, input.contractId);
    const schedule = await scheduleOrRefuse(tx, input.contractId);
    if (schedule.state === "paused") return viewWithin(tx, ctx.actor.organizationId, input.contractId);
    if (schedule.state === "ended") throw new ConflictError("This schedule has ended. Save it again to start it, rather than pausing it.");
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const [after] = await tx.update(schema.contractBillingSchedule)
      .set({ state: "paused", pausedOn: today, updatedAt: new Date() })
      .where(eq(schema.contractBillingSchedule.id, schedule.id)).returning();
    await audit(tx, ctx, "contract.billing_paused", "service_contract", input.contractId, schedule, after);
    return viewWithin(tx, ctx.actor.organizationId, input.contractId);
  });
}

/**
 * Start billing again from today.
 *
 * Each period whose billing day fell while it was paused is written down as
 * skipped, so the worker never bills it afterwards: a customer whose
 * contract was paused for three months is not sent three invoices the
 * morning it is resumed. A period owed from before the pause, which the
 * worker had not reached, is still owed and is billed as usual.
 */
export function resume(ctx: ServiceContext, input: { contractId: string }): Promise<ScheduleView> {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const contract = await loadContract(tx, input.contractId);
    const schedule = await scheduleOrRefuse(tx, input.contractId);
    if (schedule.state !== "paused" || !schedule.pausedOn) {
      return viewWithin(tx, ctx.actor.organizationId, input.contractId);
    }
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const written = await writtenStarts(tx, contract.id);
    const missed = cb.periodsThrough(termsOf(schedule, contract), today)
      .filter((p) => !written.has(p.start) && p.billOn >= schedule.pausedOn! && p.billOn < today);
    if (missed.length > 0) {
      await tx.insert(schema.contractBillingPeriod).values(missed.map((p) => ({
        organizationId: ctx.actor.organizationId,
        contractId: contract.id,
        scheduleId: schedule.id,
        periodStart: p.start, periodEnd: p.end, billOn: p.billOn,
        amount: m.toString(p.amount), prorated: p.prorated, days: p.days, fullDays: p.fullDays,
        status: "skipped" as const,
        note: `Not billed: the schedule was paused from ${schedule.pausedOn} to ${today}.`,
      }))).onConflictDoNothing();
    }
    const [after] = await tx.update(schema.contractBillingSchedule)
      .set({ state: "active", pausedOn: null, updatedAt: new Date() })
      .where(eq(schema.contractBillingSchedule.id, schedule.id)).returning();
    await audit(tx, ctx, "contract.billing_resumed", "service_contract", input.contractId, schedule, { ...after, skipped: missed.length });
    return viewWithin(tx, ctx.actor.organizationId, input.contractId);
  });
}

/**
 * End the schedule on a last day, today unless another is given.
 *
 * Periods up to that day are still billed (one that has started is billed
 * cut at the last day, prorated when the schedule prorates), and nothing
 * after it. A period already invoiced past the last day keeps its invoice:
 * whether to credit the rest is decided on that invoice.
 */
export function end(ctx: ServiceContext, input: { contractId: string; lastDay?: string | undefined }): Promise<ScheduleView> {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    await loadContract(tx, input.contractId);
    const schedule = await scheduleOrRefuse(tx, input.contractId);
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const lastDay = input.lastDay ?? today;
    if (lastDay < time.addDays(schedule.startsOn, -1)) {
      throw new ConflictError(`The schedule's first day is ${schedule.startsOn}. Its last day cannot be before it.`);
    }
    const [after] = await tx.update(schema.contractBillingSchedule)
      .set({ state: "ended", endedOn: lastDay, updatedAt: new Date() })
      .where(eq(schema.contractBillingSchedule.id, schedule.id)).returning();
    await audit(tx, ctx, "contract.billing_ended", "service_contract", input.contractId, schedule, after);
    return viewWithin(tx, ctx.actor.organizationId, input.contractId);
  });
}

/* -------------------------------------------------------------- raising */

export interface Raised {
  contractId: string;
  periodStart: string;
  periodEnd: string;
  invoiceId: string;
  invoiceNumber: number;
  total: string;
}

/**
 * Raise one period as an invoice, claiming it first.
 *
 * The row goes in before the invoice and inside the same transaction, so
 * whoever inserts it is the one who bills it, and an invoice that fails
 * (a closed month, a tax rate gone) takes the claim back with it.
 */
async function raisePeriod(
  tx: Database, ctx: ServiceContext, schedule: ScheduleRow, contract: ContractRow, period: cb.Period, today: string,
): Promise<Raised | null> {
  const [claimed] = await tx.insert(schema.contractBillingPeriod).values({
    organizationId: ctx.actor.organizationId,
    contractId: contract.id,
    scheduleId: schedule.id,
    periodStart: period.start, periodEnd: period.end, billOn: period.billOn,
    amount: m.toString(period.amount), prorated: period.prorated, days: period.days, fullDays: period.fullDays,
    status: "invoiced",
  }).onConflictDoNothing().returning({ id: schema.contractBillingPeriod.id });
  if (!claimed) return null;

  /** The customer's own terms: due that many days after it is raised, or on receipt with none. */
  const [payer] = await tx.select({ terms: schema.customer.paymentTermsDays })
    .from(schema.customer).where(eq(schema.customer.id, contract.customerId)).limit(1);
  const termsDays = Number(payer?.terms ?? "0");
  const words = cb.periodWords(period.start, period.end);
  const { idempotencyKey: _key, ...plain } = ctx;
  const invoice = await billing.createIn(tx, plain, {
    customerId: contract.customerId,
    ...(contract.purchaseOrderNumber ? { purchaseOrderNumber: contract.purchaseOrderNumber } : {}),
    ...(Number.isInteger(termsDays) && termsDays > 0 ? { dueOn: time.addDays(today, termsDays) } : {}),
    memo: `${contract.name}${contract.contractNumber ? `, contract ${contract.contractNumber}` : ""}: ${words}.`,
    lines: [{
      name: schedule.description,
      description: words,
      quantity: "1",
      unitPrice: m.toString(period.amount),
      discountAmount: "0",
      taxable: schedule.taxable,
    }],
  }, {
    prepared: [{
      unitPrice: period.amount,
      quantity: "1",
      authority: "contract",
      basis: "contract_fee",
      note: `${contract.name}: ${cb.periodNote(period, usd(schedule.amount))}`,
      rateCardId: null,
      rateCardLineId: null,
    }],
    /** A contract's fee is the contract's price: no member discount comes off it. */
    memberPricing: false,
  });
  await tx.update(schema.contractBillingPeriod).set({ invoiceId: invoice.id as string, updatedAt: new Date() })
    .where(eq(schema.contractBillingPeriod.id, claimed.id));
  await audit(tx, ctx, "contract.period_billed", "service_contract", contract.id, null, {
    periodStart: period.start, periodEnd: period.end, invoiceId: invoice.id, amount: m.toString(period.amount),
  });
  return {
    contractId: contract.id,
    periodStart: period.start,
    periodEnd: period.end,
    invoiceId: invoice.id as string,
    invoiceNumber: invoice.number as number,
    total: invoice.total as string,
  };
}

/**
 * Everything owed today on one company's schedules, or one contract's.
 *
 * Each schedule in its own savepoint, so one that cannot be billed (its
 * customer exempt on a lapsed certificate, a closed month) is reported and
 * the others are still billed.
 */
async function raiseWithin(
  tx: Database, ctx: ServiceContext, contractId?: string,
): Promise<{ raised: Raised[]; failed: Array<{ contractId: string; reason: string }> }> {
  const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
  const schedules = await tx.select().from(schema.contractBillingSchedule)
    .where(contractId ? eq(schema.contractBillingSchedule.contractId, contractId) : sql`true`)
    .orderBy(asc(schema.contractBillingSchedule.createdAt));
  const raised: Raised[] = [];
  const failed: Array<{ contractId: string; reason: string }> = [];
  for (const schedule of schedules) {
    try {
      const done = await tx.transaction(async (sp) => {
        const inner = sp as unknown as Database;
        const contract = await loadContract(inner, schedule.contractId);
        const out: Raised[] = [];
        for (const period of (await owed(inner, schedule, contract, today)).slice(0, AT_ONCE)) {
          const one = await raisePeriod(inner, ctx, schedule, contract, period, today);
          if (one) out.push(one);
        }
        return out;
      });
      raised.push(...done);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      failed.push({ contractId: schedule.contractId, reason: (error as Error).message });
    }
  }
  return { raised, failed };
}

/**
 * Raise what is owed now, from the contract's screen or the API, rather than
 * waiting for the worker. `invoice:write`, because it raises invoices; the
 * same claim on the period means it cannot bill anything the worker did.
 */
export function raiseDue(ctx: ServiceContext, input: { contractId: string }) {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<{ raised: Raised[]; failed: Array<{ contractId: string; reason: string }> }>(tx, ctx, "contract_billing_raise");
    if (seen) return seen;
    await loadContract(tx, input.contractId);
    const result = await raiseWithin(tx, ctx, input.contractId);
    if (result.failed.length > 0) throw new ConflictError(result.failed.map((f) => f.reason).join(" "));
    await remember(tx, ctx, "contract_billing_raise", input.contractId, result);
    return result;
  });
}

/* --------------------------------------------------------- on the clock */

/** The worker bills as nobody in particular, with only what raising an invoice needs. */
const billingActor = (organizationId: string): Actor => ({
  userId: SYSTEM_USER_ID, organizationId, roles: [],
  grants: ["invoice:write", "invoice:read", "contract:read", "customer:read"],
  agentId: "contract-billing",
});

let lastPass: number | null = null;

export interface BillingPassResult {
  organizationId: string;
  raised: Raised[];
  failed: Array<{ contractId: string; reason: string }>;
  error: string | null;
}

/**
 * CONTRACT FEES RAISED ON THEIR BILLING DAY.
 *
 * On the worker's pass, for each company with a running schedule, every
 * period whose billing day has come in the company's calendar and that is
 * not written yet. Once a minute at most per process: a billing day is a
 * date, and nothing gains from asking more often. Each company's failure is
 * kept to that company, and a period not raised on this pass is raised on
 * the next, never twice, because the period's row is the claim.
 */
export async function billingPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<BillingPassResult[]> {
  const now = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && now - lastPass < 60_000 && now >= lastPass) return [];
  lastPass = now;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.contract_billing_organizations(${options.limit ?? 200})`,
  );
  const results: BillingPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    results.push(await billingFor(db, row.organization_id));
  }
  return results;
}

/** One company's schedules, as the pass bills them. */
export async function billingFor(db: Database, organizationId: string): Promise<BillingPassResult> {
  const ctx: ServiceContext = { actor: billingActor(organizationId), db };
  try {
    const done = await inTenant(ctx, (tx) => raiseWithin(tx, { ...ctx, db: tx }));
    return { organizationId, raised: done.raised, failed: done.failed, error: null };
  } catch (error) {
    return { organizationId, raised: [], failed: [], error: (error as Error).message };
  }
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getContractBilling: (ctx: ServiceContext, input: { contractId: string }) => view(ctx, input),
  setContractBilling: (ctx: ServiceContext, input: ScheduleInput) => set(ctx, input),
  pauseContractBilling: (ctx: ServiceContext, input: { contractId: string }) => pause(ctx, input),
  resumeContractBilling: (ctx: ServiceContext, input: { contractId: string }) => resume(ctx, input),
  endContractBilling: (ctx: ServiceContext, input: { contractId: string; lastDay?: string | undefined }) => end(ctx, input),
  raiseContractBilling: (ctx: ServiceContext, input: { contractId: string }) => raiseDue(ctx, input),
} as const;
