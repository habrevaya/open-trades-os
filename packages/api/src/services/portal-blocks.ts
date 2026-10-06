import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { bytesOf, HELD } from "./files";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp } from "@opentradesos/core";
import { packs } from "@opentradesos/trade-packs";
import { settingsWithin as portalSettingsWithin } from "./portal-settings";
import { audit, guardedWrite, ConflictError, NotFoundError, type ServiceContext } from "./context";

/**
 * WHAT A CUSTOMER SEES OF THE WORK, NOT ONLY OF THE BILLS
 *
 * Until now the account page was the same for every trade: visits, invoices,
 * estimates, plans. Everything that makes a portal worth opening was in the
 * database and nowhere on it: the service report the office published, the
 * readings a technician took, the products applied at the house, the
 * equipment on the property, the notes from the visit.
 *
 * This file reads those, for one customer, inside a grant's tenant boundary
 * (the caller has already resolved the grant and checked its scope), and the
 * company's portal layout says which of them the page draws and in what
 * order: the layout a trade pack seeds when it is applied (`portal_layout`),
 * composed by core with what every account shows regardless.
 *
 * WHAT IS SHOWN IS WHAT THE COMPANY CHOSE TO SHOW, every time, and the rule
 * is the same one the rest of the product already applies:
 *
 *  - a service report only once it is published, and only its fields marked
 *    customer visible; never the technician's own notes on it;
 *  - a visit's notes only as the office chose to share them
 *    (`visit.customer_notes`), never `technician_notes`;
 *  - photographs by the portal setting and the per photograph choice, the
 *    same test the job link uses;
 *  - a technician by first name.
 *
 * Built field by field like every other portal read: no cost, no margin, no
 * other customer.
 */

export interface ReportFieldView {
  key: string;
  label: string;
  kind: string;
  unit: string | null;
  value: string | null;
  outOfRange: boolean;
  /** What was applied, when the field records a product: pest control, lawn, pool. */
  product: {
    name: string | null;
    epaRegistrationNumber: string | null;
    quantity: string | null;
    unit: string | null;
    target: string | null;
  } | null;
}

export interface ReportView {
  id: string;
  visitId: string;
  publishedAt: string;
  summary: string | null;
  observations: string | null;
  fields: ReportFieldView[];
}

export interface AccountExtras {
  blocks: cp.PortalBlock[];
  /** Every past visit, newest first, with what the company shared about it. */
  history: {
    visitId: string;
    jobId: string;
    jobNumber: number;
    summary: string;
    date: string | null;
    status: string;
    technicianName: string | null;
    notes: string | null;
    report: ReportView | null;
  }[];
  equipment: {
    id: string;
    property: string;
    name: string;
    tag: string | null;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    installedOn: string | null;
    warrantyPartsExpiresOn: string | null;
    warrantyLaborExpiresOn: string | null;
    location: string | null;
    details: { label: string; value: string }[];
  }[];
  /**
   * One series per reading per unit: the superheat on the upstairs system
   * and on the downstairs one are two lines, never one that jumps between
   * them. `equipment` names the unit, null for readings of the whole home.
   */
  readings: {
    key: string; label: string; unit: string | null; equipment: string | null;
    points: { at: string; value: string; outOfRange: boolean }[];
  }[];
  checklist: { date: string | null; summary: string; items: { label: string; done: boolean }[] } | null;
  photos: { id: string; takenAt: string; jobNumber: number }[];
  payments: { id: string; receivedAt: string; amount: string; method: string; status: string }[];
  planVisits: { agreementId: string; planName: string; dueOn: string; state: "done" | "booked" | "skipped" | "due" }[];
  recommendations: { date: string; text: string }[];
  contact: { phone: string | null; technicians: string[] };
}

const firstName = (name: string | null) => (name ? name.trim().split(/\s+/)[0] ?? name : null);
const isoDay = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The company's default layouts, in the order the page reads them, and their
 * blocks in that order: a layout the company made itself first (it is what
 * the office arranged when no pack had seeded one, and a pack applied later
 * must not push it aside), then its primary trade's pack, then any other.
 * The office's arrangement is written to the first, naming every block, so
 * it decides the whole page.
 */
export async function defaultLayouts(tx: Database, organizationId: string) {
  const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const layouts = await tx.select().from(schema.portalLayout)
    .where(and(eq(schema.portalLayout.organizationId, organizationId), eq(schema.portalLayout.isDefault, true)))
    .orderBy(asc(schema.portalLayout.createdAt));
  const primary = org?.primaryTrade ?? "";
  const rank = (tag: string | null) => (tag === null ? 0 : tag.startsWith(`${primary}@`) ? 1 : 2);
  layouts.sort((a, b) => rank(a.tradePackId) - rank(b.tradePackId));
  if (layouts.length === 0) return { layouts, blocks: [] };
  const rows = await tx.select().from(schema.portalBlock)
    .where(inArray(schema.portalBlock.layoutId, layouts.map((l) => l.id)))
    .orderBy(asc(schema.portalBlock.sortOrder));
  const order = new Map(layouts.map((l, i) => [l.id, i]));
  rows.sort((a, b) => (order.get(a.layoutId)! - order.get(b.layoutId)!) || a.sortOrder - b.sortOrder);
  return { layouts, blocks: rows };
}

/** The company's portal layout as the page draws it. */
async function layoutOf(tx: Database, organizationId: string) {
  const { blocks } = await defaultLayouts(tx, organizationId);
  return cp.composeBlocks(blocks.map((r) => ({ kind: r.kind, title: r.title, config: r.config, visible: r.visible })));
}

/** Published reports for some visits, customer visible fields only. */
async function reportsFor(tx: Database, customerId: string, visitIds: string[]): Promise<ReportView[]> {
  if (visitIds.length === 0) return [];
  const reports = await tx.select().from(schema.serviceReport)
    .where(and(
      eq(schema.serviceReport.customerId, customerId),
      inArray(schema.serviceReport.visitId, visitIds),
      isNotNull(schema.serviceReport.publishedAt),
      eq(schema.serviceReport.skipped, false),
    ))
    .orderBy(desc(schema.serviceReport.publishedAt));
  if (reports.length === 0) return [];
  const fields = await tx.select().from(schema.serviceReportField)
    .where(and(
      inArray(schema.serviceReportField.reportId, reports.map((r) => r.id)),
      eq(schema.serviceReportField.customerVisible, true),
    ))
    .orderBy(asc(schema.serviceReportField.recordedAt));
  return reports.map((report) => ({
    id: report.id,
    visitId: report.visitId,
    publishedAt: report.publishedAt!.toISOString(),
    summary: report.summary,
    observations: report.observations,
    fields: fields.filter((f) => f.reportId === report.id && f.kind !== "photo" && f.kind !== "signature").map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      unit: f.unit,
      value: f.valueNumeric ?? f.valueText ?? (f.valueBoolean === null ? null : f.valueBoolean ? "Yes" : "No"),
      outOfRange: f.outOfRange,
      product: f.productName || f.epaRegistrationNumber || f.quantityApplied
        ? {
          name: f.productName,
          epaRegistrationNumber: f.epaRegistrationNumber,
          quantity: f.quantityApplied,
          unit: f.applicationUnit,
          target: f.targetPest,
        }
        : null,
    })),
  }));
}

/**
 * The photographs a customer may see across all their jobs, the same test
 * the job link applies to one job's: a photograph, chosen for them or shown
 * because the company shows them all, never a signature.
 */
export async function customerPhotos(tx: Database, organizationId: string, customerId: string) {
  const settings = await portalSettingsWithin(tx, organizationId);
  const jobs = await tx.select({ id: schema.job.id, number: schema.job.number })
    .from(schema.job)
    .where(and(eq(schema.job.customerId, customerId), isNull(schema.job.deletedAt)));
  if (jobs.length === 0) return [];
  const visits = await tx.select({ id: schema.visit.id, jobId: schema.visit.jobId })
    .from(schema.visit).where(inArray(schema.visit.jobId, jobs.map((j) => j.id)));
  const rows = await tx.select().from(schema.attachment)
    .where(and(
      isNull(schema.attachment.deletedAt),
      eq(schema.attachment.kind, "photo"),
      visits.length > 0
        ? or(
          and(eq(schema.attachment.entityType, "job"), inArray(schema.attachment.entityId, jobs.map((j) => j.id))),
          and(eq(schema.attachment.entityType, "visit"), inArray(schema.attachment.entityId, visits.map((v) => v.id))),
        )
        : and(eq(schema.attachment.entityType, "job"), inArray(schema.attachment.entityId, jobs.map((j) => j.id))),
    ))
    .orderBy(desc(schema.attachment.createdAt))
    .limit(200);
  const jobOfVisit = new Map(visits.map((v) => [v.id, v.jobId]));
  const numberOf = new Map(jobs.map((j) => [j.id, j.number]));
  return rows
    .filter((row) => row.contentType?.startsWith("image/")
      && cp.photoShown(settings.jobPhotos, { kind: row.kind, sharedAt: row.sharedWithCustomerAt }))
    .map((row) => ({
      row,
      jobNumber: numberOf.get(row.entityType === "job" ? row.entityId ?? "" : jobOfVisit.get(row.entityId ?? "") ?? "") ?? 0,
    }));
}

/** The bytes of one photograph a customer may see, by id, or nothing. */
export async function customerPhotoBytes(tx: Database, organizationId: string, customerId: string, attachmentId: string) {
  const shown = await customerPhotos(tx, organizationId, customerId);
  const photo = shown.find((p) => p.row.id === attachmentId)?.row;
  if (!photo) return null;
  const [file] = await tx.select({ ...HELD, contentType: schema.storedFile.contentType })
    .from(schema.storedFile)
    .where(and(eq(schema.storedFile.storageKey, photo.storageKey), isNull(schema.storedFile.deletedAt)))
    .limit(1);
  return file ? { bytes: await bytesOf(file), contentType: file.contentType } : null;
}

/** Equipment attribute labels the company's packs declare, by category code and name. */
function attributeLabels(): Map<string, { name: string; labels: Map<string, string> }> {
  const out = new Map<string, { name: string; labels: Map<string, string> }>();
  for (const pack of packs) {
    for (const category of pack.equipmentCategories) {
      const entry = { name: category.name, labels: new Map(category.attributes.map((a) => [a.key, a.label])) };
      if (!out.has(category.code)) out.set(category.code, entry);
      if (!out.has(category.name.toLowerCase())) out.set(category.name.toLowerCase(), entry);
    }
  }
  return out;
}

const shown = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return null;
};

export async function accountExtras(
  tx: Database, organizationId: string, customerId: string,
): Promise<AccountExtras> {
  const blocks = await layoutOf(tx, organizationId);
  const wants = (kind: cp.PortalBlockKind) => blocks.some((b) => b.kind === kind);

  /* ---- the visits that happened ---------------------------------------- */
  const past = await tx.select({
    visit: schema.visit,
    jobNumber: schema.job.number,
    summary: schema.job.summary,
    technicianName: schema.technician.displayName,
  })
    .from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .leftJoin(schema.visitAssignment, and(
      eq(schema.visitAssignment.visitId, schema.visit.id),
      eq(schema.visitAssignment.isLead, true),
    ))
    .leftJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(and(
      eq(schema.job.customerId, customerId),
      isNull(schema.job.deletedAt),
      inArray(schema.visit.status, ["completed", "completed_after_cancellation"]),
    ))
    .orderBy(desc(sql`coalesce(${schema.visit.completedAt}, ${schema.visit.windowStart})`))
    .limit(30);
  const reports = await reportsFor(tx, customerId, past.map((p) => p.visit.id));
  const history = past.map((p) => ({
    visitId: p.visit.id,
    jobId: p.visit.jobId,
    jobNumber: p.jobNumber,
    summary: p.summary,
    date: isoDay(p.visit.completedAt ?? p.visit.windowStart),
    status: p.visit.status,
    technicianName: firstName(p.technicianName),
    notes: p.visit.customerNotesSharedAt ? p.visit.customerNotes : null,
    report: reports.find((r) => r.visitId === p.visit.id) ?? null,
  }));

  /* ---- the equipment at their properties ------------------------------- */
  const known = attributeLabels();
  const units = await tx.select({ unit: schema.equipment, line1: schema.property.addressLine1 })
    .from(schema.customerProperty)
    .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
    .innerJoin(schema.equipment, eq(schema.equipment.propertyId, schema.property.id))
    .where(and(
      eq(schema.customerProperty.customerId, customerId),
      isNull(schema.customerProperty.endedOn),
      eq(schema.equipment.active, true),
    ))
    .orderBy(asc(schema.property.addressLine1), asc(schema.equipment.category))
    .limit(100);
  const equipment = units.map(({ unit, line1 }) => {
    const category = known.get(unit.category) ?? known.get(unit.category.toLowerCase());
    return {
      id: unit.id,
      property: line1,
      name: category?.name ?? unit.category,
      tag: unit.tag,
      manufacturer: unit.manufacturer,
      model: unit.model,
      serialNumber: unit.serialNumber,
      installedOn: unit.installedOn,
      warrantyPartsExpiresOn: unit.warrantyPartsExpiresOn,
      warrantyLaborExpiresOn: unit.warrantyLaborExpiresOn,
      location: unit.location,
      details: Object.entries(unit.attributes ?? {})
        .map(([key, value]) => ({ label: category?.labels.get(key) ?? cp.attributeLabel(key), value: shown(value) }))
        .filter((d): d is { label: string; value: string } => d.value !== null),
    };
  });

  /* ---- readings over time, for the keys the layout asks for ------------- */
  let readings: AccountExtras["readings"] = [];
  const trend = blocks.find((b) => b.kind === "readings_trend");
  if (trend) {
    const keys = cp.readingKeys(trend.config);
    const rows = await tx.select({
      key: schema.serviceReportField.key,
      label: schema.serviceReportField.label,
      unit: schema.serviceReportField.unit,
      value: schema.serviceReportField.valueNumeric,
      quantity: schema.serviceReportField.quantityApplied,
      outOfRange: schema.serviceReportField.outOfRange,
      at: schema.serviceReportField.recordedAt,
      equipmentId: schema.serviceReportField.equipmentId,
    })
      .from(schema.serviceReportField)
      .innerJoin(schema.serviceReport, eq(schema.serviceReport.id, schema.serviceReportField.reportId))
      .where(and(
        eq(schema.serviceReport.customerId, customerId),
        isNotNull(schema.serviceReport.publishedAt),
        eq(schema.serviceReportField.customerVisible, true),
        or(isNotNull(schema.serviceReportField.valueNumeric), isNotNull(schema.serviceReportField.quantityApplied)),
        keys.length > 0 ? inArray(schema.serviceReportField.key, keys) : undefined,
      ))
      .orderBy(desc(schema.serviceReportField.recordedAt))
      .limit(300);
    /** One series per reading per unit, in the order the keys are asked for, units in the order first seen. */
    const bySeries = new Map<string, AccountExtras["readings"][number]>();
    for (const row of rows) {
      const id = `${row.key}\u0000${row.equipmentId ?? ""}`;
      /** Named as the equipment block names it: its tag and what it is, "RTU-4, Air conditioner". */
      const unit = row.equipmentId ? equipment.find((e) => e.id === row.equipmentId) : undefined;
      const named = unit ? [unit.tag, unit.name].filter(Boolean).join(", ") : row.equipmentId ? "A unit no longer in use" : null;
      const series = bySeries.get(id) ?? { key: row.key, label: row.label, unit: row.unit, equipment: named, points: [] };
      if (series.points.length < 12) {
        series.points.push({ at: row.at.toISOString(), value: (row.value ?? row.quantity)!, outOfRange: row.outOfRange });
      }
      bySeries.set(id, series);
    }
    const all = [...bySeries.values()];
    const order = keys.length > 0 ? keys : [...new Set(all.map((s) => s.key))].slice(0, 6);
    readings = order.flatMap((key) => all.filter((s) => s.key === key))
      .map((s) => ({ ...s, points: [...s.points].reverse() }));
  }

  /* ---- the last visit's checklist -------------------------------------- */
  let checklist: AccountExtras["checklist"] = null;
  if (wants("checklist_results")) {
    const last = past.find((p) => p.visit.checklist.length > 0);
    if (last) {
      checklist = {
        date: isoDay(last.visit.completedAt ?? last.visit.windowStart),
        summary: last.summary,
        items: last.visit.checklist.map((item) => ({ label: item.label, done: item.doneAt !== null })),
      };
    }
  }

  /* ---- photographs ------------------------------------------------------ */
  const photos = wants("photo_gallery")
    ? (await customerPhotos(tx, organizationId, customerId)).slice(0, 24).map((p) => ({
      id: p.row.id, takenAt: p.row.createdAt.toISOString(), jobNumber: p.jobNumber,
    }))
    : [];

  /* ---- money received --------------------------------------------------- */
  const payments = wants("payments")
    ? (await tx.select({
      id: schema.payment.id, receivedAt: schema.payment.receivedAt, amount: schema.payment.amount,
      method: schema.payment.method, status: schema.payment.status,
    }).from(schema.payment)
      .where(eq(schema.payment.customerId, customerId))
      .orderBy(desc(schema.payment.receivedAt)).limit(24))
      .map((p) => ({ ...p, receivedAt: p.receivedAt.toISOString() }))
    : [];

  /* ---- the plan's visits ------------------------------------------------ */
  const planRows = await tx.select({
    agreementId: schema.agreementVisit.agreementId,
    planName: schema.agreementPlan.name,
    dueOn: schema.agreementVisit.dueOn,
    jobId: schema.agreementVisit.jobId,
    deliveredOn: schema.agreementVisit.deliveredOn,
    skippedOn: schema.agreementVisit.skippedOn,
  })
    .from(schema.agreementVisit)
    .innerJoin(schema.agreement, eq(schema.agreement.id, schema.agreementVisit.agreementId))
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(and(
      eq(schema.agreement.customerId, customerId),
      inArray(schema.agreement.status, ["pending", "active", "past_due"]),
    ))
    .orderBy(asc(schema.agreementVisit.dueOn))
    .limit(24);
  const planVisits = planRows.map((v) => ({
    agreementId: v.agreementId,
    planName: v.planName,
    dueOn: v.dueOn,
    state: v.deliveredOn ? "done" as const : v.skippedOn ? "skipped" as const : v.jobId ? "booked" as const : "due" as const,
  }));

  /* ---- what the technicians flagged ------------------------------------ */
  const recommendations = reports
    .filter((r) => r.observations?.trim())
    .slice(0, 5)
    .map((r) => ({ date: r.publishedAt, text: r.observations!.trim() }));

  /* ---- who to call ------------------------------------------------------ */
  const [main] = await tx.select({ e164: schema.phoneNumber.e164 }).from(schema.phoneNumber)
    .where(and(eq(schema.phoneNumber.purpose, "main"), isNull(schema.phoneNumber.releasedAt)))
    .orderBy(asc(schema.phoneNumber.createdAt)).limit(1);
  const technicians = [...new Set(history.map((h) => h.technicianName).filter((n): n is string => n !== null))].slice(0, 6);

  return {
    blocks, history, equipment, readings, checklist, photos, payments, planVisits, recommendations,
    contact: { phone: main?.e164 ?? null, technicians },
  };
}

/**
 * Show the customer what happened on a visit, in words the office chose, or
 * stop showing it.
 *
 * The technician's notes are where somebody writes what they would never
 * say to the customer, so they are never shown as they stand. The office
 * shares a copy: the notes as they read now, or its own wording of them,
 * and that copy is what the customer reads even as the notes on the phone
 * keep growing. The same permission as publishing a service report and as
 * showing a photograph, because it is the same decision.
 */
export async function shareVisitNotes(
  ctx: ServiceContext, input: { id: string; notes: string | null },
): Promise<{ id: string; customerNotes: string | null; sharedAt: string | null }> {
  return guardedWrite(ctx, "servicereport:publish", async (tx) => {
    const [visit] = await tx.select().from(schema.visit).where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");
    const words = input.notes?.trim() ?? "";
    if (input.notes !== null && words === "") {
      throw new ConflictError("Write what the customer should read, or stop sharing the notes.");
    }
    if (words.length > 4000) throw new ConflictError("Keep what the customer reads under 4,000 characters.");
    const sharedAt = words ? (visit.customerNotes === words && visit.customerNotesSharedAt ? visit.customerNotesSharedAt : new Date()) : null;
    await tx.update(schema.visit).set({
      customerNotes: words || null, customerNotesSharedAt: sharedAt, updatedAt: new Date(),
    }).where(eq(schema.visit.id, visit.id));
    await audit(tx, ctx, words ? "visit.notes_shared" : "visit.notes_unshared", "visit", visit.id,
      { customerNotes: visit.customerNotes }, { customerNotes: words || null });
    return { id: visit.id, customerNotes: words || null, sharedAt: sharedAt?.toISOString() ?? null };
  });
}

export const handlers = {
  shareVisitNotes: (ctx: ServiceContext, input: { id: string; notes: string | null }) => shareVisitNotes(ctx, input),
} as const;
