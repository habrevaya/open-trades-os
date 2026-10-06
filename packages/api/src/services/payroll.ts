import { createHash } from "node:crypto";
import { and, asc, eq, gte, isNull, lt, desc } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { labor, ledger, money as m, time, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { policyFor } from "./labor";
import { writePosting } from "./ledger";
import * as tips from "./tips";

/**
 * PAYROLL EXPORT
 *
 * What a bureau takes is hours by employee by pay period, at the rates
 * applied, split by the categories that are taxed or treated differently, plus
 * whatever else was earned in the period. That is the whole of the format, and
 * every piece of it already existed in this codebase and had never been joined
 * up: core classifies a week into regular, overtime and double time without
 * paying an hour a premium twice, it assembles a statement with commission and
 * clawback lines on it, `freezeRate` writes the rate as applied onto every
 * punch, and nothing read any of it.
 *
 * THREE PROPERTIES, AND THE FILE IS MOSTLY ABOUT THEM.
 *
 * A PERIOD HAS TO BE CLOSABLE. Without a close, the same hours get exported
 * twice and the second file is as authoritative looking as the first.
 * `accounting_period` had already solved this one ledger over, so `closePeriod`
 * here is its shape and not a second one: an explicit act, naming who and
 * when, reopenable by the same power because a period closed by mistake that
 * cannot be reopened is not a control but an obstacle, and people get around
 * obstacles by back-dating.
 *
 * AN EXPORT HAS TO BE REPRODUCIBLE. Running it twice for one period produces
 * the same bytes, which is asserted by a checksum rather than hoped for. That
 * requires every input to be frozen, including the clock: `buildStatement`
 * takes `now` as a parameter precisely so a re-run of a closed period gives
 * the answer it gave the first time, and this passes the instant of the close
 * rather than the current time.
 *
 * AN EDIT AFTER AN EXPORT HAS TO BE VISIBLE. A punch corrected, approved or
 * added after the close would quietly produce a different file. So the close
 * records a fingerprint over every punch and commission line inside the
 * period, and the export recomputes it and REFUSES when it has moved. Refusing
 * is the point: a second file with different numbers and no warning on it is
 * the failure this is for.
 *
 * CSV, AND ONLY CSV. Every bureau takes one, no vendor has to approve it, and
 * a self hoster can open it. A second format would be a format this project
 * has to keep correct for somebody else's importer, and the honest version of
 * that promise is a mapping layer rather than a second branch in here.
 */

const usd = (value: string) => m.money(value, "USD");
const hoursOf = (seconds: number): string => (seconds / 3600).toFixed(2);

/* ---------------------------------------------------------- the calendar */

/**
 * Declare a period.
 *
 * `payroll:configure` rather than `payroll:export`, because the pay calendar
 * is a declaration of the same kind as the overtime policy and the wage scale:
 * it says what people are owed and over what span. The permission's own
 * description in the catalogue is "Declare the overtime policy and load wage
 * scales", and this is the third of those. Running the export and closing the
 * period are the operational acts and take `payroll:export`.
 *
 * VALIDATED BY CORE. `labor.checkPeriod` refuses a period that is not a whole
 * number of workweeks and one that does not begin on the policy's workweek
 * boundary, and it is right to: overtime is measured over a workweek, so a
 * period cutting one in half cannot be settled. Half the hours that decide
 * whether Thursday was overtime are in the other period, which may already be
 * closed and paid. Semimonthly periods do exactly this.
 */
export async function declarePeriod(
  ctx: ServiceContext, input: { label: string; startDate: string; weeks: number },
) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const policy = await policyFor(tx, ctx.actor.organizationId);
    const label = input.label.trim();
    if (label === "") throw new ConflictError("A pay period needs a name.");

    const candidate: labor.PayPeriod = {
      id: input.startDate, label, startDate: input.startDate, weeks: input.weeks,
    };
    const verdict = labor.checkPeriod(candidate, policy);
    if (!verdict.ok) throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));

    const [clash] = await tx.select({ id: schema.payPeriod.id, label: schema.payPeriod.label })
      .from(schema.payPeriod)
      .where(and(
        eq(schema.payPeriod.organizationId, ctx.actor.organizationId),
        eq(schema.payPeriod.startDate, input.startDate),
      )).limit(1);
    if (clash) {
      throw new ConflictError(`A pay period already starts on ${input.startDate}: ${clash.label}.`);
    }

    /**
     * OVERLAP IS REFUSED, not merely duplicate start dates. Two periods
     * covering the same Tuesday export that Tuesday's hours twice, and the
     * second file looks exactly as correct as the first.
     */
    const bounds = labor.periodBounds(candidate, policy);
    const existing = await tx.select().from(schema.payPeriod)
      .where(eq(schema.payPeriod.organizationId, ctx.actor.organizationId));
    for (const row of existing) {
      const other = labor.periodBounds(
        { id: row.id, label: row.label, startDate: row.startDate, weeks: row.weeks }, policy,
      );
      if (bounds.start < other.end && other.start < bounds.end) {
        throw new ConflictError(
          `That period overlaps ${row.label}, which runs from ${row.startDate} for ${row.weeks} week`
          + `${row.weeks === 1 ? "" : "s"}. Two periods covering the same day export that day's hours twice.`,
        );
      }
    }

    const [row] = await tx.insert(schema.payPeriod).values({
      organizationId: ctx.actor.organizationId,
      label, startDate: input.startDate, weeks: input.weeks,
    }).returning();

    await audit(tx, ctx, "pay_period.declared", "pay_period", row!.id, null, row!);
    return {
      id: row!.id, label: row!.label, startDate: row!.startDate, weeks: row!.weeks,
      periodStart: bounds.start, periodEnd: bounds.end,
    };
  });
}

export async function periods(ctx: ServiceContext) {
  return guardedRead(ctx, "payroll:read", async (tx) => {
    const rows = await tx.select().from(schema.payPeriod)
      .where(eq(schema.payPeriod.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.payPeriod.startDate));

    const out = [];
    for (const row of rows) {
      const close = await liveClose(tx, row.id);
      out.push({
        id: row.id,
        label: row.label,
        startDate: row.startDate,
        weeks: row.weeks,
        closedAt: close?.closedAt ?? null,
        note: close?.note ?? null,
      });
    }
    return out;
  });
}

/* ------------------------------------------------------------- the close */

/**
 * Close a period.
 *
 * `payroll:export` and not `payroll:configure`, because they are different
 * powers in the same way `accounting:close` and `accounting:sync` are.
 * Declaring the pay calendar is configuration. Saying "this fortnight has been
 * run" is the act of whoever actually runs payroll and knows the file went to
 * the bureau.
 *
 * THE FINGERPRINT IS TAKEN HERE and is the whole mechanism behind "an edit
 * after an export is visible". Every punch inside the period, with the instant
 * it was last touched, and every commission line inside it, with its amount.
 * An approval, a corrected punch, a punch that arrives late off a phone and a
 * commission settled afterwards all move it.
 */
export async function closePeriod(
  ctx: ServiceContext, input: { periodId: string; note?: string | undefined },
) {
  return guardedWrite(ctx, "payroll:export", async (tx) => {
    const { period, bounds } = await loadPeriod(tx, ctx, input.periodId);

    const live = await liveClose(tx, period.id);
    if (live) {
      throw new ConflictError(
        `${period.label} was already closed at ${live.closedAt.toISOString()}. `
        + "Reopen it if something needs to change.",
      );
    }

    /**
     * A period that has not finished cannot be closed. Closing one freezes
     * hours that are still being worked, and the technician on shift at the
     * moment somebody clicked is the one who finds out.
     */
    const now = new Date();
    if (bounds.end > now) {
      throw new ConflictError(
        `${period.label} runs until ${bounds.end.toISOString()}, which has not happened yet. `
        + "Closing it now would freeze hours that are still being worked.",
      );
    }

    const open = await tx.select({ id: schema.timeclockEntry.id })
      .from(schema.timeclockEntry)
      .where(and(
        eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
        gte(schema.timeclockEntry.startedAt, bounds.start),
        lt(schema.timeclockEntry.startedAt, bounds.end),
        isNull(schema.timeclockEntry.endedAt),
      ));
    if (open.length > 0) {
      /**
       * AN OPEN PUNCH IS NOT ZERO HOURS. Somebody forgot to clock out and has
       * worked those hours. Core refuses to assemble a statement containing one
       * for exactly this reason, and catching it at the close rather than at
       * the export is the difference between fixing it on the Monday and
       * finding out on payday.
       */
      throw new ConflictError(
        `${open.length} punch${open.length === 1 ? " is" : "es are"} still open inside ${period.label}. `
        + "An open punch is not zero hours: somebody forgot to clock out and has worked them. "
        + "Close them at the time the work actually finished.",
      );
    }

    const fingerprint = await fingerprintOf(tx, ctx.actor.organizationId, bounds);

    const [row] = await tx.insert(schema.payPeriodClose).values({
      organizationId: ctx.actor.organizationId,
      payPeriodId: period.id,
      closedAt: now,
      closedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      note: input.note ?? null,
      hoursFingerprint: fingerprint,
    }).returning();

    await audit(tx, ctx, "pay_period.closed", "pay_period", period.id, null, {
      closeId: row!.id, periodEnd: bounds.end.toISOString(), note: input.note ?? null,
    });

    return {
      periodId: period.id, closeId: row!.id, label: period.label,
      closedAt: row!.closedAt, periodStart: bounds.start, periodEnd: bounds.end,
    };
  });
}

/**
 * Reopen one.
 *
 * Possible, and deliberately the same permission, for the reason the
 * accounting close gives: a period closed by mistake that cannot be reopened
 * is not a control, it is an obstacle, and people get around obstacles by
 * back-dating punches into a period that is still open, which is worse than
 * the mistake and leaves no trace.
 *
 * The reason is required. A reopened fortnight with no explanation is the
 * question a payroll auditor asks first.
 *
 * The close row STAYS, marked reopened, and a second close writes a second
 * row. "This fortnight was closed, reopened on the 14th by Dana, and closed
 * again" is the fact somebody needs; a column overwritten by the second close
 * cannot answer it.
 */
export async function reopenPeriod(
  ctx: ServiceContext, input: { periodId: string; reason: string },
) {
  return guardedWrite(ctx, "payroll:export", async (tx) => {
    if (input.reason.trim() === "") {
      throw new ConflictError("Reopening a closed pay period needs a reason. It is the first thing an auditor asks.");
    }
    const { period } = await loadPeriod(tx, ctx, input.periodId);
    const live = await liveClose(tx, period.id);
    if (!live) throw new ConflictError(`${period.label} is not closed.`);

    const [row] = await tx.update(schema.payPeriodClose).set({
      reopenedAt: new Date(),
      reopenedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      reopenedReason: input.reason.trim(),
      updatedAt: new Date(),
    }).where(eq(schema.payPeriodClose.id, live.id)).returning();

    await audit(tx, ctx, "pay_period.reopened", "pay_period", period.id, live, row!);
    return { periodId: period.id, closeId: row!.id, reopenedAt: row!.reopenedAt };
  });
}

/* ---------------------------------------------------------- the register */

export interface RegisterLine {
  kind: string;
  label: string;
  explanation: string;
  hours: string | null;
  rate: string | null;
  amount: string;
}

export interface RegisterRow {
  technicianId: string;
  technicianName: string;
  classification: string | null;
  lines: RegisterLine[];
  gross: string;
  /**
   * Reimbursements and per diem, paid in full beside the gross: not wages, so
   * no tax is taken from them, and not in `gross` for that reason.
   */
  nonTaxable: string;
  /** What a clawback could not be taken out of this period without going negative. */
  carriedForward: string;
  warnings: string[];
}

/**
 * The pay register: what every person is owed for the period, and why.
 *
 * A read rather than a stored total, for the reason the timesheet gives: a
 * stored overtime figure is a number somebody can edit, and a payroll number
 * nobody can explain is worse than a wrong one. What IS stored is the rate as
 * applied, frozen onto each punch at the moment it closed.
 *
 * People who cannot be assembled come back as `problems` rather than as an
 * exception, so the screen shows every one of them at once. The export refuses
 * on any of them, which is the right place for the refusal: the register is
 * the screen somebody fixes them on.
 */
export async function register(ctx: ServiceContext, input: { periodId: string }) {
  return guardedRead(ctx, "payroll:read", async (tx) => {
    const { period, policy, bounds, corePeriod } = await loadPeriod(tx, ctx, input.periodId);
    const close = await liveClose(tx, period.id);
    /**
     * The close instant when there is one, the current time when there is not.
     * See `assemble`: this is the clock, and freezing it is what makes an
     * export of a closed period reproducible.
     */
    const assembled = await assemble(tx, ctx, corePeriod, policy, bounds, close?.closedAt ?? new Date());

    return {
      periodId: period.id,
      label: period.label,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      closedAt: close?.closedAt ?? null,
      rows: assembled.rows,
      problems: assembled.problems,
      grossTotal: m.toString(m.sum(assembled.rows.map((row) => usd(row.gross)), "USD")),
      reimbursementTotal: m.toString(m.sum(assembled.rows.map((row) => usd(row.nonTaxable)), "USD")),
    };
  });
}

/* ----------------------------------------------------------- the export */

export interface ExportResult {
  periodId: string;
  closeId: string;
  format: string;
  /** The file itself. Deterministic: the same close produces the same bytes. */
  content: string;
  checksum: string;
  rowCount: number;
  grossTotal: string;
  /** Reimbursements and per diem the file pays beside the gross, with no tax taken. */
  reimbursementTotal: string;
  generatedAt: Date;
  /** True when this period has been exported before, so a duplicate file is visible. */
  previouslyExported: boolean;
}

/**
 * Run the export.
 *
 * Three refusals, in order, and each is a different failure:
 *
 *   1. The period is not closed. An export of an open period is a file that
 *      will be run again tomorrow with different numbers in it.
 *   2. Something inside the period changed after the close. The fingerprint
 *      moved, so this file would not be the one that was closed. Reopen it,
 *      look at what changed, and close it again, which is a deliberate act
 *      with a reason attached rather than a silently different file.
 *   3. Somebody's statement cannot be assembled. Core's refusals are the
 *      feature: an open punch, an overlap, two entries covering the same hour.
 *      Every one of them would otherwise produce a plausible number that is
 *      wrong in a way only the person being paid would notice.
 */
export async function exportPeriod(
  ctx: ServiceContext, input: { periodId: string; format?: string | undefined },
): Promise<ExportResult> {
  return guardedWrite(ctx, "payroll:export", async (tx) => {
    const format = input.format ?? "csv";
    if (format !== "csv") {
      throw new ConflictError(
        `"${format}" is not an export format this produces. CSV is the only one, because every bureau `
        + "takes one and no vendor has to approve it. A format named after a payroll product would be a "
        + "promise this project cannot keep correct from the outside.",
      );
    }

    const { period, policy, bounds, corePeriod } = await loadPeriod(tx, ctx, input.periodId);

    const close = await liveClose(tx, period.id);
    if (!close) {
      throw new ConflictError(
        `${period.label} is not closed. Close it first: an export of an open period is a file that will `
        + "be run again with different numbers in it, and nothing on either file says which is current.",
      );
    }

    const fingerprint = await fingerprintOf(tx, ctx.actor.organizationId, bounds);
    if (fingerprint !== close.hoursFingerprint) {
      throw new ConflictError(
        `Time or commission inside ${period.label} changed after it was closed at `
        + `${close.closedAt.toISOString()}, so this export would not be the period that was closed. `
        + "Reopen it, look at what changed, and close it again.",
      );
    }

    /**
     * THE CLOCK IS THE CLOSE. `buildStatement` takes `now` as a parameter so
     * that a re-run of a closed period gives the answer it gave the first time;
     * passing the current time would make the entry checks move under it, and
     * an export that is almost reproducible is not reproducible.
     */
    const assembled = await assemble(tx, ctx, corePeriod, policy, bounds, close.closedAt);
    if (assembled.problems.length > 0) {
      throw new ConflictError(
        `${assembled.problems.length} ${assembled.problems.length === 1 ? "person" : "people"} cannot be `
        + `assembled for ${period.label}: `
        + assembled.problems.map((p) => `${p.technicianName}: ${p.messages.join(" ")}`).join(" "),
      );
    }

    const content = toCsv(period.label, bounds, assembled.rows);
    const checksum = createHash("sha256").update(content, "utf8").digest("hex");
    const grossTotal = m.sum(assembled.rows.map((row) => usd(row.gross)), "USD");
    const reimbursementTotal = m.sum(assembled.rows.map((row) => usd(row.nonTaxable)), "USD");
    const rowCount = assembled.rows.reduce((total, row) => total + row.lines.length, 0);

    const previous = await tx.select({ id: schema.payrollExport.id })
      .from(schema.payrollExport)
      .where(eq(schema.payrollExport.payPeriodId, period.id));

    const generatedAt = new Date();
    const [row] = await tx.insert(schema.payrollExport).values({
      organizationId: ctx.actor.organizationId,
      payPeriodId: period.id,
      closeId: close.id,
      format,
      rowCount,
      grossTotal: m.toString(grossTotal),
      reimbursementTotal: m.toString(reimbursementTotal),
      checksum,
      generatedAt,
      generatedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "payroll.exported", "pay_period", period.id, null, {
      exportId: row!.id, closeId: close.id, checksum, rowCount,
      grossTotal: m.toString(grossTotal),
      reimbursementTotal: m.toString(reimbursementTotal),
    });

    return {
      periodId: period.id,
      closeId: close.id,
      format,
      content,
      checksum,
      rowCount,
      grossTotal: m.toString(grossTotal),
      reimbursementTotal: m.toString(reimbursementTotal),
      generatedAt,
      previouslyExported: previous.length > 0,
    };
  });
}

/** Every export that has ever left the building, for "which file did we send". */
export async function exportsFor(ctx: ServiceContext, input: { periodId: string }) {
  return guardedRead(ctx, "payroll:read", async (tx) => {
    const rows = await tx.select().from(schema.payrollExport)
      .where(and(
        eq(schema.payrollExport.organizationId, ctx.actor.organizationId),
        eq(schema.payrollExport.payPeriodId, input.periodId),
      ))
      .orderBy(asc(schema.payrollExport.generatedAt));
    return rows.map((row) => ({
      id: row.id,
      closeId: row.closeId,
      format: row.format,
      rowCount: row.rowCount,
      grossTotal: row.grossTotal,
      reimbursementTotal: row.reimbursementTotal,
      checksum: row.checksum,
      generatedAt: row.generatedAt,
    }));
  });
}

/* ------------------------------------------------- paying the commission */

/**
 * PAY THE COMMISSION, which is a different event from earning it.
 *
 * Earning posted an expense and a liability. This discharges the liability
 * against cash and expenses nothing, because the expense was recognised when
 * the work was sold; recognising it again here would double the cost of every
 * job. Skipping the posting entirely and simply marking the rows paid leaves
 * the liability on the balance sheet forever as money the company still owes
 * its technicians.
 *
 * EVERYTHING OWED UP TO THE END OF THIS PERIOD, not only what was earned
 * inside it. A commission earned in a fortnight nobody declared a period for
 * would otherwise sit outside every window forever, owed, with no run that
 * could clear it.
 *
 * A PERSON WHOSE NET IS NEGATIVE IS SKIPPED AND NAMED. Core refuses to issue a
 * statement whose gross is negative and carries the excess forward instead,
 * because recovering an overpayment out of wages already earned is constrained
 * in most places, sometimes to nothing, and a payroll run that hands somebody a
 * negative cheque has made that decision on the operator's behalf. The same
 * rule applies to the cash: their rows stay unpaid and offset their next run.
 */
export async function payCommissions(ctx: ServiceContext, input: { periodId: string }) {
  return guardedWrite(ctx, "payroll:export", async (tx) => {
    const { period, bounds } = await loadPeriod(tx, ctx, input.periodId);
    const close = await liveClose(tx, period.id);
    if (!close) {
      throw new ConflictError(
        `${period.label} is not closed. Paying out of an open period pays an amount that can still change.`,
      );
    }

    const owed = await unpaidBefore(tx, ctx.actor.organizationId, bounds.end);
    const payable = owed.filter((person) => m.isPositive(person.amount));
    const carried = owed.filter((person) => m.isNegative(person.amount));

    const total = m.sum(payable.map((person) => person.amount), "USD");
    const paidAt = new Date();
    let transactionId: string | null = null;

    if (m.isPositive(total)) {
      transactionId = await writePosting(tx, ctx, ledger.postCommissionPayment({
        payrollRunId: period.id,
        occurredAt: paidAt,
        amount: total,
      }));

      for (const person of payable) {
        for (const entryId of person.entryIds) {
          await tx.update(schema.commissionEntry)
            .set({ paidAt, paidInPeriodId: period.id, updatedAt: new Date() })
            .where(eq(schema.commissionEntry.id, entryId));
        }
      }

      await audit(tx, ctx, "commission.paid", "pay_period", period.id, null, {
        total: m.toString(total), people: payable.length, ledgerTransactionId: transactionId,
      });
    }

    return {
      periodId: period.id,
      paidAt,
      total: m.toString(total),
      ledgerTransactionId: transactionId,
      people: payable.map((person) => ({
        technicianId: person.technicianId,
        amount: m.toString(person.amount),
        /** True when this cheque includes commission earned before this period. */
        includesEarlierPeriods: person.earliest < bounds.start,
      })),
      /** Named rather than paid. See the note above on negative gross. */
      carried: carried.map((person) => ({
        technicianId: person.technicianId,
        amount: m.toString(person.amount),
      })),
    };
  });
}

/* ------------------------------------------------------- passing tips on */

/**
 * PAY OUT THE TIPS, which discharges what was held for the technicians.
 *
 * The other half of `postPayment`'s tip leg: that credited Tips payable when
 * the customer paid, and this debits it against cash when the money is passed
 * on. Nothing is expensed, because a tip was never the company's to spend,
 * and nothing is netted against anything: a commission reversal carried
 * forward is not taken out of a tip (see `labor.buildStatement`).
 *
 * Everything owed that arrived before the end of the period, not only inside
 * it, for the reason commissions are paid that way. Marked with the period
 * that paid it, in the same transaction as the posting, so running this twice
 * pays nothing twice.
 */
export async function payTips(ctx: ServiceContext, input: { periodId: string }) {
  return guardedWrite(ctx, "payroll:export", async (tx) => {
    const { period, bounds } = await loadPeriod(tx, ctx, input.periodId);
    const close = await liveClose(tx, period.id);
    if (!close) {
      throw new ConflictError(
        `${period.label} is not closed. Paying out of an open period pays an amount that can still change.`,
      );
    }

    const owed = (await tips.unpaidBefore(tx, ctx.actor.organizationId, bounds.end))
      .filter((person) => m.isPositive(person.amount));
    const total = m.sum(owed.map((person) => person.amount), "USD");
    const paidAt = new Date();
    let transactionId: string | null = null;

    if (m.isPositive(total)) {
      transactionId = await writePosting(tx, ctx, ledger.postTipPayout({
        payrollRunId: period.id,
        occurredAt: paidAt,
        amount: total,
      }));
      await tips.markPaid(tx, owed.flatMap((person) => person.ids), paidAt, period.id);
      await audit(tx, ctx, "tips.paid", "pay_period", period.id, null, {
        total: m.toString(total), people: owed.length, ledgerTransactionId: transactionId,
      });
    }

    return {
      periodId: period.id,
      paidAt,
      total: m.toString(total),
      ledgerTransactionId: transactionId,
      people: owed.map((person) => ({
        technicianId: person.technicianId,
        amount: m.toString(person.amount),
        includesEarlierPeriods: person.earliest < bounds.start,
      })),
    };
  });
}

/* ------------------------------------------------------- one's own pay */

export interface OwnStatement {
  periodId: string;
  label: string;
  periodStart: Date;
  periodEnd: Date;
  closedAt: Date;
  /** Their lines on the register, exactly as the export carried them. Null when they had nothing that period. */
  statement: Pick<RegisterRow, "classification" | "lines" | "gross" | "nonTaxable" | "carriedForward" | "warnings"> | null;
  /** Why their statement could not be worked out, when it could not, for them to ask the office about. */
  problems: string[];
  /** The commission behind the commission lines: which invoice, how it was worked out, and whether it is paid. */
  commissions: {
    id: string; invoiceNumber: number; kind: string; amount: string; explanation: string;
    occurredAt: Date; paidAt: Date | null;
  }[];
}

/** How many closed periods somebody's own pay goes back: a year of fortnights. */
const OWN_PERIODS = 26;

/**
 * A PERSON'S OWN PAY STATEMENTS, for the periods payroll has closed.
 *
 * Built by the same `assemble` the register and the export are, at the
 * instant the period was closed, narrowed to them: so the statement somebody
 * reads is the one the bureau was sent, line for line, and not a second
 * calculation that could disagree with it. Only closed periods, because an
 * open one is still being corrected and a figure read on Tuesday that has
 * moved by Friday is a dispute, not a statement.
 *
 * `payroll:own`, resolved from the session to the person's own technician
 * record. There is no way to ask for somebody else's: the call takes no
 * person. Somebody with no technician record has no punches, commission or
 * tips here to show, and is told so rather than shown an empty table.
 */
export async function ownStatements(ctx: ServiceContext): Promise<{ technician: boolean; statements: OwnStatement[] }> {
  return guardedRead(ctx, "payroll:own", async (tx) => {
    const [own] = await tx.select({ id: schema.technician.id })
      .from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(and(
        eq(schema.membership.organizationId, ctx.actor.organizationId),
        eq(schema.membership.userId, ctx.actor.userId),
        eq(schema.membership.active, true),
      )).limit(1);
    if (!own) return { technician: false, statements: [] };

    const rows = await tx.select().from(schema.payPeriod)
      .where(eq(schema.payPeriod.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.payPeriod.startDate));

    const statements: OwnStatement[] = [];
    for (const row of rows) {
      if (statements.length >= OWN_PERIODS) break;
      const close = await liveClose(tx, row.id);
      if (!close) continue;
      const { period, policy, bounds, corePeriod } = await loadPeriod(tx, ctx, row.id);
      const assembled = await assemble(tx, ctx, corePeriod, policy, bounds, close.closedAt, own.id);
      const mine = assembled.rows.find((r) => r.technicianId === own.id) ?? null;
      const commissions = await tx.select({
        entry: schema.commissionEntry,
        invoiceNumber: schema.invoice.number,
      }).from(schema.commissionEntry)
        .innerJoin(schema.commissionEvent, eq(schema.commissionEvent.id, schema.commissionEntry.eventId))
        .innerJoin(schema.invoice, eq(schema.invoice.id, schema.commissionEvent.invoiceId))
        .where(and(
          eq(schema.commissionEntry.organizationId, ctx.actor.organizationId),
          eq(schema.commissionEntry.technicianId, own.id),
          gte(schema.commissionEntry.occurredAt, bounds.start),
          lt(schema.commissionEntry.occurredAt, bounds.end),
        ))
        .orderBy(asc(schema.commissionEntry.occurredAt));
      statements.push({
        periodId: period.id,
        label: period.label,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        closedAt: close.closedAt,
        statement: mine
          ? {
            classification: mine.classification, lines: mine.lines, gross: mine.gross,
            nonTaxable: mine.nonTaxable, carriedForward: mine.carriedForward, warnings: mine.warnings,
          }
          : null,
        problems: assembled.problems.filter((p) => p.technicianId === own.id).flatMap((p) => p.messages),
        commissions: commissions.map(({ entry, invoiceNumber }) => ({
          id: entry.id, invoiceNumber, kind: entry.kind, amount: entry.amount, explanation: entry.explanation,
          occurredAt: entry.occurredAt, paidAt: entry.paidAt,
        })),
      });
    }
    return { technician: true, statements };
  });
}

/* ------------------------------------------------------------- internals */

async function loadPeriod(tx: Database, ctx: ServiceContext, periodId: string) {
  const [period] = await tx.select().from(schema.payPeriod)
    .where(and(
      eq(schema.payPeriod.id, periodId),
      eq(schema.payPeriod.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!period) throw new NotFoundError("Pay period");

  const policy = await policyFor(tx, ctx.actor.organizationId);
  const corePeriod: labor.PayPeriod = {
    id: period.id, label: period.label, startDate: period.startDate, weeks: period.weeks,
  };
  return { period, policy, corePeriod, bounds: labor.periodBounds(corePeriod, policy) };
}

/** The close that is in force, or none. A reopened close does not count. */
async function liveClose(
  tx: Database, payPeriodId: string,
): Promise<typeof schema.payPeriodClose.$inferSelect | null> {
  const [row] = await tx.select().from(schema.payPeriodClose)
    .where(and(
      eq(schema.payPeriodClose.payPeriodId, payPeriodId),
      isNull(schema.payPeriodClose.reopenedAt),
    ))
    .orderBy(desc(schema.payPeriodClose.closedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Which pay period covers an instant, closed or not, read once for as many
 * instants as are asked about.
 *
 * Walks the periods rather than querying a range, because the bounds are
 * derived with the policy's zone by `periodBounds` and a date comparison in
 * SQL would quietly use UTC. Companies have tens of pay periods a year, not
 * millions, so loading them all once and answering a list of instants from
 * memory is cheaper than a query per row.
 */
export async function periodFinder(
  tx: Database, organizationId: string,
): Promise<(instant: Date) => { id: string; label: string; closedAt: Date | null } | null> {
  const rows = await tx.select().from(schema.payPeriod)
    .where(eq(schema.payPeriod.organizationId, organizationId));

  /**
   * The periods are read BEFORE the policy, and this is not an optimisation.
   * `policyFor` refuses outright when no overtime policy has been declared,
   * which is right for a timesheet and wrong here: commission has nothing to
   * do with overtime, and a company that pays commission and has nobody on the
   * clock would otherwise be unable to settle one at all. A pay period cannot
   * exist without a policy, because declaring one is checked against it, so
   * there is nothing to resolve when there are no periods.
   */
  if (rows.length === 0) return () => null;
  const policy = await policyFor(tx, organizationId);
  const known: { id: string; label: string; bounds: { start: Date; end: Date }; closedAt: Date | null }[] = [];
  for (const row of rows) {
    known.push({
      id: row.id,
      label: row.label,
      bounds: labor.periodBounds(
        { id: row.id, label: row.label, startDate: row.startDate, weeks: row.weeks }, policy,
      ),
      closedAt: (await liveClose(tx, row.id))?.closedAt ?? null,
    });
  }
  return (instant) => {
    const hit = known.find((p) => instant >= p.bounds.start && instant < p.bounds.end);
    return hit ? { id: hit.id, label: hit.label, closedAt: hit.closedAt } : null;
  };
}

/**
 * The closed pay period covering an instant, if any.
 *
 * Exported because anything that dates money into the past has to ask it
 * first. A commission backdated into a fortnight that has already been
 * exported and paid changes a number the bureau has, the technician has been
 * paid on, and the tax authority has been told about, and nothing anywhere
 * says it moved.
 */
export async function closedPeriodCovering(
  tx: Database, organizationId: string, instant: Date,
): Promise<{ id: string; label: string; closedAt: Date } | null> {
  const found = (await periodFinder(tx, organizationId))(instant);
  return found?.closedAt ? { id: found.id, label: found.label, closedAt: found.closedAt } : null;
}

/**
 * EVERY FACT THE EXPORT DEPENDS ON, IN ONE STRING.
 *
 * Punches by id and the instant each was last touched, commission lines by id
 * and amount. Sorted, so the hash does not depend on the order Postgres
 * happened to return rows in, which would make it move for no reason and
 * produce a refusal nobody could explain.
 *
 * A punch added, deleted, edited, approved or re-costed changes this. So does
 * a commission settled or reversed inside the window. That is the full set of
 * things that can change a payroll file, which is why it is the full set of
 * things in here.
 */
async function fingerprintOf(
  tx: Database, organizationId: string, bounds: { start: Date; end: Date },
): Promise<string> {
  const punches = await tx.select({
    id: schema.timeclockEntry.id,
    updatedAt: schema.timeclockEntry.updatedAt,
  }).from(schema.timeclockEntry)
    .where(and(
      eq(schema.timeclockEntry.organizationId, organizationId),
      gte(schema.timeclockEntry.startedAt, bounds.start),
      lt(schema.timeclockEntry.startedAt, bounds.end),
    ));

  const commissions = await tx.select({
    id: schema.commissionEntry.id,
    amount: schema.commissionEntry.amount,
  }).from(schema.commissionEntry)
    .where(and(
      eq(schema.commissionEntry.organizationId, organizationId),
      gte(schema.commissionEntry.occurredAt, bounds.start),
      lt(schema.commissionEntry.occurredAt, bounds.end),
    ));

  /**
   * Tips too, because they are on the file. A tip arriving inside a closed
   * period (a payment backdated into it) would otherwise change what the
   * export says without the export noticing.
   */
  const tipped = await tx.select({ id: schema.tipShare.id, amount: schema.tipShare.amount })
    .from(schema.tipShare)
    .where(and(
      eq(schema.tipShare.organizationId, organizationId),
      gte(schema.tipShare.occurredAt, bounds.start),
      lt(schema.tipShare.occurredAt, bounds.end),
    ));

  /** And the cash tips people kept, which are on the file as `cash_tip`. */
  const kept = await tx.select({ id: schema.cashTip.id, amount: schema.cashTip.amount })
    .from(schema.cashTip)
    .where(and(
      eq(schema.cashTip.organizationId, organizationId),
      gte(schema.cashTip.receivedAt, bounds.start),
      lt(schema.cashTip.receivedAt, bounds.end),
    ));

  /**
   * Approved reimbursements and per diem days, which are on the file as their
   * own lines. A day away recorded into a period after it closed is refused
   * when it is recorded, but the file still names what it counted, so one
   * written some other way changes the fingerprint instead of the bytes.
   */
  const repaid = await tx.select({ id: schema.expense.id, amount: schema.expense.amount })
    .from(schema.expense)
    .where(and(
      eq(schema.expense.organizationId, organizationId),
      eq(schema.expense.status, "approved"),
      gte(schema.expense.decidedAt, bounds.start),
      lt(schema.expense.decidedAt, bounds.end),
    ));
  const zone = (await policyFor(tx, organizationId)).timeZone;
  const awayDays = await tx.select({ id: schema.perDiem.id, amount: schema.perDiem.amount })
    .from(schema.perDiem)
    .where(and(
      eq(schema.perDiem.organizationId, organizationId),
      gte(schema.perDiem.day, time.dateIn(bounds.start, zone)),
      lt(schema.perDiem.day, time.dateIn(bounds.end, zone)),
    ));

  const lines = [
    ...punches.map((row) => `t:${row.id}:${row.updatedAt.toISOString()}`),
    ...repaid.map((row) => `x:${row.id}:${row.amount}`),
    ...awayDays.map((row) => `d:${row.id}:${row.amount}`),
    ...commissions.map((row) => `c:${row.id}:${row.amount}`),
    ...tipped.map((row) => `p:${row.id}:${row.amount}`),
    ...kept.map((row) => `k:${row.id}:${row.amount}`),
  ].sort();

  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * Everything still owed, per person, earned before a given instant.
 *
 * Shared with the payroll service, which pays it, so there is one definition
 * of what is outstanding rather than two that can disagree.
 *
 * CUMULATIVE rather than windowed to one period, and that is deliberate. A
 * commission earned in a fortnight nobody ever declared a period for would
 * otherwise never be paid by anything: it would sit outside every window
 * forever, owed, with the liability on the balance sheet and no run that could
 * clear it.
 */
export async function unpaidBefore(
  tx: Database, organizationId: string, until: Date,
): Promise<{ technicianId: string; amount: m.Money; entryIds: string[]; earliest: Date }[]> {
  const rows = await tx.select().from(schema.commissionEntry)
    .where(and(
      eq(schema.commissionEntry.organizationId, organizationId),
      isNull(schema.commissionEntry.paidAt),
      lt(schema.commissionEntry.occurredAt, until),
    ))
    .orderBy(asc(schema.commissionEntry.technicianId), asc(schema.commissionEntry.occurredAt));

  const byPerson = new Map<string, {
    technicianId: string; amount: m.Money; entryIds: string[]; earliest: Date;
  }>();
  for (const row of rows) {
    const current = byPerson.get(row.technicianId)
      ?? { technicianId: row.technicianId, amount: m.zero("USD"), entryIds: [], earliest: row.occurredAt };
    current.amount = m.add(current.amount, usd(row.amount));
    current.entryIds.push(row.id);
    if (row.occurredAt < current.earliest) current.earliest = row.occurredAt;
    byPerson.set(row.technicianId, current);
  }
  return [...byPerson.values()];
}

interface Assembled {
  rows: RegisterRow[];
  problems: { technicianId: string; technicianName: string; messages: string[] }[];
}

/**
 * One statement per person, built by core.
 *
 * THE RATE IS THE BASE RATE, NOT THE LOADED ONE, and the distinction is money.
 * `labor.week` reports what hours COST the company and uses the loaded rate,
 * base plus fringe. Payroll pays what the person is OWED, which is the base:
 * the fringe is a contribution to a health, pension or training fund and
 * paying it to the technician as wages hands them their own pension money and
 * leaves the fund short.
 *
 * ONE BLENDED BASE RATE PER PERIOD, weighted by the hours at each, because
 * `buildStatement` takes a single rate per person and the frozen rate lives on
 * each punch. Exact whenever somebody worked one classification, which is the
 * ordinary case, and an approximation when they worked two in a period where
 * overtime fell in the more expensive one. Saying so rather than implying a
 * precision this does not have: an exact answer needs overtime attributed back
 * to the specific hours that caused it, which differs by jurisdiction and is a
 * question this product has not asked the operator yet. `labor.week` carries
 * the same caveat and the two agree, which is the point of stating it twice.
 *
 * A CLOSED PUNCH WITH NO FROZEN RATE REFUSES. Blending over the ones that have
 * a rate would pay the unpriced hours at somebody else's rate, and the only
 * symptom is a number slightly too large or too small.
 */
async function assemble(
  tx: Database, ctx: ServiceContext,
  period: labor.PayPeriod, policy: labor.OvertimePolicy,
  bounds: { start: Date; end: Date }, now: Date,
  /** One person only, for their own statement. Everybody when absent. */
  only?: string,
): Promise<Assembled> {
  const punches = await tx.select({
    entry: schema.timeclockEntry,
    technicianName: schema.technician.displayName,
  }).from(schema.timeclockEntry)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.timeclockEntry.technicianId))
    .where(and(
      eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
      gte(schema.timeclockEntry.startedAt, bounds.start),
      lt(schema.timeclockEntry.startedAt, bounds.end),
      ...(only ? [eq(schema.timeclockEntry.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.timeclockEntry.startedAt));

  const commissionRows = await tx.select({
    entry: schema.commissionEntry,
    technicianName: schema.technician.displayName,
    earnedAt: schema.commissionEvent.occurredAt,
    invoiceId: schema.commissionEvent.invoiceId,
  }).from(schema.commissionEntry)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionEntry.technicianId))
    .innerJoin(schema.commissionEvent, eq(schema.commissionEvent.id, schema.commissionEntry.eventId))
    .where(and(
      eq(schema.commissionEntry.organizationId, ctx.actor.organizationId),
      gte(schema.commissionEntry.occurredAt, bounds.start),
      lt(schema.commissionEntry.occurredAt, bounds.end),
      ...(only ? [eq(schema.commissionEntry.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.commissionEntry.occurredAt));

  /** Tips that arrived inside the period, with the invoice they came with for the line's label. */
  const tipRows = await tx.select({
    share: schema.tipShare,
    technicianName: schema.technician.displayName,
    invoiceNumber: schema.invoice.number,
  }).from(schema.tipShare)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.tipShare.technicianId))
    .leftJoin(schema.invoice, eq(schema.invoice.id, schema.tipShare.invoiceId))
    .where(and(
      eq(schema.tipShare.organizationId, ctx.actor.organizationId),
      gte(schema.tipShare.occurredAt, bounds.start),
      lt(schema.tipShare.occurredAt, bounds.end),
      ...(only ? [eq(schema.tipShare.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.tipShare.occurredAt), asc(schema.tipShare.id));

  /**
   * Cash tips people kept and recorded on the phone, for the `cash_tip` line:
   * reported pay the company never held, so it is on the statement and paid
   * by nobody.
   */
  const cashRows = await tx.select({
    tip: schema.cashTip,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
  }).from(schema.cashTip)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.cashTip.technicianId))
    .leftJoin(schema.job, eq(schema.job.id, schema.cashTip.jobId))
    .where(and(
      eq(schema.cashTip.organizationId, ctx.actor.organizationId),
      gte(schema.cashTip.receivedAt, bounds.start),
      lt(schema.cashTip.receivedAt, bounds.end),
      ...(only ? [eq(schema.cashTip.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.cashTip.receivedAt), asc(schema.cashTip.id));

  /**
   * What people spent for the company that the office approved inside this
   * period, dated by the approval. Approved only: a pending one is not owed,
   * and a refused one never will be.
   */
  const expenseRows = await tx.select({
    expense: schema.expense,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
  }).from(schema.expense)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.expense.technicianId))
    .leftJoin(schema.job, eq(schema.job.id, schema.expense.jobId))
    .where(and(
      eq(schema.expense.organizationId, ctx.actor.organizationId),
      eq(schema.expense.status, "approved"),
      gte(schema.expense.decidedAt, bounds.start),
      lt(schema.expense.decidedAt, bounds.end),
      ...(only ? [eq(schema.expense.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.expense.decidedAt), asc(schema.expense.id));

  /**
   * Days away inside the period, by the day itself in the company's calendar:
   * the period's first and last days, so a per diem for a day in a fortnight
   * lands in that fortnight whatever time it was typed.
   */
  const firstDay = time.dateIn(bounds.start, policy.timeZone);
  const endDay = time.dateIn(bounds.end, policy.timeZone);
  const perDiemRows = await tx.select({
    perDiem: schema.perDiem,
    technicianName: schema.technician.displayName,
    jobNumber: schema.job.number,
  }).from(schema.perDiem)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.perDiem.technicianId))
    .innerJoin(schema.job, eq(schema.job.id, schema.perDiem.jobId))
    .where(and(
      eq(schema.perDiem.organizationId, ctx.actor.organizationId),
      gte(schema.perDiem.day, firstDay),
      lt(schema.perDiem.day, endDay),
      ...(only ? [eq(schema.perDiem.technicianId, only)] : []),
    ))
    .orderBy(asc(schema.perDiem.day), asc(schema.perDiem.id));

  const names = new Map<string, string>();
  for (const row of punches) names.set(row.entry.technicianId, row.technicianName);
  for (const row of commissionRows) names.set(row.entry.technicianId, row.technicianName);
  /** Somebody tipped and not on the clock this period is still somebody to pay. */
  for (const row of tipRows) names.set(row.share.technicianId, row.technicianName);
  for (const row of cashRows) names.set(row.tip.technicianId, row.technicianName);
  /** Somebody paid back for a receipt, or a day away, and not on the clock, is still somebody to pay. */
  for (const row of expenseRows) names.set(row.expense.technicianId, row.technicianName);
  for (const row of perDiemRows) names.set(row.perDiem.technicianId, row.technicianName);

  const rows: RegisterRow[] = [];
  const problems: Assembled["problems"] = [];

  for (const [technicianId, technicianName] of names) {
    const mine = punches.filter((row) => row.entry.technicianId === technicianId);
    const closed = mine.filter((row) => row.entry.endedAt !== null);
    const unpriced = closed.filter((row) => row.entry.appliedBaseRate === null);

    if (unpriced.length > 0) {
      problems.push({
        technicianId, technicianName,
        messages: [
          `${unpriced.length} of ${technicianName}'s punches in this period have no rate frozen on them, `
          + "so what those hours are worth is not recorded. Paying the rest at a blended rate would pay "
          + "those hours at somebody else's. Load a wage scale for their classification and re-cost them.",
        ],
      });
      continue;
    }

    /**
     * Weighted by seconds, as one division at the end rather than a share per
     * entry. Multiplying each rate by a six place share and adding them up
     * loses a fraction on every entry whose share does not terminate: eight
     * shifts of eight hours and one of four give shares summing to 0.999998,
     * so the blended rate comes out a hundredth of a cent under the rate
     * everybody was actually paid, and it is under on every period forever.
     */
    const totalSeconds = closed.reduce((total, row) => total + (row.entry.minutes ?? 0) * 60, 0);
    let baseRate = m.zero("USD");
    if (totalSeconds > 0) {
      let weighted = m.zero("USD");
      for (const row of closed) {
        const seconds = (row.entry.minutes ?? 0) * 60;
        weighted = m.add(weighted, m.multiply(usd(row.entry.appliedBaseRate ?? "0"), String(seconds)));
      }
      baseRate = m.divide(weighted, String(totalSeconds));
    }

    const entries: labor.TimeEntry[] = mine.map((row) => ({
      id: row.entry.id,
      personId: technicianId,
      kind: row.entry.kind as labor.TimeEntryKind,
      startedAt: row.entry.startedAt,
      endedAt: row.entry.endedAt,
      ...(row.entry.jobId ? { jobId: row.entry.jobId } : {}),
    }));

    const commissions = commissionRows
      .filter((row) => row.entry.technicianId === technicianId && row.entry.kind === "earned")
      .map((row) => ({
        eventId: row.invoiceId,
        part: {
          personId: technicianId,
          amount: usd(row.entry.amount),
          explanation: row.entry.explanation,
        },
        occurredAt: row.entry.occurredAt,
      }));

    const clawbacks = commissionRows
      .filter((row) => row.entry.technicianId === technicianId && row.entry.kind === "reversed")
      .map((row) => ({
        creditId: row.invoiceId,
        line: {
          personId: technicianId,
          amount: usd(row.entry.amount),
          explanation: row.entry.explanation,
        },
        occurredAt: row.entry.occurredAt,
        earnedAt: row.earnedAt,
      }));

    const verdict = labor.buildStatement({
      personId: technicianId,
      period,
      policy,
      basis: { kind: "hourly", baseRate },
      entries,
      commissions,
      clawbacks,
      tips: tipRows
        .filter((row) => row.share.technicianId === technicianId)
        .map((row) => ({
          tipId: row.share.id,
          personId: technicianId,
          amount: usd(row.share.amount),
          label: row.invoiceNumber ? `Tip, invoice ${row.invoiceNumber}` : "Tip",
          occurredAt: row.share.occurredAt,
        })),
      cashTips: cashRows
        .filter((row) => row.tip.technicianId === technicianId)
        .map((row) => ({
          tipId: row.tip.id,
          personId: technicianId,
          amount: usd(row.tip.amount),
          label: row.jobNumber ? `Cash tip kept, job ${row.jobNumber}` : "Cash tip kept",
          occurredAt: row.tip.receivedAt,
        })),
      reimbursements: expenseRows
        .filter((row) => row.expense.technicianId === technicianId)
        .map((row) => ({
          expenseId: row.expense.id,
          personId: technicianId,
          amount: usd(row.expense.amount),
          label: `Reimbursement: ${row.expense.description.slice(0, 80)}${row.jobNumber ? `, job ${row.jobNumber}` : ""}`,
          occurredAt: row.expense.decidedAt ?? row.expense.createdAt,
        })),
      perDiems: perDiemRows
        .filter((row) => row.perDiem.technicianId === technicianId)
        .map((row) => ({
          perDiemId: row.perDiem.id,
          personId: technicianId,
          amount: usd(row.perDiem.amount),
          label: `Per diem, ${row.perDiem.day}, job ${row.jobNumber}`,
          occurredAt: labor.startOfPolicyDay(row.perDiem.day, policy),
        })),
      currency: "USD",
      now,
    });

    if (!verdict.ok) {
      problems.push({
        technicianId, technicianName,
        messages: verdict.refusals.map((refusal) => refusal.message),
      });
      continue;
    }

    rows.push({
      technicianId,
      technicianName,
      classification: mine.find((row) => row.entry.classification)?.entry.classification ?? null,
      lines: verdict.statement.lines.map((line) => ({
        kind: line.kind,
        label: line.label,
        explanation: line.explanation,
        hours: line.seconds === undefined ? null : hoursOf(line.seconds),
        rate: line.rate ? m.toString(line.rate) : null,
        amount: m.toString(line.amount),
      })),
      gross: m.toString(verdict.statement.gross),
      nonTaxable: m.toString(verdict.statement.nonTaxable),
      carriedForward: m.toString(verdict.statement.carriedForward),
      warnings: verdict.statement.warnings,
    });
  }

  /** Sorted by name so the file is the same file every time it is produced. */
  rows.sort((a, b) => a.technicianName.localeCompare(b.technicianName) || a.technicianId.localeCompare(b.technicianId));
  problems.sort((a, b) => a.technicianName.localeCompare(b.technicianName));
  return { rows, problems };
}

/**
 * THE FILE.
 *
 * One row per person per pay category, which is the shape every bureau takes
 * and the shape the categories matter in: regular, overtime and double time
 * are taxed and reported differently in enough places that collapsing them
 * into a single hours figure makes the file useless for the thing it is for.
 * On-call, commission and a commission reversal come through as their own
 * categories for the same reason.
 *
 * The amounts add to the gross exactly, including the carried-forward line,
 * which core prints at zero so that the lines still add up while the carried
 * amount stays visible.
 *
 * TWO CATEGORIES ARE NOT WAGES. `reimbursement` is what a person spent for the
 * company and the office approved, and `per_diem` is the company's flat rate
 * for a day away. Both are paid in full with no tax taken from them, so the
 * rows of those two categories are NOT in the gross: the file's amounts add to
 * the gross plus the reimbursement total, which is why the export keeps the two
 * apart. The bureau reads the category, exactly as it reads `cash_tip`.
 */
function toCsv(
  label: string, bounds: { start: Date; end: Date }, rows: RegisterRow[],
): string {
  const header = [
    "period", "period_start", "period_end", "employee_id", "employee_name",
    "classification", "pay_category", "hours", "rate", "amount",
  ];
  const out = [header.join(",")];

  for (const row of rows) {
    for (const line of row.lines) {
      out.push([
        label,
        bounds.start.toISOString(),
        bounds.end.toISOString(),
        row.technicianId,
        row.technicianName,
        row.classification ?? "",
        line.kind,
        line.hours ?? "",
        line.rate ?? "",
        line.amount,
      ].map(csvCell).join(","));
    }
  }

  /** A trailing newline, so appending to the file does not join two rows. */
  return `${out.join("\n")}\n`;
}

/**
 * A company called "Smith, Jones & Co" and a technician called
 * O'Brien, J. both break a naive join, and the second one is the common case
 * on a payroll file. Quoted when it has to be, doubled quotes inside.
 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  declarePayPeriod: (ctx: ServiceContext, input: {
    label: string; startDate: string; weeks: number;
  }) => declarePeriod(ctx, input),

  listPayPeriods: async (ctx: ServiceContext): Promise<{
    periods: {
      id: string; label: string; startDate: string; weeks: number;
      closedAt: Date | null; note: string | null;
    }[];
  }> => ({ periods: await periods(ctx) }),

  getPayrollRegister: (ctx: ServiceContext, input: { periodId: string }) =>
    register(ctx, input),

  closePayPeriod: (ctx: ServiceContext, input: { periodId: string; note?: string | undefined }) =>
    closePeriod(ctx, {
      periodId: input.periodId,
      ...(input.note ? { note: input.note } : {}),
    }),

  reopenPayPeriod: (ctx: ServiceContext, input: { periodId: string; reason: string }) =>
    reopenPeriod(ctx, input),

  exportPayPeriod: (ctx: ServiceContext, input: { periodId: string; format?: string | undefined }) =>
    exportPeriod(ctx, {
      periodId: input.periodId,
      ...(input.format ? { format: input.format } : {}),
    }),

  listPayrollExports: async (ctx: ServiceContext, input: { periodId: string }): Promise<{
    exports: {
      id: string; closeId: string; format: string; rowCount: number;
      grossTotal: string; reimbursementTotal: string; checksum: string; generatedAt: Date;
    }[];
  }> => ({ exports: await exportsFor(ctx, input) }),

  payCommissions: (ctx: ServiceContext, input: { periodId: string }) =>
    payCommissions(ctx, input),

  payTips: (ctx: ServiceContext, input: { periodId: string }) => payTips(ctx, input),

  getMyPayStatements: (ctx: ServiceContext) => ownStatements(ctx),
} as const;
