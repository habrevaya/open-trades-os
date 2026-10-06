import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, payExtras as px, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { closedPeriodCovering } from "./payroll";
import { technicianScopeFilter } from "./scope";
import { remember, replayed } from "./once";

/**
 * CASH TIPS A TECHNICIAN KEPT, FROM THE OFFICE'S SIDE
 *
 * A customer hands a technician a twenty for themselves. It never reaches the
 * company, so nothing about it is booked, but it is still pay, and a tip an
 * employee keeps is reported through payroll as a `cash_tip` line (M17). The
 * technician records it on the phone; this is for when they did not, or got it
 * wrong, and the office knows because the customer said so.
 *
 * The office can RECORD one for a technician and CORRECT one, each with a
 * reason, each audited, and the technician sees both on `/me/pay`. A
 * correction keeps the amount before and after and who changed it, and a
 * correction to nothing is how a tip that was never given comes off their pay.
 *
 * NEVER INTO A PERIOD THAT HAS GONE. A tip in a pay period that has been closed
 * is on a file the bureau already has, so recording or changing one there is
 * refused and says to reopen the period first, as a backdated commission is.
 *
 * `tip:record`, narrowed to the people the reader's timesheet scope reaches, so
 * a branch manager answers for their own branch's people. A technician reads
 * their own with `payroll:own` and nobody else's, by any id.
 */

export interface CashTipView {
  id: string;
  technicianId: string;
  technicianName: string;
  jobId: string | null;
  jobNumber: number | null;
  amount: string;
  receivedAt: Date;
  /** The technician's own note, or for one the office recorded, why it did. */
  note: string | null;
  /** Who put it on their pay: they did from the phone, or somebody in the office. */
  recordedBy: "technician" | "office";
  recordedByName: string | null;
  /** Every change since, oldest first. */
  corrections: {
    previousAmount: string; newAmount: string; reason: string; correctedByName: string | null; at: Date;
  }[];
}

async function views(tx: Database, where: ReturnType<typeof and>, limit: number): Promise<CashTipView[]> {
  const rows = await tx.select({
    tip: schema.cashTip,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
  }).from(schema.cashTip)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.cashTip.technicianId))
    .leftJoin(schema.job, eq(schema.job.id, schema.cashTip.jobId))
    .where(where)
    .orderBy(desc(schema.cashTip.receivedAt), desc(schema.cashTip.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const changes = await tx.select().from(schema.cashTipCorrection)
    .where(inArray(schema.cashTipCorrection.cashTipId, rows.map((r) => r.tip.id)))
    .orderBy(asc(schema.cashTipCorrection.createdAt), asc(schema.cashTipCorrection.id));
  return rows.map(({ tip, technicianName, jobNumber }) => ({
    id: tip.id,
    technicianId: tip.technicianId,
    technicianName,
    jobId: tip.jobId,
    jobNumber: jobNumber ?? null,
    amount: tip.amount,
    receivedAt: tip.receivedAt,
    note: tip.note,
    recordedBy: tip.recordedByUserId ? "office" : "technician",
    recordedByName: tip.recordedByName,
    corrections: changes.filter((c) => c.cashTipId === tip.id).map((c) => ({
      previousAmount: c.previousAmount, newAmount: c.newAmount, reason: c.reason,
      correctedByName: c.correctedByName, at: c.createdAt,
    })),
  }));
}

const inScope = (ctx: ServiceContext) => {
  const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  return people === undefined ? undefined : sql`exists (
    select 1 from public.technician where ${schema.technician.id} = ${schema.cashTip.technicianId} and ${people}
  )`;
};

/** How long a reason may be. */
const REASON_MAX = 500;

function reasonOf(value: string | null | undefined, what: string): string {
  const reason = (value ?? "").trim();
  if (reason === "") throw new ConflictError(`Say ${what}. The technician reads it, and so does whoever audits their pay.`);
  return reason.slice(0, REASON_MAX);
}

async function selfName(tx: Database, ctx: ServiceContext): Promise<string | null> {
  const [self] = await tx.select({ name: schema.user.name, email: schema.user.email }).from(schema.user)
    .where(eq(schema.user.id, ctx.actor.userId)).limit(1);
  return self?.name ?? self?.email ?? null;
}

async function refuseIfClosed(tx: Database, ctx: ServiceContext, instant: Date): Promise<void> {
  const closed = await closedPeriodCovering(tx, ctx.actor.organizationId, instant);
  if (closed) {
    throw new ConflictError(
      `${closed.label} is closed and has gone to payroll, so a tip in it cannot be added or changed. Reopen it first.`,
    );
  }
}

export interface RecordInput {
  technicianId: string;
  /** The tip, in dollars and cents. */
  amount: string;
  /** The day it was handed over, in the company's calendar. Today when left out. */
  receivedOn?: string | undefined;
  /** The job it was for, by number, when it was for one. */
  jobNumber?: number | undefined;
  /** Why the office is recording it, which the technician reads. Required. */
  reason: string;
}

/**
 * Put a cash tip on a technician's pay.
 *
 * The same figure on the same day for the same job that the technician has
 * already recorded from the phone is refused as a likely duplicate and says
 * so, because paying tax on a tip twice is the mistake this would otherwise
 * make easy. The reason is how the office says it was not the same one.
 */
export async function recordFor(ctx: ServiceContext, input: RecordInput): Promise<CashTipView> {
  return guardedWrite(ctx, "tip:record", async (tx) => {
    const again = await replayed<CashTipView>(tx, ctx, "cash_tip_record");
    if (again) return again;

    const checked = px.checkTipAmount(input.amount);
    if (!checked.ok) throw new ConflictError(checked.reason);
    const reason = reasonOf(input.reason, "why you are recording this tip");

    const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
    const [person] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.technicianId),
        people === undefined ? undefined : people,
      )).limit(1);
    if (!person) throw new NotFoundError("Technician");

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    let receivedAt = new Date();
    if (input.receivedOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn) || Number.isNaN(Date.parse(`${input.receivedOn}T00:00:00Z`))) {
        throw new ConflictError("Say the day the tip was handed over.");
      }
      if (input.receivedOn > today) throw new ConflictError("That day has not happened yet.");
      if (input.receivedOn < time.addDays(today, -366)) throw new ConflictError("That is more than a year ago.");
      /** Noon, so the tip sits in the middle of its day whichever way a clock change leans. */
      receivedAt = time.instantOfLocal(input.receivedOn, 12 * 60, zone);
    }
    await refuseIfClosed(tx, ctx, receivedAt);

    let jobId: string | null = null;
    if (input.jobNumber !== undefined) {
      const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(eq(schema.job.number, input.jobNumber), isNull(schema.job.deletedAt))).limit(1);
      if (!job) throw new ConflictError(`There is no job ${input.jobNumber}. Check the number, or leave it empty.`);
      jobId = job.id;
    }

    const day = time.dayBoundsIn(time.dateIn(receivedAt, zone), zone);
    const [alike] = await tx.select({ id: schema.cashTip.id }).from(schema.cashTip)
      .where(and(
        eq(schema.cashTip.technicianId, input.technicianId),
        eq(schema.cashTip.amount, m.toString(checked.amount)),
        gte(schema.cashTip.receivedAt, day.start),
        sql`${schema.cashTip.receivedAt} < ${day.end.toISOString()}::timestamptz`,
        jobId ? eq(schema.cashTip.jobId, jobId) : undefined,
      )).limit(1);
    if (alike) {
      throw new ConflictError(
        "They already have a tip of that amount on that day. If this is a second one, correct that tip or give it another amount, "
        + "so their pay does not carry it twice.",
      );
    }

    const [row] = await tx.insert(schema.cashTip).values({
      /** A cash tip's id has no default: the phone makes its own, and the office makes one here. */
      id: randomUUID(),
      organizationId: ctx.actor.organizationId,
      technicianId: input.technicianId,
      jobId,
      amount: m.toString(checked.amount),
      receivedAt,
      note: reason,
      recordedByUserId: ctx.actor.userId,
      recordedByName: await selfName(tx, ctx),
    }).returning({ id: schema.cashTip.id });
    await audit(tx, ctx, "tip.cash_recorded_by_office", "cash_tip", row!.id, null, {
      technicianId: input.technicianId, amount: m.toString(checked.amount), jobId, reason,
    });

    const [view] = await views(tx, eq(schema.cashTip.id, row!.id), 1);
    await remember(tx, ctx, "cash_tip_record", row!.id, JSON.parse(JSON.stringify(view!)));
    return view!;
  });
}

/**
 * Change what a cash tip was, with the reason. Zero takes it off their pay.
 * The amounts before and after, the reason and who changed it are kept and
 * shown to the technician.
 */
export async function correct(
  ctx: ServiceContext, input: { id: string; amount: string; reason: string },
): Promise<CashTipView> {
  return guardedWrite(ctx, "tip:record", async (tx) => {
    const again = await replayed<CashTipView>(tx, ctx, "cash_tip_correction");
    if (again) return again;

    const checked = px.checkTipAmount(input.amount, { allowZero: true });
    if (!checked.ok) throw new ConflictError(checked.reason);
    const reason = reasonOf(input.reason, "why the tip is being changed");

    const [row] = await tx.select().from(schema.cashTip)
      .where(and(eq(schema.cashTip.id, input.id), inScope(ctx))).limit(1).for("update");
    if (!row) throw new NotFoundError("Cash tip");
    if (m.compare(m.money(row.amount), checked.amount) === 0) {
      throw new ConflictError("That is already the amount. Nothing to change.");
    }
    await refuseIfClosed(tx, ctx, row.receivedAt);

    const name = await selfName(tx, ctx);
    await tx.insert(schema.cashTipCorrection).values({
      organizationId: ctx.actor.organizationId,
      cashTipId: row.id,
      previousAmount: row.amount,
      newAmount: m.toString(checked.amount),
      reason,
      correctedByUserId: ctx.actor.userId,
      correctedByName: name,
    });
    await tx.update(schema.cashTip).set({ amount: m.toString(checked.amount), updatedAt: new Date() })
      .where(eq(schema.cashTip.id, row.id));
    await audit(tx, ctx, "tip.cash_corrected", "cash_tip", row.id,
      { amount: row.amount }, { amount: m.toString(checked.amount), reason });

    const [view] = await views(tx, eq(schema.cashTip.id, row.id), 1);
    const answer = JSON.parse(JSON.stringify(view!)) as CashTipView;
    await remember(tx, ctx, "cash_tip_correction", row.id, answer);
    return view!;
  });
}

/** How far back the office's list goes. */
const LIST_DAYS = 120;

/** The cash tips on the pay of the people the reader answers for, newest first. */
export async function list(ctx: ServiceContext, input: { technicianId?: string | undefined } = {}): Promise<CashTipView[]> {
  return guardedRead(ctx, "tip:record", async (tx) => views(tx, and(
    eq(schema.cashTip.organizationId, ctx.actor.organizationId),
    gte(schema.cashTip.receivedAt, new Date(Date.now() - LIST_DAYS * 86_400_000)),
    inScope(ctx),
    input.technicianId ? eq(schema.cashTip.technicianId, input.technicianId) : undefined,
  ), 300));
}

/** Your own, whoever recorded them, and every change made to each. */
export async function mine(ctx: ServiceContext): Promise<{ technician: boolean; tips: CashTipView[] }> {
  return guardedRead(ctx, "payroll:own", async (tx) => {
    const [own] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(and(
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.membership.userId, ctx.actor.userId),
        eq(schema.membership.active, true),
      )).limit(1);
    if (!own) return { technician: false, tips: [] };
    return {
      technician: true,
      tips: await views(tx, and(
        eq(schema.cashTip.technicianId, own.id),
        gte(schema.cashTip.receivedAt, new Date(Date.now() - LIST_DAYS * 86_400_000)),
      ), 200),
    };
  });
}

export const handlers = {
  recordCashTipFor: (ctx: ServiceContext, input: RecordInput) => recordFor(ctx, input),
  correctCashTip: (ctx: ServiceContext, input: { id: string; amount: string; reason: string }) => correct(ctx, input),
  listCashTips: async (ctx: ServiceContext, input: { technicianId?: string | undefined }) =>
    ({ tips: await list(ctx, input) }),
  listMyCashTips: (ctx: ServiceContext) => mine(ctx),
} as const;
