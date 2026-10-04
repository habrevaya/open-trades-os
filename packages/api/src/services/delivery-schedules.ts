import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, permissionsFor, reporting, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { catalogueFor } from "./report-company";
import {
  deliverReport, sourceOf, mayReceive, companyPeople, cleanAddresses,
  type ReportSource, type DeliveryRecipient,
} from "./report-delivery";
import { deliverStatements, type StatementRunResult } from "./statement-delivery";
import { within } from "./workflow-schedule";
import { replayed, remember } from "./once";

/**
 * SCHEDULED DELIVERY: THE SETTINGS, AND THE CLOCK THAT FIRES THEM
 *
 * Reports on a cadence, and the monthly statement run, are one table and one
 * clock. See `schema/delivery.ts` for why.
 *
 * The clock is the workflow clock's shape exactly (`workflow-schedule.ts`): a
 * cross tenant read that returns ids, then inside each tenant a conditional
 * update on the due time as the claim, with the delivery in the SAME
 * transaction. Claiming first and sending after would lose an occurrence to a
 * crash in between; sending first would let two workers both send. Together, a
 * crash rolls both back and the next pass tries again, and the unique key on
 * the delivery row stops a retry from repeating one that committed.
 *
 * A LATE PASS SENDS ONCE. A worker down for three days comes back to three
 * missed Monday reports; it sends the one that was due and goes back on the
 * clock, because three copies of a weekly report arriving in one minute is
 * the outage being shown to the customer.
 */

/* ------------------------------------------------------------- the shapes */

export interface ReportScheduleInput {
  /** Exactly one of these. */
  builtIn?: string | undefined;
  reportId?: string | undefined;
  name?: string | undefined;
  frequency: string;
  weekdays?: number[] | undefined;
  dayOfMonth?: number | undefined;
  time: string;
  period?: string | undefined;
  userIds?: string[] | undefined;
  addresses?: string[] | undefined;
}

export interface LastDelivery {
  id: string;
  at: Date;
  status: string;
  error: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  rowCount: number | null;
  recipients: (DeliveryRecipient & { messageStatus: string | null })[];
}

export interface ReportScheduleView {
  id: string;
  name: string;
  builtIn: string | null;
  reportId: string | null;
  /** Where the report lives in the app. Null when it has been deleted. */
  reportPath: string | null;
  cadence: reporting.Cadence;
  /** The cadence in words. */
  cadenceText: string;
  period: reporting.Period;
  periodText: string;
  userIds: string[];
  /** The people, by name, for the list. */
  people: { userId: string; name: string }[];
  addresses: string[];
  paused: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
  ownerUserId: string | null;
  lastDelivery: LastDelivery | null;
}

const cadenceOf = (row: typeof schema.deliverySchedule.$inferSelect): reporting.Cadence => ({
  frequency: row.frequency,
  ...(row.frequency === "weekly" ? { weekdays: row.weekdays } : {}),
  ...(row.frequency === "monthly" ? { dayOfMonth: row.dayOfMonth ?? 1 } : {}),
  time: row.timeOfDay,
});

const periodOf = (value: string): reporting.Period => (reporting.isPeriod(value) ? value : "all");

/* ----------------------------------------------------------- report schedules */

/** The source a form or a request named, exactly one of the two. */
function sourceFrom(input: { builtIn?: string | undefined; reportId?: string | undefined }): ReportSource {
  if ((input.builtIn === undefined) === (input.reportId === undefined)) {
    throw new ConflictError("A schedule sends one report: either one that ships, or one somebody saved.");
  }
  return input.builtIn !== undefined ? { builtIn: input.builtIn } : { reportId: input.reportId! };
}

/**
 * Everything a schedule has to be before it is stored, checked against the
 * person storing it, with the first problem in words.
 *
 * It is checked again at every delivery, because people and roles change.
 * Checking now as well is what turns "it never arrived" into a sentence on the
 * form while somebody is still looking at it.
 */
async function checkReportSchedule(tx: Database, ctx: ServiceContext, input: ReportScheduleInput) {
  const source = sourceFrom(input);
  const named = await sourceOf(tx, source);
  if (!named) throw new NotFoundError("Report");

  const decision = reporting.resolveReport(named.definition, await catalogueFor(tx, ctx.actor.organizationId), permissionsFor(ctx.actor));
  if (!decision.ok) {
    throw new ConflictError(
      `You cannot schedule a report you cannot run yourself. ${reporting.explainRefusal(decision)}`,
    );
  }

  const cadence = reporting.checkCadence({
    frequency: input.frequency,
    weekdays: input.weekdays,
    dayOfMonth: input.dayOfMonth,
    time: input.time,
  });
  if (!cadence.ok) throw new ConflictError(cadence.reason);

  const period = input.period ?? reporting.defaultPeriod(cadence.cadence.frequency);
  if (!reporting.isPeriod(period)) throw new ConflictError(`There is no such period as "${period}".`);

  const userIds = [...new Set(input.userIds ?? [])];
  const addresses = cleanAddresses(input.addresses ?? []);
  if (userIds.length === 0 && addresses.length === 0) {
    throw new ConflictError("Pick somebody to send it to.");
  }

  const people = await companyPeople(tx);
  for (const userId of userIds) {
    const person = people.get(userId);
    if (!person) throw new ConflictError("One of the people picked is not in this company.");
    const refusal = await mayReceive(tx, ctx.actor.organizationId, userId, named.definition);
    if (refusal) {
      /**
       * Refused at the save rather than skipped at the send. Emailing a report
       * to somebody who could not open it in the app is the report builder's
       * scope hole with a mail server attached.
       */
      throw new ConflictError(`${person.name ?? person.email} ${refusal}, so it cannot be sent to them.`);
    }
  }

  return { source, named, cadence: cadence.cadence, period, userIds, addresses };
}

export function createReportSchedule(ctx: ServiceContext, input: ReportScheduleInput) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "delivery_schedule"),
        )).limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.deliverySchedule)
          .where(eq(schema.deliverySchedule.id, seen.entityId)).limit(1);
        if (existing) return existing;
      }
    }

    const checked = await checkReportSchedule(tx, ctx, input);
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);

    const [created] = await tx.insert(schema.deliverySchedule).values({
      organizationId: ctx.actor.organizationId,
      kind: "report",
      name: input.name?.trim() || checked.named.name,
      builtInReport: "builtIn" in checked.source ? checked.source.builtIn : null,
      reportId: "reportId" in checked.source ? checked.source.reportId : null,
      frequency: checked.cadence.frequency,
      weekdays: checked.cadence.weekdays ?? [],
      dayOfMonth: checked.cadence.dayOfMonth ?? null,
      timeOfDay: checked.cadence.time,
      period: checked.period,
      recipientUserIds: checked.userIds,
      externalAddresses: checked.addresses,
      ownerUserId: ctx.actor.userId,
      // Planned from now, so a report scheduled at noon for seven in the
      // morning arrives tomorrow at seven rather than straight away.
      nextRunAt: reporting.nextDelivery(checked.cadence, new Date(), timezone),
    }).returning();

    await audit(tx, ctx, "report_schedule.created", "delivery_schedule", created!.id, null, created);
    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "report_schedule.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "delivery_schedule", entityId: created!.id,
      });
    }
    return created!;
  });
}

/**
 * Change one. The person changing it becomes whose authority it runs under,
 * because they are the one now vouching for who receives it.
 */
export function updateReportSchedule(ctx: ServiceContext, input: { id: string } & ReportScheduleInput) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const before = await loadReportSchedule(tx, input.id);
    const checked = await checkReportSchedule(tx, ctx, input);
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);

    const [after] = await tx.update(schema.deliverySchedule).set({
      name: input.name?.trim() || before.name,
      builtInReport: "builtIn" in checked.source ? checked.source.builtIn : null,
      reportId: "reportId" in checked.source ? checked.source.reportId : null,
      frequency: checked.cadence.frequency,
      weekdays: checked.cadence.weekdays ?? [],
      dayOfMonth: checked.cadence.dayOfMonth ?? null,
      timeOfDay: checked.cadence.time,
      period: checked.period,
      recipientUserIds: checked.userIds,
      externalAddresses: checked.addresses,
      ownerUserId: ctx.actor.userId,
      nextRunAt: before.pausedAt ? null : reporting.nextDelivery(checked.cadence, new Date(), timezone),
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(schema.deliverySchedule.id, input.id)).returning();

    await audit(tx, ctx, "report_schedule.updated", "delivery_schedule", input.id, before, after);
    return after!;
  });
}

async function loadReportSchedule(tx: Database, id: string) {
  const [row] = await tx.select().from(schema.deliverySchedule)
    .where(and(eq(schema.deliverySchedule.id, id), eq(schema.deliverySchedule.kind, "report"))).limit(1);
  if (!row) throw new NotFoundError("Schedule");
  return row;
}

/**
 * Pause or resume.
 *
 * Resuming plans from NOW. A schedule paused in March and resumed in June has
 * three months of Mondays behind it, and none of them is owed.
 */
export function setReportSchedulePaused(ctx: ServiceContext, input: { id: string; paused: boolean }) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const before = await loadReportSchedule(tx, input.id);
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const [after] = await tx.update(schema.deliverySchedule).set(input.paused
      ? { pausedAt: before.pausedAt ?? new Date(), nextRunAt: null, updatedAt: new Date() }
      : {
          pausedAt: null,
          nextRunAt: reporting.nextDelivery(cadenceOf(before), new Date(), timezone),
          updatedAt: new Date(),
        })
      .where(eq(schema.deliverySchedule.id, input.id)).returning();
    await audit(tx, ctx, input.paused ? "report_schedule.paused" : "report_schedule.resumed",
      "delivery_schedule", input.id, before, after);
    return after!;
  });
}

/**
 * SEND IT NOW, rather than at the next occurrence.
 *
 * Somebody setting up a Monday report wants to see what Monday's email will
 * look like on the Thursday they set it up, and somebody whose accountant
 * asks "can you send me that again" wants a button rather than an edit to the
 * schedule. So: the same delivery a scheduled occurrence makes, to the same
 * people, over the same days measured back from now, through the same
 * `deliverReport`, so every recipient is still checked the same way and sent
 * the report as themselves.
 *
 * AS THE PERSON PRESSING IT, not as whoever set the schedule up. A schedule
 * runs under the authority of the person who vouched for its recipients; a
 * send now is a new decision to send, made by somebody else, and the delivery
 * row records whose run it was. Somebody who could not run the report
 * themselves is refused by the same check the schedule form makes.
 *
 * The clock is not touched: the next scheduled one still goes when it was
 * going to. A paused schedule can still be sent by hand, because pausing is
 * about the clock and this is not the clock.
 *
 * Once per press. The delivery's key is the request's idempotency key when it
 * has one, so a retried request finds the first delivery rather than emailing
 * everybody twice, and a fresh one otherwise, so a second press is a second
 * send, which is what pressing it twice means.
 */
export function sendReportScheduleNow(
  ctx: ServiceContext, input: { id: string },
): Promise<LastDelivery & { scheduleId: string }> {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const seen = await replayed<LastDelivery & { scheduleId: string }>(tx, ctx, "report_schedule_send");
    if (seen) return seen;

    const row = await loadReportSchedule(tx, input.id);
    const source: ReportSource = row.builtInReport ? { builtIn: row.builtInReport } : { reportId: row.reportId ?? "" };
    const named = await sourceOf(tx, source);
    if (!named) throw new ConflictError("The report this schedule sends has been deleted, so there is nothing to send.");
    const decision = reporting.resolveReport(named.definition, await catalogueFor(tx, ctx.actor.organizationId), permissionsFor(ctx.actor));
    if (!decision.ok) {
      throw new ConflictError(`You cannot send a report you cannot run yourself. ${reporting.explainRefusal(decision)}`);
    }

    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const result = await deliverReport(tx, {
      organizationId: ctx.actor.organizationId,
      ownerUserId: ctx.actor.userId,
      source,
      recipients: { userIds: row.recipientUserIds, addresses: row.externalAddresses },
      period: periodOf(row.period),
      at: new Date(),
      timezone,
      key: `schedule:${row.id}:now:${ctx.idempotencyKey ?? randomUUID()}`,
      scheduleId: row.id,
    });

    const [delivery] = result.deliveryId
      ? await tx.select().from(schema.reportDelivery).where(eq(schema.reportDelivery.id, result.deliveryId)).limit(1)
      : [];
    if (!delivery) throw new ConflictError("That was not sent. Nothing was recorded, so try again.");
    await audit(tx, ctx, "report_schedule.sent_now", "delivery_schedule", row.id, null,
      { deliveryId: delivery.id, status: delivery.status });

    const statuses = await messageStatuses(tx,
      delivery.recipients.flatMap((r) => (r.messageId ? [r.messageId] : [])));
    const answer = { ...shapeDelivery(delivery, statuses), scheduleId: row.id };
    await remember(tx, ctx, "report_schedule_send", delivery.id, answer);
    return answer;
  });
}

/**
 * Remove one. Deleted rather than flagged: what it sent stays, on the
 * delivery rows, named as it was, and a schedule nobody can see or restore is
 * not worth a column every read has to remember.
 */
export function removeReportSchedule(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const before = await loadReportSchedule(tx, input.id);
    await tx.delete(schema.deliverySchedule).where(eq(schema.deliverySchedule.id, input.id));
    await audit(tx, ctx, "report_schedule.deleted", "delivery_schedule", input.id, before, null);
    return { ok: true as const };
  });
}

/** The people a report can be sent to, for the form to offer. Everybody in the company, by name. */
export function recipientChoices(ctx: ServiceContext): Promise<{ userId: string; name: string; email: string }[]> {
  return guardedRead(ctx, "report:read", async (tx) => {
    const people = await companyPeople(tx);
    return [...people.entries()]
      .map(([userId, person]) => ({ userId, name: person.name ?? person.email, email: person.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** One schedule, for the form that changes it. */
export function getReportSchedule(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "report:read", (tx) => loadReportSchedule(tx, input.id));
}

/** Message statuses for the messages a delivery queued, in one read. */
async function messageStatuses(tx: Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: schema.message.id, status: schema.message.status })
    .from(schema.message).where(inArray(schema.message.id, ids));
  return new Map(rows.map((row) => [row.id, row.status]));
}

function shapeDelivery(
  row: typeof schema.reportDelivery.$inferSelect, statuses: Map<string, string>,
): LastDelivery {
  return {
    id: row.id,
    at: row.createdAt,
    status: row.status,
    error: row.error,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    rowCount: row.rowCount,
    recipients: row.recipients.map((r) => ({
      ...r, messageStatus: r.messageId ? statuses.get(r.messageId) ?? null : null,
    })),
  };
}

/** Every report schedule, with what its last delivery did. */
export function listReportSchedules(ctx: ServiceContext): Promise<ReportScheduleView[]> {
  return guardedRead(ctx, "report:read", async (tx) => {
    const rows = await tx.select().from(schema.deliverySchedule)
      .where(eq(schema.deliverySchedule.kind, "report"))
      .orderBy(schema.deliverySchedule.name);
    const people = await companyPeople(tx);

    const out: ReportScheduleView[] = [];
    for (const row of rows) {
      const [last] = await tx.select().from(schema.reportDelivery)
        .where(eq(schema.reportDelivery.scheduleId, row.id))
        .orderBy(desc(schema.reportDelivery.createdAt)).limit(1);
      const statuses = await messageStatuses(tx,
        (last?.recipients ?? []).flatMap((r) => (r.messageId ? [r.messageId] : [])));
      const source: ReportSource = row.builtInReport ? { builtIn: row.builtInReport } : { reportId: row.reportId ?? "" };
      const named = await sourceOf(tx, source);
      const cadence = cadenceOf(row);
      const period = periodOf(row.period);
      out.push({
        id: row.id,
        name: row.name,
        builtIn: row.builtInReport,
        reportId: row.reportId,
        reportPath: named?.path ?? null,
        cadence,
        cadenceText: reporting.describeCadence(cadence),
        period,
        periodText: reporting.PERIODS.find((p) => p.key === period)?.label ?? period,
        userIds: row.recipientUserIds,
        people: row.recipientUserIds.map((userId) => {
          const person = people.get(userId);
          return { userId, name: person ? person.name ?? person.email : "Somebody who has left" };
        }),
        addresses: row.externalAddresses,
        paused: row.pausedAt !== null,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
        lastError: row.lastError,
        ownerUserId: row.ownerUserId,
        lastDelivery: last ? shapeDelivery(last, statuses) : null,
      });
    }
    return out;
  });
}

/** What one schedule, or every schedule and automation, has sent, newest first. */
export function reportDeliveries(ctx: ServiceContext, input: { scheduleId?: string | undefined; limit?: number | undefined } = {}) {
  return guardedRead(ctx, "report:read", async (tx) => {
    const rows = await tx.select().from(schema.reportDelivery)
      .where(input.scheduleId ? eq(schema.reportDelivery.scheduleId, input.scheduleId) : undefined)
      .orderBy(desc(schema.reportDelivery.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));
    const statuses = await messageStatuses(tx,
      rows.flatMap((row) => row.recipients.flatMap((r) => (r.messageId ? [r.messageId] : []))));
    return rows.map((row) => ({
      ...shapeDelivery(row, statuses),
      reportName: row.reportName,
      scheduleId: row.scheduleId,
      workflowRunId: row.workflowRunId,
    }));
  });
}

/* ------------------------------------------------------- monthly statements */

export interface StatementSchedule {
  enabled: boolean;
  dayOfMonth: number;
  time: string;
  minimumBalance: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
}

const STATEMENT_DEFAULTS = { dayOfMonth: 1, time: "08:00", minimumBalance: "0" };

/** The company's monthly statement setting. Off until somebody turns it on. */
export function statementSchedule(ctx: ServiceContext): Promise<StatementSchedule> {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const [row] = await tx.select().from(schema.deliverySchedule)
      .where(eq(schema.deliverySchedule.kind, "statements")).limit(1);
    if (!row) return { enabled: false, ...STATEMENT_DEFAULTS, nextRunAt: null, lastRunAt: null, lastError: null };
    return {
      enabled: row.pausedAt === null,
      dayOfMonth: row.dayOfMonth ?? 1,
      time: row.timeOfDay,
      minimumBalance: row.minimumBalance ?? "0",
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      lastError: row.lastError,
    };
  });
}

/**
 * Turn monthly statements on or off, and say when and above what.
 *
 * Off is a pause, not a delete, so the months already sent stay attached to
 * the setting that sent them. `invoice:send`, because the only thing this
 * does is put bills in front of customers on a clock.
 */
export function setStatementSchedule(ctx: ServiceContext, input: {
  enabled: boolean;
  dayOfMonth?: number | undefined;
  time?: string | undefined;
  minimumBalance?: string | undefined;
}): Promise<StatementSchedule> {
  return guardedWrite(ctx, "invoice:send", async (tx) => {
    const cadence = reporting.checkCadence({
      frequency: "monthly",
      dayOfMonth: input.dayOfMonth ?? STATEMENT_DEFAULTS.dayOfMonth,
      time: input.time ?? STATEMENT_DEFAULTS.time,
    });
    if (!cadence.ok) throw new ConflictError(cadence.reason);
    const minimum = (input.minimumBalance ?? STATEMENT_DEFAULTS.minimumBalance).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(minimum)) {
      throw new ConflictError("The smallest balance worth a statement is an amount like 25 or 25.00.");
    }
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const next = input.enabled ? reporting.nextDelivery(cadence.cadence, new Date(), timezone) : null;

    const [before] = await tx.select().from(schema.deliverySchedule)
      .where(eq(schema.deliverySchedule.kind, "statements")).limit(1);
    const values = {
      frequency: "monthly" as const,
      dayOfMonth: cadence.cadence.dayOfMonth ?? 1,
      timeOfDay: cadence.cadence.time,
      minimumBalance: minimum,
      pausedAt: input.enabled ? null : before?.pausedAt ?? new Date(),
      nextRunAt: next,
      ownerUserId: ctx.actor.userId,
      lastError: null,
      updatedAt: new Date(),
    };

    const [after] = before
      ? await tx.update(schema.deliverySchedule).set(values)
          .where(eq(schema.deliverySchedule.id, before.id)).returning()
      : await refusingDuplicate(
          "delivery_schedule_statements_idx",
          "Monthly statements were set up by somebody else a moment ago. Reload and change that one.",
          () => tx.insert(schema.deliverySchedule).values({
            organizationId: ctx.actor.organizationId,
            kind: "statements",
            name: "Monthly statements",
            ...values,
          }).returning(),
        );

    await audit(tx, ctx, input.enabled ? "statement_schedule.enabled" : "statement_schedule.disabled",
      "delivery_schedule", after!.id, before ?? null, after);
    return {
      enabled: after!.pausedAt === null,
      dayOfMonth: after!.dayOfMonth ?? 1,
      time: after!.timeOfDay,
      minimumBalance: after!.minimumBalance ?? "0",
      nextRunAt: after!.nextRunAt,
      lastRunAt: after!.lastRunAt,
      lastError: after!.lastError,
    };
  });
}

/* ----------------------------------------------------------------- the clock */

export interface DeliveryTick {
  organizationId: string;
  scheduleId: string;
  kind: "report" | "statements";
  action: "delivered" | "skipped";
  reason?: string;
  /** Whether anything went into the outbox, so the pass knows to send it. */
  queued: boolean;
  report?: { status: string; error: string | null };
  statements?: StatementRunResult;
}

/** The actor a tick enters a tenant with. Holds nothing; each delivery has its own. */
function tickActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "delivery-clock" };
}

/**
 * One schedule's occurrence, delivered or not.
 *
 * Exported so a test can drive one schedule at a chosen moment without
 * reaching across tenants, and so the pass is a loop over this rather than a
 * second copy of the decision.
 */
export async function deliverOne(
  db: Database, organizationId: string, scheduleId: string, now = new Date(),
): Promise<DeliveryTick> {
  const ctx: ServiceContext = { actor: tickActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(schema.deliverySchedule)
      .where(eq(schema.deliverySchedule.id, scheduleId)).limit(1);
    const base = { organizationId, scheduleId, kind: row?.kind ?? "report", queued: false } as const;
    if (!row) return { ...base, action: "skipped" as const, reason: "gone" };
    if (row.pausedAt) return { ...base, action: "skipped" as const, reason: "paused" };
    const due = row.nextRunAt;
    if (!due) return { ...base, action: "skipped" as const, reason: "never_fires" };
    if (due > now) return { ...base, action: "skipped" as const, reason: "not_due" };

    const timezone = await timezoneOf(tx, organizationId);
    const cadence = cadenceOf(row);
    /**
     * THE CLAIM, conditional on the due time still being the one read and the
     * schedule still not paused, so of two workers that both saw it due exactly
     * one proceeds, and a pause that landed a moment ago wins.
     */
    const next = reporting.nextDelivery(cadence, now > due ? now : due, timezone);
    /**
     * Compared at the millisecond, because that is all a JavaScript date holds.
     * Postgres keeps microseconds, so a due time written by anything other
     * than this service (an operator's `now()`, a migration) would never equal
     * itself read back through the driver, and every pass would decide
     * somebody else had it. `workflow-runner.ts` learned the same thing.
     */
    const claimed = await tx.update(schema.deliverySchedule).set({
      nextRunAt: next, lastRunAt: due, updatedAt: new Date(),
    }).where(and(
      eq(schema.deliverySchedule.id, scheduleId),
      sql`date_trunc('milliseconds', ${schema.deliverySchedule.nextRunAt}) = ${due.toISOString()}::timestamptz`,
      sql`${schema.deliverySchedule.pausedAt} is null`,
    )).returning({ id: schema.deliverySchedule.id });
    if (claimed.length === 0) return { ...base, action: "skipped" as const, reason: "claimed_elsewhere" };

    if (row.kind === "statements") {
      const result = await deliverStatements(tx, {
        organizationId, scheduleId, at: due, minimumBalance: row.minimumBalance,
      });
      await tx.update(schema.deliverySchedule).set({
        lastError: result.refused > 0
          ? `${result.refused} of ${result.owing} customers owing were not sent a statement. The list below says why.`
          : null,
      }).where(eq(schema.deliverySchedule.id, scheduleId));
      return { ...base, kind: "statements" as const, action: "delivered" as const, queued: result.queued > 0, statements: result };
    }

    const source: ReportSource = row.builtInReport
      ? { builtIn: row.builtInReport }
      : { reportId: row.reportId ?? "" };
    /**
     * Keyed on the calendar day of the OCCURRENCE, not of the pass. A pass
     * that runs late for Monday's report still writes Monday's key, so the
     * Monday report cannot go twice however the passes fall.
     */
    const result = await deliverReport(tx, {
      organizationId,
      ownerUserId: row.ownerUserId,
      source,
      recipients: { userIds: row.recipientUserIds, addresses: row.externalAddresses },
      period: periodOf(row.period),
      at: due,
      timezone,
      key: `schedule:${scheduleId}:${reporting.deliveryDay(due, timezone)}`,
      scheduleId,
    });
    await tx.update(schema.deliverySchedule).set({ lastError: result.error })
      .where(eq(schema.deliverySchedule.id, scheduleId));
    return {
      ...base, kind: "report" as const, action: "delivered" as const,
      queued: result.recipients.some((r) => r.messageId),
      report: { status: result.status, error: result.error },
    };
  });
}

/**
 * One pass over every schedule that is due, across every tenant.
 *
 * The cross tenant read goes through `app.due_deliveries`, which returns ids
 * and nothing else and is not callable by the role the request path uses.
 */
export async function deliverDue(
  db: Database,
  options: { now?: Date; limit?: number; shouldStop?: () => boolean; only?: readonly string[] } = {},
): Promise<DeliveryTick[]> {
  const now = options.now ?? new Date();
  const rows = within(options.only, await db.execute<{ organization_id: string; schedule_id: string; kind: string }>(
    sql`select organization_id, schedule_id, kind from app.due_deliveries(${options.limit ?? 100})`,
  ));

  const results: DeliveryTick[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await deliverOne(db, row.organization_id, row.schedule_id, now));
    } catch (error) {
      /**
       * One company's broken schedule must not stop everybody else's. The
       * transaction rolled back, so it is still due and the next pass tries
       * again; the reason is written where the screen shows it, in its own
       * transaction because the one that failed is gone.
       */
      const reason = (error as Error).message;
      await inTenant({ actor: tickActor(row.organization_id), db }, async (tx) =>
        tx.update(schema.deliverySchedule).set({ lastError: `Could not send: ${reason}` })
          .where(eq(schema.deliverySchedule.id, row.schedule_id)),
      ).catch(() => undefined);
      results.push({
        organizationId: row.organization_id, scheduleId: row.schedule_id,
        kind: row.kind === "statements" ? "statements" : "report",
        action: "skipped", reason, queued: false,
      });
    }
  }
  return results;
}

/* --------------------------------------------------------------- handlers */

type ScheduleWire = {
  builtIn?: string | undefined;
  reportId?: string | undefined;
  name?: string | undefined;
  frequency: string;
  weekdays?: number[] | undefined;
  dayOfMonth?: number | undefined;
  time: string;
  period?: string | undefined;
  userIds?: string[] | undefined;
  addresses?: string[] | undefined;
};

export const handlers = {
  listReportSchedules: async (ctx: ServiceContext) => ({ schedules: await listReportSchedules(ctx) }),
  createReportSchedule: (ctx: ServiceContext, input: ScheduleWire) => createReportSchedule(ctx, input),
  updateReportSchedule: (ctx: ServiceContext, input: ScheduleWire & { id: string }) =>
    updateReportSchedule(ctx, input),
  setReportSchedulePaused: (ctx: ServiceContext, input: { id: string; paused: boolean }) =>
    setReportSchedulePaused(ctx, input),
  deleteReportSchedule: (ctx: ServiceContext, input: { id: string }) => removeReportSchedule(ctx, input),
  sendReportScheduleNow: (ctx: ServiceContext, input: { id: string }) => sendReportScheduleNow(ctx, input),
  listReportDeliveries: async (ctx: ServiceContext, input: { scheduleId?: string | undefined; limit?: number | undefined }) =>
    ({ deliveries: await reportDeliveries(ctx, input) }),
  getStatementSchedule: (ctx: ServiceContext) => statementSchedule(ctx),
  setStatementSchedule: (ctx: ServiceContext, input: {
    enabled: boolean; dayOfMonth?: number | undefined; time?: string | undefined; minimumBalance?: string | undefined;
  }) => setStatementSchedule(ctx, input),
} as const;
