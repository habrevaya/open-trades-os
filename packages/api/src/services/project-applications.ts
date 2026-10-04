import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, project as plan, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import * as retainage from "./retainage";
import {
  approvedChangeOrders, lastInvoicedApplication, lineKey, loadProjectIn, rememberKey,
  scheduleOfValues, seenKey,
} from "./project-position";

/**
 * M12. PROGRESS BILLING: THE APPLICATION FOR PAYMENT.
 *
 * One period's billing on a project, stated in full: the schedule of values
 * line by line, work done before and this period, materials stored, the
 * retainage the customer is holding, what has been certified already and
 * what is due now. Printed in the two page shape every certifier, owner's
 * representative and lender reads (a summary and a continuation sheet), and
 * raised as an invoice through the billing service.
 *
 * The arithmetic is core's `computeApplication` and `paymentLines`; this
 * file finds the inputs, keeps a draft's lines in step with the schedule of
 * values, and freezes the figures when the invoice is raised.
 *
 * `invoice:write` to make, change and raise one, and `invoice:read` to read
 * one, because an application is a bill in all but name. The dispatcher
 * preset, which holds `job:write` and very deliberately nothing that touches
 * money, cannot see these.
 */

type ApplicationRow = typeof schema.projectApplication.$inferSelect;
type ApplicationLineRow = typeof schema.projectApplicationLine.$inferSelect;

export interface ApplicationView {
  id: string;
  projectId: string;
  projectName: string;
  number: number;
  periodFrom: string | null;
  periodTo: string;
  status: ApplicationRow["status"];
  retainageRate: string;
  storedRetainageRate: string;
  retainageReleased: string;
  notes: string | null;
  invoiceId: string | null;
  invoicedAt: Date | null;
  /**
   * How this project's retainage is on the books: `receivable`, held on its
   * own account when billed, or `net`, revenue when released, for a project
   * billed before retainage was booked (see `services/retainage.ts`).
   */
  retainageBooking: retainage.RetainageBooking;
  /** What invoicing this application moved on the retainage receivable. Null on a draft or the old way. */
  retainageBooked: string | null;
  lines: (plan.ApplicationLine & { id: string })[];
  /** Null while the draft has something wrong with it; `problems` then says what. */
  totals: plan.ApplicationTotals | null;
  problems: string[];
}

/* ------------------------------------------------------------------ reading */

export async function list(ctx: ServiceContext, input: { projectId: string }) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    const rows = await tx.select().from(schema.projectApplication)
      .where(eq(schema.projectApplication.projectId, project.id))
      .orderBy(asc(schema.projectApplication.number));
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      status: row.status,
      /** Frozen once invoiced. Null on a draft, whose figure moves as it is filled in. */
      currentPaymentDue: row.currentPaymentDue,
      totalRetainage: row.totalRetainage,
      invoiceId: row.invoiceId,
    }));
  });
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<ApplicationView> {
  return guardedRead(ctx, "invoice:read", async (tx) => viewIn(tx, ctx, input.id));
}

async function loadIn(tx: Database, organizationId: string, id: string): Promise<ApplicationRow> {
  const [row] = await tx.select().from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.id, id),
      eq(schema.projectApplication.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Application for payment");
  return row;
}

async function linesOf(tx: Database, applicationId: string): Promise<ApplicationLineRow[]> {
  return tx.select().from(schema.projectApplicationLine)
    .where(eq(schema.projectApplicationLine.applicationId, applicationId))
    .orderBy(asc(schema.projectApplicationLine.sortOrder));
}

/**
 * Everything core needs, read once. An invoiced application is computed from
 * its own frozen lines and rates, and so says what it said; a draft from the
 * schedule as it stands.
 */
async function inputsFor(tx: Database, row: ApplicationRow, lines: ApplicationLineRow[]) {
  const project = await loadProjectIn(tx, row.organizationId, row.projectId);
  const earlier = await tx.select().from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.projectId, row.projectId),
      eq(schema.projectApplication.status, "invoiced"),
      lt(schema.projectApplication.number, row.number),
    ))
    .orderBy(desc(schema.projectApplication.number));
  const previous = earlier[0] ?? null;
  const changes = await approvedChangeOrders(tx, row.projectId);

  const input: plan.ApplicationInput = {
    lines: lines.map((line) => ({
      key: line.id,
      description: line.description,
      scheduledValue: line.scheduledValue,
      previousWork: line.previousWork,
      previousStored: line.previousStored,
      workThisPeriod: line.workThisPeriod,
      storedNow: line.storedNow,
    })),
    contractSum: row.status === "invoiced" ? row.contractSum ?? "0" : project.contractValue ?? "0",
    netChangeOrders: row.status === "invoiced"
      ? row.netChangeOrders ?? "0"
      : m.toString(m.sum(changes.map((c) => m.money(c.amount)))),
    retainageRate: row.retainageRate,
    storedRetainageRate: row.storedRetainageRate,
    retainageReleasedBefore: m.toString(m.sum(earlier.map((a) => m.money(a.retainageReleased)))),
    retainageReleasedNow: row.retainageReleased,
    previousCertificates: previous?.totalEarnedLessRetainage ?? "0",
  };
  return { project, input, previousRetainage: previous?.totalRetainage ?? "0" };
}

async function viewIn(tx: Database, ctx: ServiceContext, id: string): Promise<ApplicationView> {
  let row = await loadIn(tx, ctx.actor.organizationId, id);
  if (row.status === "draft") {
    await syncDraft(tx, row);
    row = await loadIn(tx, ctx.actor.organizationId, id);
  }
  const lines = await linesOf(tx, row.id);
  const { project, input } = await inputsFor(tx, row, lines);
  const decision = plan.computeApplication(input);
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: project.name,
    number: row.number,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
    retainageRate: row.retainageRate,
    storedRetainageRate: row.storedRetainageRate,
    retainageReleased: row.retainageReleased,
    notes: row.notes,
    invoiceId: row.invoiceId,
    invoicedAt: row.invoicedAt,
    retainageBooking: row.status === "invoiced"
      ? (row.retainageBooked === null ? "net" : "receivable")
      : await retainage.bookingOf(tx, row.projectId, row.id),
    retainageBooked: row.retainageBooked,
    lines: decision.ok
      ? decision.lines.map((line) => ({ ...line, id: line.key }))
      : lines.map((line) => ({
          id: line.id, key: line.id, description: line.description,
          scheduledValue: line.scheduledValue, previousWork: line.previousWork,
          previousStored: line.previousStored, workThisPeriod: line.workThisPeriod,
          storedNow: line.storedNow,
          completedAndStored: m.toString(m.add(m.add(m.money(line.previousWork), m.money(line.workThisPeriod)), m.money(line.storedNow))),
          percentComplete: "0.00", balanceToFinish: "0", thisPeriod: "0",
        })),
    totals: decision.ok ? decision.totals : null,
    problems: decision.ok ? [] : decision.problems,
  };
}

/**
 * A DRAFT FOLLOWS THE SCHEDULE OF VALUES.
 *
 * A change order agreed while an application is being filled in belongs on
 * it, and a phase's value moved by a change order has to be what this
 * application measures against. So every read and write of a draft lays its
 * lines over the schedule as it stands: new lines added, values and
 * descriptions brought up to date, previous figures copied fresh from the
 * last invoiced application. What somebody typed for this period is kept
 * against the line it was typed on.
 *
 * A line no longer on the schedule is removed only when nothing was entered
 * on it and nothing was certified on it before. Anything else stays, and the
 * schedule then fails to add up to the contract, which is refused in words
 * rather than silently resolved.
 */
async function syncDraft(tx: Database, row: ApplicationRow): Promise<void> {
  const schedule = await scheduleOfValues(tx, row.projectId);
  const existing = await linesOf(tx, row.id);
  const byKey = new Map(existing.map((line) => [lineKey(line), line]));

  const previous = await tx.select().from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.projectId, row.projectId),
      eq(schema.projectApplication.status, "invoiced"),
      lt(schema.projectApplication.number, row.number),
    ))
    .orderBy(desc(schema.projectApplication.number)).limit(1);
  const prior = previous[0] ? await linesOf(tx, previous[0].id) : [];
  const priorByKey = new Map(prior.map((line) => [lineKey(line), line]));

  for (const [index, item] of schedule.entries()) {
    const before = priorByKey.get(item.key);
    const previousWork = before
      ? m.toString(m.add(m.money(before.previousWork), m.money(before.workThisPeriod)))
      : "0";
    const previousStored = before ? m.toString(m.money(before.storedNow)) : "0";
    const line = byKey.get(item.key);
    if (line) {
      if (line.scheduledValue !== item.scheduledValue || line.description !== item.description
        || line.previousWork !== previousWork || line.previousStored !== previousStored
        || line.sortOrder !== index + 1) {
        await tx.update(schema.projectApplicationLine).set({
          description: item.description,
          scheduledValue: item.scheduledValue,
          previousWork,
          previousStored,
          sortOrder: index + 1,
          updatedAt: new Date(),
        }).where(eq(schema.projectApplicationLine.id, line.id));
      }
      byKey.delete(item.key);
      continue;
    }
    await tx.insert(schema.projectApplicationLine).values({
      organizationId: row.organizationId,
      applicationId: row.id,
      sortOrder: index + 1,
      projectPhaseId: item.phaseId,
      changeOrderId: item.changeOrderId,
      description: item.description,
      scheduledValue: item.scheduledValue,
      previousWork,
      previousStored,
      /** Materials stored last time are still stored until somebody says they went in. */
      storedNow: previousStored,
    });
  }

  const stale = [...byKey.values()].filter((line) =>
    m.isZero(m.money(line.workThisPeriod)) && m.isZero(m.money(line.storedNow))
    && m.isZero(m.money(line.previousWork)) && m.isZero(m.money(line.previousStored)));
  if (stale.length > 0) {
    await tx.delete(schema.projectApplicationLine)
      .where(inArray(schema.projectApplicationLine.id, stale.map((l) => l.id)));
  }
}

/* ----------------------------------------------------------------- creating */

/**
 * START THE NEXT APPLICATION.
 *
 * Refused while the project bills by draws, because two ways of billing the
 * same work is how it gets billed twice; while another application is still
 * a draft, because two drafts would both count themselves as the next one;
 * and while there is no contract value, because the summary's third line is
 * the contract and there is nothing to write on it.
 *
 * The period runs on from the last one, and the retainage rates carry over
 * from it (or start from the project's), because a rate that silently reset
 * would release the retainage on every application after the first.
 */
export async function create(
  ctx: ServiceContext,
  input: {
    projectId: string; periodTo: string; periodFrom?: string | null | undefined;
    retainageRate?: string | null | undefined; storedRetainageRate?: string | null | undefined;
  },
): Promise<ApplicationView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await seenKey(tx, ctx, "project_application");
    if (seen) return viewIn(tx, ctx, seen);

    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`application:${project.id}`}))`);

    if (project.contractValue === null) {
      throw new ConflictError("This project has no contract value, so there is no contract sum to apply for payment against.");
    }
    const [draw] = await tx.select({ id: schema.projectDraw.id }).from(schema.projectDraw)
      .where(eq(schema.projectDraw.projectId, project.id)).limit(1);
    if (draw) {
      throw new ConflictError(
        "This project is billed by draws. Applying for payment as well would bill the same work two ways, "
        + "which is how it gets billed twice.",
      );
    }
    const [draft] = await tx.select({ number: schema.projectApplication.number })
      .from(schema.projectApplication)
      .where(and(eq(schema.projectApplication.projectId, project.id), eq(schema.projectApplication.status, "draft")))
      .limit(1);
    if (draft) {
      throw new ConflictError(`Application ${draft.number} is still a draft. Finish or delete it before starting the next.`);
    }

    const last = await lastInvoicedApplication(tx, project.id);
    const periodFrom = input.periodFrom ?? (last ? time.nextDay(last.periodTo) : project.startsOn);
    if (periodFrom && input.periodTo < periodFrom) {
      throw new ConflictError("That period ends before it starts.");
    }
    if (last && input.periodTo <= last.periodTo) {
      throw new ConflictError(`Application ${last.number} already covers up to ${last.periodTo}.`);
    }
    const rate = (value: string | null | undefined, fallback: string): string => {
      const chosen = value ?? fallback;
      const parsed = Number(chosen);
      if (!(parsed >= 0 && parsed < 1)) {
        throw new ConflictError("Retainage is a fraction of the work, from 0 up to but not including 1: 0.1 is ten per cent.");
      }
      return chosen;
    };

    const [row] = await tx.insert(schema.projectApplication).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      number: (last?.number ?? 0) + 1,
      periodFrom: periodFrom ?? null,
      periodTo: input.periodTo,
      status: "draft",
      retainageRate: rate(input.retainageRate, last?.retainageRate ?? project.retainageRate ?? "0"),
      storedRetainageRate: rate(input.storedRetainageRate, last?.storedRetainageRate ?? project.retainageRate ?? "0"),
    }).returning();

    await rememberKey(tx, ctx, "project_application.create", "project_application", row!.id);
    await audit(tx, ctx, "project_application.created", "project_application", row!.id, null, row!);
    return viewIn(tx, ctx, row!.id);
  });
}

export interface DraftChange {
  id: string;
  periodFrom?: string | null | undefined;
  periodTo?: string | undefined;
  retainageRate?: string | undefined;
  storedRetainageRate?: string | undefined;
  retainageReleased?: string | undefined;
  notes?: string | null | undefined;
  lines?: {
    id: string;
    workThisPeriod?: string | undefined;
    storedNow?: string | undefined;
    /**
     * Complete to date, as a percentage of the line: "60" for sixty per cent.
     * The work this period is worked out from it, after what was done before
     * and what is stored, which is how most people fill a continuation sheet
     * in: they know how far along the line is, not the dollars this month.
     */
    percentComplete?: string | undefined;
  }[] | undefined;
}

/**
 * Fill the draft in. What this period's work is, what is stored, the
 * retainage and any release. Saved even when the figures do not yet add up,
 * because a twelve line schedule is filled in over an afternoon; the view
 * says what is wrong and raising it refuses until nothing is.
 */
export async function updateDraft(ctx: ServiceContext, input: DraftChange): Promise<ApplicationView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const row = await loadIn(tx, ctx.actor.organizationId, input.id);
    assertDraft(row);
    await syncDraft(tx, row);

    const fraction = (value: string | undefined, label: string): string | undefined => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!(parsed >= 0 && parsed < 1)) throw new ConflictError(`${label} is a fraction from 0 up to but not including 1.`);
      return value;
    };
    const amount = (value: string | undefined, label: string): string | undefined => {
      if (value === undefined) return undefined;
      try {
        return m.toString(m.money(value === "" ? "0" : value));
      } catch {
        throw new ConflictError(`${label}: ${value} is not an amount of money.`);
      }
    };
    if (input.periodTo !== undefined || input.periodFrom !== undefined) {
      const from = input.periodFrom !== undefined ? input.periodFrom : row.periodFrom;
      const to = input.periodTo ?? row.periodTo;
      if (from && to < from) throw new ConflictError("That period ends before it starts.");
    }

    await tx.update(schema.projectApplication).set({
      ...(input.periodFrom !== undefined ? { periodFrom: input.periodFrom } : {}),
      ...(input.periodTo !== undefined ? { periodTo: input.periodTo } : {}),
      ...(input.retainageRate !== undefined ? { retainageRate: fraction(input.retainageRate, "Retainage")! } : {}),
      ...(input.storedRetainageRate !== undefined
        ? { storedRetainageRate: fraction(input.storedRetainageRate, "Retainage on stored materials")! } : {}),
      ...(input.retainageReleased !== undefined
        ? { retainageReleased: amount(input.retainageReleased, "Retainage released")! } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.projectApplication.id, row.id));

    if (input.lines && input.lines.length > 0) {
      const lines = await linesOf(tx, row.id);
      const byId = new Map(lines.map((l) => [l.id, l]));
      for (const change of input.lines) {
        const line = byId.get(change.id);
        if (!line) throw new NotFoundError("Application line");
        const stored = amount(change.storedNow, line.description) ?? line.storedNow;
        let work = amount(change.workThisPeriod, line.description);
        if (change.percentComplete !== undefined && change.percentComplete !== "") {
          const percent = Number(change.percentComplete);
          if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
            throw new ConflictError(`${line.description}: a percentage complete is from 0 to 100.`);
          }
          const toDate = m.round(m.multiply(m.money(line.scheduledValue), String(percent / 100)), 2);
          work = m.toString(m.subtract(m.subtract(toDate, m.money(line.previousWork)), m.money(stored)));
        }
        await tx.update(schema.projectApplicationLine).set({
          ...(work !== undefined ? { workThisPeriod: work } : {}),
          storedNow: stored,
          updatedAt: new Date(),
        }).where(eq(schema.projectApplicationLine.id, line.id));
      }
    }

    await audit(tx, ctx, "project_application.updated", "project_application", row.id, row, input);
    return viewIn(tx, ctx, row.id);
  });
}

function assertDraft(row: ApplicationRow): void {
  if (row.status !== "draft") {
    throw new ConflictError(
      `Application ${row.number} has been invoiced, so it says what it said. `
      + "A correction is a credit note against its invoice and the next application.",
    );
  }
}

/** A draft that should not exist. An invoiced one cannot be deleted. */
export async function removeDraft(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; deleted: true }> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const row = await loadIn(tx, ctx.actor.organizationId, input.id);
    assertDraft(row);
    await tx.delete(schema.projectApplication).where(eq(schema.projectApplication.id, row.id));
    await audit(tx, ctx, "project_application.deleted", "project_application", row.id, row, null);
    return { id: row.id, deleted: true as const };
  });
}

/* ----------------------------------------------------------------- invoicing */

export interface RaiseApplicationResult {
  applicationId: string;
  invoiceId: string;
  amount: string;
  /** False when the invoice already existed, which is what a retry gets. */
  created: boolean;
}

/**
 * RAISE THE INVOICE, IDEMPOTENTLY, IN THREE STEPS.
 *
 * The same shape `projects.raiseDraw` uses and for the same reason: billing
 * may not be called from inside another service's transaction, so the
 * figures are checked in one transaction, the invoice is created through
 * `billing.create` under a key derived from this application, and the
 * application is frozen against it in a second transaction. A retry after a
 * crash between the two gets the same invoice back and finishes the job.
 *
 * The invoice's total is compared with the payment due before anything is
 * frozen. The only way they differ is an invoice made by an earlier attempt
 * on a draft that was edited before the attempt finished, and freezing an
 * application against an invoice for a different amount would be two
 * documents disagreeing about one bill.
 */
export async function raise(ctx: ServiceContext, input: { id: string }): Promise<RaiseApplicationResult> {
  const prepared = await guardedWrite(ctx, "invoice:write", async (tx) => {
    const row = await loadIn(tx, ctx.actor.organizationId, input.id);
    if (row.status === "invoiced") return { done: true as const, row };
    await syncDraft(tx, row);
    const lines = await linesOf(tx, row.id);
    const { project, input: figures, previousRetainage } = await inputsFor(tx, row, lines);
    const decision = plan.computeApplication(figures);
    if (!decision.ok) throw new ConflictError(decision.problems.join(" "));
    const invoiceLines = plan.paymentLines(decision, previousRetainage);
    if (!invoiceLines.ok) throw new ConflictError(invoiceLines.reason);
    return { done: false as const, row, project, decision, invoiceLines, figures };
  });

  if (prepared.done) {
    return {
      applicationId: prepared.row.id,
      invoiceId: prepared.row.invoiceId!,
      amount: prepared.row.currentPaymentDue ?? "0",
      created: false,
    };
  }

  const { row, project, decision, invoiceLines, figures } = prepared;
  const invoice = await billing.create(
    { ...ctx, idempotencyKey: `project-application:${row.id}` },
    {
      customerId: project.customerId,
      memo: `${project.name}, application for payment ${row.number}, period to ${row.periodTo}`,
      lines: invoiceLines.lines.map((line) => ({
        name: line.name,
        description: line.description,
        quantity: "1",
        unitPrice: line.amount,
        discountAmount: "0",
        /**
         * Not taxed on top. The schedule of values is the contract sum, and an
         * invoice that added tax to it would no longer agree with the
         * application the customer certified. Where tax applies to the work
         * it is in the contract sum already.
         */
        taxable: false,
      })),
    },
  );

  if (!m.equals(m.money(invoice.total), m.money(decision.totals.currentPaymentDue))) {
    throw new ConflictError(
      `Invoice ${invoice.number} was already made for this application for ${m.format(m.money(invoice.total))}, `
      + `and the application now asks for ${m.format(m.money(decision.totals.currentPaymentDue))}. `
      + "It was changed while it was being raised. Put the figures back, or void that invoice and start a new application.",
    );
  }

  await guardedWrite(ctx, "invoice:write", async (tx) => {
    /**
     * Locked and checked: only the transaction that turns this draft into an
     * invoiced application books its retainage, so a raise retried after it
     * went books nothing twice.
     */
    const [still] = await tx.select({ status: schema.projectApplication.status }).from(schema.projectApplication)
      .where(eq(schema.projectApplication.id, row.id)).for("update").limit(1);
    if (still?.status !== "draft") return;
    const booked = await retainage.bookOnInvoice(tx, ctx, {
      applicationId: row.id, projectId: project.id, customerId: project.customerId,
      totalRetainage: decision.totals.totalRetainage, at: new Date(),
    });
    await tx.update(schema.projectApplication).set({
      status: "invoiced",
      retainageBooked: booked,
      invoiceId: invoice.id,
      invoicedAt: new Date(),
      contractSum: decision.totals.contractSumToDate,
      netChangeOrders: figures.netChangeOrders,
      totalCompletedAndStored: decision.totals.totalCompletedAndStored,
      totalRetainage: decision.totals.totalRetainage,
      totalEarnedLessRetainage: decision.totals.totalEarnedLessRetainage,
      previousCertificates: decision.totals.previousCertificates,
      currentPaymentDue: decision.totals.currentPaymentDue,
      updatedAt: new Date(),
    }).where(and(eq(schema.projectApplication.id, row.id), eq(schema.projectApplication.status, "draft")));
    await audit(tx, ctx, "project_application.invoiced", "project_application", row.id,
      { status: "draft" }, { status: "invoiced", invoiceId: invoice.id, totals: decision.totals });
  });

  return { applicationId: row.id, invoiceId: invoice.id, amount: decision.totals.currentPaymentDue, created: true };
}

/** Today in the company's zone, for the period a new application defaults to. */
export async function today(ctx: ServiceContext): Promise<string> {
  return guardedRead(ctx, "invoice:read", async (tx) =>
    time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId)));
}

export const handlers = {
  listProjectApplications: async (ctx: ServiceContext, input: { projectId: string }) =>
    ({ applications: await list(ctx, input) }),
  getProjectApplication: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  createProjectApplication: (ctx: ServiceContext, input: {
    projectId: string; periodTo: string; periodFrom?: string | null | undefined;
    retainageRate?: string | null | undefined; storedRetainageRate?: string | null | undefined;
  }) => create(ctx, input),
  updateProjectApplication: (ctx: ServiceContext, input: DraftChange) => updateDraft(ctx, input),
  deleteProjectApplication: (ctx: ServiceContext, input: { id: string }) => removeDraft(ctx, input),
  raiseProjectApplication: (ctx: ServiceContext, input: { id: string }) => raise(ctx, input),
} as const;
