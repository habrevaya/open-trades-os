import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, money as m, payExtras as px, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { attach, bytesOf, decode, put } from "./files";
import { closedPeriodCovering, periodFinder } from "./payroll";
import { settingsWithin } from "./pay-extras";
import { technicianScopeFilter } from "./scope";
import { remember, replayed } from "./once";

/**
 * WHAT A PERSON PAID FOR THE COMPANY, AND A DAY AWAY
 *
 * A technician buys a part, pays a toll or eats two hours from home. They
 * record it with a photograph of the receipt and the job it was for, the
 * office approves or refuses it with a reason, and an approved one goes to the
 * payroll bureau as a non-taxable reimbursement line in the pay period it was
 * approved in. A per diem is the company's flat allowance for a day away,
 * recorded by the office against the job, and exported the same way.
 *
 * NOTHING HERE POSTS TO THE LEDGER. What the company owes a person for a
 * receipt is a payable, and whether this product books payables is the
 * question receiving stock left unanswered (M16). The cost is on the job
 * through M15's costing, which is where an owner reads it, and the money is
 * paid through payroll. Posting it as well would be two places for the same
 * money to be wrong.
 *
 * WHO. A person records their own and sees their own (`expense:own`, in every
 * preset); never anybody else's, and the person is the phone's or the session's,
 * never one the payload names. Deciding, and recording a day away, is
 * `expense:approve`, narrowed to the people the approver's timesheet scope
 * reaches, so a branch manager decides their own branch's.
 *
 * A DECISION IS FINAL. Approved is what the payroll file is built from and
 * refused is what the person has been told, so neither is edited afterwards:
 * a wrong approval is put right with the bureau, a wrong refusal by the person
 * recording it again. Both are said on the screen that decides.
 */

/* ------------------------------------------------------------------ views */

export interface ExpenseView {
  id: string;
  technicianId: string;
  technicianName: string;
  jobId: string | null;
  jobNumber: number | null;
  amount: string;
  spentOn: string;
  description: string;
  status: "pending" | "approved" | "refused";
  recordedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionReason: string | null;
  /** Photographs kept with it. Zero is said to the office, because it is theirs to accept or ask for. */
  receipts: number;
  /** For an approved one: the pay period it goes out in. Null when no period covers the day it was approved. */
  paidIn: { id: string; label: string; closed: boolean } | null;
}

export interface PerDiemView {
  id: string;
  technicianId: string;
  technicianName: string;
  jobId: string;
  jobNumber: number;
  day: string;
  amount: string;
  note: string | null;
  paidIn: { id: string; label: string; closed: boolean } | null;
}

const RECEIPTS = sql<number>`(select count(*)::int from public.attachment a
  where a.entity_type = 'expense' and a.entity_id = "expense"."id" and a.deleted_at is null)`;

type Found = ReturnType<typeof periodFinder> extends Promise<infer F> ? F : never;

async function viewsOf(
  tx: Database, ctx: ServiceContext, where: ReturnType<typeof and>, limit: number,
): Promise<ExpenseView[]> {
  const rows = await tx.select({
    expense: schema.expense,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
    receipts: RECEIPTS,
  }).from(schema.expense)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.expense.technicianId))
    .leftJoin(schema.job, eq(schema.job.id, schema.expense.jobId))
    .where(where)
    /** Waiting first, because that is the queue, then the newest. */
    .orderBy(
      sql`case ${schema.expense.status} when 'pending' then 0 else 1 end`,
      desc(schema.expense.recordedAt), desc(schema.expense.id),
    )
    .limit(limit);
  const find: Found = rows.some((r) => r.expense.status === "approved")
    ? await periodFinder(tx, ctx.actor.organizationId) : () => null;
  return rows.map(({ expense, technicianName, jobNumber, receipts }) => {
    const period = expense.status === "approved" && expense.decidedAt ? find(expense.decidedAt) : null;
    return {
      id: expense.id,
      technicianId: expense.technicianId,
      technicianName,
      jobId: expense.jobId,
      jobNumber: jobNumber ?? null,
      amount: expense.amount,
      spentOn: expense.spentOn,
      description: expense.description,
      status: expense.status,
      recordedAt: expense.recordedAt,
      decidedAt: expense.decidedAt,
      decidedByName: expense.decidedByName,
      decisionReason: expense.decisionReason,
      receipts,
      paidIn: period ? { id: period.id, label: period.label, closed: period.closedAt !== null } : null,
    };
  });
}

/** The people the caller's timesheet scope reaches, as a condition on an expense's person. */
const inScope = (ctx: ServiceContext) => {
  const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  return people === undefined ? undefined : sql`exists (
    select 1 from public.technician where ${schema.technician.id} = ${schema.expense.technicianId} and ${people}
  )`;
};

/** The signed in person's own place on the board, or none. */
async function ownTechnician(tx: Database, ctx: ServiceContext): Promise<{ id: string; name: string } | null> {
  const [row] = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician)
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      eq(schema.membership.userId, ctx.actor.userId),
      eq(schema.membership.active, true),
    )).limit(1);
  return row ?? null;
}

/* -------------------------------------------------------------- recording */

export interface ExpenseInput {
  /** Made by the phone, so a retried sync records it once. The server makes one when it is left out. */
  id?: string | undefined;
  jobId?: string | null | undefined;
  /** The job by the number the office calls it, for a person typing it in. Ignored when `jobId` is given. */
  jobNumber?: number | undefined;
  amount: string;
  spentOn: string;
  description: string;
  /** When the person recorded it, by the phone's clock for one made offline. */
  recordedAt?: Date | undefined;
}

export interface Photo { fileName: string; contentType?: string | undefined; bytes: string }

/**
 * Record one, for a person already known to be a technician. The phone's
 * queue and the web form both come through here, so there is one set of rules.
 *
 * The same id sent again is the first one back and changes nothing, even if
 * somebody has decided it since, so a phone that lost the response and sends
 * again is not told it did something wrong.
 */
export async function recordWithin(
  tx: Database, ctx: ServiceContext, technicianId: string, input: ExpenseInput,
): Promise<{ id: string; created: boolean }> {
  if (input.id) {
    const [seen] = await tx.select({ id: schema.expense.id, technicianId: schema.expense.technicianId })
      .from(schema.expense).where(eq(schema.expense.id, input.id)).limit(1);
    if (seen) {
      if (seen.technicianId !== technicianId) throw new ConflictError("That expense is somebody else's.");
      return { id: seen.id, created: false };
    }
  }
  const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
  const checked = px.checkExpense({ amount: input.amount, spentOn: input.spentOn, today, description: input.description });
  if (!checked.ok) throw new ConflictError(checked.reason);

  let jobId = input.jobId ?? null;
  if (jobId || input.jobNumber !== undefined) {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(
        jobId ? eq(schema.job.id, jobId) : eq(schema.job.number, input.jobNumber!),
        isNull(schema.job.deletedAt),
      )).limit(1);
    if (!job) {
      throw new ConflictError(jobId
        ? "That job is not here. Pick one from your day, or leave it empty for the shop."
        : `There is no job ${input.jobNumber}. Check the number, or leave it empty for the shop.`);
    }
    jobId = job.id;
  }
  const [row] = await tx.insert(schema.expense).values({
    ...(input.id ? { id: input.id } : {}),
    organizationId: ctx.actor.organizationId,
    technicianId,
    jobId,
    amount: m.toString(checked.amount),
    spentOn: input.spentOn,
    description: checked.description,
    ...(input.recordedAt ? { recordedAt: input.recordedAt } : {}),
  }).returning({ id: schema.expense.id });
  await audit(tx, ctx, "expense.recorded", "expense", row!.id, null, {
    technicianId, amount: m.toString(checked.amount), spentOn: input.spentOn, jobId,
  });
  return { id: row!.id, created: true };
}

/** A photograph of the receipt, kept and pointed at the expense. The same bytes twice are one receipt. */
export async function addReceiptWithin(
  tx: Database, ctx: ServiceContext, expenseId: string, photo: Photo,
): Promise<{ id: string }> {
  const { file } = await put(tx, ctx.actor.organizationId, {
    bytes: decode(photo.bytes), claimedType: photo.contentType, uploadedByUserId: ctx.actor.userId,
  });
  const [already] = await tx.select({ id: schema.attachment.id }).from(schema.attachment)
    .where(and(
      eq(schema.attachment.entityType, "expense"),
      eq(schema.attachment.entityId, expenseId),
      eq(schema.attachment.storageKey, file.storageKey),
      isNull(schema.attachment.deletedAt),
    )).limit(1);
  if (already) return { id: already.id };
  const { id } = await attach(tx, ctx.actor.organizationId, {
    entityType: "expense", entityId: expenseId, storageKey: file.storageKey,
    kind: file.contentType.startsWith("image/") ? "photo" : "document",
    fileName: photo.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes,
    uploadedByUserId: ctx.actor.userId,
  });
  await audit(tx, ctx, "expense.receipt_added", "expense", expenseId, null, { storageKey: file.storageKey });
  return { id };
}

/**
 * Record what you paid, from the web. Always the signed in person's own: the
 * call takes no person.
 */
export async function record(
  ctx: ServiceContext, input: ExpenseInput & { receipt?: Photo | undefined },
): Promise<ExpenseView> {
  return guardedWrite(ctx, "expense:own", async (tx) => {
    const own = await ownTechnician(tx, ctx);
    if (!own) {
      throw new ConflictError("You are not on the board, so there is nobody to pay this back to. Ask the office.");
    }
    const { id } = await recordWithin(tx, ctx, own.id, input);
    if (input.receipt) await addReceiptWithin(tx, ctx, id, input.receipt);
    const [view] = await viewsOf(tx, ctx, eq(schema.expense.id, id), 1);
    return view!;
  });
}

/** A receipt added to one of your own after the fact, while it is still waiting. */
export async function addReceipt(ctx: ServiceContext, input: { id: string; receipt: Photo }) {
  return guardedWrite(ctx, "expense:own", async (tx) => {
    const own = await ownTechnician(tx, ctx);
    const [row] = own ? await tx.select({ status: schema.expense.status }).from(schema.expense)
      .where(and(eq(schema.expense.id, input.id), eq(schema.expense.technicianId, own.id))).limit(1) : [];
    if (!row) throw new NotFoundError("Expense");
    if (row.status !== "pending") throw new ConflictError("The office has already answered this one, so a photograph can no longer be added to it.");
    return addReceiptWithin(tx, ctx, input.id, input.receipt);
  });
}

/* ---------------------------------------------------------------- reading */

export interface OwnExpenses {
  technician: boolean;
  expenses: ExpenseView[];
  perDiems: PerDiemView[];
}

/** How far back somebody's own list goes. */
const OWN_DAYS = 120;

/** Your own, newest first, and the days away you were paid for. */
export async function mine(ctx: ServiceContext): Promise<OwnExpenses> {
  return guardedRead(ctx, "expense:own", async (tx) => {
    const own = await ownTechnician(tx, ctx);
    if (!own) return { technician: false, expenses: [], perDiems: [] };
    const since = new Date(Date.now() - OWN_DAYS * 86_400_000);
    return {
      technician: true,
      expenses: await viewsOf(tx, ctx, and(
        eq(schema.expense.technicianId, own.id), gte(schema.expense.recordedAt, since),
      ), 200),
      perDiems: await perDiemViews(tx, ctx, and(
        eq(schema.perDiem.technicianId, own.id),
        gte(schema.perDiem.day, time.dateIn(since, await timezoneOf(tx, ctx.actor.organizationId))),
      ), 200),
    };
  });
}

export interface ExpenseFilter {
  status?: "pending" | "approved" | "refused" | undefined;
  technicianId?: string | undefined;
  jobId?: string | undefined;
}

/** Everybody's, for whoever decides, narrowed to the people their scope reaches. */
export async function list(ctx: ServiceContext, input: ExpenseFilter = {}) {
  return guardedRead(ctx, "expense:approve", async (tx) => {
    const expenses = await viewsOf(tx, ctx, and(
      eq(schema.expense.organizationId, ctx.actor.organizationId),
      inScope(ctx),
      input.status ? eq(schema.expense.status, input.status) : undefined,
      input.technicianId ? eq(schema.expense.technicianId, input.technicianId) : undefined,
      input.jobId ? eq(schema.expense.jobId, input.jobId) : undefined,
    ), 300);
    const [{ waiting } = { waiting: 0 }] = await tx.select({ waiting: sql<number>`count(*)::int` })
      .from(schema.expense)
      .where(and(eq(schema.expense.organizationId, ctx.actor.organizationId), eq(schema.expense.status, "pending"), inScope(ctx)));
    const settings = await settingsWithin(tx, ctx.actor.organizationId);
    return { expenses, waiting, perDiemRate: settings.perDiemRate };
  });
}

/**
 * The bytes of a receipt, for the person it is whose it is or whoever decides.
 * `index` is which photograph, oldest first. A receipt is somebody's own
 * money, so it is never served to anybody the scope does not reach.
 */
export async function receipt(
  ctx: ServiceContext, input: { id: string; index?: number | undefined },
): Promise<{ bytes: Buffer; contentType: string }> {
  assertCan(ctx.actor, "expense:own");
  return guardedRead(ctx, "expense:own", async (tx) => {
    const own = await ownTechnician(tx, ctx);
    const [row] = await tx.select({ technicianId: schema.expense.technicianId }).from(schema.expense)
      .where(eq(schema.expense.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Receipt");
    const mine = own !== null && row.technicianId === own.id;
    if (!mine) {
      /** Not theirs: only whoever decides, and only for the people their scope reaches. */
      assertCan(ctx.actor, "expense:approve");
      const [seen] = await tx.select({ id: schema.expense.id }).from(schema.expense)
        .where(and(eq(schema.expense.id, input.id), inScope(ctx))).limit(1);
      if (!seen) throw new NotFoundError("Receipt");
    }
    const [file] = await tx.select({ storage: schema.storedFile }).from(schema.attachment)
      .innerJoin(schema.storedFile, and(
        eq(schema.storedFile.organizationId, schema.attachment.organizationId),
        eq(schema.storedFile.storageKey, schema.attachment.storageKey),
      ))
      .where(and(
        eq(schema.attachment.entityType, "expense"),
        eq(schema.attachment.entityId, input.id),
        isNull(schema.attachment.deletedAt),
        isNull(schema.storedFile.deletedAt),
      ))
      .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))
      .offset(Math.max(0, input.index ?? 0)).limit(1);
    if (!file) throw new NotFoundError("Receipt");
    return { bytes: await bytesOf(file.storage), contentType: file.storage.contentType };
  });
}

/* --------------------------------------------------------------- deciding */

/**
 * Approve or refuse one that is waiting.
 *
 * A refusal says why, in words the person reads; an approval may. The instant
 * of approval is what puts it on a pay period, and an approval that would land
 * in a period already closed is refused, because it would change a file the
 * bureau already has. (The period containing "now" cannot be closed, so this
 * only fires when somebody has closed a period over the present by hand, which
 * the close itself already refuses.)
 *
 * The same decision again is the first answer back; the other decision is a
 * refusal that says who decided and when, because a decision is final.
 */
export async function decide(
  ctx: ServiceContext, input: { id: string; decision: "approve" | "refuse"; reason?: string | null | undefined },
): Promise<ExpenseView> {
  return guardedWrite(ctx, "expense:approve", async (tx) => {
    const [row] = await tx.select().from(schema.expense)
      .where(and(eq(schema.expense.id, input.id), inScope(ctx))).limit(1).for("update");
    if (!row) throw new NotFoundError("Expense");

    const wanted = input.decision === "approve" ? "approved" : "refused";
    if (row.status === wanted) return (await viewsOf(tx, ctx, eq(schema.expense.id, row.id), 1))[0]!;
    if (row.status !== "pending") {
      throw new ConflictError(
        `This was ${row.status} by ${row.decidedByName ?? "the office"}. A decision is final, because the payroll file is built from it. `
        + (row.status === "approved"
          ? "If it was a mistake, put it right with the payroll bureau."
          : "If it was a mistake, ask the person to record it again."),
      );
    }
    const reason = (input.reason ?? "").trim();
    if (wanted === "refused" && reason === "") {
      throw new ConflictError("Say why you are refusing it. The person reads this.");
    }

    const now = new Date();
    if (wanted === "approved") {
      const closed = await closedPeriodCovering(tx, ctx.actor.organizationId, now);
      if (closed) {
        throw new ConflictError(`${closed.label} is closed and covers today, so this cannot be added to it. Reopen it first.`);
      }
    }
    const [self] = await tx.select({ name: schema.user.name, email: schema.user.email }).from(schema.user)
      .where(eq(schema.user.id, ctx.actor.userId)).limit(1);
    await tx.update(schema.expense).set({
      status: wanted,
      decidedAt: now,
      decidedByUserId: ctx.actor.userId,
      decidedByName: self?.name ?? self?.email ?? null,
      decisionReason: reason === "" ? null : reason.slice(0, 500),
      updatedAt: now,
    }).where(eq(schema.expense.id, row.id));
    await audit(tx, ctx, `expense.${wanted}`, "expense", row.id, { status: row.status }, {
      status: wanted, amount: row.amount, reason: reason === "" ? null : reason,
    });
    return (await viewsOf(tx, ctx, eq(schema.expense.id, row.id), 1))[0]!;
  });
}

/* --------------------------------------------------------------- per diem */

async function perDiemViews(
  tx: Database, ctx: ServiceContext, where: ReturnType<typeof and>, limit: number,
): Promise<PerDiemView[]> {
  const rows = await tx.select({
    perDiem: schema.perDiem,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
  }).from(schema.perDiem)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.perDiem.technicianId))
    .innerJoin(schema.job, eq(schema.job.id, schema.perDiem.jobId))
    .where(where)
    .orderBy(desc(schema.perDiem.day), desc(schema.perDiem.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const find = await periodFinder(tx, ctx.actor.organizationId);
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  return rows.map(({ perDiem, technicianName, jobNumber }) => {
    const period = find(time.startOfDayIn(perDiem.day, zone));
    return {
      id: perDiem.id,
      technicianId: perDiem.technicianId,
      technicianName,
      jobId: perDiem.jobId,
      jobNumber,
      day: perDiem.day,
      amount: perDiem.amount,
      note: perDiem.note,
      paidIn: period ? { id: period.id, label: period.label, closed: period.closedAt !== null } : null,
    };
  });
}

const personInScope = (ctx: ServiceContext, technicianId: string) => {
  const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
  return people === undefined ? sql`true` : sql`exists (
    select 1 from public.technician where ${schema.technician.id} = ${technicianId} and ${people}
  )`;
};

export interface PerDiemInput {
  technicianId: string;
  /** The job they were away on, by id or by the number the office calls it. One of the two. */
  jobId?: string | undefined;
  jobNumber?: number | undefined;
  /** The first and last day away, both included. */
  from: string;
  to: string;
  note?: string | null | undefined;
}

export interface PerDiemResult {
  /** The days newly recorded. */
  recorded: string[];
  /** Days that already had one for this person, left as they were. */
  alreadyHad: string[];
  /** What one day is worth, as it stood when these were recorded. */
  rate: string;
}

/**
 * Record the company's rate for each day somebody was away on a job.
 *
 * The rate is the company's current one and is frozen onto each day. A day that
 * already has one for this person is left alone and named, so asking again for
 * a longer stretch adds the new days and nothing twice. A day inside a pay
 * period that has been closed is refused outright: the file for it has gone.
 */
export async function recordPerDiem(ctx: ServiceContext, input: PerDiemInput): Promise<PerDiemResult> {
  return guardedWrite(ctx, "expense:approve", async (tx) => {
    const again = await replayed<PerDiemResult>(tx, ctx, "per_diem_batch");
    if (again) return again;

    const days = px.daysAway(input.from, input.to);
    if (!days.ok) throw new ConflictError(days.reason);

    const settings = await settingsWithin(tx, ctx.actor.organizationId);
    if (!settings.perDiemRate) {
      throw new ConflictError("No per diem rate is set. Say what a day away is worth on Pay rules first.");
    }
    const [person] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(and(eq(schema.technician.id, input.technicianId), personInScope(ctx, input.technicianId))).limit(1);
    if (!person) throw new NotFoundError("Technician");
    if (!input.jobId && input.jobNumber === undefined) throw new ConflictError("Say which job they were away on.");
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(
        input.jobId ? eq(schema.job.id, input.jobId) : eq(schema.job.number, input.jobNumber!),
        isNull(schema.job.deletedAt),
      )).limit(1);
    if (!job) throw new ConflictError(input.jobId ? "That job is not here." : `There is no job ${input.jobNumber}.`);

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const find = await periodFinder(tx, ctx.actor.organizationId);
    for (const day of days.days) {
      const period = find(time.startOfDayIn(day, zone));
      if (period?.closedAt) {
        throw new ConflictError(`${day} is in ${period.label}, which is closed and has gone to payroll. Reopen it first, or leave that day out.`);
      }
    }

    const had = await tx.select({ day: schema.perDiem.day }).from(schema.perDiem)
      .where(and(
        eq(schema.perDiem.technicianId, input.technicianId),
        inArray(schema.perDiem.day, days.days),
      ));
    const alreadyHad = new Set(had.map((r) => r.day));
    const fresh = days.days.filter((d) => !alreadyHad.has(d));
    if (fresh.length > 0) {
      await tx.insert(schema.perDiem).values(fresh.map((day) => ({
        organizationId: ctx.actor.organizationId,
        technicianId: input.technicianId,
        jobId: job.id,
        day,
        amount: settings.perDiemRate!,
        recordedByUserId: ctx.actor.userId,
        note: input.note?.trim() ? input.note.trim().slice(0, 300) : null,
      })));
      await audit(tx, ctx, "per_diem.recorded", "technician", input.technicianId, null, {
        jobId: job.id, days: fresh, rate: settings.perDiemRate,
      });
    }
    const answer: PerDiemResult = {
      recorded: fresh,
      alreadyHad: days.days.filter((d) => alreadyHad.has(d)),
      rate: settings.perDiemRate,
    };
    await remember(tx, ctx, "per_diem_batch", null, answer);
    return answer;
  });
}

export async function listPerDiem(
  ctx: ServiceContext, input: { technicianId?: string | undefined; jobId?: string | undefined; from?: string | undefined; to?: string | undefined },
): Promise<PerDiemView[]> {
  return guardedRead(ctx, "expense:approve", async (tx) => {
    const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
    return perDiemViews(tx, ctx, and(
      eq(schema.perDiem.organizationId, ctx.actor.organizationId),
      people === undefined ? undefined : sql`exists (
        select 1 from public.technician where ${schema.technician.id} = ${schema.perDiem.technicianId} and ${people}
      )`,
      input.technicianId ? eq(schema.perDiem.technicianId, input.technicianId) : undefined,
      input.jobId ? eq(schema.perDiem.jobId, input.jobId) : undefined,
      input.from ? gte(schema.perDiem.day, input.from) : undefined,
      input.to ? sql`${schema.perDiem.day} <= ${input.to}` : undefined,
    ), 300);
  });
}

/**
 * Take a day away back out, for one recorded against the wrong person or job.
 * Refused once the pay period it falls in has been closed, because the file
 * for it has gone.
 */
export async function removePerDiem(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "expense:approve", async (tx) => {
    const people = technicianScopeFilter(scopeOf(ctx, "timesheet"), ctx.actor);
    const [row] = await tx.select().from(schema.perDiem)
      .where(and(
        eq(schema.perDiem.id, input.id),
        people === undefined ? undefined : sql`exists (
          select 1 from public.technician where ${schema.technician.id} = ${schema.perDiem.technicianId} and ${people}
        )`,
      )).limit(1).for("update");
    if (!row) throw new NotFoundError("Per diem");
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const period = (await periodFinder(tx, ctx.actor.organizationId))(time.startOfDayIn(row.day, zone));
    if (period?.closedAt) {
      throw new ConflictError(`${row.day} is in ${period.label}, which is closed and has gone to payroll. Reopen it first.`);
    }
    await tx.delete(schema.perDiem).where(eq(schema.perDiem.id, row.id));
    await audit(tx, ctx, "per_diem.removed", "technician", row.technicianId, row, null);
    return { id: row.id, removed: true };
  });
}

/* ------------------------------------------------------------- on a job */

export interface JobExpenses {
  /** Approved only: what the company has agreed to pay back. */
  reimbursements: ExpenseView[];
  perDiems: PerDiemView[];
  /** What the two come to, which is what the job's cost carries (M15). */
  total: string;
}

/**
 * What the company has agreed to pay people for one job, which its costing
 * counts. `job.cost:read`, because it is a cost.
 */
export async function forJob(ctx: ServiceContext, input: { jobId: string }): Promise<JobExpenses> {
  return guardedRead(ctx, "job.cost:read", async (tx) => {
    const reimbursements = await viewsOf(tx, ctx, and(
      eq(schema.expense.jobId, input.jobId), eq(schema.expense.status, "approved"),
    ), 200);
    const perDiems = await perDiemViews(tx, ctx, eq(schema.perDiem.jobId, input.jobId), 200);
    const total = m.sum([
      ...reimbursements.map((r) => m.money(r.amount)),
      ...perDiems.map((p) => m.money(p.amount)),
    ], "USD");
    return { reimbursements, perDiems, total: m.toString(total) };
  });
}

export const handlers = {
  recordExpense: (ctx: ServiceContext, input: ExpenseInput & { receipt?: Photo | undefined }) => record(ctx, input),
  addExpenseReceipt: (ctx: ServiceContext, input: { id: string; receipt: Photo }) => addReceipt(ctx, input),
  listMyExpenses: (ctx: ServiceContext) => mine(ctx),
  listExpenses: (ctx: ServiceContext, input: ExpenseFilter) => list(ctx, input),
  decideExpense: (ctx: ServiceContext, input: { id: string; decision: "approve" | "refuse"; reason?: string | null | undefined }) =>
    decide(ctx, input),
  recordPerDiem: (ctx: ServiceContext, input: PerDiemInput) => recordPerDiem(ctx, input),
  listPerDiem: (ctx: ServiceContext, input: { technicianId?: string | undefined; jobId?: string | undefined; from?: string | undefined; to?: string | undefined }) =>
    listPerDiem(ctx, input),
  removePerDiem: (ctx: ServiceContext, input: { id: string }) => removePerDiem(ctx, input),
  getJobExpenses: (ctx: ServiceContext, input: { jobId: string }) => forJob(ctx, input),
} as const;
