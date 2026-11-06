import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { can, reporting, time, work } from "@opentradesos/core";
import { guardedRead, NotFoundError, scopeOf, timezoneOf, type ServiceContext } from "./context";
import { jobVisibility } from "./scope";
import { closeMatching, textFilter, type Searched } from "./text-search";
import { shopNames } from "./visit-shop";

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

    /**
     * WHAT EACH REPORT RECORDED, the last answer to each field, in words: a
     * reading with its unit, a yes or no, a choice ("Where the fault was: In
     * equipment another trade owns"), or a product and how much of it. The
     * office reads here what the phone wrote, which the figures read too.
     */
    const answers = reports.length === 0 ? [] : await tx.select({
      reportId: schema.serviceReportField.reportId, key: schema.serviceReportField.key, label: schema.serviceReportField.label,
      valueNumeric: schema.serviceReportField.valueNumeric, valueText: schema.serviceReportField.valueText,
      valueBoolean: schema.serviceReportField.valueBoolean, unit: schema.serviceReportField.unit,
      productName: schema.serviceReportField.productName, quantityApplied: schema.serviceReportField.quantityApplied,
      applicationUnit: schema.serviceReportField.applicationUnit,
    }).from(schema.serviceReportField)
      .where(inArray(schema.serviceReportField.reportId, reports.map((r) => r.id)))
      .orderBy(desc(schema.serviceReportField.recordedAt), desc(schema.serviceReportField.createdAt));
    const said = (a: (typeof answers)[number]): string => {
      if (a.productName) return `${a.productName}${a.quantityApplied !== null ? `, ${Number(a.quantityApplied)}${a.applicationUnit ? ` ${a.applicationUnit}` : ""}` : ""}`;
      if (a.valueNumeric !== null) return `${Number(a.valueNumeric)}${a.unit ? ` ${a.unit}` : ""}`;
      if (a.valueBoolean !== null) return a.valueBoolean ? "Yes" : "No";
      return a.valueText ?? "";
    };
    const readingsOf = (reportId: string) => {
      const seen = new Set<string>();
      return answers.filter((a) => a.reportId === reportId && !seen.has(a.key) && seen.add(a.key))
        .map((a) => ({ key: a.key, label: a.label, value: said(a) }))
        .filter((a) => a.value !== "");
    };

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
      /** The shop it goes out from, written when it was given to somebody (`visit-shop.ts`). */
      shop: visit.locationId ? (await shopNames(tx, [visit.locationId])).get(visit.locationId) ?? null : null,
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
      reports: reports.map((r) => ({ ...r, readings: readingsOf(r.id) })),
      inspections,
      changes,
      siblings,
      /** Who called it off and when they asked, judged by the window frozen on it (`visit-cancellations.ts`). */
      cancellation: (reporting.VISIT_CALLED_OFF as readonly string[]).includes(visit.status)
        ? {
          by: visit.cancelledBy,
          at: visit.cancelledAt,
          noticeHours: visit.cancelNoticeHours,
          late: ((verdict) => verdict === "late" ? true : verdict === "in_time" ? false : null)(reporting.cancellationOf({
            status: visit.status, windowStart: visit.windowStart, cancelledBy: visit.cancelledBy,
            cancelledAt: visit.cancelledAt, noticeHours: visit.cancelNoticeHours,
          })),
          reason: visit.cancelReason
            ? {
              code: visit.cancelReason, label: work.cancelReasonLabel(visit.cancelReason), note: visit.cancelReasonNote,
              words: work.cancelReasonWords(visit.cancelReason, visit.cancelReasonNote),
            }
            : null,
        }
        : null,
    };
  });
}

export type VisitPage = Awaited<ReturnType<typeof get>>;

export interface FoundVisit {
  id: string;
  sequence: number;
  status: string;
  windowStart: Date | null;
  /** The day of the window in the company's own calendar, `YYYY-MM-DD`; null for a visit not yet placed. */
  day: string | null;
  jobId: string;
  jobNumber: number;
  jobSummary: string;
  customerName: string | null;
}

/**
 * The people on a visit and its crew, as places a word can be found. Each is
 * an `exists` tied to the visit being listed, so it only ever narrows the
 * visits the reader's scope already lets them open: naming another branch's
 * technician finds nothing of that branch.
 */
const assignedTo: Searched = (match) => sql`exists (
  select 1 from public.visit_assignment search_assignment
  join public.technician search_technician on search_technician.id = search_assignment.technician_id
  where search_assignment.visit_id = ${schema.visit.id} and ${match(sql`search_technician.display_name`)}
)`;
const bookedToCrew: Searched = (match) => sql`exists (
  select 1 from public.crew search_crew
  where search_crew.id = ${schema.visit.crewId} and ${match(sql`search_crew.name`)}
)`;

/**
 * THE VISITS A WORD FINDS, for the search box.
 *
 * A visit is found by the words on it and on its job: both notes on the visit
 * (the technician's, and what the office chose to show the customer), the
 * job's summary and its number, the customer's name, the name of anybody
 * assigned to it, and the name of the crew it is booked to. Read under the same
 * rule as one visit on its own (`get`): `visit:read`, through the visit's job
 * and the reader's own visit scope, so a technician finds the visits they could
 * open and no others, and a job out of scope is a visit that is not there.
 * Newest window first, the words matched as every list matches them
 * (`text-search.ts`).
 */
export async function find(
  ctx: ServiceContext, input: { q: string; limit: number; close?: boolean | undefined },
): Promise<{ data: FoundVisit[]; hasMore: boolean }> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    if (input.close) await closeMatching(tx);
    const rows = await tx.select({
      id: schema.visit.id,
      sequence: schema.visit.sequence,
      status: schema.visit.status,
      windowStart: schema.visit.windowStart,
      jobId: schema.job.id,
      jobNumber: schema.job.number,
      jobSummary: schema.job.summary,
      customerName: schema.customer.name,
    }).from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .leftJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .where(and(
        eq(schema.visit.organizationId, ctx.actor.organizationId),
        eq(schema.job.organizationId, ctx.actor.organizationId),
        isNull(schema.job.deletedAt),
        jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.job.id}`),
        textFilter(
          input.q,
          [
            schema.visit.technicianNotes, schema.visit.customerNotes, schema.job.summary, schema.customer.name,
            assignedTo, bookedToCrew,
          ],
          schema.job.number,
          { close: input.close },
        ) ?? sql`false`,
      ))
      .orderBy(sql`${schema.visit.windowStart} desc nulls last`, desc(schema.visit.id))
      .limit(input.limit + 1);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return {
      data: rows.slice(0, input.limit).map((row) => ({
        ...row, day: row.windowStart ? time.dateIn(row.windowStart, zone) : null,
      })),
      hasMore: rows.length > input.limit,
    };
  });
}
