import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { can } from "@opentradesos/core";
import { guardedRead, NotFoundError, scopeOf, type ServiceContext } from "./context";
import { jobVisibility } from "./scope";

/**
 * ONE VISIT, ON ITS OWN
 *
 * A visit was a row in its job's table and nothing more, so every link to one
 * (a report's drill, a deadline about a visit cancelled under a technician, a
 * customer asking to move one) opened the job and left somebody to work out
 * which of its visits was meant. A three day install has three visits with
 * three crews, three sets of notes and three signatures, and "open the job" is
 * the wrong answer to "what happened on Tuesday".
 *
 * Everything here is read from records that already carry the visit: its
 * times, who was on it, what it used, the units it worked, the report and any
 * inspection filed from it, what the customer asked to change. Nothing is
 * stored for this page.
 *
 * SCOPED BY ITS JOB. A technician who could not open the job cannot open its
 * visits either, and out of scope reads as not found, for the reason the job
 * page gives: "you may not see this" confirms there is something to see.
 */
export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const [found] = await tx.select({
      visit: schema.visit,
      job: {
        id: schema.job.id, number: schema.job.number, summary: schema.job.summary, status: schema.job.status,
        customerId: schema.job.customerId, propertyId: schema.job.propertyId, equipmentId: schema.job.equipmentId,
      },
    }).from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .where(and(
        eq(schema.visit.id, input.id),
        isNull(schema.job.deletedAt),
        jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.job.id}`),
      )).limit(1);
    if (!found) throw new NotFoundError("Visit");
    const { visit, job } = found;

    const [customer] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, job.customerId)).limit(1);
    const [place] = job.propertyId ? await tx.select({
      id: schema.property.id, line1: schema.property.addressLine1, city: schema.property.city,
      state: schema.property.state, accessNotes: schema.property.accessNotes,
    }).from(schema.property).where(eq(schema.property.id, job.propertyId)).limit(1) : [];

    const team = await tx.select({
      technicianId: schema.technician.id, name: schema.technician.displayName, isLead: schema.visitAssignment.isLead,
    }).from(schema.visitAssignment)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(eq(schema.visitAssignment.visitId, visit.id))
      .orderBy(desc(schema.visitAssignment.isLead), asc(schema.technician.displayName));
    const [crew] = visit.crewId
      ? await tx.select({ name: schema.crew.name }).from(schema.crew).where(eq(schema.crew.id, visit.crewId)).limit(1)
      : [];

    /**
     * What it used, by name and quantity. The cost is the job costing
     * permission's and is left to the job's own statement, so a dispatcher
     * opening a visit does not see what a part cost the company.
     */
    const used = await tx.select({
      id: schema.jobLine.id, kind: schema.jobLine.kind, name: schema.jobLine.name,
      quantity: schema.jobLine.quantity, unitPrice: schema.jobLine.unitPrice,
      nonBillableReason: schema.jobLine.nonBillableReason, billed: sql<boolean>`${schema.jobLine.invoiceLineId} is not null`,
    }).from(schema.jobLine).where(eq(schema.jobLine.visitId, visit.id)).orderBy(asc(schema.jobLine.occurredAt));

    /** Time on the clock against this visit, for whoever may read timesheets. */
    const time = can(ctx.actor, "timesheet:read") ? await tx.select({
      id: schema.timeclockEntry.id, kind: schema.timeclockEntry.kind, technician: schema.technician.displayName,
      startedAt: schema.timeclockEntry.startedAt, endedAt: schema.timeclockEntry.endedAt, minutes: schema.timeclockEntry.minutes,
    }).from(schema.timeclockEntry)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.timeclockEntry.technicianId))
      .where(eq(schema.timeclockEntry.visitId, visit.id))
      .orderBy(asc(schema.timeclockEntry.startedAt)) : null;

    const units = await tx.select({
      equipmentId: schema.visitAsset.equipmentId, outcome: schema.visitAsset.outcome, notes: schema.visitAsset.notes,
      completedAt: schema.visitAsset.completedAt, category: schema.equipment.category, tag: schema.equipment.tag,
      serialNumber: schema.equipment.serialNumber,
    }).from(schema.visitAsset)
      .innerJoin(schema.equipment, eq(schema.equipment.id, schema.visitAsset.equipmentId))
      .where(eq(schema.visitAsset.visitId, visit.id))
      .orderBy(asc(schema.visitAsset.sequence));

    const reports = await tx.select({
      id: schema.serviceReport.id, summary: schema.serviceReport.summary, skipped: schema.serviceReport.skipped,
      skipReason: schema.serviceReport.skipReason, submittedAt: schema.serviceReport.submittedAt,
      publishedAt: schema.serviceReport.publishedAt,
    }).from(schema.serviceReport).where(eq(schema.serviceReport.visitId, visit.id));

    const inspections = await tx.select({
      id: schema.inspection.id, performedOn: schema.inspection.performedOn, result: schema.inspection.result,
      programme: schema.inspectionProgram.name,
    }).from(schema.inspection)
      .leftJoin(schema.inspectionProgram, eq(schema.inspectionProgram.id, schema.inspection.programId))
      .where(eq(schema.inspection.visitId, visit.id));

    const changes = await tx.select({
      id: schema.visitChangeRequest.id, kind: schema.visitChangeRequest.kind, status: schema.visitChangeRequest.status,
      reason: schema.visitChangeRequest.reason, requestedStart: schema.visitChangeRequest.requestedStart,
      createdAt: schema.visitChangeRequest.createdAt, decidedAt: schema.visitChangeRequest.decidedAt,
      response: schema.visitChangeRequest.response,
    }).from(schema.visitChangeRequest)
      .where(eq(schema.visitChangeRequest.visitId, visit.id))
      .orderBy(desc(schema.visitChangeRequest.createdAt));

    /** The other trips on the same job, so a three day install can be walked a day at a time. */
    const siblings = await tx.select({
      id: schema.visit.id, sequence: schema.visit.sequence, status: schema.visit.status,
      windowStart: schema.visit.windowStart,
    }).from(schema.visit).where(eq(schema.visit.jobId, job.id)).orderBy(asc(schema.visit.sequence));

    return {
      id: visit.id,
      sequence: visit.sequence,
      status: visit.status,
      windowStart: visit.windowStart,
      windowEnd: visit.windowEnd,
      estimatedDurationMinutes: visit.estimatedDurationMinutes,
      dispatchedAt: visit.dispatchedAt,
      enRouteAt: visit.enRouteAt,
      arrivedAt: visit.arrivedAt,
      completedAt: visit.completedAt,
      technicianNotes: visit.technicianNotes,
      checklist: visit.checklist,
      signed: visit.signatureUrl !== null,
      rentalEvent: visit.rentalEvent,
      /** The days the customer agreed this visit may happen on, which the multi day rebalance reads. */
      movableFrom: visit.movableFrom,
      movableUntil: visit.movableUntil,
      job,
      customer: customer ?? null,
      property: place
        ? { id: place.id, address: [place.line1, place.city, place.state].filter(Boolean).join(", "), accessNotes: place.accessNotes }
        : null,
      team,
      crew: crew?.name ?? null,
      used,
      time,
      units,
      reports,
      inspections,
      changes,
      siblings,
    };
  });
}

export type VisitPage = Awaited<ReturnType<typeof get>>;
