import { and, eq, desc, lt, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError, UnprocessableError, scopeOf,
  withProvenance,
} from "./context";
import { admitInstant, requireImport } from "./history";
import { assertUnclaimed, byExternal, provenance } from "./provenance";
import { enforceWithin } from "./custom-fields";
import { releaseAllFor } from "./inventory";
import * as obligations from "./obligations";
import { jobScopeFilter } from "./scope";
import { emit } from "./events";
import { awayBetween } from "./time-off";
import { inForceAt } from "./pricebook";
import * as acquisition from "./acquisition";
import * as marketing from "./marketing";
import type { JobCreate, listJobs, getJob, updateJob, scheduleVisit, completeVisit, listJobTypes, listJobLines } from "../contracts/jobs";

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
  table: "job" | "invoice" | "estimate" | "purchase_order" | "credit_note",
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

/**
 * A number for a new document: the next one, or the one a migration asked
 * for.
 *
 * Asking for one is recording history, so it needs `data:import`. The source
 * document's number is what the customer knows it by, and an invoice that
 * changes number on the way in is one nobody can find on the phone.
 *
 * Taken under the same lock as `nextNumber`, and refused if it is in use
 * rather than left to the unique index, so the answer is a sentence instead
 * of a constraint name. Nothing has to "move the sequence past" an imported
 * number, because there is no sequence: the next number is always one more
 * than the highest in use, so importing invoice 2201 makes the next new one
 * 2202 and two documents can never share a number.
 */
async function claimNumber(
  tx: Database, ctx: ServiceContext,
  table: "job" | "invoice" | "estimate",
  requested: number | undefined,
): Promise<number> {
  if (requested === undefined) return nextNumber(tx, ctx.actor.organizationId, table);
  requireImport(ctx);
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtext(${`number:${table}:${ctx.actor.organizationId}`}))
  `);
  const taken = await tx.execute(sql`
    select 1 from ${sql.raw(`public.${table}`)}
    where organization_id = ${ctx.actor.organizationId} and number = ${requested}
    limit 1
  `);
  if (taken.length > 0) {
    throw new ConflictError(`${table[0]!.toUpperCase()}${table.slice(1)} number ${requested} is already taken.`);
  }
  return requested;
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
        /**
         * Published on every row and produced by nothing, so a board or a
         * migration reading "when is this job next out" always got
         * undefined. The earliest window still ahead of a visit that is
         * still going to happen. The outer id is written out, not
         * interpolated: see test/sql-fragments.test.ts for why.
         */
        nextVisitAt: sql<string | null>`(
          select to_char(min(v.window_start) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          from public.visit v
          where v.job_id = "job"."id"
            and v.window_start >= now()
            and v.status in ('unassigned', 'scheduled', 'dispatched', 'en_route', 'working')
        )`,
      })
      .from(schema.job)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(and(
        isNull(schema.job.deletedAt),
        input.status ? inArray(schema.job.status, input.status) : undefined,
        input.customerId ? eq(schema.job.customerId, input.customerId) : undefined,
        input.propertyId ? eq(schema.job.propertyId, input.propertyId) : undefined,
        byExternal(schema.job, input),
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
        nextVisitAt: r.nextVisitAt,
      })),
    };
  });
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getJob.input>) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    return { ...clean(ctx, "job", job), visits: await visitsOf(tx, input.id) };
  });
}

/**
 * A job's visits as the contract publishes them, with who is assigned to
 * each. `technicianIds` was published on every visit and never read, so a
 * migration checking which technician it had put on a visit always saw none.
 */
async function visitsOf(tx: Database, jobId: string) {
  const visits = await tx.select().from(schema.visit)
    .where(eq(schema.visit.jobId, jobId))
    .orderBy(schema.visit.sequence);
  if (visits.length === 0) return [];
  const assigned = await tx.select({
    visitId: schema.visitAssignment.visitId, technicianId: schema.visitAssignment.technicianId,
  }).from(schema.visitAssignment)
    .where(inArray(schema.visitAssignment.visitId, visits.map((v) => v.id)))
    .orderBy(desc(schema.visitAssignment.isLead));
  return visits.map((v) => ({
    ...withProvenance(v),
    technicianIds: assigned.filter((a) => a.visitId === v.id).map((a) => a.technicianId),
  }));
}

async function assignedTo(tx: Database, visitId: string): Promise<string[]> {
  const rows = await tx.select({ technicianId: schema.visitAssignment.technicianId })
    .from(schema.visitAssignment).where(eq(schema.visitAssignment.visitId, visitId))
    .orderBy(desc(schema.visitAssignment.isLead));
  return rows.map((r) => r.technicianId);
}

/**
 * A callback has to point at real work for the same customer.
 *
 * Both halves matter. A parent from another company is a cross tenant read
 * dressed as a field, and RLS already hides it so the lookup simply misses.
 * A parent belonging to a DIFFERENT customer is the one that would slip
 * through: it makes the callback rate count a return visit against work
 * nobody connected to it, and the review rule withhold an ask from the
 * wrong person.
 */
async function assertCallbackParent(
  tx: Database,
  organizationId: string,
  input: { parentJobId: string; customerId: string; selfId?: string },
): Promise<void> {
  if (input.selfId && input.parentJobId === input.selfId) {
    throw new ConflictError("A job cannot be a return visit for itself.");
  }

  const [parent] = await tx.select({
    id: schema.job.id,
    customerId: schema.job.customerId,
  }).from(schema.job)
    .where(and(
      eq(schema.job.id, input.parentJobId),
      eq(schema.job.organizationId, organizationId),
      isNull(schema.job.deletedAt),
    )).limit(1);

  if (!parent) throw new NotFoundError("The job this is a return visit for");
  if (parent.customerId !== input.customerId) {
    throw new ConflictError(
      "That job belongs to a different customer, so this is not a return visit for it. "
      + "A callback counted against unrelated work makes the callback rate meaningless.",
    );
  }
}

/**
 * NOBODY IS BOOKED ONTO A DAY THEY HAVE OFF.
 *
 * The board has shown approved time off since it was built, so an empty
 * column says why it is empty. Booking did not ask, so a job booked from a
 * customer's page put a technician on the morning of their holiday and the
 * first anybody knew was a customer waiting at home. Asked here, of the same
 * approved time off the board reads, so the two cannot disagree.
 *
 * Only for work still to come. A visit whose window has already ended is a
 * record of what happened, and history is not refused for being
 * inconvenient: a migration loading last year's visits must not fail because
 * somebody also took that week off.
 */
async function assertAvailable(
  tx: Database, organizationId: string,
  technicianIds: readonly string[], windowStart: Date, windowEnd: Date,
): Promise<void> {
  if (technicianIds.length === 0 || windowEnd.getTime() < Date.now()) return;
  const people = await tx.select({
    id: schema.technician.id, displayName: schema.technician.displayName, active: schema.technician.active,
  }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, organizationId),
      inArray(schema.technician.id, [...technicianIds]),
    ));
  /**
   * The same refusal dispatch gives for the same mistake. Booking an id that
   * is not a technician here used to succeed and leave a visit assigned to
   * nobody anybody could see.
   */
  if (people.length !== new Set(technicianIds).size || people.some((p) => !p.active)) {
    throw new ConflictError("One of those technicians is not active in this company.");
  }
  const away = await awayBetween(tx, organizationId, windowStart, windowEnd, [...technicianIds]);
  if (away.size === 0) return;
  const names = people.filter((p) => away.has(p.id)).map((p) => p.displayName);
  throw new ConflictError(
    `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} on approved time off then. `
    + "Choose somebody else, or another time.",
  );
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
        if (existing) return { ...clean(ctx, "job", existing), visits: await visitsOf(tx, existing.id) };
      }
    }

    if (input.parentJobId) {
      await assertCallbackParent(tx, ctx.actor.organizationId, {
        parentJobId: input.parentJobId,
        customerId: input.customerId,
      });
    }

    await assertUnclaimed(tx, "job", input.externalRef);
    await assertUnclaimed(tx, "visit", input.visit?.externalRef);
    if (input.visit) {
      await assertAvailable(
        tx, ctx.actor.organizationId, input.visit.technicianIds,
        new Date(input.visit.windowStart), new Date(input.visit.windowEnd),
      );
    }
    const number = await claimNumber(tx, ctx, "job", input.number);

    await enforceWithin(
      tx, ctx.actor.organizationId, "job", input.customFields,
    );

    /**
     * The lead source somebody chose, checked against the channel list the
     * same way a customer's is. A job loaded from another system keeps what
     * its old system said, and is not credited to any touch: its marketing
     * happened in somebody else's software.
     */
    const imported = input.externalRef !== undefined;
    const { declared, verbatim } = await acquisition.declaredOrVerbatim(tx, ctx.actor.organizationId, {
      leadSource: input.leadSource, channelId: input.channelId, campaignId: input.campaignId,
    }, imported);

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
      leadSource: declared?.sourceKey ?? verbatim,
      leadSourceOrigin: declared ? (imported ? "imported" : "manual") : verbatim ? "imported" : null,
      channelId: declared?.channelId ?? null,
      acquisitionCampaignId: declared?.campaignId ?? null,
      purchaseOrderNumber: input.purchaseOrderNumber ?? null,
      costCode: input.costCode ?? null,
      priority: input.priority ?? 0,
      status: input.visit ? "scheduled" : "lead",
      tags: input.tags,
      customFields: input.customFields,
      /**
       * The three the contract published and nothing wrote. Without
       * `parentJobId` the callback rate has no numerator and the review
       * request rule that withholds an ask while a callback is open can
       * never fire, so customers were asked to review work we were still
       * coming back to fix.
       */
      parentJobId: input.parentJobId ?? null,
      isWarranty: input.isWarranty ?? false,
      priceSource: input.priceSource ?? "price_book",
      ...provenance(input.externalRef),
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
        ...provenance(input.visit.externalRef),
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

    /**
     * CREDITED, like every other path that creates work. A job a CSR types in
     * after a call on the Google Ads number is the commonest way work arrives
     * in this trade, and until this line it was the one way that was never
     * credited to anything. History from another system is the exception:
     * stitching today's touches onto a job from 2019 would credit this
     * month's ads with last decade's work.
     */
    if (!imported) {
      const credit = await marketing.creditWork(tx, ctx.actor.organizationId, {
        jobId: job!.id,
        declared,
        callId: input.callId ?? null,
        userId: ctx.actor.userId,
      });
      if (!credit.credited) {
        await acquisition.assertLeadSourceGiven(tx, ctx.actor.organizationId, declared, "job", false);
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

    /**
     * The audit entry below is not an event. The audit log is what somebody
     * reads afterwards; a domain event is what a workflow subscribes to, and
     * the builder offered "when a job is created" while only status CHANGES
     * emitted anything. A job booked and never moved off `scheduled` emitted
     * nothing at all.
     */
    await emit(tx, ctx, {
      name: "job.created", entityType: "job", entityId: job!.id,
      payload: { job: job! },
    });

    /** Read back, so the response carries what crediting wrote onto it. */
    const [saved] = await tx.select().from(schema.job).where(eq(schema.job.id, job!.id)).limit(1);
    await audit(tx, ctx, "job.created", "job", job!.id, null, saved!);
    /**
     * With its visits, as the contract has always said. The created job came
     * back without them, so a caller that booked a visit inline had to read
     * the job again to learn the visit's id.
     */
    return { ...clean(ctx, "job", saved!), visits: await visitsOf(tx, job!.id) };
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

/**
 * The states a job's last visit finishes it from: work not yet finished.
 * Not `canTransition(status, "completed")`, which also allows invoiced back
 * to completed for a voided invoice, a move a visit must never make.
 */
const FINISHED_BY_LAST_VISIT = ["lead", "estimating", "scheduled", "in_progress", "on_hold"] as const;

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
     * WHEN IT WAS FINISHED, on the move to finished and at no other time.
     *
     * Completing a job stamped now, so a job finished in 2022 and recorded
     * during a migration was finished on the day of the cutover, and every
     * report asking what was done in a month was wrong for every month
     * before it. The time is taken only together with the move to
     * `completed`: changing when an already finished job was finished is
     * rewriting a fact other things (commission, the technician's numbers)
     * were computed from, and is not an edit this route offers.
     */
    let completedAt: Date | null = null;
    let historical = false;
    if (input.completedAt !== undefined) {
      if (input.status !== "completed" || before.status === "completed" || before.completedAt !== null) {
        throw new UnprocessableError("completedAt goes with the move to completed", [{
          path: "completedAt",
          message: 'Send it with status "completed", on a job that is not already completed.',
        }]);
      }
      completedAt = new Date(input.completedAt);
      historical = (await admitInstant(tx, ctx, completedAt, "completedAt")).historical;
    }

    /**
     * Moving a job to a different customer or property is deliberately not
     * possible here. It sounds like an edit and it is a re-parenting: the
     * visits, the invoice, the equipment history and the portal links all
     * point at the old pair, and changing one of them silently strands the
     * rest. When it is genuinely needed it wants its own endpoint that moves
     * all of it together.
     */
    if (input.parentJobId) {
      await assertCallbackParent(tx, ctx.actor.organizationId, {
        parentJobId: input.parentJobId,
        customerId: before.customerId,
        selfId: input.id,
      });
    }

    if (input.customFields !== undefined) {
      await enforceWithin(
        tx, ctx.actor.organizationId, "job", input.customFields, before.customFields,
      );
    }

    /**
     * A lead source corrected on the job: checked, written as `manual`, and
     * recorded as a declared touch on this job so the change reaches the
     * reports. Null clears the columns and records nothing.
     */
    const changingSource = input.leadSource !== undefined || input.channelId !== undefined
      || input.campaignId !== undefined;
    const declared = changingSource
      ? await acquisition.resolveDeclared(tx, ctx.actor.organizationId, {
        leadSource: input.leadSource, channelId: input.channelId, campaignId: input.campaignId,
      })
      : null;
    const sourceColumns = !changingSource ? {} : declared
      ? {
        leadSource: declared.sourceKey, leadSourceOrigin: "manual",
        channelId: declared.channelId, acquisitionCampaignId: declared.campaignId,
      }
      : { leadSource: null, leadSourceOrigin: null, channelId: null, acquisitionCampaignId: null };
    if (declared) {
      await marketing.declareSource(tx, ctx.actor.organizationId, {
        declared, customerId: before.customerId, jobId: input.id, userId: ctx.actor.userId,
      });
    }

    const [after] = await tx.update(schema.job).set({
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.customerComplaint !== undefined ? { customerComplaint: input.customerComplaint } : {}),
      ...(input.jobTypeId !== undefined ? { jobTypeId: input.jobTypeId } : {}),
      ...sourceColumns,
      ...(input.purchaseOrderNumber !== undefined ? { purchaseOrderNumber: input.purchaseOrderNumber } : {}),
      ...(input.costCode !== undefined ? { costCode: input.costCode } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
      ...(input.isWarranty !== undefined ? { isWarranty: input.isWarranty } : {}),
      ...(input.priceSource !== undefined ? { priceSource: input.priceSource } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      // Completion is a timestamp as well as a status, and a job that reaches
      // "completed" without one is invisible to every report that asks what
      // was finished this week.
      ...(input.status === "completed" && before.completedAt === null
        ? { completedAt: completedAt ?? new Date() }
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
    /**
     * A job finished in 2022 and recorded now is not news. "When a job is
     * completed, ask for a review" would otherwise ask a thousand customers
     * on the day of a migration about work they have forgotten.
     */
    if (!historical) await emit(tx, ctx, {
      name: "job.updated", entityType: "job", entityId: input.id,
      payload: { job: after! }, previous: { job: before },
    });
    if (!historical && input.status !== undefined && input.status !== before.status) {
      await emit(tx, ctx, {
        /**
         * Built from the status enum, and the catalogue carries a line per
         * status, so a status added to the database without one is a
         * compile error rather than an event nobody can subscribe to.
         */
        name: `job.${input.status}` as const, entityType: "job", entityId: input.id,
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
    /**
     * THE CONTRACT SAID IDEMPOTENT AND THIS DID NOT READ THE KEY.
     *
     * The dispatcher handed the Idempotency-Key over and nothing looked at
     * it, so a retried request after a dropped response added a second
     * visit, and a technician was sent twice. Checked inside the
     * transaction like every other create, so two simultaneous retries
     * cannot both pass.
     */
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "visit"),
        )).limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.visit)
          .where(eq(schema.visit.id, seen.entityId)).limit(1);
        if (existing) return { ...withProvenance(existing), technicianIds: await assignedTo(tx, existing.id) };
      }
    }

    const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, input.id)).limit(1);
    if (!job) throw new NotFoundError("Job");
    /**
     * A cancelled job is finished with. Sending somebody to it is a visit
     * the customer said no to, and the job's status would go on saying
     * cancelled while a van drove there. A cancelled visit is still
     * recorded, because that is history rather than work.
     */
    if (job.status === "cancelled" && input.status !== "cancelled") {
      throw new ConflictError(`Job ${job.number} was cancelled. Book a new job rather than a visit on this one.`);
    }
    await assertUnclaimed(tx, "visit", input.externalRef);

    /**
     * Half a window is not a window. A start with no end invents the end,
     * and an end with no start invents the start, and either puts a
     * technician somewhere at a time nobody agreed.
     */
    if ((input.windowStart === undefined) !== (input.windowEnd === undefined)) {
      throw new UnprocessableError("A window has both ends or neither", [{
        path: input.windowStart === undefined ? "windowStart" : "windowEnd",
        message: "Send windowStart and windowEnd together, or neither for a visit with no time yet.",
      }]);
    }
    if (input.windowStart && input.windowEnd && Date.parse(input.windowEnd) < Date.parse(input.windowStart)) {
      throw new UnprocessableError("The window ends before it starts", [{
        path: "windowEnd", message: "windowEnd is before windowStart.",
      }]);
    }

    if (input.windowStart && input.windowEnd && input.status !== "cancelled") {
      await assertAvailable(
        tx, ctx.actor.organizationId, input.technicianIds,
        new Date(input.windowStart), new Date(input.windowEnd),
      );
    }

    const rows = await tx.execute<{ next: number }>(sql`
      select coalesce(max(sequence), 0) + 1 as next from public.visit where job_id = ${input.id}
    `);
    const next = Number(rows[0]?.next ?? 1);

    const [visit] = await tx.insert(schema.visit).values({
      organizationId: ctx.actor.organizationId,
      jobId: input.id,
      sequence: next,
      /**
       * CANCELLED COULD NOT BE RECORDED, so a migration either dropped a
       * cancelled visit from the job's history or loaded it as scheduled and
       * sent somebody to a customer who had said no. A visit with no window
       * cannot be dispatched, so it is unassigned whoever is named on it.
       */
      status: input.status === "cancelled" ? "cancelled"
        : input.technicianIds.length > 0 && input.windowStart ? "scheduled" : "unassigned",
      windowStart: input.windowStart ? new Date(input.windowStart) : null,
      windowEnd: input.windowEnd ? new Date(input.windowEnd) : null,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      crewId: input.crewId ?? null,
      ...provenance(input.externalRef),
    }).returning();

    if (input.technicianIds.length > 0) {
      await tx.insert(schema.visitAssignment).values(
        input.technicianIds.map((technicianId, i) => ({
          organizationId: ctx.actor.organizationId,
          visitId: visit!.id, technicianId, isLead: i === 0,
        })),
      );
    }

    /**
     * A LEAD WITH A VISIT ON THE BOARD IS BOOKED.
     *
     * A job created without a visit starts as a lead, and the first visit
     * put on it later left it there, so the jobs list called booked work a
     * lead and the pipeline counted it twice. Only from those two states and
     * only for a visit with a time: a visit with no window is not booked
     * yet, and a job further along keeps its own status.
     */
    if ((job.status === "lead" || job.status === "estimating") && input.windowStart && input.status !== "cancelled") {
      await tx.update(schema.job).set({ status: "scheduled", updatedAt: new Date() })
        .where(eq(schema.job.id, input.id));
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "visit.schedule",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "visit", entityId: visit!.id,
      });
    }

    await audit(tx, ctx, "visit.scheduled", "visit", visit!.id, null, visit!);
    return { ...withProvenance(visit!), technicianIds: input.technicianIds };
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
      return { ...withProvenance(visit), technicianIds: await assignedTo(tx, visit.id), raisedDispatchException: false };
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

    /**
     * WHAT WAS USED, ON THE JOB.
     *
     * `partsUsed` has been in the contract since it was written and nothing
     * read it, so the capacitor the office recorded while completing a visit
     * went nowhere: not onto the job's cost, and not onto the invoice raised
     * from the job afterwards. Each one is a job line priced from the price
     * book version in force today, frozen by its version id the same way an
     * invoice line is, and left unbilled until an invoice takes it.
     */
    if (input.partsUsed?.length) {
      const itemIds = [...new Set(input.partsUsed.map((p) => p.priceBookItemId))];
      const versions = await tx.select({
        itemId: schema.priceBookItemVersion.itemId,
        versionId: schema.priceBookItemVersion.id,
        name: schema.priceBookItemVersion.name,
        description: schema.priceBookItemVersion.description,
        price: schema.priceBookItemVersion.price,
        cost: schema.priceBookItemVersion.cost,
        taxable: schema.priceBookItemVersion.taxable,
        kind: schema.priceBookItem.kind,
      }).from(schema.priceBookItemVersion)
        .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
        .where(and(inArray(schema.priceBookItemVersion.itemId, itemIds), inForceAt()));
      const byItem = new Map(versions.map((v) => [v.itemId, v]));
      const missing = itemIds.filter((id) => !byItem.has(id));
      if (missing.length > 0) throw new NotFoundError("Price book item");

      const [assignee] = await assignedTo(tx, input.id);
      await tx.insert(schema.jobLine).values(input.partsUsed.map((part) => {
        const v = byItem.get(part.priceBookItemId)!;
        return {
          organizationId: ctx.actor.organizationId,
          jobId: visit.jobId,
          visitId: input.id,
          kind: v.kind === "labor" ? "labor" as const : v.kind === "equipment" ? "equipment" as const : "part" as const,
          source: "office" as const,
          priceBookItemVersionId: v.versionId,
          name: v.name,
          description: v.description ?? null,
          quantity: part.quantity,
          unitPrice: v.price,
          unitCost: v.cost ?? null,
          taxable: v.taxable,
          technicianId: assignee ?? null,
          occurredAt: completedAt,
        };
      }));
    }

    const remaining = await tx.select({ id: schema.visit.id }).from(schema.visit)
      .where(and(
        eq(schema.visit.jobId, visit.jobId),
        inArray(schema.visit.status, ["unassigned", "scheduled", "dispatched", "en_route", "working"]),
      ));

    /**
     * The last visit done finishes the job, but only along the job's own
     * lifecycle. This wrote "completed" whatever the job said, so a late
     * visit finished on a job already invoiced walked it back from invoiced
     * to completed, with its invoice and ledger postings still standing, and
     * the job came off every "awaiting payment" list. And it emitted
     * nothing, so "when a job is completed" never fired for work finished
     * this way, only for a status typed in by hand.
     */
    const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, visit.jobId)).limit(1);
    if (remaining.length === 0 && job && (FINISHED_BY_LAST_VISIT as readonly string[]).includes(job.status)) {
      const [finished] = await tx.update(schema.job)
        .set({ status: "completed", completedAt, updatedAt: new Date() })
        .where(eq(schema.job.id, visit.jobId))
        .returning();
      await emit(tx, ctx, {
        name: "job.completed", entityType: "job", entityId: visit.jobId,
        payload: { job: finished! }, previous: { job },
      });
    }

    /** The same event a technician's phone raises for the same act. */
    await emit(tx, ctx, {
      name: "visit.completed", entityType: "visit", entityId: input.id,
      payload: { visitId: input.id, completedAt: completedAt.toISOString() },
    });

    await audit(tx, ctx, "visit.completed", "visit", input.id, visit, updated!);
    return { ...withProvenance(updated!), technicianIds: await assignedTo(tx, input.id), raisedDispatchException: wasCancelled };
  });
}

/**
 * What was used on a job, oldest first. Cost is redacted by the same rule
 * as everywhere else it appears, at this boundary.
 */
export async function lines(ctx: ServiceContext, input: z.infer<typeof listJobLines.input>) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");
    const rows = await tx.select().from(schema.jobLine)
      .where(eq(schema.jobLine.jobId, input.id))
      .orderBy(schema.jobLine.occurredAt, schema.jobLine.createdAt);
    return {
      data: rows.map((row) => {
        const shown = clean(ctx, "jobLine", row);
        return {
          id: row.id, jobId: row.jobId, visitId: row.visitId, kind: row.kind, source: row.source,
          priceBookItemVersionId: row.priceBookItemVersionId, name: row.name, description: row.description,
          quantity: row.quantity, unitPrice: row.unitPrice,
          ...("unitCost" in shown ? { unitCost: row.unitCost } : {}),
          taxable: row.taxable, invoiceLineId: row.invoiceLineId, nonBillableReason: row.nonBillableReason,
          occurredAt: row.occurredAt.toISOString(),
        };
      }),
    };
  });
}

/** The kinds of work this company does, by name. */
export async function listTypes(ctx: ServiceContext, input: z.infer<typeof listJobTypes.input>) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const rows = await tx.select().from(schema.jobType)
      // No `deleted_at` filter: nothing deletes a job type, it is made inactive.
      .where(input.includeInactive ? undefined : eq(schema.jobType.active, true))
      .orderBy(schema.jobType.name);
    return {
      data: rows.map((r) => ({
        id: r.id, name: r.name, code: r.code,
        defaultDurationMinutes: r.defaultDurationMinutes,
        requiredSkills: r.requiredSkills, active: r.active,
      })),
    };
  });
}

export { nextNumber, claimNumber };
