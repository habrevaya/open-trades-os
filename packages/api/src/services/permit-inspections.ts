import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, reporting, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { jobScopeFilter } from "./scope";
import { replayed, remember } from "./once";

/**
 * THE CITY'S VISITS TO A PERMITTED JOB
 *
 * A permit is filed against a job as a compliance document (M23). This is
 * what the authority's inspector did about it: the day they came, which stage
 * it was, pass or fail, and on a fail what they wrote and whose work it was
 * about. The electrical pack's first time inspection pass rate reads it
 * (`inspection_pass` in `kpi-catalogue.ts`), and nothing else could: M33's
 * inspections are the contractor's own, of a property, against a programme.
 *
 * Recorded by the office, from the job (`job:write`), because the result
 * reaches a company on the authority's portal or the tag left on the panel,
 * and is typed in by whoever reads it. Read with the job (`job:read`) and,
 * because the permits are documents, `document:read`.
 *
 * WHOSE WORK A FAIL WAS ABOUT is required on a fail and is one of two words,
 * never read out of the inspector's text later: the pass rate leaves out a
 * job failed only for somebody else's work, and an exclusion decided from
 * free text is an exclusion nobody can check.
 */

export type PermitInspectionResult = typeof schema.permitInspectionResult.enumValues[number];
export type PermitFailureScope = typeof schema.permitFailureScope.enumValues[number];

export interface PermitInspectionView {
  id: string;
  permitId: string;
  jobId: string;
  inspectedOn: string;
  stage: string | null;
  result: PermitInspectionResult;
  failureScope: PermitFailureScope | null;
  findings: string | null;
  inspectorName: string | null;
  recordedAt: string;
}

export interface JobPermit {
  id: string;
  name: string;
  reference: string | null;
  issuerName: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  state: typeof schema.complianceDocumentState.enumValues[number];
  inspections: PermitInspectionView[];
}

export interface JobPermits {
  jobId: string;
  permits: JobPermit[];
  /**
   * Where the job stands in the first time pass rate, from every inspection
   * on every permit it holds (core's `permitVerdict`). Null before the first
   * inspection.
   */
  verdict: reporting.PermitVerdict | null;
}

/** A compliance document is a permit when its kind says so, however it was typed. */
const IS_PERMIT = sql`lower(trim(${schema.complianceDocument.kind})) = 'permit'`;

const view = (row: typeof schema.permitInspection.$inferSelect): PermitInspectionView => ({
  id: row.id,
  permitId: row.permitId,
  jobId: row.jobId,
  inspectedOn: row.inspectedOn,
  stage: row.stage,
  result: row.result,
  failureScope: row.failureScope,
  findings: row.findings,
  inspectorName: row.inspectorName,
  recordedAt: row.createdAt.toISOString(),
});

/** The job, if the caller may see it. Out of scope reads as missing, as it does on the job itself. */
async function visibleJob(tx: Database, ctx: ServiceContext, jobId: string): Promise<{ id: string }> {
  const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
    .where(and(
      eq(schema.job.id, jobId),
      isNull(schema.job.deletedAt),
      jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
    )).limit(1);
  if (!job) throw new NotFoundError("Job");
  return job;
}

/**
 * Every permit filed against a job, each with the authority's inspections in
 * the order they happened, and where the job stands.
 */
export async function forJob(ctx: ServiceContext, input: { id: string }): Promise<JobPermits> {
  return guardedRead(ctx, "job:read", async (tx) => {
    assertCan(ctx.actor, "document:read");
    await visibleJob(tx, ctx, input.id);
    const permits = await tx.select().from(schema.complianceDocument)
      .where(and(
        eq(schema.complianceDocument.subjectType, "job"),
        eq(schema.complianceDocument.subjectId, input.id),
        IS_PERMIT,
      ))
      .orderBy(asc(schema.complianceDocument.createdAt));
    const inspections = await tx.select().from(schema.permitInspection)
      .where(eq(schema.permitInspection.jobId, input.id))
      .orderBy(asc(schema.permitInspection.inspectedOn), asc(schema.permitInspection.createdAt));
    return {
      jobId: input.id,
      permits: permits.map((permit) => ({
        id: permit.id,
        name: permit.name,
        reference: permit.reference,
        issuerName: permit.issuerName,
        issuedOn: permit.issuedOn,
        expiresOn: permit.expiresOn,
        state: permit.state,
        inspections: inspections.filter((i) => i.permitId === permit.id).map(view),
      })),
      verdict: reporting.permitVerdict(inspections),
    };
  });
}

export interface RecordInput {
  permitId: string;
  inspectedOn: string;
  stage?: string | null | undefined;
  result: PermitInspectionResult;
  failureScope?: PermitFailureScope | null | undefined;
  findings?: string | null | undefined;
  inspectorName?: string | null | undefined;
}

/**
 * Record one of the authority's visits to a permitted job.
 *
 * Refused, in words: a document that is not a permit or is not filed against
 * a job; a day still to come in the company's calendar, or one before the
 * permit was issued; a fail that does not say whose work it was about or
 * what the inspector found; and a pass that says whose work it failed.
 * Replayed with the same idempotency key, the first answer comes back and
 * nothing is recorded twice.
 */
export async function record(ctx: ServiceContext, input: RecordInput): Promise<PermitInspectionView> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const seen = await replayed<PermitInspectionView>(tx, ctx, "permit_inspection");
    if (seen) return seen;

    const [permit] = await tx.select().from(schema.complianceDocument)
      .where(eq(schema.complianceDocument.id, input.permitId)).limit(1);
    if (!permit) throw new NotFoundError("Permit");
    if (permit.kind.trim().toLowerCase() !== "permit") {
      throw new ConflictError(`${permit.name} is filed as a ${permit.kind}, not a permit, so the city does not inspect against it.`);
    }
    if (permit.subjectType !== "job" || !permit.subjectId) {
      throw new ConflictError(`${permit.name} is not filed against a job. File the permit on the job first, then record its inspections.`);
    }
    const job = await visibleJob(tx, ctx, permit.subjectId);

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    if (input.inspectedOn > today) {
      throw new ConflictError(`${input.inspectedOn} has not happened yet. Record an inspection once the inspector has been.`);
    }
    if (permit.issuedOn && input.inspectedOn < permit.issuedOn) {
      throw new ConflictError(
        `${permit.name} was issued on ${permit.issuedOn}, so nobody inspected under it on ${input.inspectedOn}. One of the two dates is a typing mistake.`,
      );
    }

    const findings = input.findings?.trim() || null;
    const failureScope = input.failureScope ?? null;
    if (input.result === "failed") {
      if (!failureScope) {
        throw new ConflictError("Say whose work the inspector failed: ours, or something outside our work.");
      }
      if (!findings) {
        throw new ConflictError("Write down what the inspector found, in their words, so the fix and the next visit can be checked against it.");
      }
    } else if (failureScope) {
      throw new ConflictError("A passed inspection failed nothing, so it has no work to blame. Leave whose work it was empty.");
    }

    const [row] = await tx.insert(schema.permitInspection).values({
      organizationId: ctx.actor.organizationId,
      permitId: permit.id,
      jobId: job.id,
      inspectedOn: input.inspectedOn,
      stage: input.stage?.trim() || null,
      result: input.result,
      failureScope,
      findings,
      inspectorName: input.inspectorName?.trim() || null,
      recordedByUserId: ctx.portalGrantId ? null : ctx.actor.userId,
    }).returning();

    const answer = view(row!);
    await audit(tx, ctx, "permit_inspection.recorded", "permit_inspection", row!.id, null, answer);
    await remember(tx, ctx, "permit_inspection", row!.id, answer);
    return answer;
  });
}

/**
 * Take off an inspection recorded by mistake: the wrong job, the wrong day,
 * one the inspector never made. The audit log keeps what it said. There is no
 * state for a visit that did not happen, because a kept row nobody counts is
 * a row somebody later counts.
 */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ removed: boolean }> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [row] = await tx.select().from(schema.permitInspection)
      .where(eq(schema.permitInspection.id, input.id)).limit(1);
    if (!row) return { removed: false };
    await visibleJob(tx, ctx, row.jobId);
    await tx.delete(schema.permitInspection).where(eq(schema.permitInspection.id, row.id));
    await audit(tx, ctx, "permit_inspection.removed", "permit_inspection", row.id, view(row), null);
    return { removed: true };
  });
}

export const handlers = {
  listJobPermitInspections: (ctx: ServiceContext, input: { id: string }) => forJob(ctx, input),
  recordPermitInspection: (ctx: ServiceContext, input: RecordInput) => record(ctx, input),
  removePermitInspection: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
