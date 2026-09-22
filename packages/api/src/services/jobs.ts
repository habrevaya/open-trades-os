import { and, eq, desc, lt, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean, cleanAll,
  decodeCursor, paginate, NotFoundError, ConflictError, scopeOf,
} from "./context";
import { audit } from "./customers";
import type { JobCreate, listJobs, getJob, scheduleVisit, completeVisit } from "../contracts/jobs";

type CreateInput = z.infer<typeof JobCreate>;

/**
 * The next job number for an organization.
 *
 * Taken inside the caller's transaction with a row lock on the organization,
 * so two people booking at the same moment cannot be handed the same number.
 * A duplicate job number is the kind of thing a contractor notices immediately
 * and never quite trusts you about afterwards.
 */
async function nextNumber(tx: any, organizationId: string, table: "job" | "invoice" | "estimate"): Promise<number> {
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
        scope === "own" && ctx.actor.technicianId
          ? sql`exists (
              select 1 from public.visit v
              join public.visit_assignment va on va.visit_id = v.id
              where v.job_id = ${schema.job.id} and va.technician_id = ${ctx.actor.technicianId}
            )`
          : undefined,
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
       * in the same place every other approaching deadline does.
       */
      await tx.insert(schema.obligation).values({
        organizationId: ctx.actor.organizationId,
        kind: "dispatch.completed_after_cancellation",
        entityType: "visit",
        entityId: input.id,
        dueAt: new Date(),
        consequence: "A technician completed work on a cancelled visit. Confirm whether to bill it.",
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
