import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m } from "@opentradesos/core";
import { NotFoundError, type ServiceContext } from "./context";

/**
 * M12. WHERE A PROJECT STANDS, READ ONE WAY BY EVERYBODY WHO ASKS.
 *
 * Change orders, applications for payment and the contract guards on the
 * project itself all ask the same three questions: how much has been billed,
 * how much has been billed against one phase, and what the schedule of
 * values is. Each asked them for itself, a change order would be refused
 * against one total and an application raised against another, and the two
 * would disagree on the day it mattered. So they are answered here, once,
 * inside the caller's transaction and without a guard of their own: every
 * caller has already passed one.
 */

export async function loadProjectIn(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.project)
    .where(and(eq(schema.project.id, id), eq(schema.project.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Project");
  return row;
}

/** The last application that became an invoice, whose figures the next one starts from. */
export async function lastInvoicedApplication(tx: Database, projectId: string) {
  const [row] = await tx.select().from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.projectId, projectId),
      eq(schema.projectApplication.status, "invoiced"),
    ))
    .orderBy(desc(schema.projectApplication.number)).limit(1);
  return row ?? null;
}

/**
 * EVERYTHING BILLED SO FAR, as the contract guards need it.
 *
 * Raised draws, plus the work CERTIFIED on the last application rather than
 * the sum of what the applications invoiced. The difference is the
 * retainage: work certified and held back is work the customer has agreed
 * was done, and cutting the contract below it is cutting it below work
 * already accepted.
 */
export async function billedToDate(tx: Database, projectId: string): Promise<m.Money> {
  const draws = await tx.select({ amount: schema.projectDraw.amount }).from(schema.projectDraw)
    .where(and(eq(schema.projectDraw.projectId, projectId), isNotNull(schema.projectDraw.invoiceId)));
  const last = await lastInvoicedApplication(tx, projectId);
  return m.add(
    m.sum(draws.map((d) => m.money(d.amount))),
    m.money(last?.totalCompletedAndStored ?? "0"),
  );
}

/**
 * Billed against one phase: every draw planned on it, since a planned draw
 * is a promise the schedule has already made, and what the last application
 * certified on its line.
 */
export async function billedAgainstPhase(tx: Database, projectId: string, phaseId: string): Promise<m.Money> {
  const draws = await tx.select({ amount: schema.projectDraw.amount }).from(schema.projectDraw)
    .where(eq(schema.projectDraw.projectPhaseId, phaseId));
  const last = await lastInvoicedApplication(tx, projectId);
  let certified = m.zero();
  if (last) {
    const [line] = await tx.select().from(schema.projectApplicationLine)
      .where(and(
        eq(schema.projectApplicationLine.applicationId, last.id),
        eq(schema.projectApplicationLine.projectPhaseId, phaseId),
      )).limit(1);
    if (line) {
      certified = m.add(m.add(m.money(line.previousWork), m.money(line.workThisPeriod)), m.money(line.storedNow));
    }
  }
  return m.add(m.sum(draws.map((d) => m.money(d.amount))), certified);
}

/** What the phases' billing values add up to. */
export async function phaseTotal(tx: Database, projectId: string): Promise<m.Money> {
  const rows = await tx.select({ billingValue: schema.projectPhase.billingValue })
    .from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId));
  return m.sum(rows.map((r) => m.money(r.billingValue ?? "0")));
}

/** The amounts of every change order agreed so far, in the order they were raised. */
export async function approvedChangeOrders(tx: Database, projectId: string) {
  return tx.select().from(schema.projectChangeOrder)
    .where(and(
      eq(schema.projectChangeOrder.projectId, projectId),
      eq(schema.projectChangeOrder.status, "approved"),
    ))
    .orderBy(asc(schema.projectChangeOrder.number));
}

export interface ScheduleOfValuesItem {
  /** `phase:<id>` or `change_order:<id>`. Stable across applications, which is what carries a line's history. */
  key: string;
  phaseId: string | null;
  changeOrderId: string | null;
  description: string;
  scheduledValue: string;
}

/**
 * THE SCHEDULE OF VALUES: every phase that carries part of the contract, in
 * order, then every agreed change order that landed on no phase, as a line
 * of its own. That second half is how a certifier expects to see extra work:
 * by its change order number, not folded silently into a phase they
 * certified at a different value last month.
 */
export async function scheduleOfValues(tx: Database, projectId: string): Promise<ScheduleOfValuesItem[]> {
  const phases = await tx.select().from(schema.projectPhase)
    .where(and(eq(schema.projectPhase.projectId, projectId), isNotNull(schema.projectPhase.billingValue)))
    .orderBy(asc(schema.projectPhase.sequence));
  const changes = await tx.select().from(schema.projectChangeOrder)
    .where(and(
      eq(schema.projectChangeOrder.projectId, projectId),
      eq(schema.projectChangeOrder.status, "approved"),
      isNull(schema.projectChangeOrder.projectPhaseId),
    ))
    .orderBy(asc(schema.projectChangeOrder.number));

  return [
    ...phases.map((phase) => ({
      key: `phase:${phase.id}`,
      phaseId: phase.id,
      changeOrderId: null,
      description: phase.name,
      scheduledValue: m.toString(m.money(phase.billingValue!)),
    })),
    ...changes.map((change) => ({
      key: `change_order:${change.id}`,
      phaseId: null,
      changeOrderId: change.id,
      description: `Change order ${change.number}: ${change.title}`,
      scheduledValue: m.toString(m.money(change.amount)),
    })),
  ];
}

/** The key a stored application line answers to, matching `ScheduleOfValuesItem.key`. */
export const lineKey = (line: { projectPhaseId: string | null; changeOrderId: string | null; id: string }) =>
  line.projectPhaseId ? `phase:${line.projectPhaseId}`
  : line.changeOrderId ? `change_order:${line.changeOrderId}`
  : `line:${line.id}`;

/**
 * IDEMPOTENCY ON THE CALLER'S KEY, the way billing keeps it: the first write
 * under a key records which row it made, and a retry under the same key gets
 * that row back instead of making a second. Scoped by the kind of row, so one
 * key reused across two different calls cannot return the wrong thing.
 */
export async function seenKey(tx: Database, ctx: ServiceContext, entityType: string): Promise<string | null> {
  if (!ctx.idempotencyKey) return null;
  const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return seen?.entityId ?? null;
}

export async function rememberKey(
  tx: Database, ctx: ServiceContext, eventType: string, entityType: string, entityId: string,
): Promise<void> {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    direction: "inbound", provider: "api", eventType,
    idempotencyKey: ctx.idempotencyKey, status: "succeeded",
    entityType, entityId,
  });
}
