import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";

/**
 * THE DOCUMENT THAT LEAVES WITH THE CUSTOMER
 *
 * `service_report` and `service_report_field` are written: `services/field.ts`
 * creates a report when a technician's phone syncs one, records every captured
 * field as its own row, and submits it. That half works and is tested.
 *
 * Three permissions were granted to roles and checked by nothing, and they
 * name the three things that were missing:
 *
 *   `servicereport:read`     nothing could read a report back. The rows went
 *                            in from the field app and no screen, route or
 *                            report could show one, so a company could not
 *                            answer "what did we actually do at that
 *                            address" without a database client.
 *
 *   `servicereport:write`    templates existed only as a side effect of
 *                            installing a trade pack. A company could not
 *                            add a field, retire one, or declare a report of
 *                            its own, and nobody in the office could correct
 *                            a summary a technician typed in a basement.
 *
 *   `servicereport:publish`  `published_at` is the column that decides
 *                            whether the customer sees the document.
 *                            `services/field.ts` reads it to derive a status
 *                            and NOTHING SET IT, so every report ever
 *                            captured was stuck at "submitted" and no
 *                            customer ever received one.
 *
 * THE PROPERTY THIS FILE IS ABOUT is that publishing is a decision somebody
 * takes, separately from capture. A report is written on a phone, in a
 * basement, by somebody holding a torch, and it carries readings that may be
 * out of range, a summary that may be three words, and fields marked not
 * customer visible. Publishing is the office saying "this is the document we
 * stand behind", and collapsing it into submit would mean every typo a
 * technician makes is a document a customer has already read.
 */

/* ------------------------------------------------------------- templates */

/**
 * One declared field on a template.
 *
 * Mirrors the shape `services/trade-pack.ts` writes when it installs a pack,
 * because the two have to be the same thing: a company that installs the HVAC
 * pack and then adds a field of its own must end up with one template, not a
 * pack template and a custom one that disagree.
 */
export interface TemplateField {
  key: string;
  label: string;
  kind: typeof schema.readingKind.enumValues[number];
  unit?: string | undefined;
  options?: string[] | undefined;
  /**
   * Whether the customer sees it.
   *
   * DEFAULTS TO FALSE HERE AND THE COLUMN DEFAULTS TO TRUE, which is not an
   * inconsistency: the column is what a technician's capture lands in and a
   * reading is useful to the office by default, while a field somebody is
   * declaring on a template is being designed and the safe default for
   * "should a customer read this" is no. A compressor superheat reading means
   * nothing to a homeowner and a note about a landlord does not belong in
   * front of a tenant.
   */
  customerVisible?: boolean | undefined;
  /** Whether it is worth plotting over time. */
  trend?: boolean | undefined;
  /** The range a reading is judged against. Both ends, or neither. */
  min?: number | undefined;
  max?: number | undefined;
  required?: boolean | undefined;
}

export interface TemplateView {
  id: string;
  name: string;
  jobTypeId: string | null;
  tradePackId: string | null;
  version: number;
  active: boolean;
  fields: TemplateField[];
}

const viewOfTemplate = (
  row: typeof schema.serviceReportTemplate.$inferSelect,
): TemplateView => ({
  id: row.id,
  name: row.name,
  jobTypeId: row.jobTypeId,
  tradePackId: row.tradePackId,
  version: row.version,
  active: row.active,
  fields: row.fields as TemplateField[],
});

export async function listTemplates(
  ctx: ServiceContext, input: { includeRetired?: boolean | undefined } = {},
): Promise<TemplateView[]> {
  return guardedRead(ctx, "servicereport:read", async (tx) => {
    const rows = await tx.select().from(schema.serviceReportTemplate)
      .where(and(
        eq(schema.serviceReportTemplate.organizationId, ctx.actor.organizationId),
        /**
         * `active`, and NOT `isNull(deletedAt)`.
         *
         * Retiring a template sets `active = false`, for the reason
         * `services/company.ts` gives about business units: reports reference
         * the template they answered, and a delete would strand them. So
         * nothing writes the soft delete column and a filter on it could
         * never be the thing that decided, which makes it protection that is
         * not there. A guard test counts the tables in that state.
         */
        input.includeRetired ? undefined : eq(schema.serviceReportTemplate.active, true),
      ))
      .orderBy(asc(schema.serviceReportTemplate.name));
    return rows.map(viewOfTemplate);
  });
}

export interface TemplateInput {
  name: string;
  jobTypeId?: string | null | undefined;
  fields: TemplateField[];
}

export async function defineTemplate(
  ctx: ServiceContext, input: TemplateInput,
): Promise<TemplateView> {
  return guardedWrite(ctx, "servicereport:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A service report template needs a name.");
    const fields = checkFields(input.fields);

    /**
     * ONE ACTIVE TEMPLATE PER JOB TYPE.
     *
     * `services/field.ts` resolves a template for a visit from its job type.
     * Two active ones matching the same job type means the report a technician
     * is handed depends on which row came back first, so the same work
     * captures different readings on different days and the trend chart is
     * made of two different measurements.
     *
     * A template with no job type is the company's general one and there may
     * be several, because those are chosen by name rather than resolved.
     */
    if (input.jobTypeId) {
      await assertOneActivePerJobType(tx, ctx.actor.organizationId, input.jobTypeId, null);
    }

    const [row] = await tx.insert(schema.serviceReportTemplate).values({
      organizationId: ctx.actor.organizationId,
      name,
      jobTypeId: input.jobTypeId ?? null,
      fields,
    }).returning();

    await audit(
      tx, ctx, "service_report_template.defined",
      "service_report_template", row!.id, null, row!,
    );
    return viewOfTemplate(row!);
  });
}

export interface TemplateUpdate {
  id: string;
  name?: string | undefined;
  jobTypeId?: string | null | undefined;
  fields?: TemplateField[] | undefined;
  active?: boolean | undefined;
}

/**
 * Change a template, and bump its version when the fields move.
 *
 * THE VERSION IS WHY THIS IS NOT A PLAIN UPDATE. `service_report` stores
 * `template_version` alongside `template_id`, so a report captured last March
 * records which set of questions it was answering. Editing the fields without
 * bumping the version makes every report ever captured claim it answered the
 * current questions, and a reading that was never asked for reads as missing
 * rather than as not applicable.
 *
 * The bump is on the FIELDS only. Renaming a template or retiring it does not
 * change what any past report was asked, so bumping on those would strand
 * reports against a version nothing distinguishes.
 */
export async function updateTemplate(
  ctx: ServiceContext, input: TemplateUpdate,
): Promise<TemplateView> {
  return guardedWrite(ctx, "servicereport:write", async (tx) => {
    const [before] = await tx.select().from(schema.serviceReportTemplate)
      .where(and(
        eq(schema.serviceReportTemplate.organizationId, ctx.actor.organizationId),
        eq(schema.serviceReportTemplate.id, input.id),
      ));
    if (!before) throw new NotFoundError("Service report template");

    const name = input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined && name === "") {
      throw new ConflictError("A service report template needs a name.");
    }
    const fields = input.fields === undefined ? undefined : checkFields(input.fields);

    const jobTypeId = input.jobTypeId === undefined ? before.jobTypeId : input.jobTypeId;
    const active = input.active === undefined ? before.active : input.active;
    if (jobTypeId && active) {
      await assertOneActivePerJobType(tx, ctx.actor.organizationId, jobTypeId, input.id);
    }

    const [row] = await tx.update(schema.serviceReportTemplate).set({
      ...(name === undefined ? {} : { name }),
      ...(input.jobTypeId === undefined ? {} : { jobTypeId: input.jobTypeId }),
      ...(fields === undefined ? {} : { fields, version: before.version + 1 }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.serviceReportTemplate.organizationId, ctx.actor.organizationId),
      eq(schema.serviceReportTemplate.id, input.id),
    )).returning();

    await audit(
      tx, ctx, "service_report_template.updated",
      "service_report_template", input.id, before, row!,
    );
    return viewOfTemplate(row!);
  });
}

/**
 * The declared fields, validated.
 *
 * Refused here rather than discovered on a phone in a basement, which is
 * where the consequence of a bad declaration actually lands.
 */
function checkFields(fields: TemplateField[]): TemplateField[] {
  const seen = new Set<string>();
  const out: TemplateField[] = [];

  for (const field of fields) {
    const key = field.key.trim();
    const label = field.label.trim();
    if (key === "") throw new ConflictError("Every field needs a key.");
    if (label === "") {
      throw new ConflictError(`The field "${key}" needs a label. It is what a technician reads.`);
    }
    if (seen.has(key)) {
      /**
       * `service_report_field` is one row per captured key, so two fields
       * sharing a key produce two rows that a reader cannot tell apart, and a
       * trend over that key plots both.
       */
      throw new ConflictError(
        `Two fields both use the key "${key}". A captured reading is stored under its key, `
        + "so a reader could not tell the two apart.",
      );
    }
    seen.add(key);

    const hasMin = field.min !== undefined && field.min !== null;
    const hasMax = field.max !== undefined && field.max !== null;
    /**
     * BOTH ENDS OR NEITHER. `out_of_range` is computed by comparing a reading
     * against the pair, and a half declared range silently judges nothing: a
     * reading of minus forty against a declared maximum alone is in range,
     * and the field reads as checked.
     */
    if (hasMin !== hasMax) {
      throw new ConflictError(
        `The field "${key}" declares only one end of its range. A reading is judged against `
        + "both, so one end alone judges nothing while looking as though it does.",
      );
    }
    if (hasMin && hasMax && field.min! > field.max!) {
      throw new ConflictError(`The field "${key}" has a minimum above its maximum.`);
    }
    if (hasMin && field.kind !== "numeric" && field.kind !== "measurement") {
      throw new ConflictError(
        `The field "${key}" is a ${field.kind} and declares a numeric range, which nothing `
        + "would compare it against.",
      );
    }
    if (field.kind === "select" && (field.options ?? []).length === 0) {
      throw new ConflictError(
        `The field "${key}" is a list to choose from and declares no options, so a technician `
        + "would be shown an empty list.",
      );
    }

    out.push({
      key,
      label,
      kind: field.kind,
      ...(field.unit ? { unit: field.unit.trim() } : {}),
      ...(field.options ? { options: field.options } : {}),
      customerVisible: field.customerVisible ?? false,
      trend: field.trend ?? false,
      ...(hasMin ? { min: field.min } : {}),
      ...(hasMax ? { max: field.max } : {}),
      ...(field.required ? { required: true } : {}),
    });
  }

  return out;
}

async function assertOneActivePerJobType(
  tx: Database, organizationId: string, jobTypeId: string, exceptId: string | null,
): Promise<void> {
  const clash = await tx.select({ name: schema.serviceReportTemplate.name })
    .from(schema.serviceReportTemplate)
    .where(and(
      eq(schema.serviceReportTemplate.organizationId, organizationId),
      eq(schema.serviceReportTemplate.jobTypeId, jobTypeId),
      eq(schema.serviceReportTemplate.active, true),
      exceptId === null ? undefined : ne(schema.serviceReportTemplate.id, exceptId),
    ));
  if (clash.length > 0) {
    throw new ConflictError(
      `"${clash[0]!.name}" is already the active template for that job type. Two means the `
      + "report a technician is handed depends on which row came back first, so the same work "
      + "captures different readings on different days.",
    );
  }
}

/* --------------------------------------------------------------- reports */

export type ReportStatus = "draft" | "submitted" | "published" | "skipped";

export interface ReportField {
  key: string;
  label: string;
  kind: string;
  unit: string | null;
  value: string | number | boolean | null;
  equipmentId: string | null;
  customerVisible: boolean;
  /** Judged against the template's declared range at capture time. */
  outOfRange: boolean;
  recordedAt: string;
  /** The regulated half, present only on a chemical application. */
  chemical: {
    productName: string | null;
    epaRegistrationNumber: string | null;
    quantityApplied: string | null;
    applicationUnit: string | null;
    applicatorLicense: string | null;
    targetPest: string | null;
  } | null;
}

export interface ReportView {
  id: string;
  visitId: string;
  jobId: string;
  customerId: string;
  propertyId: string;
  templateId: string | null;
  templateVersion: number | null;
  status: ReportStatus;
  summary: string | null;
  technicianNotes: string | null;
  observations: string | null;
  skipped: boolean;
  skipReason: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  fields: ReportField[];
}

/**
 * One value out of the four typed columns.
 *
 * FOUR COLUMNS AND NOT ONE JSONB, which is the schema's decision and the
 * right one: a refrigerant weight is trended, range checked and exported to a
 * regulator, and none of those work against a string. This function is where
 * the four become one value for a reader, and the order matters only in that
 * exactly one of them is ever set.
 */
function valueOf(row: typeof schema.serviceReportField.$inferSelect): ReportField["value"] {
  if (row.valueNumeric !== null) return row.valueNumeric;
  if (row.valueBoolean !== null) return row.valueBoolean;
  if (row.valueText !== null) return row.valueText;
  return null;
}

const statusOf = (row: typeof schema.serviceReport.$inferSelect): ReportStatus =>
  row.skipped ? "skipped" : row.publishedAt ? "published" : row.submittedAt ? "submitted" : "draft";

/**
 * One report, with its captured fields.
 *
 * `customerFacing` is the switch that makes this usable from the portal as
 * well as the office, and it does two things rather than one: it drops the
 * fields marked not customer visible, and it drops the technician's own
 * notes. Those notes are where somebody writes "told them the unit is on its
 * last legs, they did not want to hear it", and a portal that showed them
 * would be a different product.
 */
export async function get(
  ctx: ServiceContext,
  input: { id: string; customerFacing?: boolean | undefined },
): Promise<ReportView> {
  return guardedRead(ctx, "servicereport:read", async (tx) =>
    viewWithin(tx, ctx.actor.organizationId, input.id, input.customerFacing ?? false));
}

/**
 * The view, built inside the caller's own transaction.
 *
 * THIS IS NOT A TIDYING. The write paths below used to end with
 * `return get(ctx, { id })`, which opens its own `guardedRead` and therefore
 * its own transaction: it ran while the surrounding write was still
 * uncommitted and read the row as it was BEFORE the write. Every publish
 * returned a report still marked submitted, and the tests that caught it
 * reported the right value from the database and the wrong one from the call.
 *
 * A guarded function calling another guarded function is the shape to avoid,
 * and it is worth saying out loud because it fails quietly: nothing throws,
 * the write lands, and the value handed back is stale by exactly one
 * operation.
 */
async function viewWithin(
  tx: Database, organizationId: string, id: string, customerFacing: boolean,
): Promise<ReportView> {
  {
    const [row] = await tx.select().from(schema.serviceReport)
      .where(and(
        eq(schema.serviceReport.organizationId, organizationId),
        eq(schema.serviceReport.id, id),
      ));
    if (!row) throw new NotFoundError("Service report");

    const fields = await tx.select().from(schema.serviceReportField)
      .where(and(
        eq(schema.serviceReportField.organizationId, organizationId),
        eq(schema.serviceReportField.reportId, id),
        customerFacing ? eq(schema.serviceReportField.customerVisible, true) : undefined,
      ))
      .orderBy(asc(schema.serviceReportField.recordedAt));

    return {
      id: row.id,
      visitId: row.visitId,
      jobId: row.jobId,
      customerId: row.customerId,
      propertyId: row.propertyId,
      templateId: row.templateId,
      templateVersion: row.templateVersion,
      status: statusOf(row),
      summary: row.summary,
      technicianNotes: customerFacing ? null : row.technicianNotes,
      observations: row.observations,
      skipped: row.skipped,
      skipReason: row.skipReason,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      fields: fields.map((field) => ({
        key: field.key,
        label: field.label,
        kind: field.kind,
        unit: field.unit,
        value: valueOf(field),
        equipmentId: field.equipmentId,
        customerVisible: field.customerVisible,
        outOfRange: field.outOfRange,
        recordedAt: field.recordedAt.toISOString(),
        chemical: field.kind === "chemical"
          ? {
            productName: field.productName,
            epaRegistrationNumber: field.epaRegistrationNumber,
            quantityApplied: field.quantityApplied,
            applicationUnit: field.applicationUnit,
            applicatorLicense: field.applicatorLicense,
            targetPest: field.targetPest,
          }
          : null,
      })),
    };
  }
}

export interface ReportQuery {
  jobId?: string | undefined;
  visitId?: string | undefined;
  customerId?: string | undefined;
  propertyId?: string | undefined;
  status?: ReportStatus | undefined;
  /** Only the ones with a reading outside its declared range. */
  outOfRangeOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface ReportSummary {
  id: string;
  visitId: string;
  jobId: string;
  customerId: string;
  propertyId: string;
  status: ReportStatus;
  summary: string | null;
  fieldCount: number;
  outOfRangeCount: number;
  submittedAt: string | null;
  publishedAt: string | null;
}

export async function list(
  ctx: ServiceContext, input: ReportQuery,
): Promise<{ reports: ReportSummary[] }> {
  return guardedRead(ctx, "servicereport:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const rows = await tx.select().from(schema.serviceReport)
      .where(and(
        eq(schema.serviceReport.organizationId, ctx.actor.organizationId),
        /**
         * NO SOFT DELETE FILTER, because nothing soft deletes a service
         * report and nothing should. It is the record of what happened at an
         * address on a day: a report that was wrong is withdrawn, which is
         * `unpublish` and leaves a reason on the document, and a visit that
         * did not happen is a visit somebody cancelled rather than a report
         * somebody deletes.
         */
        input.jobId ? eq(schema.serviceReport.jobId, input.jobId) : undefined,
        input.visitId ? eq(schema.serviceReport.visitId, input.visitId) : undefined,
        input.customerId ? eq(schema.serviceReport.customerId, input.customerId) : undefined,
        input.propertyId ? eq(schema.serviceReport.propertyId, input.propertyId) : undefined,
        input.status === "published" ? sql`${schema.serviceReport.publishedAt} is not null` : undefined,
        input.status === "submitted"
          ? and(
            sql`${schema.serviceReport.submittedAt} is not null`,
            sql`${schema.serviceReport.publishedAt} is null`,
            eq(schema.serviceReport.skipped, false),
          )
          : undefined,
        input.status === "draft"
          ? and(
            sql`${schema.serviceReport.submittedAt} is null`,
            eq(schema.serviceReport.skipped, false),
          )
          : undefined,
        input.status === "skipped" ? eq(schema.serviceReport.skipped, true) : undefined,
      ))
      .orderBy(desc(schema.serviceReport.createdAt))
      .limit(limit);

    if (rows.length === 0) return { reports: [] };

    /**
     * The field tallies in one grouped query rather than one per report,
     * because a list of fifty reports is otherwise fifty round trips and this
     * is a screen somebody opens every morning.
     */
    const tallies = await tx.select({
      reportId: schema.serviceReportField.reportId,
      total: sql<number>`count(*)::int`,
      outOfRange: sql<number>`count(*) filter (where ${schema.serviceReportField.outOfRange})::int`,
    }).from(schema.serviceReportField)
      .where(and(
        eq(schema.serviceReportField.organizationId, ctx.actor.organizationId),
        inArray(schema.serviceReportField.reportId, rows.map((r) => r.id)),
      ))
      .groupBy(schema.serviceReportField.reportId);

    const countOf = new Map(tallies.map((t) => [t.reportId, t]));

    const reports = rows.map((row) => ({
      id: row.id,
      visitId: row.visitId,
      jobId: row.jobId,
      customerId: row.customerId,
      propertyId: row.propertyId,
      status: statusOf(row),
      summary: row.summary,
      fieldCount: countOf.get(row.id)?.total ?? 0,
      outOfRangeCount: countOf.get(row.id)?.outOfRange ?? 0,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    }));

    /**
     * Filtered after the tally rather than joined into the query above,
     * because "has a reading out of range" is a property of the report's
     * fields and expressing it as a correlated EXISTS would be a second way
     * of asking the same question the tally already answers.
     */
    return {
      reports: input.outOfRangeOnly
        ? reports.filter((report) => report.outOfRangeCount > 0)
        : reports,
    };
  });
}

/**
 * The office's own words on the report.
 *
 * `summary` and `observations` only. `technician_notes` is deliberately NOT
 * editable here: it is what the person who was in the building wrote, and an
 * office that can rewrite it has destroyed the one record of what the
 * technician actually said. If it is wrong, the observation field is where the
 * correction goes, with both visible to whoever reads the file.
 */
export async function annotate(
  ctx: ServiceContext,
  input: { id: string; summary?: string | null | undefined; observations?: string | null | undefined },
): Promise<ReportView> {
  return guardedWrite(ctx, "servicereport:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    /**
     * A published report is not edited.
     *
     * The customer has the document. Changing what it says afterwards, with
     * no second version and nothing recording that it changed, means two
     * people holding the same report and reading different things. Unpublish
     * first, which is a recorded act.
     */
    if (before.publishedAt) {
      throw new ConflictError(
        "That report is published and the customer has it. Unpublish it first: editing a "
        + "document somebody is already holding means two people reading different things.",
      );
    }

    const [row] = await tx.update(schema.serviceReport).set({
      ...(input.summary === undefined ? {} : { summary: input.summary?.trim() || null }),
      ...(input.observations === undefined ? {} : { observations: input.observations?.trim() || null }),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.serviceReport.organizationId, ctx.actor.organizationId),
      eq(schema.serviceReport.id, input.id),
    )).returning();

    await audit(tx, ctx, "service_report.annotated", "service_report", input.id, before, row!);
    return viewWithin(tx, ctx.actor.organizationId, input.id, false);
  });
}

/**
 * Publish it, which is the write the whole module was missing.
 *
 * `published_at` is read by `services/field.ts` to derive a status and was set
 * by nothing, so every report ever captured sat at "submitted" forever and no
 * customer received one.
 */
export async function publish(
  ctx: ServiceContext, input: { id: string },
): Promise<ReportView> {
  return guardedWrite(ctx, "servicereport:publish", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if (before.publishedAt) {
      return viewWithin(tx, ctx.actor.organizationId, input.id, false);
    }

    /**
     * SUBMITTED FIRST. A draft is a report a technician has not finished: the
     * phone has synced some of it and may sync more, so publishing one sends
     * the customer a document that then changes underneath them.
     */
    if (!before.submittedAt) {
      throw new ConflictError(
        "That report has not been submitted yet. A draft is still syncing from the phone, so "
        + "publishing it would send the customer a document that changes afterwards.",
      );
    }
    /**
     * A SKIPPED REPORT IS NOT A DOCUMENT. The technician said there was
     * nothing to report and gave a reason. Publishing it would send a customer
     * an empty form with a letterhead on it.
     */
    if (before.skipped) {
      throw new ConflictError(
        `That report was skipped${before.skipReason ? `: ${before.skipReason}` : ""}. `
        + "There is no document to send.",
      );
    }

    const [row] = await tx.update(schema.serviceReport)
      .set({ publishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.serviceReport.organizationId, ctx.actor.organizationId),
        eq(schema.serviceReport.id, input.id),
      )).returning();

    await audit(tx, ctx, "service_report.published", "service_report", input.id, before, row!);
    return viewWithin(tx, ctx.actor.organizationId, input.id, false);
  });
}

/**
 * Take it back, with a reason.
 *
 * Recorded as an act rather than a silent clearing of the column, because
 * "the customer was sent a report and then it was withdrawn" is exactly the
 * sort of thing somebody asks about a year later. The reason goes on the
 * report's observations so it travels with the document rather than living
 * only in the audit log.
 */
export async function unpublish(
  ctx: ServiceContext, input: { id: string; reason: string },
): Promise<ReportView> {
  return guardedWrite(ctx, "servicereport:publish", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if (!before.publishedAt) {
      throw new ConflictError("That report is not published.");
    }
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError(
        "Withdrawing a report the customer already has needs a reason. Somebody will ask.",
      );
    }

    const [row] = await tx.update(schema.serviceReport).set({
      publishedAt: null,
      observations: before.observations
        ? `${before.observations}\nWithdrawn: ${reason}`
        : `Withdrawn: ${reason}`,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.serviceReport.organizationId, ctx.actor.organizationId),
      eq(schema.serviceReport.id, input.id),
    )).returning();

    await audit(tx, ctx, "service_report.unpublished", "service_report", input.id, before, row!);
    return viewWithin(tx, ctx.actor.organizationId, input.id, false);
  });
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.serviceReport)
    .where(and(
      eq(schema.serviceReport.organizationId, organizationId),
      eq(schema.serviceReport.id, id),
    ));
  if (!row) throw new NotFoundError("Service report");
  return row;
}

export const handlers = {
  listServiceReportTemplates: async (
    ctx: ServiceContext, input: { includeRetired?: boolean | undefined },
  ): Promise<{ templates: TemplateView[] }> => ({ templates: await listTemplates(ctx, input) }),
  defineServiceReportTemplate: (ctx: ServiceContext, input: TemplateInput): Promise<TemplateView> =>
    defineTemplate(ctx, input),
  updateServiceReportTemplate: (ctx: ServiceContext, input: TemplateUpdate): Promise<TemplateView> =>
    updateTemplate(ctx, input),
  listServiceReports: (ctx: ServiceContext, input: ReportQuery): Promise<{ reports: ReportSummary[] }> =>
    list(ctx, input),
  getServiceReport: (
    ctx: ServiceContext, input: { id: string; customerFacing?: boolean | undefined },
  ): Promise<ReportView> => get(ctx, input),
  annotateServiceReport: (ctx: ServiceContext, input: {
    id: string; summary?: string | null | undefined; observations?: string | null | undefined;
  }): Promise<ReportView> => annotate(ctx, input),
  publishServiceReport: (ctx: ServiceContext, input: { id: string }): Promise<ReportView> =>
    publish(ctx, input),
  unpublishServiceReport: (
    ctx: ServiceContext, input: { id: string; reason: string },
  ): Promise<ReportView> => unpublish(ctx, input),
} as const;
