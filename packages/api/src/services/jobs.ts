import { and, eq, desc, lt, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError, scopeOf,
} from "./context";
import { audit } from "./customers";
import { releaseAllFor } from "./inventory";
import * as obligations from "./obligations";
import { jobScopeFilter } from "./scope";
import { emit } from "./events";
import type { JobCreate, listJobs, getJob, updateJob, scheduleVisit, completeVisit } from "../contracts/jobs";

type CreateInput = z.infer<typeof JobCreate>;

/**
 * The next human-facing number for an organization.
 *
 * `max(number) + 1` is only correct if nobody else is doing it at the same
 * time, and this comment used to claim a row lock on the organization that
 * the code never took. Two people booking in the same second both read the
 * same maximum and both got job 41. A duplicate job number is the kind of
 * thing a contractor notices immediately and never quite trusts you about
 * afterwards, and it is invisible in testing because it needs concurrency to
 * appear at all.
 *
 * Two things now hold it, and the second is the one that actually guarantees
 * it:
 *
 *   The advisory lock serialises allocation per (organization, table) for
 *   the rest of the transaction. It is transaction scoped, so it is released
 *   on commit or rollback without anything having to remember to.
 *
 *   The unique index on (organization_id, number) makes a duplicate
 *   impossible rather than merely unlikely. A lock can be skipped by a future
 *   code path that inserts a number of its own; the index cannot.
 *
 * Sequences were the obvious alternative and are wrong here: numbering is per
 * organization, so it would mean a sequence per tenant per table, created and
 * dropped with the tenant, and gaps on every rolled back transaction. Invoice
 * numbering with gaps is a real problem in several jurisdictions.
 */
async function nextNumber(
  tx: Database, organizationId: string,
  table: "job" | "invoice" | "estimate" | "purchase_order",
): Promise<number> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtext(${`number:${table}:${organizationId}`}))
  `);
  const [row] = await tx.execute(sql`
    select coalesce(max(number), 0) + 1 as next
    from ${sql.raw(`public.${table}`)}
    where organization_id = ${organizationId}
  `);
  return Number((row as { next: number }).next);
}

export async function list(ctx: ServiceContext, input: z.infer<typeof listJobs.input>) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    /**
     * A technician is scoped to their own work. This is a SCOPE question, not
     * a permission one: they may read jobs, and only theirs. Without it a
     * departing technician can walk out with the whole customer list.
     */
    const scope = scopeOf(ctx, "job");

    const rows = await tx
      .select({
        job: schema.job,
        customerName: schema.customer.name,
        propertyAddress: schema.property.addressLine1,
      })
      .from(schema.job)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(and(
        isNull(schema.job.deletedAt),
        input.status ? inArray(schema.job.status, input.status) : undefined,
        input.customerId ? eq(schema.job.customerId, input.customerId) : undefined,
        input.propertyId ? eq(schema.job.propertyId, input.propertyId) : undefined,
        cursor ? lt(schema.job.createdAt, new Date(cursor)) : undefined,
        // Every scope, not just `own`. An unhandled one used to fall through
        // to no filter, which turned a role written to be limited into one
        // that read the whole organization. See services/scope.ts.
        jobScopeFilter(scope, ctx.actor),
      ))
      .orderBy(desc(schema.job.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.job.createdAt.toISOString());
    return {
      ...page,
      data: page.data.map((r) => ({
        ...clean(ctx, "job", r.job),
        customerName: r.customerName,
        propertyAddress: r.propertyAddress,
      })),
    };
  });
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getJob.input>) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    const visits = await tx.select().from(schema.visit)
      .where(eq(schema.visit.jobId, input.id))
      .orderBy(schema.visit.sequence);

    return { ...clean(ctx, "job", job), visits };
  });
}

export async function create(ctx: ServiceContext, input: CreateInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "job"),
        )).limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.job).where(eq(schema.job.id, seen.entityId)).limit(1);
        if (existing) return clean(ctx, "job", existing);
      }
    }

    const number = await nextNumber(tx, ctx.actor.organizationId, "job");

    const [job] = await tx.insert(schema.job).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId: input.customerId,
      propertyId: input.propertyId,
      jobTypeId: input.jobTypeId ?? null,
      summary: input.summary,
      description: input.description ?? null,
      customerComplaint: input.customerComplaint ?? null,
      equipmentId: input.equipmentId ?? null,
      leadSource: input.leadSource ?? null,
      purchaseOrderNumber: input.purchaseOrderNumber ?? null,
      costCode: input.costCode ?? null,
      priority: input.priority ?? 0,
      status: input.visit ? "scheduled" : "lead",
      tags: input.tags,
      customFields: input.customFields,
    }).returning();

    /**
     * Parties beyond the customer. Residential omits this entirely and the
     * customer holds every role, which keeps the simple case simple. The
     * commercial case needs all of them, and needed them from the first
     * migration rather than after invoicing was written.
     */
    if (input.parties?.length) {
      await tx.insert(schema.jobParty).values(input.parties.map((p) => ({
        organizationId: ctx.actor.organizationId,
        jobId: job!.id,
        role: p.role,
        customerId: p.customerId ?? null,
        contactId: p.contactId ?? null,
        externalName: p.externalName ?? null,
        externalReference: p.externalReference ?? null,
      })));
    }

    /** Why this is free, cheaper, or billed to somebody else. */
    if (input.coverage) {
      await tx.insert(schema.entitlement).values({
        organizationId: ctx.actor.organizationId,
        jobId: job!.id,
        source: input.coverage.source,
        coversLabour: input.coverage.coversLabour,
        coversParts: input.coverage.coversParts,
        externalReference: input.coverage.externalReference ?? null,
        customerResponsibility: input.coverage.customerResponsibility ?? null,
      });
    }

    if (input.visit) {
      const [visit] = await tx.insert(schema.visit).values({
        organizationId: ctx.actor.organizationId,
        jobId: job!.id,
        sequence: 1,
        status: input.visit.technicianIds.length > 0 ? "scheduled" : "unassigned",
        windowStart: new Date(input.visit.windowStart),
        windowEnd: new Date(input.visit.windowEnd),
        estimatedDurationMinutes: input.visit.estimatedDurationMinutes,
      }).returning({ id: schema.visit.id });

      if (input.visit.technicianIds.length > 0) {
        await tx.insert(schema.visitAssignment).values(
          input.visit.technicianIds.map((technicianId, i) => ({
            organizationId: ctx.actor.organizationId,
            visitId: visit!.id,
            technicianId,
            isLead: i === 0,
          })),
        );
      }
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "job.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "job", entityId: job!.id,
      });
    }

    await audit(tx, ctx, "job.created", "job", job!.id, null, job!);
    return clean(ctx, "job", job!);
  });
}

/**
 * A job's status is a lifecycle, not a field, and this is where that is
 * enforced.
 *
 * The office genuinely does edit a booked job: the customer describes the
 * problem better on the second call, dispatch moves it to a different job
 * type, somebody puts it on hold. All of that is an ordinary update.
 *
 * What is not an ordinary update is walking the status backwards. A job that
 * has been invoiced cannot return to "lead", and one that has been paid is
 * finished. Those transitions do not fail loudly in a permissive system: they
 * succeed, and the money the job produced is still sitting in the ledger
 * pointing at work the board now says has not started.
 */
const REACHABLE: Record<string, readonly string[]> = {
  lead: ["lead", "estimating", "scheduled", "cancelled"],
  estimating: ["estimating", "lead", "scheduled", "cancelled"],
  scheduled: ["scheduled", "in_progress", "on_hold", "completed", "cancelled"],
  in_progress: ["in_progress", "on_hold", "completed", "cancelled"],
  on_hold: ["on_hold", "scheduled", "in_progress", "cancelled"],
  completed: ["completed", "in_progress", "invoiced", "cancelled"],
  // Invoiced is where the ledger has entries, so the only ways out are
  // forward to paid or, if the invoice is voided, back to completed.
  invoiced: ["invoiced", "paid", "completed"],
  paid: ["paid"],
  cancelled: ["cancelled"],
};

export function canTransition(from: string, to: string): boolean {
  return (REACHABLE[from] ?? []).includes(to);
}

export async function update(ctx: ServiceContext, input: z.infer<typeof updateJob.input>) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [before] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Job");

    if (input.status !== undefined && !canTransition(before.status, input.status)) {
      throw new ConflictError(
        `A job cannot move from "${before.status}" to "${input.status}".`,
      );
    }

    /**
     * Moving a job to a different customer or property is deliberately not
     * possible here. It sounds like an edit and it is a re-parenting: the
     * visits, the invoice, the equipment history and the portal links all
     * point at the old pair, and changing one of them silently strands the
     * rest. When it is genuinely needed it wants its own endpoint that moves
     * all of it together.
     */
    const [after] = await tx.update(schema.job).set({
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.customerComplaint !== undefined ? { customerComplaint: input.customerComplaint } : {}),
      ...(input.jobTypeId !== undefined ? { jobTypeId: input.jobTypeId } : {}),
      ...(input.leadSource !== undefined ? { leadSource: input.leadSource } : {}),
      ...(input.purchaseOrderNumber !== undefined ? { purchaseOrderNumber: input.purchaseOrderNumber } : {}),
      ...(input.costCode !== undefined ? { costCode: input.costCode } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      // Completion is a timestamp as well as a status, and a job that reaches
      // "completed" without one is invisible to every report that asks what
      // was finished this week.
      ...(input.status === "completed" && before.completedAt === null
        ? { completedAt: new Date() }
        : {}),
      ...(input.status === "cancelled" && before.cancelledAt === null
        ? { cancelledAt: new Date() }
        : {}),
      updatedAt: new Date(),
    }).where(eq(schema.job.id, input.id)).returning();

    await audit(tx, ctx, "job.updated", "job", input.id, before, after!);

    /**
     * Emitted in the same transaction as the update. After commit is the
     * obvious place and it is wrong under load: the transaction commits, the
     * process dies, and the workflow that was meant to text the customer
     * never runs with no trace that anything was missed.
     *
     * A status change is its own event as well as an update, because "when a
     * job is completed" is the thing every workflow author actually wants and
     * making them filter `job.updated` for it is a worse product.
     */
    await emit(tx, ctx, {
      name: "job.updated", entityType: "job", entityId: input.id,
      payload: { job: after! }, previous: { job: before },
    });
    if (input.status !== undefined && input.status !== before.status) {
      await emit(tx, ctx, {
        name: `job.${input.status}`, entityType: "job", entityId: input.id,
        payload: { job: after! }, previous: { job: before },
      });
    }

    /**
     * A CANCELLED JOB GIVES ITS PARTS BACK.
     *
     * A reservation is a `commit` movement with a job on it, and the level
     * fold subtracts every OPEN commitment from available. Nothing closed
     * one, so a cancelled job held its parts forever: the shelf showed them
     * and the available figure did not, and the reorder engine kept buying
     * against a shortfall that existed only because of a job nobody was
     * going to do. Every number stayed internally consistent, which is why
     * nothing detected it.
     *
     * Inside the same transaction as the cancellation. Afterwards is the
     * obvious place and is wrong for the same reason the event emit above is
     * in here: the cancellation commits, the process dies, and the stock
     * stays held with nothing recording that it should not be.
     */
    if (input.status === "cancelled" && before.status !== "cancelled") {
      const freed = await releaseAllFor(ctx, { jobId: input.id });
      if (freed.released.length > 0) {
        await audit(tx, ctx, "job.released_stock", "job", input.id, null, freed);
      }
    }

    return clean(ctx, "job", after!);
  });
}

export async function addVisit(ctx: ServiceContext, input: z.infer<typeof scheduleVisit.input>) {
  return guardedWrite(ctx, "visit:write", async (tx) => {
    const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, input.id)).limit(1);
    if (!job) throw new NotFoundError("Job");

    const rows = await tx.execute<{ next: number }>(sql`
      select coalesce(max(sequence), 0) + 1 as next from public.visit where job_id = ${input.id}
    `);
    const next = Number(rows[0]?.next ?? 1);

    const [visit] = await tx.insert(schema.visit).values({
      organizationId: ctx.actor.organizationId,
      jobId: input.id,
      sequence: next,
      status: input.technicianIds.length > 0 ? "scheduled" : "unassigned",
      windowStart: new Date(input.windowStart),
      windowEnd: new Date(input.windowEnd),
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      crewId: input.crewId ?? null,
    }).returning();

    if (input.technicianIds.length > 0) {
      await tx.insert(schema.visitAssignment).values(
        input.technicianIds.map((technicianId, i) => ({
          organizationId: ctx.actor.organizationId,
          visitId: visit!.id, technicianId, isLead: i === 0,
        })),
      );
    }

    await audit(tx, ctx, "visit.scheduled", "visit", visit!.id, null, visit!);
    return visit!;
  });
}

/**
 * Completing a visit.
 *
 * The important behaviour is what happens when dispatch cancelled it while the
 * device was offline. The write is ACCEPTED into a distinguished state and an
 * exception is raised for a human, because rejecting it destroys the labour
 * record, photos, signature, readings and, in a regulated trade, a record that
 * legally has to exist. The work physically happened, and deleting the
 * evidence does not undo it.
 */
export async function complete(ctx: ServiceContext, input: z.infer<typeof completeVisit.input>) {
  return guardedWrite(ctx, "job:complete", async (tx) => {
    const [visit] = await tx.select().from(schema.visit).where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    if (visit.status === "completed" || visit.status === "completed_after_cancellation") {
      // Idempotent by nature: a retry from a truck must not double-complete.
      return { ...visit, raisedDispatchException: false };
    }

    const wasCancelled = visit.status === "cancelled";
    const completedAt = input.completedOfflineAt ? new Date(input.completedOfflineAt) : new Date();

    const [updated] = await tx.update(schema.visit).set({
      status: wasCancelled ? "completed_after_cancellation" : "completed",
      completedAt,
      technicianNotes: input.technicianNotes ?? visit.technicianNotes,
      signatureUrl: input.signatureUrl ?? visit.signatureUrl,
      ...(input.checklist ? { checklist: input.checklist.map((c) => ({ id: c.id, label: "", required: false, doneAt: c.doneAt })) } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.visit.id, input.id)).returning();

    if (wasCancelled) {
      /**
       * Not an error on the write, an obligation on a dispatcher. It shows up
       * in the same place every other approaching deadline does: the
       * deadlines section of the task queue, which now exists.
       *
       * Keyed by the VISIT, not the job. A job can carry several visits and
       * only one of them was done after the cancellation; collapsing it to
       * the job loses which, and the decision is about that one piece of
       * work. The screen resolves the visit's job for the link rather than
       * the obligation giving up the precision to make linking easier.
       */
      await obligations.raise(tx, ctx.actor.organizationId, {
        kind: "dispatch.completed_after_cancellation",
        entityType: "visit",
        entityId: input.id,
        dueAt: new Date(),
        consequence:
          "A technician completed work on a cancelled visit"
          + (visit.windowStart ? ` from ${visit.windowStart.toISOString().slice(0, 10)}` : "")
          + ". Confirm whether to bill it.",
      });
    }

    const remaining = await tx.select({ id: schema.visit.id }).from(schema.visit)
      .where(and(
        eq(schema.visit.jobId, visit.jobId),
        inArray(schema.visit.status, ["unassigned", "scheduled", "dispatched", "en_route", "working"]),
      ));

    if (remaining.length === 0) {
      await tx.update(schema.job)
        .set({ status: "completed", completedAt, updatedAt: new Date() })
        .where(eq(schema.job.id, visit.jobId));
    }

    await audit(tx, ctx, "visit.completed", "visit", input.id, visit, updated!);
    return { ...updated!, raisedDispatchException: wasCancelled };
  });
}

export { nextNumber };
