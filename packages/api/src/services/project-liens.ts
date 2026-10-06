import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, money as m, project as plan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as files from "./files";
import { loadProjectIn, rememberKey, seenKey } from "./project-position";

/**
 * M12. NOTICES AND WAIVERS, AS RECORDS.
 *
 * What was sent and received about the right to be paid on a project: a
 * preliminary notice to the owner, a notice from a supplier, a conditional
 * waiver handed over with an application, an unconditional one when the
 * money cleared, a final one at the end. Each with its date, its party, its
 * amount, the payment it is against and, where somebody scanned it, the
 * paper itself.
 *
 * NOTHING HERE KNOWS ANY STATE'S LIEN LAW, and that is the decision rather
 * than the gap. Which notices are required, by when and in what form, and
 * when a waiver takes effect, differ by state and change with the
 * legislature; a product that told a contractor their notice was late and
 * was wrong would be wrong about whether they get paid. The checklist is
 * core's `waiverChecklist`, which says only what is and is not on file
 * against each payment. BUILD.md lists state by state lien rules among the
 * things this product does not do, and the screen says so beside the list.
 *
 * `invoice:read` to read and `invoice:write` to record, because these are
 * payment documents, held by whoever holds the invoices.
 */

type RecordRow = typeof schema.projectLienRecord.$inferSelect;

export interface LienRecordInput {
  projectId: string;
  kind: "notice" | "waiver";
  direction: "sent" | "received";
  condition?: "conditional" | "unconditional" | null | undefined;
  scope?: "progress" | "final" | null | undefined;
  title: string;
  partyName: string;
  onDate: string;
  throughDate?: string | null | undefined;
  amount?: string | null | undefined;
  invoiceId?: string | null | undefined;
  notes?: string | null | undefined;
  /** The scanned or signed paper, base64. */
  document?: { fileName: string; contentType?: string | undefined; bytes: string } | undefined;
}

export interface LienRecordView {
  id: string;
  kind: RecordRow["kind"];
  direction: RecordRow["direction"];
  condition: RecordRow["condition"];
  scope: RecordRow["scope"];
  title: string;
  partyName: string;
  onDate: string;
  throughDate: string | null;
  amount: string | null;
  invoiceId: string | null;
  invoiceNumber: number | null;
  notes: string | null;
  documents: { id: string; fileName: string | null; storageKey: string }[];
  createdAt: Date;
}

/**
 * Record one. A waiver says whether it is conditional and whether it is for
 * progress or final, because those are the two facts that decide what it
 * does; a notice says neither, because it has neither. The payment, when
 * named, has to be an invoice this project raised: a waiver filed against
 * some other job's invoice is a waiver nobody will find when it is needed.
 */
export async function record(ctx: ServiceContext, input: LienRecordInput): Promise<LienRecordView> {
  if (input.document) assertCan(ctx.actor, "document:write");
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await seenKey(tx, ctx, "project_lien_record");
    if (seen) return viewIn(tx, ctx.actor.organizationId, seen);

    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    const title = input.title.trim();
    const party = input.partyName.trim();
    if (title === "") throw new ConflictError("Say what the document is: a preliminary notice, a conditional waiver on a progress payment.");
    if (party === "") throw new ConflictError("Say who it was sent to or received from.");
    if (input.kind === "waiver" && (!input.condition || !input.scope)) {
      throw new ConflictError("A waiver is conditional or unconditional, and for a progress payment or the final one. Say which.");
    }
    if (input.kind === "notice" && (input.condition || input.scope)) {
      throw new ConflictError("A notice is not conditional or final; only a waiver is.");
    }
    let amount: string | null = null;
    if (input.amount !== undefined && input.amount !== null && input.amount !== "") {
      try {
        amount = m.toString(m.money(input.amount));
      } catch {
        throw new ConflictError(`${input.amount} is not an amount of money.`);
      }
      if (m.isNegative(m.money(amount))) throw new ConflictError("An amount on a notice or waiver is never negative.");
    }
    if (input.throughDate && input.throughDate > input.onDate && input.kind === "waiver" && input.condition === "unconditional") {
      /** Not a legal rule, a typing check: an unconditional waiver cannot cover work that has not happened by the day it was signed. */
      throw new ConflictError("That unconditional waiver covers work through a date after it was signed.");
    }
    if (input.invoiceId) {
      const payments = await paymentsOf(tx, project.id);
      if (!payments.some((p) => p.invoiceId === input.invoiceId)) {
        throw new ConflictError("That invoice is not a payment this project billed.");
      }
    }

    const [row] = await tx.insert(schema.projectLienRecord).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      kind: input.kind,
      direction: input.direction,
      condition: input.kind === "waiver" ? input.condition ?? null : null,
      scope: input.kind === "waiver" ? input.scope ?? null : null,
      title,
      partyName: party,
      onDate: input.onDate,
      throughDate: input.throughDate ?? null,
      amount,
      invoiceId: input.invoiceId ?? null,
      notes: input.notes?.trim() || null,
    }).returning();

    if (input.document) {
      const bytes = Buffer.from(input.document.bytes, "base64");
      const { file } = await files.put(tx, ctx.actor.organizationId, {
        bytes, claimedType: input.document.contentType, uploadedByUserId: ctx.actor.userId,
      });
      await files.attach(tx, ctx.actor.organizationId, {
        entityType: "project_lien_record",
        entityId: row!.id,
        storageKey: file.storageKey,
        kind: "document",
        fileName: input.document.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        uploadedByUserId: ctx.actor.userId,
      });
    }

    await rememberKey(tx, ctx, "project_lien_record.record", "project_lien_record", row!.id);
    await audit(tx, ctx, "project_lien_record.recorded", "project_lien_record", row!.id, null, row!);
    return viewIn(tx, ctx.actor.organizationId, row!.id);
  });
}

async function viewIn(tx: Database, organizationId: string, id: string): Promise<LienRecordView> {
  const [row] = await tx.select().from(schema.projectLienRecord)
    .where(and(eq(schema.projectLienRecord.id, id), eq(schema.projectLienRecord.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Notice or waiver");
  return (await shapeAll(tx, [row]))[0]!;
}

async function shapeAll(tx: Database, rows: RecordRow[]): Promise<LienRecordView[]> {
  const ids = rows.map((r) => r.id);
  const documents = ids.length === 0 ? [] : await tx.select().from(schema.attachment)
    .where(and(
      eq(schema.attachment.entityType, "project_lien_record"),
      inArray(schema.attachment.entityId, ids),
      isNull(schema.attachment.deletedAt),
    ));
  const invoiceIds = rows.map((r) => r.invoiceId).filter((x): x is string => x !== null);
  const invoices = invoiceIds.length === 0 ? [] : await tx.select({ id: schema.invoice.id, number: schema.invoice.number })
    .from(schema.invoice).where(inArray(schema.invoice.id, invoiceIds));
  const numbers = new Map(invoices.map((i) => [i.id, i.number]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    condition: row.condition,
    scope: row.scope,
    title: row.title,
    partyName: row.partyName,
    onDate: row.onDate,
    throughDate: row.throughDate,
    amount: row.amount,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceId ? numbers.get(row.invoiceId) ?? null : null,
    notes: row.notes,
    documents: documents.filter((d) => d.entityId === row.id)
      .map((d) => ({ id: d.id, fileName: d.fileName, storageKey: d.storageKey })),
    createdAt: row.createdAt,
  }));
}

/**
 * Every payment the project has billed: each raised draw and each invoiced
 * application, with the invoice it became and whether anything is left
 * owing on it.
 */
async function paymentsOf(tx: Database, projectId: string): Promise<plan.PaymentForWaivers[]> {
  const draws = await tx.select({
    label: schema.projectDraw.label,
    amount: schema.projectDraw.amount,
    invoiceId: schema.projectDraw.invoiceId,
    raisedAt: schema.projectDraw.raisedAt,
  }).from(schema.projectDraw)
    .where(eq(schema.projectDraw.projectId, projectId))
    .orderBy(asc(schema.projectDraw.sequence));
  const applications = await tx.select().from(schema.projectApplication)
    .where(and(eq(schema.projectApplication.projectId, projectId), eq(schema.projectApplication.status, "invoiced")))
    .orderBy(asc(schema.projectApplication.number));

  const invoiceIds = [
    ...draws.map((d) => d.invoiceId), ...applications.map((a) => a.invoiceId),
  ].filter((x): x is string => x !== null);
  const invoices = invoiceIds.length === 0 ? [] : await tx.select({
    id: schema.invoice.id, number: schema.invoice.number, balance: schema.invoice.balance,
    issuedOn: schema.invoice.issuedOn, status: schema.invoice.status,
  }).from(schema.invoice).where(inArray(schema.invoice.id, invoiceIds));
  const byId = new Map(invoices.map((i) => [i.id, i]));

  const out: plan.PaymentForWaivers[] = [];
  for (const draw of draws) {
    const invoice = draw.invoiceId ? byId.get(draw.invoiceId) : undefined;
    if (!invoice) continue;
    out.push({
      invoiceId: invoice.id,
      label: `${draw.label}, invoice ${invoice.number}`,
      amount: m.toString(m.money(draw.amount)),
      billedOn: invoice.issuedOn,
      paid: invoice.status === "paid" || m.isZero(m.money(invoice.balance)),
    });
  }
  for (const application of applications) {
    const invoice = application.invoiceId ? byId.get(application.invoiceId) : undefined;
    if (!invoice) continue;
    out.push({
      invoiceId: invoice.id,
      label: `Application ${application.number}, invoice ${invoice.number}`,
      amount: m.toString(m.money(application.currentPaymentDue ?? "0")),
      billedOn: invoice.issuedOn,
      paid: invoice.status === "paid" || m.isZero(m.money(invoice.balance)),
    });
  }
  return out;
}

/** The records, newest first, and the checklist per payment beside them. */
export async function list(ctx: ServiceContext, input: { projectId: string }) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    const rows = await tx.select().from(schema.projectLienRecord)
      .where(eq(schema.projectLienRecord.projectId, project.id))
      .orderBy(asc(schema.projectLienRecord.onDate), asc(schema.projectLienRecord.createdAt));
    const records = await shapeAll(tx, rows);
    const checklist = plan.waiverChecklist(await paymentsOf(tx, project.id), records.map((r) => ({
      id: r.id, kind: r.kind, direction: r.direction, condition: r.condition, scope: r.scope,
      partyName: r.partyName, onDate: r.onDate, amount: r.amount, invoiceId: r.invoiceId,
    })));
    return {
      records,
      checklist: checklist.map((row) => ({
        invoiceId: row.invoiceId,
        label: row.label,
        amount: row.amount,
        billedOn: row.billedOn,
        paid: row.paid,
        conditional: row.conditional.map((r) => r.id),
        unconditional: row.unconditional.map((r) => r.id),
        notes: row.notes,
      })),
      /** Said on every read, so nobody mistakes the checklist for advice. */
      disclaimer: "These are the records on file. Which notices and waivers your state requires, and when, is not something this product decides.",
    };
  });
}

/** A record entered wrong. Removed outright, with the audit line keeping what it said. */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; deleted: true }> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const [row] = await tx.select().from(schema.projectLienRecord)
      .where(and(eq(schema.projectLienRecord.id, input.id), eq(schema.projectLienRecord.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Notice or waiver");
    await tx.delete(schema.projectLienRecord).where(eq(schema.projectLienRecord.id, row.id));
    await audit(tx, ctx, "project_lien_record.deleted", "project_lien_record", row.id, row, null);
    return { id: row.id, deleted: true as const };
  });
}

export const handlers = {
  listProjectLienRecords: (ctx: ServiceContext, input: { projectId: string }) => list(ctx, input),
  recordProjectLienRecord: (ctx: ServiceContext, input: LienRecordInput) => record(ctx, input),
  deleteProjectLienRecord: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
