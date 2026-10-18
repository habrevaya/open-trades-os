import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { jobVisibility } from "./scope";
import { chemicalAt, inForceAt } from "./pricebook";
import { fileReport, templateFor } from "./field";

/**
 * WHAT WAS APPLIED ON A VISIT, CHOSEN FROM THE BOOK
 *
 * A chemical application has always been a service report row with regulated
 * columns (the product, its EPA number, how much, the unit, the licence and the
 * target), filled on the phone and typed by name. A name cannot be costed, so
 * pest control's chemical cost per stop could not be computed: matching
 * "Termidor SC" to an item would be reading words for a meaning.
 *
 * Now the company marks the materials that are chemicals in its price book
 * (`price_book_item.chemical_unit`, with the unit the cost is per and the EPA
 * number from the label), and an application names the item it was chosen
 * from (`service_report_field.price_book_item_id`). The phone and the
 * browser's "My day" choose it in the field (`service_report.set_field` in
 * `services/field.ts`); this file is the office's side: what a visit's report
 * asks about products and what is recorded, and recording one the technician
 * missed, on the same report, created the same way.
 *
 * A typed product is still recorded and still shown: older records, and a
 * product the book does not hold. It is never valued from its name.
 */

export interface AppliedProduct {
  id: string;
  /** The report field it answers: "Product applied, brand or product name". */
  field: string;
  productName: string | null;
  epaRegistrationNumber: string | null;
  quantity: string | null;
  unit: string | null;
  applicatorLicense: string | null;
  targetPest: string | null;
  /** True when it was chosen from the price book, false when it was typed by name. */
  fromBook: boolean;
  recordedAt: string;
}

export interface ProductsOnVisit {
  visitId: string;
  /** The report it goes on, or null when nothing has been recorded on the visit yet. */
  reportId: string | null;
  /** Published reports are the customer's and are not added to here. */
  published: boolean;
  /** The product fields this visit's report asks for, from its template. Empty when it asks for none. */
  fields: Array<{ key: string; label: string }>;
  /** The chemicals in the price book, by name, with their unit and EPA number. Never a cost. */
  chemicals: Array<{ id: string; name: string; unit: string; epaRegistrationNumber: string | null }>;
  /** The latest answer to each product field on each report on the visit. */
  applied: AppliedProduct[];
}

/** The visit, if this person may see its job, with what the report needs to be filed. */
async function visitFor(tx: Database, ctx: ServiceContext, visitId: string) {
  const [found] = await tx.select({
    id: schema.visit.id, jobId: schema.visit.jobId, jobTypeId: schema.job.jobTypeId,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(and(
      eq(schema.visit.id, visitId),
      eq(schema.visit.organizationId, ctx.actor.organizationId),
      isNull(schema.job.deletedAt),
      jobVisibility(scopeOf(ctx, "servicereport"), ctx.actor, sql`${schema.job.id}`),
    )).limit(1);
  if (!found) throw new NotFoundError("Visit");
  return found;
}

/**
 * The fields a report asks about products: the chemical fields of the
 * template it was written against, or of the job type's template for a visit
 * with no report yet.
 */
async function productFields(tx: Database, report: { templateId: string | null } | null, jobTypeId: string | null) {
  const template = report?.templateId
    ? (await tx.select({ fields: schema.serviceReportTemplate.fields }).from(schema.serviceReportTemplate)
      .where(eq(schema.serviceReportTemplate.id, report.templateId)).limit(1))[0] ?? null
    : await templateFor(tx, jobTypeId);
  return (template?.fields ?? []).filter((f) => f.kind === "chemical").map((f) => ({ key: f.key, label: f.label }));
}

async function readWithin(tx: Database, ctx: ServiceContext, visitId: string): Promise<ProductsOnVisit> {
  const visit = await visitFor(tx, ctx, visitId);
  const [report] = await tx.select({
    id: schema.serviceReport.id, templateId: schema.serviceReport.templateId, publishedAt: schema.serviceReport.publishedAt,
  }).from(schema.serviceReport).where(eq(schema.serviceReport.visitId, visitId))
    .orderBy(asc(schema.serviceReport.createdAt)).limit(1);
  const fields = await productFields(tx, report ?? null, visit.jobTypeId);

  const chemicals = await tx.select({
    id: schema.priceBookItem.id, name: schema.priceBookItemVersion.name,
    unit: schema.priceBookItem.chemicalUnit, epaRegistrationNumber: schema.priceBookItem.epaRegistrationNumber,
  }).from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id))
    .where(and(
      eq(schema.priceBookItem.organizationId, ctx.actor.organizationId),
      isNotNull(schema.priceBookItem.chemicalUnit),
      eq(schema.priceBookItem.active, true),
      isNull(schema.priceBookItem.deletedAt),
      inForceAt(),
    ))
    .orderBy(asc(schema.priceBookItemVersion.name)).limit(500);

  /** The latest answer to each chemical field, on every report on the visit, as the scorecard reads it. */
  const rows = await tx.execute<{
    id: string; label: string; product_name: string | null; epa_registration_number: string | null;
    quantity_applied: string | null; application_unit: string | null; applicator_license: string | null;
    target_pest: string | null; price_book_item_id: string | null; recorded_at: Date | string;
  }>(sql`
    select distinct on (f.report_id, f.key) f.id, f.label, f.product_name, f.epa_registration_number,
           f.quantity_applied::text as quantity_applied, f.application_unit, f.applicator_license, f.target_pest,
           f.price_book_item_id, f.recorded_at
    from public.service_report_field f
    join public.service_report r on r.id = f.report_id
    where r.visit_id = ${visitId} and f.kind = 'chemical'
    order by f.report_id, f.key, f.recorded_at desc, f.created_at desc`);

  return {
    visitId,
    reportId: report?.id ?? null,
    published: Boolean(report?.publishedAt),
    fields,
    chemicals: chemicals.map((c) => ({ id: c.id, name: c.name, unit: c.unit ?? "", epaRegistrationNumber: c.epaRegistrationNumber })),
    applied: rows
      .filter((r) => r.product_name !== null || r.quantity_applied !== null || r.price_book_item_id !== null)
      .map((r) => ({
        id: r.id,
        field: r.label,
        productName: r.product_name,
        epaRegistrationNumber: r.epa_registration_number,
        quantity: r.quantity_applied,
        unit: r.application_unit,
        applicatorLicense: r.applicator_license,
        targetPest: r.target_pest,
        fromBook: r.price_book_item_id !== null,
        recordedAt: new Date(r.recorded_at).toISOString(),
      })),
  };
}

/** What a visit's report asks about products, what is recorded, and the chemicals to choose from. */
export async function forVisit(ctx: ServiceContext, input: { id: string }): Promise<ProductsOnVisit> {
  return guardedRead(ctx, "servicereport:read", (tx) => readWithin(tx, ctx, input.id));
}

/**
 * THE OFFICE RECORDS A PRODUCT THE TECHNICIAN MISSED, chosen from the book.
 *
 * On the visit's report, as the latest answer to one of its product fields,
 * with the item's name, EPA number and unit carried from the book exactly as
 * the phone carries them, so the regulated record and the scorecard read it
 * the same way. The report is created as the phone would create it when the
 * visit has none.
 *
 * Refused in words: a published report (the customer has it; unpublish it
 * first, as an edit to its summary is refused), a visit whose report asks for
 * no product, a field that is not one of its product fields, an item that is
 * not a chemical in the book, and an amount that is not a positive number.
 */
export async function record(
  ctx: ServiceContext,
  input: {
    id: string; field: string; priceBookItemId: string; quantity: string;
    applicatorLicense?: string | undefined; targetPest?: string | undefined;
  },
): Promise<ProductsOnVisit> {
  return guardedWrite(ctx, "servicereport:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const visit = await visitFor(tx, ctx, input.id);
    const [existing] = await tx.select({
      id: schema.serviceReport.id, templateId: schema.serviceReport.templateId,
      publishedAt: schema.serviceReport.publishedAt, propertyId: schema.serviceReport.propertyId,
    }).from(schema.serviceReport).where(eq(schema.serviceReport.visitId, visit.id))
      .orderBy(asc(schema.serviceReport.createdAt)).limit(1);
    if (existing?.publishedAt) {
      throw new ConflictError(
        "That visit's report is published and the customer has it. Unpublish it first: adding to a "
        + "document somebody is already holding means two people reading different things.",
      );
    }

    const fields = await productFields(tx, existing ?? null, visit.jobTypeId);
    if (fields.length === 0) {
      throw new ConflictError("This visit's report does not ask what product was applied, so there is nowhere to record one.");
    }
    const field = fields.find((f) => f.key === input.field);
    if (!field) throw new ConflictError(`The report does not ask "${input.field}". Choose one of its product questions.`);

    const now = new Date();
    const chemical = await chemicalAt(tx, org, input.priceBookItemId, now);
    if (!chemical) {
      throw new ConflictError("That is not a chemical in your price book. Mark the item as a chemical on its page first.");
    }
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new ConflictError("Enter how much was applied as a number more than nought, like 1.5.");
    }

    const reportId = existing?.id ?? crypto.randomUUID();
    const refused = await fileReport(tx, org, reportId, visit.id);
    if (refused) throw new ConflictError(refused);
    const [report] = await tx.select({ propertyId: schema.serviceReport.propertyId })
      .from(schema.serviceReport).where(eq(schema.serviceReport.id, reportId)).limit(1);

    const [row] = await tx.insert(schema.serviceReportField).values({
      organizationId: org,
      reportId,
      propertyId: report!.propertyId,
      key: field.key,
      label: field.label,
      kind: "chemical",
      valueText: chemical.name,
      productName: chemical.name,
      epaRegistrationNumber: chemical.epaRegistrationNumber,
      quantityApplied: String(quantity),
      applicationUnit: chemical.unit,
      applicatorLicense: input.applicatorLicense?.trim() || null,
      targetPest: input.targetPest?.trim() || null,
      priceBookItemId: chemical.itemId,
      recordedAt: now,
    }).returning({ id: schema.serviceReportField.id });

    await audit(tx, ctx, "service_report.product_recorded", "service_report", reportId, null, {
      fieldId: row!.id, visitId: visit.id, field: field.key, priceBookItemId: chemical.itemId,
      productName: chemical.name, quantity: input.quantity, unit: chemical.unit,
    });
    return readWithin(tx, ctx, visit.id);
  });
}

export const handlers = {
  getVisitProducts: (ctx: ServiceContext, input: { id: string }) => forVisit(ctx, input),
  recordVisitProduct: (ctx: ServiceContext, input: Parameters<typeof record>[1]) => record(ctx, input),
} as const;
