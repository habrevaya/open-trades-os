import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, work, type field } from "@opentradesos/core";
import {
  audit, guardedRead, scopeOf, NotFoundError, type ServiceContext,
} from "./context";
import { jobScopeFilter } from "./scope";
import { sideOf } from "./visit-notices";

/**
 * A PART ASKED FOR FROM THE FIELD (`part.request`)
 *
 * The technician at the unit says what part it needs, in words, from the
 * phone's queue. That raises one office task naming the job, the part and who
 * asked, in the office queue, and keeps the request on the job. The phone
 * never places a hold: a hold names the purchase order the part is on, which is
 * the office's to know. Whoever orders the part places the hold from the task
 * (`jobHolds.place` with `partRequestId`), which links the hold here and
 * finishes the task.
 *
 * `field:sync` is all it needs, the same class of act as writing a note on the
 * visit: it asks, it decides nothing. Only from a visit the person is on (in
 * person or through their crew), on a job that is not cancelled.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest a part's words may be; the server keeps no more. */
export const PART_WORDS_MAX = 300;
export const PART_NOTE_MAX = 1000;

export async function requestOperation(
  tx: Database, ctx: ServiceContext, op: field.FieldOperation, technicianId: string | null,
): Promise<string | null> {
  if (!technicianId) return "This phone is not registered to a technician, so it cannot ask for a part. Ring the office.";
  if (!UUID.test(op.subjectId)) return "That request has no id.";
  const visitId = typeof op.payload["visitId"] === "string" ? op.payload["visitId"] : "";
  if (!UUID.test(visitId)) return "That request names no visit.";
  const part = typeof op.payload["part"] === "string" ? op.payload["part"].trim() : "";
  if (part === "") return "Say what part you need, in a few words.";
  if (part.length > PART_WORDS_MAX) return `Say the part in ${PART_WORDS_MAX} characters or fewer. Put the rest in the note.`;
  const said = typeof op.payload["note"] === "string" ? op.payload["note"].trim() : "";
  if (said.length > PART_NOTE_MAX) return `Keep the note to ${PART_NOTE_MAX} characters or fewer.`;
  const note = said === "" ? null : said;

  /** A request already written under this id is the phone sending it again. */
  const [already] = await tx.select({ id: schema.partRequest.id }).from(schema.partRequest)
    .where(eq(schema.partRequest.id, op.subjectId)).limit(1);
  if (already) return null;

  const [found] = await tx.select({
    visitId: schema.visit.id,
    windowStart: schema.visit.windowStart,
    job: schema.job,
    customerName: schema.customer.name,
    address: schema.property.addressLine1,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
    .where(and(eq(schema.visit.id, visitId), isNull(schema.job.deletedAt))).limit(1);
  if (!found) return "That visit is not here.";
  if (!((await sideOf(tx, visitId))?.technicianIds ?? []).includes(technicianId)) {
    return "That visit is not one of yours, so you cannot ask for a part on it from your phone. Ring the office.";
  }
  if (found.job.status === "cancelled") return "That job was cancelled, so no part is needed for it. Ring the office if it is.";

  const [tech] = await tx.select({ name: schema.technician.displayName }).from(schema.technician)
    .where(eq(schema.technician.id, technicianId)).limit(1);
  const who = tech?.name ?? "A technician";
  const label = work.documentNumber(found.job.numberPrefix, found.job.number);

  const [task] = await tx.insert(schema.task).values({
    organizationId: ctx.actor.organizationId,
    title: work.partRequestTitle({ jobLabel: label, part }),
    body: work.partRequestBody({
      technicianName: who, customerName: found.customerName, address: found.address,
      summary: found.job.summary, part, note,
    }),
    priority: "normal",
    entityType: "job",
    entityId: found.job.id,
    queue: "office",
    createdByUserId: ctx.actor.userId,
  }).returning({ id: schema.task.id });

  /** Written once even if two syncs land at once: the id is the phone's. */
  const [request] = await tx.insert(schema.partRequest).values({
    id: op.subjectId,
    organizationId: ctx.actor.organizationId,
    jobId: found.job.id,
    visitId,
    technicianId,
    requestedByUserId: ctx.actor.userId,
    part,
    note,
    requestedAt: op.occurredAt,
    taskId: task!.id,
  }).onConflictDoNothing().returning();
  if (!request) {
    await tx.delete(schema.task).where(eq(schema.task.id, task!.id));
    return null;
  }
  await audit(tx, ctx, "part.requested", "part_request", request.id, null, {
    jobId: found.job.id, visitId, part, note, taskId: task!.id, from: "phone",
  });
  return null;
}

/* ------------------------------------------------------------------ reads */

export interface PartRequestView {
  id: string;
  jobId: string;
  visitId: string | null;
  part: string;
  note: string | null;
  requestedAt: string;
  requestedBy: string | null;
  taskId: string | null;
  /** The task's own state, so a screen can say whether the office has finished with it. */
  taskStatus: string | null;
  /** The hold the office placed from it, or null while nobody has. */
  holdId: string | null;
  /** The order the hold names. Null for a reader without `po:read`, and before a hold. */
  purchaseOrderId: string | null;
  purchaseOrderNumber: number | null;
}

async function viewsWhere(tx: Database, ctx: ServiceContext, where: ReturnType<typeof eq>): Promise<PartRequestView[]> {
  const rows = await tx.select({
    request: schema.partRequest,
    technicianName: schema.technician.displayName,
    taskStatus: schema.task.status,
    orderId: schema.jobHold.purchaseOrderId,
    orderNumber: schema.purchaseOrder.number,
  }).from(schema.partRequest)
    .leftJoin(schema.technician, eq(schema.technician.id, schema.partRequest.technicianId))
    .leftJoin(schema.task, eq(schema.task.id, schema.partRequest.taskId))
    .leftJoin(schema.jobHold, eq(schema.jobHold.id, schema.partRequest.holdId))
    .leftJoin(schema.purchaseOrder, eq(schema.purchaseOrder.id, schema.jobHold.purchaseOrderId))
    .where(where)
    .orderBy(asc(schema.partRequest.requestedAt));
  const orders = can(ctx.actor, "po:read");
  return rows.map(({ request, technicianName, taskStatus, orderId, orderNumber }) => ({
    id: request.id,
    jobId: request.jobId,
    visitId: request.visitId,
    part: request.part,
    note: request.note,
    requestedAt: request.requestedAt.toISOString(),
    requestedBy: technicianName ?? null,
    taskId: request.taskId,
    taskStatus: taskStatus ?? null,
    holdId: request.holdId,
    purchaseOrderId: orders ? orderId ?? null : null,
    purchaseOrderNumber: orders ? orderNumber ?? null : null,
  }));
}

/** The parts asked for from the field on one job, oldest first. */
export function forJob(ctx: ServiceContext, input: { id: string }): Promise<{ data: PartRequestView[] }> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt), jobScopeFilter(scopeOf(ctx, "job"), ctx.actor)))
      .limit(1);
    if (!job) throw new NotFoundError("Job");
    return { data: await viewsWhere(tx, ctx, eq(schema.partRequest.jobId, job.id)) };
  });
}

/**
 * The request a task was raised for, or null for any other task. For the
 * task's page, which offers the hold from it; the job is checked against the
 * reader's scope, so a task about a job they cannot see shows no request.
 */
export function forTask(ctx: ServiceContext, input: { taskId: string }): Promise<PartRequestView | null> {
  return guardedRead(ctx, "task:read", async (tx) => {
    const [row] = await tx.select({ id: schema.partRequest.id, jobId: schema.partRequest.jobId })
      .from(schema.partRequest).where(eq(schema.partRequest.taskId, input.taskId)).limit(1);
    if (!row || !can(ctx.actor, "job:read")) return null;
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, row.jobId), isNull(schema.job.deletedAt), jobScopeFilter(scopeOf(ctx, "job"), ctx.actor)))
      .limit(1);
    if (!job) return null;
    return (await viewsWhere(tx, ctx, eq(schema.partRequest.id, row.id)))[0] ?? null;
  });
}

/**
 * The parts asked for on each of these jobs, for the phone's day: what was
 * asked, when, and whether the office has put the job on hold for it yet. The
 * words only; never the order, which is purchasing's.
 */
export async function forField(
  tx: Database, jobIds: string[],
): Promise<Map<string, Array<{ id: string; part: string; note: string | null; requestedAt: string; held: boolean }>>> {
  const out = new Map<string, Array<{ id: string; part: string; note: string | null; requestedAt: string; held: boolean }>>();
  if (jobIds.length === 0) return out;
  const rows = await tx.select().from(schema.partRequest)
    .where(inArray(schema.partRequest.jobId, [...new Set(jobIds)]))
    .orderBy(asc(schema.partRequest.requestedAt));
  for (const row of rows) {
    const list = out.get(row.jobId) ?? [];
    list.push({ id: row.id, part: row.part, note: row.note, requestedAt: row.requestedAt.toISOString(), held: row.holdId !== null });
    out.set(row.jobId, list);
  }
  return out;
}

export const handlers = {
  listJobPartRequests: (ctx: ServiceContext, input: { id: string }) => forJob(ctx, input),
} as const;
