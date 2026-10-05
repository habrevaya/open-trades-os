import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, type Database } from "@opentradesos/db";
import { can, customerPortal as cp, field, money as m, time } from "@opentradesos/core";
import type { z } from "zod";
import { audit, guardedRead, timezoneOf, type ServiceContext } from "./context";
import * as estimates from "./estimates";
import * as billing from "./billing";
import * as tasks from "./tasks";
import * as tips from "./tips";
import * as financing from "./financing";
import { settingsWithin as portalSettingsWithin } from "./portal-settings";
import { excludedItemsWithin, memberPricingWithin } from "./agreements";
import { settingWithin as agentSettingWithin } from "./agents";
import { createEstimate } from "../contracts/estimates";
import { createInvoice } from "../contracts/billing";
import type { VisitForField } from "../contracts/field";

/**
 * SELLING AND CLOSING ON SITE
 *
 * What the phone does at the kitchen table, as operations in the same queue
 * as everything else, so all of it works with no signal and lands when the
 * van finds one:
 *
 *   estimate.create    good, better and best built on the phone from the
 *                      price book it carries, with ids it made itself
 *   estimate.approve   the customer's choice and their signature, drawn on
 *                      the phone's glass, against the figure they were shown
 *   estimate.decline   the customer saying no, with why
 *   invoice.raise      the bill for the visit's work, or for the option they
 *                      signed for, shown to them and signed for
 *   task.claim/close   the office queue, from the phone
 *   tip.record         a cash tip the technician kept
 *
 * Each goes through the service the office uses (`estimates.createIn`,
 * `estimates.decide`, `billing.createIn`, `tasks.claim`), so a figure is
 * worked out by one set of rules wherever it was asked for. Each answers
 * with a refusal in words (returned, so the rest of the day still lands),
 * and each runs in a savepoint, so a refusal half way leaves nothing half
 * written.
 *
 * THE FIGURE THE CUSTOMER SAW IS CHECKED, NOT TRUSTED. The phone sends what
 * it showed beside the signature. The server works the figure out again from
 * the price book, the plan and the lines, and a signature over a different
 * figure is never recorded as agreement to this one: an approval is refused
 * and said, and an invoice is kept as a draft for the office with the
 * difference in words.
 */

/** A refusal said to the technician, or a conflict recorded and told to the office. */
export type Outcome = string | { conflict: string } | null;

/** The service refusals that are already a sentence for a person. */
const REFUSALS = new Set(["ConflictError", "UnprocessableError", "NotFoundError", "PeriodClosedError"]);

function said(error: unknown): string | null {
  const name = error instanceof Error ? error.name : "";
  if (REFUSALS.has(name)) return (error as Error).message;
  if (name === "PermissionError") return "Your account may not do that. Ask the office.";
  return null;
}

/** In a savepoint, with the service's own refusal said in words. Anything else is a fault and is thrown. */
async function savepoint(tx: Database, run: (sp: Database) => Promise<Outcome>): Promise<Outcome> {
  try {
    return await tx.transaction(async (sp) => run(sp as unknown as Database));
  } catch (error) {
    const sentence = said(error);
    if (sentence !== null) return sentence;
    throw error;
  }
}

/**
 * The context a service is called in for one operation, keyed by the
 * operation rather than by the request that carried it. The office's
 * services record their idempotency key as they write; a sync request's own
 * key would be recorded once for the first estimate or invoice in the batch
 * and then collide with the second, so each operation brings its own, made
 * from its client id, which is already what makes it apply once.
 */
const keyed = (ctx: ServiceContext, op: field.FieldOperation, purpose: string, db?: Database): ServiceContext =>
  ({ ...ctx, ...(db ? { db } : {}), idempotencyKey: `field-${purpose}:${op.clientId}` });

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

const money = (value: unknown): m.Money | null => {
  if (typeof value !== "string") return null;
  try {
    return m.money(value);
  } catch {
    return null;
  }
};

interface VisitFacts { id: string; jobId: string; jobNumber: number; customerId: string; propertyId: string }

async function visitFacts(tx: Database, visitId: string | null): Promise<VisitFacts | null> {
  if (!visitId) return null;
  const [row] = await tx.select({
    id: schema.visit.id, jobId: schema.visit.jobId, jobNumber: schema.job.number,
    customerId: schema.job.customerId, propertyId: schema.job.propertyId,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(eq(schema.visit.id, visitId)).limit(1);
  return row ?? null;
}

async function deviceTechnician(tx: Database, deviceId: string): Promise<string | null> {
  const [row] = await tx.select({ technicianId: schema.device.technicianId })
    .from(schema.device).where(eq(schema.device.id, deviceId)).limit(1);
  return row?.technicianId ?? null;
}

/** Whether this phone's person is on the visit. The narrow rule every on site power rests on. */
async function onVisit(tx: Database, visitId: string, technicianId: string | null): Promise<boolean> {
  if (!technicianId) return false;
  const [row] = await tx.select({ id: schema.visitAssignment.id }).from(schema.visitAssignment)
    .where(and(
      eq(schema.visitAssignment.visitId, visitId),
      eq(schema.visitAssignment.technicianId, technicianId),
    )).limit(1);
  return row !== undefined;
}

/* ------------------------------------------------------------- estimates */

/**
 * An estimate built on the phone.
 *
 * The phone sends options and lines with the ids it made and the price book
 * version each line was priced from, and nothing it may not choose: the
 * customer, the address and the job come off the visit, and every price on
 * a book line is the book's (the version the phone showed, see
 * `estimates.WrittenOnSite`). Member pricing is the server's, by the plan in
 * force on the day, exactly as the phone worked it out.
 */
export async function writeEstimate(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  if (!can(ctx.actor, "estimate:write")) return "Your account may not write estimates. Ask the office.";
  const estimateId = uuid(op.subjectId);
  if (!estimateId) return "That estimate has no id.";
  const visit = await visitFacts(tx, uuid(op.payload["visitId"]));
  if (!visit) return "That estimate is not on a visit that is here.";

  const options = Array.isArray(op.payload["options"]) ? op.payload["options"] as Array<Record<string, unknown>> : [];
  if (options.length === 0) return "That estimate has no options on it.";

  const optionIds: string[] = [];
  const lineIds: string[][] = [];
  const versionIds: Array<Array<string | null>> = [];
  const shaped = options.map((option) => {
    optionIds.push(uuid(option["id"]) ?? "");
    const lines = Array.isArray(option["lines"]) ? option["lines"] as Array<Record<string, unknown>> : [];
    lineIds.push(lines.map((line) => uuid(line["id"]) ?? ""));
    versionIds.push(lines.map((line) => uuid(line["versionId"])));
    return {
      name: option["name"],
      ...(typeof option["description"] === "string" && option["description"].trim() !== "" ? { description: option["description"] } : {}),
      isRecommended: option["isRecommended"] === true,
      lines: lines.map((line) => ({
        ...(uuid(line["priceBookItemId"]) ? { priceBookItemId: line["priceBookItemId"] } : {}),
        name: line["name"],
        ...(typeof line["description"] === "string" && line["description"].trim() !== "" ? { description: line["description"] } : {}),
        quantity: line["quantity"] ?? "1",
        unitPrice: line["unitPrice"] ?? "0",
        taxable: line["taxable"] !== false,
        isOptional: line["isOptional"] === true,
        isSelected: line["isSelected"] === true,
      })),
    };
  });
  if (optionIds.some((id) => id === "") || lineIds.some((ids) => ids.some((id) => id === ""))) {
    return "Some of that estimate has no id, so it cannot be written.";
  }

  const parsed = createEstimate.input.safeParse({
    customerId: visit.customerId,
    propertyId: visit.propertyId,
    jobId: visit.jobId,
    ...(text(op.payload["title"], 200) ? { title: text(op.payload["title"], 200) } : {}),
    taxRate: typeof op.payload["taxRate"] === "string" ? op.payload["taxRate"] : "0",
    options: shaped,
  });
  if (!parsed.success) return "Some of that estimate could not be read. Build it again.";

  return savepoint(tx, async (sp) => {
    await estimates.createIn(sp, keyed(ctx, op, "estimate", sp), parsed.data, {
      estimateId, optionIds, lineIds, versionIds, pricedAt: op.occurredAt,
    });
    return null;
  });
}

/**
 * The customer's choice and signature, taken on the phone's glass.
 *
 * WHO MAY CARRY IT. Somebody who may approve on a customer's behalf
 * (`estimate:approve`), or the technician on this visit holding
 * `estimate:present`, and then only with the customer's own name and drawn
 * signature: the yes is the customer's, and the phone is how it travelled.
 *
 * WHAT THEY SIGNED FOR. The phone sends the total it showed. The option is
 * worked out again here, with the optional lines they ticked, and a
 * signature over any other figure is refused rather than recorded as
 * agreement to this one, in a sentence that tells the technician to show it
 * again. Then it is `estimates.decide`, the same approval the customer's own
 * link makes, recorded as given in person, signed at the moment it was.
 */
export async function approveEstimate(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  const estimateId = uuid(op.subjectId);
  if (!estimateId) return "That approval names no estimate.";
  const visit = await visitFacts(tx, uuid(op.payload["visitId"]));
  if (!visit) return "That approval is not on a visit that is here.";

  const signerName = text(op.payload["signerName"], 200);
  const uploadId = text(op.payload["signatureUploadId"], 100);
  const mayApprove = can(ctx.actor, "estimate:approve");
  if (!mayApprove) {
    if (!can(ctx.actor, "estimate:present")) {
      return "Your account may not take a customer's signature on an estimate. Send them the link instead.";
    }
    if (!(await onVisit(tx, visit.id, await deviceTechnician(tx, op.deviceId)))) {
      return "That visit is not on your day, so you cannot take a signature for it.";
    }
    if (!signerName || !uploadId) return "The customer has to sign and give their name for this to count as their yes.";
  }

  const optionId = uuid(op.payload["optionId"]);
  if (!optionId) return "That approval names no option.";
  const shown = money(op.payload["shownTotal"]);
  if (!shown) return "That approval does not say what the customer was shown, so it cannot be checked.";
  const selected = Array.isArray(op.payload["selectedLineIds"])
    ? (op.payload["selectedLineIds"] as unknown[]).map(uuid).filter((x): x is string => x !== null)
    : [];

  return savepoint(tx, async (sp) => {
    const current = await estimates.loadEstimate(sp, ctx, estimateId);
    if (current.customerId !== visit.customerId) return "That estimate is for another customer.";
    const option = current.options.find((o) => o.id === optionId);
    if (!option) return "That option is not on the estimate any more.";

    const would = optionTotal(option.lines.map((line) => ({
      ...line, isSelected: line.isOptional ? selected.includes(line.id) : line.isSelected,
    })));
    if (!field.sameAmount(m.toString(would), m.toString(shown))) {
      return `The customer was shown ${m.format(m.round(shown, 2))}, and this option with what they ticked comes to `
        + `${m.format(would)}, so it was not recorded as approved. Show it to them again and have them sign again.`;
    }

    await estimates.decide(sp, keyed(ctx, op, "approval", sp), {
      estimateId,
      optionId,
      selectedLineIds: selected,
      signerName: signerName ?? "Customer",
      capturedVia: "in_person",
      signedAt: op.occurredAt,
      ...(uploadId ? { uploadId } : {}),
    });
    return null;
  });
}

/** An option's total as `estimates.recomputeOption` would make it, with nothing written. */
function optionTotal(lines: ReadonlyArray<{
  quantity: string; unitPrice: string; discountAmount: string; taxable: boolean; taxRate: string;
  isOptional: boolean; isSelected: boolean;
}>): m.Money {
  const priced = field.priceOnSite(lines.map((l) => ({
    quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount,
    // Priced already: the member's part is inside the line's discount.
    memberDiscountAmount: "0",
    taxable: l.taxable, taxRate: l.taxRate, isOptional: l.isOptional, isSelected: l.isSelected,
  })));
  return m.money(priced.totals.total);
}

/** The customer saying no on site, with their reason. The office's own decline, and its event. */
export async function declineEstimate(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  const estimateId = uuid(op.subjectId);
  if (!estimateId) return "That names no estimate.";
  if (!can(ctx.actor, "estimate:write")) return "Your account may not decline estimates. Ask the office.";
  const visit = await visitFacts(tx, uuid(op.payload["visitId"]));
  if (!visit) return "That is not on a visit that is here.";
  return savepoint(tx, async (sp) => {
    const current = await estimates.loadEstimate(sp, ctx, estimateId);
    if (current.customerId !== visit.customerId) return "That estimate is for another customer.";
    const reason = text(op.payload["reason"], 1000);
    await estimates.decline(keyed(ctx, op, "decline", sp), { id: estimateId, ...(reason ? { reason } : {}) });
    return null;
  });
}

/* --------------------------------------------------------------- invoices */

/**
 * THE INVOICE, RAISED ON SITE.
 *
 * From one of two things, chosen on the phone, and never both on one
 * invoice:
 *
 *   the option the customer signed for, copied as signed by the estimate's
 *   own conversion (discounts, tax and member pricing as applied, nothing
 *   priced again), then issued;
 *
 *   the work recorded on the job, the parts and charges not yet billed,
 *   priced by `billing.createIn`, the same rules as an invoice the office
 *   raises: the price book, the member's plan, a warranty's or a contract's
 *   share, an authorised limit.
 *
 * Never both, because an option is usually a flat price that covers the
 * parts used to do it, and adding them again bills the customer twice for
 * one capacitor. Recorded parts left out stay unbilled for the office.
 *
 * WHO. Somebody who may write invoices, or the technician on this visit
 * holding `invoice:raise_on_site`.
 *
 * WHAT THE CUSTOMER SAW. The phone's figure rides with it, and the server's
 * is compared to the cent. Equal: issued, and their signature recorded
 * against it. Different (a price changed since the phone's book, a warranty
 * the phone could not see): kept as a DRAFT for the office, never issued at
 * a figure the customer did not sign for, and the difference said.
 */
export async function raiseInvoice(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  const invoiceId = uuid(op.subjectId);
  if (!invoiceId) return "That invoice has no id.";
  const [already] = await tx.select({ id: schema.invoice.id }).from(schema.invoice)
    .where(eq(schema.invoice.id, invoiceId)).limit(1);
  if (already) return null;

  const visit = await visitFacts(tx, uuid(op.payload["visitId"]));
  if (!visit) return "That invoice is not on a visit that is here.";
  if (!can(ctx.actor, "invoice:write")) {
    if (!can(ctx.actor, "invoice:raise_on_site")) return "Your account may not raise invoices. Ask the office to raise it.";
    if (!(await onVisit(tx, visit.id, await deviceTechnician(tx, op.deviceId)))) {
      return "That visit is not on your day, so you cannot invoice it.";
    }
  }
  const shown = money(op.payload["shownTotal"]);
  if (!shown) return "That invoice does not say what the customer was shown, so it cannot be checked.";
  const signerName = text(op.payload["signerName"], 200);
  const uploadId = text(op.payload["signatureUploadId"], 100);
  const source = op.payload["source"] === "estimate" ? "estimate" : "work";

  const outcome = source === "estimate"
    ? await fromEstimate(tx, ctx, op, visit, invoiceId, shown)
    : await fromWork(tx, ctx, op, visit, invoiceId, shown);
  if (typeof outcome === "string") return outcome;

  if (signerName) {
    await signInvoice(tx, ctx, { invoiceId, signerName, uploadId, signedAt: op.occurredAt });
  }
  return outcome;
}

async function fromEstimate(
  tx: Database, ctx: ServiceContext, op: field.FieldOperation, visit: VisitFacts, invoiceId: string, shown: m.Money,
): Promise<Outcome> {
  const estimateId = uuid(op.payload["estimateId"]);
  if (!estimateId) return "That invoice names no estimate to bill.";
  return savepoint(tx, async (sp) => {
    const [estimate] = await sp.select({
      id: schema.estimate.id, customerId: schema.estimate.customerId, jobId: schema.estimate.jobId,
      status: schema.estimate.status, number: schema.estimate.number,
    }).from(schema.estimate).where(eq(schema.estimate.id, estimateId)).limit(1);
    if (!estimate) return "That estimate is not here.";
    if (estimate.customerId !== visit.customerId) return "That estimate is for another customer.";
    if (estimate.jobId && estimate.jobId !== visit.jobId) return `Estimate ${estimate.number} is for another job.`;
    if (estimate.status === "converted") return `Estimate ${estimate.number} has already been turned into work and billed.`;
    if (estimate.status !== "approved") return `Estimate ${estimate.number} has not been approved, so there is nothing agreed to bill.`;

    /** Approved on this visit, so it is this visit's job's work. */
    if (!estimate.jobId) {
      await sp.update(schema.estimate).set({ jobId: visit.jobId, updatedAt: new Date() })
        .where(eq(schema.estimate.id, estimate.id));
    }
    await estimates.convertIn(sp, keyed(ctx, op, "invoice", sp), { id: estimate.id, createJob: false, createInvoice: true }, { invoiceId });
    const [draft] = await sp.select({ total: schema.invoice.total }).from(schema.invoice)
      .where(eq(schema.invoice.id, invoiceId)).limit(1);
    const total = m.money(draft!.total);
    if (!field.sameAmount(m.toString(total), m.toString(shown))) {
      return {
        conflict: `The customer was shown ${m.format(m.round(shown, 2))} and estimate ${estimate.number} comes to `
          + `${m.format(total)}, so the invoice was kept as a draft for the office to check before it is sent.`,
      };
    }
    await billing.issueIn(sp, keyed(ctx, op, "invoice", sp), { id: invoiceId });
    return null;
  });
}

async function fromWork(
  tx: Database, ctx: ServiceContext, op: field.FieldOperation, visit: VisitFacts, invoiceId: string, shown: m.Money,
): Promise<Outcome> {
  const asked = Array.isArray(op.payload["jobLineIds"])
    ? (op.payload["jobLineIds"] as unknown[]).map(uuid).filter((x): x is string => x !== null)
    : [];
  if (asked.length === 0) return "That invoice names no work to bill.";

  const rows = await tx.select({
    line: schema.jobLine,
    itemId: schema.priceBookItemVersion.itemId,
  }).from(schema.jobLine)
    .leftJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.jobLine.priceBookItemVersionId))
    .where(and(inArray(schema.jobLine.id, asked), eq(schema.jobLine.jobId, visit.jobId)))
    .orderBy(asc(schema.jobLine.occurredAt), asc(schema.jobLine.id));
  if (rows.length !== new Set(asked).size) return "Some of that work is not on this job any more, so the invoice was not raised.";
  const billed = rows.filter((r) => r.line.invoiceLineId !== null || r.line.nonBillableReason !== null);
  if (billed.length > 0) {
    return `${billed.map((r) => r.line.name).slice(0, 3).join(", ")} ${billed.length === 1 ? "is" : "are"} already billed `
      + "or not billable, so the invoice was not raised. Open the day with a signal and look again.";
  }

  const base = {
    customerId: visit.customerId,
    jobId: visit.jobId,
    lines: rows.map((r) => ({
      jobLineId: r.line.id,
      ...(r.itemId ? { priceBookItemId: r.itemId } : {}),
      name: r.line.name,
      ...(r.line.description ? { description: r.line.description } : {}),
      quantity: r.line.quantity,
      unitPrice: r.line.unitPrice,
      taxable: r.line.taxable,
    })),
  };
  const parsed = createInvoice.input.safeParse({ ...base, expectedTotals: { total: m.toString(shown) } });
  if (!parsed.success) return "Some of that work could not be read, so the invoice was not raised.";

  const issued = await savepoint(tx, async (sp) => {
    await billing.createIn(sp, keyed(ctx, op, "invoice", sp), parsed.data, { id: invoiceId });
    return null;
  });
  if (issued === null) return null;

  /**
   * The office's prices disagree with what the customer saw. Kept as a draft
   * with the same lines, for the office, rather than issued at a figure the
   * customer did not sign for or thrown away with the work on it.
   */
  const differs = typeof issued === "string" && /totals expected/.test(issued);
  if (!differs) return issued;
  const draft = createInvoice.input.parse({ ...base, draft: true });
  const kept = await savepoint(tx, async (sp) => {
    await billing.createIn(sp, keyed(ctx, op, "invoice", sp), draft, { id: invoiceId });
    return null;
  });
  if (kept !== null) return kept;
  const [row] = await tx.select({ total: schema.invoice.total }).from(schema.invoice)
    .where(eq(schema.invoice.id, invoiceId)).limit(1);
  return {
    conflict: `The customer was shown ${m.format(m.round(shown, 2))} and the office's prices make it `
      + `${m.format(m.money(row?.total ?? "0"))}, so the invoice was kept as a draft for the office to check before it is sent.`,
  };
}

/**
 * The customer's signature on the invoice: who, when, the drawn image's id
 * and a hash of every figure on it, the same evidence an estimate's
 * signature is.
 */
async function signInvoice(tx: Database, ctx: ServiceContext, input: {
  invoiceId: string; signerName: string; uploadId: string | null; signedAt: Date;
}): Promise<void> {
  const [invoice] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, input.invoiceId)).limit(1);
  if (!invoice) return;
  const lines = await tx.select({
    name: schema.invoiceLine.name, quantity: schema.invoiceLine.quantity, unitPrice: schema.invoiceLine.unitPrice,
    discountAmount: schema.invoiceLine.discountAmount, taxAmount: schema.invoiceLine.taxAmount,
    lineTotal: schema.invoiceLine.lineTotal,
  }).from(schema.invoiceLine).where(eq(schema.invoiceLine.invoiceId, invoice.id)).orderBy(asc(schema.invoiceLine.sortOrder));
  const documentHash = createHash("sha256").update(JSON.stringify({
    number: invoice.number, subtotal: invoice.subtotal, discountTotal: invoice.discountTotal,
    taxTotal: invoice.taxTotal, total: invoice.total, lines,
  })).digest("hex");
  await tx.insert(schema.documentSignature).values({
    organizationId: ctx.actor.organizationId,
    subject: "invoice",
    subjectId: invoice.id,
    signerName: input.signerName,
    documentHash,
    uploadId: input.uploadId,
    signedAt: input.signedAt,
  });
  await audit(tx, ctx, "invoice.signed_on_site", "invoice", invoice.id, null, {
    signerName: input.signerName, signedAt: input.signedAt.toISOString(),
  });
}

/* ---------------------------------------------------------- tips and money */

/**
 * A tip taken with a payment on site, split the way a tip from the portal is.
 *
 * Offered only when the company takes tips, and held to the portal's rules:
 * an amount in dollars and cents, never more than what is being paid. The
 * shares go to everybody on the job's visits, evenly, which is what the
 * customer was thanking.
 */
export async function tipFor(tx: Database, ctx: ServiceContext, input: { typed: unknown; paying: m.Money }): Promise<
  { ok: true; tip: m.Money } | { ok: false; reason: string }
> {
  const typed = typeof input.typed === "string" ? input.typed : "";
  if (typed.trim() === "" || /^0+(\.0+)?$/.test(typed.trim())) return { ok: true, tip: m.zero("USD") };
  const settings = await portalSettingsWithin(tx, ctx.actor.organizationId);
  if (!settings.tipping.enabled) return { ok: false, reason: "This company does not take tips with a payment. Record the payment without one." };
  const checked = cp.checkTip(typed, input.paying, settings.tipping);
  return checked.ok ? { ok: true, tip: checked.tip } : { ok: false, reason: checked.reason };
}

/** Everybody on the job's visits that were not cancelled: who a tip on this job is for. */
export async function crewOf(tx: Database, jobId: string): Promise<string[]> {
  const rows = await tx.selectDistinct({ id: schema.visitAssignment.technicianId })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .where(and(eq(schema.visit.jobId, jobId), sql`${schema.visit.status} <> 'cancelled'`));
  return rows.map((r) => r.id);
}

export async function writeTipShares(tx: Database, ctx: ServiceContext, input: {
  paymentId: string; invoiceId: string | null; jobId: string; tip: m.Money; occurredAt: Date;
}): Promise<void> {
  await tips.writeShares(tx, {
    organizationId: ctx.actor.organizationId,
    paymentId: input.paymentId,
    invoiceId: input.invoiceId,
    jobId: input.jobId,
    tip: input.tip,
    technicianIds: await crewOf(tx, input.jobId),
    occurredAt: input.occurredAt,
  });
}

/**
 * A cash tip the technician kept, for their pay statement.
 *
 * Always the phone's own person: a tip recorded on somebody else's pay is a
 * record about money nobody saw change hands. Its id is the operation's, so
 * a replay that somehow reached here writes it once.
 */
export async function recordCashTip(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  const technicianId = await deviceTechnician(tx, op.deviceId);
  if (!technicianId) return "This phone is not registered to a technician, so there is nobody to record the tip for.";
  const amount = money(op.payload["amount"]);
  if (!amount || !m.isPositive(amount)) return "A tip has to be an amount of money more than nothing.";
  if (m.compare(amount, m.money("10000")) > 0) return "That is more than a tip. Record it as a payment instead.";
  const visit = await visitFacts(tx, uuid(op.subjectId));
  const id = uuid(op.payload["tipId"]) ?? uuid(op.clientId);
  if (!id) return "That tip has no id.";
  await tx.insert(schema.cashTip).values({
    id,
    organizationId: ctx.actor.organizationId,
    technicianId,
    jobId: visit?.jobId ?? null,
    visitId: visit?.id ?? null,
    amount: m.toString(m.round(amount, 2)),
    receivedAt: op.occurredAt,
    note: text(op.payload["note"], 500),
  }).onConflictDoNothing();
  await audit(tx, ctx, "tip.cash_recorded", "cash_tip", id, null, {
    amount: m.toString(m.round(amount, 2)), technicianId, jobId: visit?.jobId ?? null,
  });
  return null;
}

/* ------------------------------------------------------------------ tasks */

/**
 * Taking a task and finishing it, from the phone, through the queue's own
 * service: claiming is conditional, so the second of two people taking the
 * same task offline is told somebody else has it, and finishing your own
 * needs only `task:read`, the rule `tasks.close` already keeps.
 */
export async function taskOperation(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<Outcome> {
  const taskId = uuid(op.subjectId);
  if (!taskId) return "That names no task.";
  return savepoint(tx, async (sp) => {
    const scoped = keyed(ctx, op, "task", sp);
    if (op.kind === "task.claim") {
      await tasks.claim(scoped, { id: taskId });
      return null;
    }
    const outcome = text(op.payload["outcome"], 2000);
    const overrideReason = text(op.payload["overrideReason"], 2000);
    await tasks.close(scoped, {
      id: taskId,
      ...(outcome ? { outcome } : {}),
      ...(overrideReason ? { overrideReason } : {}),
    });
    return null;
  });
}

/* --------------------------------------------------------------- the day */

type Sales = Pick<z.infer<typeof VisitForField>, "member" | "estimates" | "billable" | "invoices">;

/**
 * What the phone needs on each visit to sell and close: the member's plan,
 * the estimates it can present, the work still to bill and the invoices
 * already raised. Built from what a customer may see (prices, never cost or
 * margin), because the screen these feed is turned round to face them.
 * One query each for the whole day.
 */
export async function salesFor(
  tx: Database, ctx: ServiceContext,
  visits: Array<{ visitId: string; jobId: string; customerId: string; propertyId: string }>,
  on: Date,
): Promise<Map<string, Sales>> {
  const out = new Map<string, Sales>();
  if (visits.length === 0) return out;
  const day = time.dateIn(on, await timezoneOf(tx, ctx.actor.organizationId));
  const jobIds = [...new Set(visits.map((v) => v.jobId))];
  const customerIds = [...new Set(visits.map((v) => v.customerId))];

  const members = new Map<string, Sales["member"]>();
  for (const v of visits) {
    const key = `${v.customerId}:${v.propertyId}`;
    if (members.has(key)) continue;
    const found = await memberPricingWithin(tx, { customerId: v.customerId, propertyId: v.propertyId, on: day });
    members.set(key, found ? {
      planName: found.planName, rate: found.rate,
      waivesDiagnosticFee: found.waivesDiagnosticFee, waivesAfterHoursRate: found.waivesAfterHoursRate,
      /** Flattened here, because the phone carries the price book without its categories. */
      excludedItemIds: await excludedItemsWithin(tx, found.exclusions),
    } : null);
  }

  /**
   * Estimates on the visit's job, and the customer's undecided ones at this
   * address that belong to no job yet: the replacement quoted last month is
   * the one a technician is asked about at the door.
   */
  const readable = can(ctx.actor, "estimate:read");
  const estimateRows = readable ? await tx.select().from(schema.estimate)
    .where(or(
      inArray(schema.estimate.jobId, jobIds),
      and(
        inArray(schema.estimate.customerId, customerIds),
        isNull(schema.estimate.jobId),
        inArray(schema.estimate.status, ["draft", "sent", "viewed", "approved"]),
      ),
    ))
    .orderBy(desc(schema.estimate.createdAt)).limit(200) : [];
  const optionRows = estimateRows.length ? await tx.select().from(schema.estimateOption)
    .where(inArray(schema.estimateOption.estimateId, estimateRows.map((e) => e.id)))
    .orderBy(asc(schema.estimateOption.sortOrder)) : [];
  const lineRows = optionRows.length ? await tx.select().from(schema.estimateLine)
    .where(inArray(schema.estimateLine.optionId, optionRows.map((o) => o.id)))
    .orderBy(asc(schema.estimateLine.sortOrder)) : [];

  const billable = await tx.select({
    line: schema.jobLine,
    kind: schema.priceBookItem.kind,
    feeRole: schema.priceBookItem.feeRole,
    itemId: schema.priceBookItem.id,
  }).from(schema.jobLine)
    .leftJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.jobLine.priceBookItemVersionId))
    .leftJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
    .where(and(
      inArray(schema.jobLine.jobId, jobIds),
      isNull(schema.jobLine.invoiceLineId),
      isNull(schema.jobLine.nonBillableReason),
    ))
    .orderBy(asc(schema.jobLine.occurredAt), asc(schema.jobLine.id));

  const invoiceRows = can(ctx.actor, "invoice:read") ? await tx.select({
    id: schema.invoice.id, jobId: schema.invoice.jobId, number: schema.invoice.number,
    status: schema.invoice.status, total: schema.invoice.total, balance: schema.invoice.balance,
  }).from(schema.invoice)
    .where(and(inArray(schema.invoice.jobId, jobIds), sql`${schema.invoice.status} <> 'void'`))
    .orderBy(asc(schema.invoice.number)) : [];

  for (const v of visits) {
    const mine = estimateRows.filter((e) => e.jobId === v.jobId
      || (e.jobId === null && e.customerId === v.customerId && e.propertyId === v.propertyId));
    out.set(v.visitId, {
      member: members.get(`${v.customerId}:${v.propertyId}`) ?? null,
      estimates: mine.map((e) => ({
        id: e.id,
        number: e.number,
        status: e.status,
        title: e.title,
        jobId: e.jobId,
        selectedOptionId: e.selectedOptionId,
        signerName: e.signerName,
        terms: e.terms,
        options: optionRows.filter((o) => o.estimateId === e.id).map((o) => ({
          id: o.id,
          name: o.name,
          description: o.description,
          isRecommended: o.isRecommended,
          total: o.total,
          lines: lineRows.filter((l) => l.optionId === o.id).map((l) => ({
            id: l.id,
            name: l.name,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountAmount: l.discountAmount,
            memberDiscountAmount: l.memberDiscountAmount,
            taxable: l.taxable,
            taxRate: l.taxRate,
            isOptional: l.isOptional,
            isSelected: l.isSelected,
          })),
        })),
      })),
      billable: billable.filter((b) => b.line.jobId === v.jobId).map((b) => ({
        id: b.line.id,
        name: b.line.name,
        quantity: b.line.quantity,
        unitPrice: b.line.unitPrice,
        taxable: b.line.taxable,
        itemKind: b.kind ?? null,
        feeRole: b.feeRole ?? null,
        itemId: b.itemId ?? null,
      })),
      invoices: invoiceRows.filter((i) => i.jobId === v.jobId).map((i) => ({
        id: i.id, number: i.number, status: i.status, total: i.total, balance: i.balance,
      })),
    });
  }
  return out;
}

/** The office queue as the phone shows it: the person's own tasks and the ones nobody has taken. */
export async function tasksFor(tx: Database, ctx: ServiceContext) {
  if (!can(ctx.actor, "task:read")) return [];
  const rows = await tx.select({
    task: schema.task,
    checklistTotal: sql<number>`(select count(*)::int from public.task_checklist_item i where i.task_id = "task"."id")`,
    checklistDone: sql<number>`(select count(*)::int from public.task_checklist_item i where i.task_id = "task"."id" and i.done_at is not null)`,
  }).from(schema.task)
    .where(and(
      sql`${schema.task.status} in ('open', 'in_progress')`,
      or(eq(schema.task.assigneeUserId, ctx.actor.userId), isNull(schema.task.assigneeUserId)),
    ))
    .orderBy(sql`${schema.task.dueAt} asc nulls last`, desc(schema.task.priority))
    .limit(100);
  const now = Date.now();
  return rows.map(({ task, checklistTotal, checklistDone }) => ({
    id: task.id,
    title: task.title,
    body: task.body,
    priority: task.priority,
    status: task.status,
    mine: task.assigneeUserId === ctx.actor.userId,
    dueAt: task.dueAt?.toISOString() ?? null,
    overdue: task.dueAt !== null && task.dueAt.getTime() < now,
    checklistTotal: Number(checklistTotal),
    checklistDone: Number(checklistDone),
  }));
}

/**
 * What this person may do on site, so the phone offers only what the server
 * would accept, and the rest of what selling needs: whether the company takes
 * tips with a payment, whether a lender is connected, and whether the field
 * assistant is on.
 */
export async function abilitiesFor(tx: Database, ctx: ServiceContext) {
  const tipping = (await portalSettingsWithin(tx, ctx.actor.organizationId)).tipping;
  const lender = await financing.connectionWithin(tx, ctx.actor.organizationId);
  const assistant = await agentSettingWithin(tx, ctx.actor.organizationId, "field");
  return {
    writeEstimates: can(ctx.actor, "estimate:write"),
    presentEstimates: can(ctx.actor, "estimate:present") || can(ctx.actor, "estimate:approve"),
    raiseInvoices: can(ctx.actor, "invoice:raise_on_site") || can(ctx.actor, "invoice:write"),
    takePayments: can(ctx.actor, "payment:collect"),
    tasks: can(ctx.actor, "task:read"),
    tipping: { enabled: tipping.enabled, presets: tipping.presets },
    financing: lender !== null,
    assistant: assistant.enabled,
  };
}

/* ------------------------------------------------- the office's view of it */

/**
 * The customer's signature on an invoice or an estimate taken on a phone:
 * who, when, and the drawn image's storage key once it has arrived, for the
 * office's screens. The image follows the record over one bar of signal, so
 * the key is null until it has.
 */
export async function signatureOn(ctx: ServiceContext, input: { subject: "invoice" | "estimate"; subjectId: string }) {
  return guardedRead(ctx, input.subject === "invoice" ? "invoice:read" : "estimate:read", async (tx) => {
    const [signature] = await tx.select({
      signerName: schema.documentSignature.signerName,
      signedAt: schema.documentSignature.signedAt,
      uploadId: schema.documentSignature.uploadId,
    }).from(schema.documentSignature)
      .where(and(
        eq(schema.documentSignature.subject, input.subject),
        eq(schema.documentSignature.subjectId, input.subjectId),
      ))
      .orderBy(desc(schema.documentSignature.signedAt)).limit(1);
    if (!signature) return null;
    const [image] = signature.uploadId ? await tx.select({ storageKey: schema.fieldUpload.storageKey })
      .from(schema.fieldUpload).where(eq(schema.fieldUpload.clientId, signature.uploadId)).limit(1) : [];
    return {
      signerName: signature.signerName,
      signedAt: signature.signedAt.toISOString(),
      onSite: signature.uploadId !== null,
      imageKey: image?.storageKey ?? null,
    };
  });
}
