import { deflateSync, inflateSync } from "node:zlib";
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import { bytesOf, HELD } from "./files";
import { schema, type Database } from "@opentradesos/db";
import { branding as brand, can, customerPortal as cp, money as m, pdf, reporting, time, work } from "@opentradesos/core";
import { contactOf, guardedRead, NotFoundError, scopeOf, timezoneOf, type ServiceContext } from "./context";
import { invoiceScopeFilter, estimateScopeFilter, jobScopeFilter } from "./scope";
import { InvalidGrantError, inGrant, peek, requireScope, type ResolvedGrant } from "./portal";
import { proposalWithin } from "./proposals";
import { settingsWithin as portalSettingsWithin } from "./portal-settings";
import { buildStatement, type Statement } from "./statements";
import type { ReportResult } from "./reports";

/**
 * THE FILES A CUSTOMER OR AN ACCOUNTANT IS HANDED
 *
 * An invoice, a proposal and a statement as PDF, for the office's screens and
 * for the customer's own links, and a report as PDF for the email a schedule
 * sends. The layouts are `pdf` in core; this file reads what they print.
 *
 * ONE READER PER DOCUMENT, FOR BOTH SIDES. The office's copy and the
 * customer's copy of an invoice come from `invoiceDocWithin`, run inside the
 * office's guarded read or inside the customer's grant. Two readers would be
 * two places to decide what a customer may see, and the second would be the
 * one that printed the cost column.
 *
 * WHAT A CUSTOMER MAY SEE IS DECIDED BY WHAT IS SELECTED. The document is
 * built field by field from customer facing columns, exactly as the portal's
 * invoice page is, so a column added to the invoice table tomorrow cannot
 * reach a printed page because somebody forgot to delete it.
 *
 * Streams are compressed with zlib. A thousand row report is a few hundred
 * kilobytes written plain and a few dozen compressed, and an email carries
 * the second.
 */

export interface PdfFile {
  filename: string;
  bytes: Uint8Array;
}

export const RENDER: pdf.RenderOptions = {
  deflate: (bytes) => new Uint8Array(deflateSync(bytes)),
};

/** What a logo with transparency is decoded and compressed again with. */
const CODECS: pdf.ImageCodecs = {
  inflate: (bytes) => new Uint8Array(inflateSync(bytes)),
  deflate: (bytes) => new Uint8Array(deflateSync(bytes)),
};

/**
 * The company's logo as a page draws it, or null for none or one a PDF cannot
 * carry (a WebP kept from before the settings screen turned them into PNGs, a
 * GIF, an ICO; an SVG is never kept): the documents then print the name alone,
 * as before there was a logo, rather than refusing to print.
 */
export async function logoOf(tx: Database): Promise<pdf.PdfImage | null> {
  const [found] = await tx.select({ bytes: schema.brandAsset.bytes })
    .from(schema.brandAsset).where(eq(schema.brandAsset.kind, "logo")).limit(1);
  return found ? pdf.readImage(new Uint8Array(found.bytes), CODECS) : null;
}

/**
 * Whether the estimate and invoice PDFs can print the logo kept now, for the
 * settings screen to say so when they cannot (a WebP uploaded through the
 * API, or before the screen turned one into a PNG). True with no logo:
 * there is nothing being left off.
 */
export async function logoPrints(ctx: ServiceContext): Promise<boolean> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const [found] = await tx.select({ id: schema.brandAsset.id })
      .from(schema.brandAsset).where(eq(schema.brandAsset.kind, "logo")).limit(1);
    return !found || (await logoOf(tx)) !== null;
  });
}

/**
 * The company as a document's header prints it: the name, the colour, and
 * the lines a customer needs to reach it, which every document had to leave
 * out while the company record had no phone, email or address.
 */
export async function companyOf(tx: Database, organizationId: string): Promise<pdf.Company> {
  const [org] = await tx.select({ name: schema.organization.name, color: schema.organization.brandColor })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return {
    name: org?.name ?? "",
    color: org?.color ? brand.parseColor(org.color) : null,
    contact: brand.contactLines(await contactOf(tx, organizationId)),
    logo: await logoOf(tx),
  };
}

/* ------------------------------------------------------------- invoice */

/**
 * An invoice as its PDF prints it, inside a transaction already in the
 * tenant. `customerId` narrows it to an invoice that customer is billed or
 * pays, for the customer's account link; a draft is never a customer's.
 */
export async function invoiceDocWithin(
  tx: Database,
  organizationId: string,
  invoiceId: string,
  options: {
    customerId?: string | undefined;
    customerFacing?: boolean | undefined;
    /** The office reader's invoice scope, so a technician's PDF is of their own work only. */
    scope?: SQL | undefined;
  } = {},
): Promise<pdf.InvoicePdfInput> {
  const [invoice] = await tx.select({
    number: schema.invoice.number,
    numberPrefix: schema.invoice.numberPrefix,
    status: schema.invoice.status,
    issuedOn: schema.invoice.issuedOn,
    dueOn: schema.invoice.dueOn,
    currency: schema.invoice.currency,
    subtotal: schema.invoice.subtotal,
    discountTotal: schema.invoice.discountTotal,
    taxTotal: schema.invoice.taxTotal,
    total: schema.invoice.total,
    amountPaid: schema.invoice.amountPaid,
    balance: schema.invoice.balance,
    propertyId: schema.invoice.propertyId,
    customerId: schema.invoice.customerId,
    payerCustomerId: schema.invoice.payerCustomerId,
  })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.id, invoiceId),
      isNull(schema.invoice.deletedAt),
      ...(options.customerId ? [or(
        eq(schema.invoice.customerId, options.customerId),
        eq(schema.invoice.payerCustomerId, options.customerId),
      )] : []),
      ...(options.customerFacing ? [ne(schema.invoice.status, "draft")] : []),
      options.scope,
    ))
    .limit(1);
  if (!invoice) throw new NotFoundError("Invoice");

  const names = new Map((await tx.select({ id: schema.customer.id, name: schema.customer.name })
    .from(schema.customer)
    .where(or(
      eq(schema.customer.id, invoice.customerId),
      ...(invoice.payerCustomerId ? [eq(schema.customer.id, invoice.payerCustomerId)] : []),
    ))).map((c) => [c.id, c.name] as const));

  const lines = await tx.select({
    name: schema.invoiceLine.name,
    description: schema.invoiceLine.description,
    quantity: schema.invoiceLine.quantity,
    unitPrice: schema.invoiceLine.unitPrice,
    lineTotal: schema.invoiceLine.lineTotal,
  })
    .from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLine.sortOrder));

  let propertyAddress = "";
  if (invoice.propertyId) {
    const [property] = await tx.select({
      line1: schema.property.addressLine1, line2: schema.property.addressLine2,
      city: schema.property.city, state: schema.property.state, postalCode: schema.property.postalCode,
    }).from(schema.property).where(eq(schema.property.id, invoice.propertyId)).limit(1);
    propertyAddress = property
      ? [property.line1, property.line2, `${property.city}, ${property.state} ${property.postalCode}`]
          .filter(Boolean).join(", ")
      : "";
  }

  /**
   * Netted per payment, the rule the portal's invoice page follows: a refund
   * is a negative allocation beside the original, which is right for the
   * books and wrong on paper, where it reads as two payments.
   */
  const applied = await tx.select({
    paymentId: schema.paymentAllocation.paymentId,
    amount: schema.paymentAllocation.amount,
    receivedAt: schema.payment.receivedAt,
    method: schema.payment.method,
  })
    .from(schema.paymentAllocation)
    .innerJoin(schema.payment, eq(schema.payment.id, schema.paymentAllocation.paymentId))
    .where(eq(schema.paymentAllocation.invoiceId, invoiceId))
    .orderBy(asc(schema.payment.receivedAt), asc(schema.paymentAllocation.createdAt));
  const byPayment = new Map<string, { receivedAt: string; method: string; net: m.Money }>();
  for (const row of applied) {
    const seen = byPayment.get(row.paymentId);
    const amount = m.money(row.amount, invoice.currency);
    if (seen) seen.net = m.add(seen.net, amount);
    else byPayment.set(row.paymentId, { receivedAt: row.receivedAt.toISOString(), method: row.method, net: amount });
  }

  const owing = (invoice.status === "open" || invoice.status === "partially_paid")
    && m.isPositive(m.money(invoice.balance, invoice.currency));

  return {
    company: await companyOf(tx, organizationId),
    number: invoice.number,
    numberPrefix: invoice.numberPrefix,
    status: invoice.status,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    currency: invoice.currency,
    customerName: names.get(invoice.customerId) ?? "",
    payerName: invoice.payerCustomerId ? names.get(invoice.payerCustomerId) ?? null : null,
    propertyAddress,
    lines,
    subtotal: invoice.subtotal,
    discountTotal: invoice.discountTotal,
    taxTotal: invoice.taxTotal,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    balance: invoice.balance,
    payments: [...byPayment.values()]
      .filter((p) => m.isPositive(p.net))
      .map((p) => ({ receivedAt: p.receivedAt, method: p.method, amount: m.toString(p.net) })),
    note: owing
      ? "To pay, use the link in the email this invoice came with, or call us. Reply to that email if anything here looks wrong."
      : null,
    generatedAt: new Date(),
  };
}

const invoiceFile = (doc: pdf.InvoicePdfInput): PdfFile => ({
  filename: `invoice-${work.documentNumber(doc.numberPrefix, doc.number)}.pdf`,
  bytes: pdf.invoicePdf(doc, RENDER),
});

/**
 * The customer's copy of an invoice, inside a transaction already in the
 * tenant: what the invoice email attaches. Never a draft, as their link is not.
 */
export async function invoiceFileWithin(tx: Database, organizationId: string, invoiceId: string): Promise<PdfFile> {
  return invoiceFile(await invoiceDocWithin(tx, organizationId, invoiceId, { customerFacing: true }));
}

/**
 * The office's copy, under the same permission as reading the invoice and the
 * same scope as the invoice list: a technician who sees invoices on their own
 * work gets a PDF of those and a not found for the rest.
 */
export function invoicePdf(ctx: ServiceContext, input: { id: string }): Promise<PdfFile> {
  return guardedRead(ctx, "invoice:read", async (tx) =>
    invoiceFile(await invoiceDocWithin(tx, ctx.actor.organizationId, input.id, {
      scope: invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor),
    })));
}

/**
 * The customer's copy, from the invoice link in their email. Peeked, not
 * spent, for the reason the invoice page gives: saving the file is reading it.
 */
export async function invoicePdfForToken(db: Database, input: { token: string }): Promise<PdfFile> {
  const grant = await peek(db, input.token);
  const invoiceId = requireScope(grant, "invoice");
  return inGrant(db, grant, async (tx) =>
    invoiceFile(await invoiceDocWithin(tx, grant.organizationId, invoiceId, { customerFacing: true })));
}

function customerOf(grant: ResolvedGrant): string {
  if (grant.scope !== "customer" || !grant.customerId) throw new InvalidGrantError();
  return grant.customerId;
}

/**
 * An invoice from the customer's whole account link (or their sign in, which
 * carries the same kind of grant): one they are billed or pay, and never a
 * draft, which is the office's work in progress.
 */
export async function invoicePdfForAccount(db: Database, input: { token: string; invoiceId: string }): Promise<PdfFile> {
  const grant = await peek(db, input.token);
  const customerId = customerOf(grant);
  return inGrant(db, grant, async (tx) =>
    invoiceFile(await invoiceDocWithin(tx, grant.organizationId, input.invoiceId, { customerId, customerFacing: true })));
}

/* ---------------------------------------------------------- work order */

/** A moment in the company's own clock, in words: "Tue, Oct 6, 9:00 AM". */
function momentIn(at: Date, zone: string, withZone = false): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone,
    ...(withZone ? { timeZoneName: "short" as const } : {}),
  }).format(at);
}

/** A visit's window in words, the second end without its day when it is the same day. */
function windowIn(start: Date | null, end: Date | null, zone: string): string {
  if (!start) return "Not booked for a time yet";
  if (!end) return momentIn(start, zone, true);
  const sameDay = time.dateIn(start, zone) === time.dateIn(end, zone);
  const until = sameDay
    ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" }).format(end)
    : momentIn(end, zone, true);
  return `${momentIn(start, zone)} to ${until}`;
}

/** The most photographs one work order prints, and the most picture bytes it reads, so a job with a hundred phone photographs is still a file somebody can print and email. */
export const WORK_ORDER_MAX_PHOTOS = 24;
export const WORK_ORDER_MAX_PHOTO_BYTES = 40 * 1024 * 1024;

/**
 * What the phone took on a job, ready to print under the visit it was taken at.
 *
 * A PHOTOGRAPH IS READ ONLY BY SOMEBODY WHO MAY OPEN ONE. The file route
 * (`/files/...`) needs `document:read` on top of whatever reads the job, so
 * the work order does too: a role that can read a job and not its documents
 * is told photographs are not shown to it, never handed the pictures through a
 * side door. The job's own scope has already narrowed which job this is.
 *
 * THE OFFICE COPY IS THE ONE HANDED TO THE CUSTOMER, so it prints what the
 * customer's own job link would show them (`photoShown`: the ones somebody
 * chose to share, or every one when the company shows them all), because a
 * technician photographs a panel with the alarm code written on it as readily
 * as a finished install. The technician's copy stays with the company and
 * prints every photograph the company holds, bar what the customer sent in.
 * The signature drawn on the phone is the customer's own and is on both.
 *
 * Only pictures this file can carry are drawn. One it cannot (a HEIC straight
 * off a phone) is said in a line under its visit rather than dropped, and the
 * count and size are capped, said in a note when they bite.
 */
async function phonePictures(
  tx: Database, ctx: ServiceContext, input: { jobId: string; visitIds: string[]; forTechnician: boolean; zone: string },
): Promise<{
  photos: Map<string, pdf.WorkOrderPicture[]>;
  signatures: Map<string, pdf.WorkOrderPicture>;
  jobPhotos: pdf.WorkOrderPicture[];
  note: string | null;
}> {
  const out = {
    photos: new Map<string, pdf.WorkOrderPicture[]>(),
    signatures: new Map<string, pdf.WorkOrderPicture>(),
    jobPhotos: [] as pdf.WorkOrderPicture[],
    note: null as string | null,
  };
  const rows = await tx.select().from(schema.attachment)
    .where(and(
      eq(schema.attachment.organizationId, ctx.actor.organizationId),
      isNull(schema.attachment.deletedAt),
      inArray(schema.attachment.kind, ["photo", "signature"]),
      or(
        and(eq(schema.attachment.entityType, "job"), eq(schema.attachment.entityId, input.jobId)),
        input.visitIds.length > 0
          ? and(eq(schema.attachment.entityType, "visit"), inArray(schema.attachment.entityId, input.visitIds))
          : undefined,
      ),
    ))
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
  const pictures = rows.filter((row) => row.contentType?.startsWith("image/"));
  if (pictures.length === 0) return out;

  if (!can(ctx.actor, "document:read")) {
    out.note = "Photographs and signatures taken on the phone are not shown to your role.";
    return out;
  }

  const settings = await portalSettingsWithin(tx, ctx.actor.organizationId);
  const shown = pictures.filter((row) => row.kind === "signature" || input.forTechnician
    || cp.photoShown(settings.jobPhotos, { kind: row.kind, sharedAt: row.sharedWithCustomerAt }));
  const heldBack = pictures.filter((row) => row.kind === "photo").length - shown.filter((row) => row.kind === "photo").length;

  /** The latest signature per visit is the one that counts: a customer who signed again meant the second. */
  const lastSignature = new Map<string, typeof shown[number]>();
  for (const row of shown) if (row.kind === "signature" && row.entityType === "visit") lastSignature.set(row.entityId, row);
  const wanted = shown.filter((row) => row.kind === "photo" || lastSignature.get(row.entityId)?.id === row.id);

  const files = await tx.select({ key: schema.storedFile.storageKey, ...HELD }).from(schema.storedFile)
    .where(and(
      inArray(schema.storedFile.storageKey, [...new Set(wanted.map((row) => row.storageKey))]),
      isNull(schema.storedFile.deletedAt),
    ));
  const held = new Map(files.map((file) => [file.key, file]));

  let photoCount = 0;
  let bytesRead = 0;
  let leftOut = 0;
  for (const row of wanted) {
    const isSignature = row.kind === "signature";
    if (!isSignature && (photoCount >= WORK_ORDER_MAX_PHOTOS || bytesRead >= WORK_ORDER_MAX_PHOTO_BYTES)) { leftOut += 1; continue; }
    const file = held.get(row.storageKey);
    if (!file) continue;
    const bytes = new Uint8Array(await bytesOf(file));
    if (!isSignature) { photoCount += 1; bytesRead += bytes.length; }
    const when = momentIn(row.createdAt, input.zone, true);
    const picture: pdf.WorkOrderPicture = {
      image: pdf.readImage(bytes, CODECS),
      caption: isSignature
        ? `Customer signed ${when}`
        : `${row.phase ? row.phase[0]!.toUpperCase() + row.phase.slice(1) : "Photograph"}, ${when}`,
    };
    if (isSignature) out.signatures.set(row.entityId, picture);
    else if (row.entityType === "visit") out.photos.set(row.entityId, [...(out.photos.get(row.entityId) ?? []), picture]);
    else out.jobPhotos.push(picture);
  }

  const notes: string[] = [];
  if (heldBack > 0) {
    notes.push(`${heldBack === 1 ? "One photograph is" : `${heldBack} photographs are`} not printed on this copy because ${heldBack === 1 ? "it is" : "they are"} not marked to show the customer. The technician's copy has ${heldBack === 1 ? "it" : "them"}.`);
  }
  if (leftOut > 0) {
    notes.push(`${leftOut === 1 ? "One more photograph is" : `${leftOut} more photographs are`} on the job's page and not printed here.`);
  }
  out.note = notes.length > 0 ? notes.join(" ") : null;
  return out;
}

/**
 * A job as its work order prints it, for somebody who may read the job: the
 * same `job:read` and the same scope as the job page, so a technician who sees
 * only their own work gets a work order for that and a not found for the rest.
 *
 * `forTechnician` is the copy that goes in the van: no prices, read without
 * them rather than printed and hidden, so there is nothing to leave out at
 * the last step. No copy has a cost (what a part cost the company), the
 * gate code, or the technician's own notes: the office copy is the one
 * handed to a customer to sign, and the technician has the gate code and
 * their notes on their phone.
 *
 * Under each visit it also prints the photographs and the customer's
 * signature taken on the phone, chosen by `phonePictures`.
 */
export function workOrderPdf(
  ctx: ServiceContext, input: { id: string; forTechnician?: boolean | undefined },
): Promise<PdfFile> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select({
      number: schema.job.number,
      numberPrefix: schema.job.numberPrefix,
      status: schema.job.status,
      summary: schema.job.summary,
      description: schema.job.description,
      customerComplaint: schema.job.customerComplaint,
      customerId: schema.job.customerId,
      propertyId: schema.job.propertyId,
      jobTypeId: schema.job.jobTypeId,
      businessUnitId: schema.job.businessUnitId,
    }).from(schema.job).where(and(
      eq(schema.job.id, input.id),
      isNull(schema.job.deletedAt),
      jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
    )).limit(1);
    if (!job) throw new NotFoundError("Job");

    const organizationId = ctx.actor.organizationId;
    const zone = await timezoneOf(tx, organizationId);
    const prices = !input.forTechnician;

    const [customer] = await tx.select({ name: schema.customer.name, phone: schema.customer.phone })
      .from(schema.customer).where(eq(schema.customer.id, job.customerId)).limit(1);
    const [property] = await tx.select({
      line1: schema.property.addressLine1, line2: schema.property.addressLine2,
      city: schema.property.city, state: schema.property.state, postalCode: schema.property.postalCode,
      accessNotes: schema.property.accessNotes, hazardNotes: schema.property.hazardNotes,
    }).from(schema.property).where(eq(schema.property.id, job.propertyId)).limit(1);
    const [branch] = job.businessUnitId
      ? await tx.select({ name: schema.businessUnit.name, code: schema.businessUnit.code })
        .from(schema.businessUnit).where(eq(schema.businessUnit.id, job.businessUnitId)).limit(1)
      : [];
    const [jobType] = job.jobTypeId
      ? await tx.select({ name: schema.jobType.name }).from(schema.jobType)
        .where(eq(schema.jobType.id, job.jobTypeId)).limit(1)
      : [];

    /** A cancelled visit is not work anybody is going to; the rest, in order. */
    const visits = await tx.select({
      id: schema.visit.id, status: schema.visit.status,
      windowStart: schema.visit.windowStart, windowEnd: schema.visit.windowEnd,
      arrivedAt: schema.visit.arrivedAt, completedAt: schema.visit.completedAt,
      checklist: schema.visit.checklist,
    }).from(schema.visit)
      .where(and(eq(schema.visit.jobId, input.id), ne(schema.visit.status, "cancelled")))
      .orderBy(asc(schema.visit.sequence), asc(schema.visit.windowStart));
    const assigned = visits.length === 0 ? [] : await tx.select({
      visitId: schema.visitAssignment.visitId, isLead: schema.visitAssignment.isLead,
      name: schema.technician.displayName,
    }).from(schema.visitAssignment)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(inArray(schema.visitAssignment.visitId, visits.map((v) => v.id)));

    const lines = await tx.select({
      name: schema.jobLine.name, description: schema.jobLine.description, kind: schema.jobLine.kind,
      quantity: schema.jobLine.quantity, unitPrice: schema.jobLine.unitPrice,
      nonBillableReason: schema.jobLine.nonBillableReason,
    }).from(schema.jobLine).where(eq(schema.jobLine.jobId, input.id))
      .orderBy(asc(schema.jobLine.occurredAt), asc(schema.jobLine.createdAt));

    const [org] = await tx.select({ currency: schema.organization.currency })
      .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
    const currency = org?.currency ?? "USD";
    const phone = await phonePictures(tx, ctx, {
      jobId: input.id, visitIds: visits.map((v) => v.id), forTechnician: Boolean(input.forTechnician), zone,
    });
    const doc: pdf.WorkOrderPdfInput = {
      company: await companyOf(tx, organizationId),
      number: job.number,
      numberPrefix: job.numberPrefix,
      status: job.status,
      branch: branch ?? null,
      jobType: jobType?.name ?? null,
      summary: job.summary,
      description: job.description,
      customerComplaint: job.customerComplaint,
      customerName: customer?.name ?? "",
      customerPhone: customer?.phone ?? null,
      propertyAddress: property
        ? [property.line1, property.line2, `${property.city}, ${property.state} ${property.postalCode}`].filter(Boolean).join(", ")
        : "",
      accessNotes: property?.accessNotes ?? null,
      hazardNotes: property?.hazardNotes ?? null,
      visits: visits.map((visit) => ({
        when: windowIn(visit.windowStart, visit.windowEnd, zone),
        status: visit.status,
        /** The lead first, as the board lists them. */
        technicians: assigned.filter((a) => a.visitId === visit.id)
          .sort((a, b) => Number(b.isLead) - Number(a.isLead)).map((a) => a.name),
        arrived: visit.arrivedAt ? momentIn(visit.arrivedAt, zone) : null,
        completed: visit.completedAt ? momentIn(visit.completedAt, zone) : null,
        checklist: visit.checklist.map((item) => ({ label: item.label, required: item.required, done: item.doneAt !== null })),
        photos: phone.photos.get(visit.id) ?? [],
        signature: phone.signatures.get(visit.id) ?? null,
      })),
      jobPhotos: phone.jobPhotos,
      photoNote: phone.note,
      parts: lines.map((line) => ({
        name: line.name,
        description: line.description,
        kind: line.kind,
        quantity: line.quantity,
        unitPrice: prices ? line.unitPrice : null,
        lineTotal: prices
          ? m.toString(m.multiply(m.money(line.unitPrice, currency), line.quantity))
          : null,
        noCharge: line.nonBillableReason,
      })),
      prices,
      currency,
      copy: input.forTechnician ? "Printed for the technician" : "Office copy",
      generatedAt: new Date(),
    };
    const number = work.documentNumber(job.numberPrefix, job.number);
    return {
      filename: `work-order-${number}${input.forTechnician ? "-technician" : ""}.pdf`,
      bytes: pdf.workOrderPdf(doc, RENDER),
    };
  });
}

/* ------------------------------------------------------------ proposal */

/**
 * The proposal as a file, in the layout its page draws: the cover, the
 * sections in the company's order, the reviews they show and each option's
 * photographs. A photograph is read from the company's own store; one the
 * PDF cannot print (a sixteen bit or interlaced PNG, a HEIC) is said in a line
 * rather than dropped.
 */
async function proposalFile(tx: Database, doc: Awaited<ReturnType<typeof proposalWithin>>): Promise<PdfFile> {
  const keys = [
    ...(doc.layout.cover?.photoKey ? [doc.layout.cover.photoKey] : []),
    ...Object.values(doc.layout.optionPhotos).flat().map((photo) => photo.storageKey),
  ];
  const images = new Map<string, pdf.PdfImage | null>();
  if (keys.length > 0) {
    const files = await tx.select({ key: schema.storedFile.storageKey, ...HELD })
      .from(schema.storedFile)
      .where(and(inArray(schema.storedFile.storageKey, [...new Set(keys)]), isNull(schema.storedFile.deletedAt)));
    for (const file of files) images.set(file.key, pdf.readImage(new Uint8Array(await bytesOf(file)), CODECS));
  }
  const coverKey = doc.layout.cover?.photoKey ?? null;
  return {
    filename: `proposal-${doc.number}.pdf`,
    bytes: pdf.proposalPdf({
      ...doc,
      company: {
        name: doc.company.name, color: doc.company.color, contact: brand.contactLines(doc.company.contact),
        logo: await logoOf(tx),
      },
      options: doc.options.map((option) => ({
        ...option,
        photos: (doc.layout.optionPhotos[option.id] ?? []).map((photo) => images.get(photo.storageKey) ?? null),
      })),
      layout: {
        cover: doc.layout.cover ? {
          headline: doc.layout.cover.headline,
          intro: doc.layout.cover.intro,
          photo: coverKey ? images.get(coverKey) ?? null : null,
          photoUnprintable: coverKey !== null && !images.get(coverKey),
        } : null,
        sections: doc.layout.sections.map((section) => ({
          kind: section.kind,
          title: section.title,
          body: section.body,
          ...(section.reviews ? { reviews: section.reviews } : {}),
        })),
      },
      generatedAt: new Date(),
    }, RENDER),
  };
}

/** The proposal the office prints at `/estimates/{id}/proposal`, as a file. */
export function proposalPdf(ctx: ServiceContext, input: { id: string }): Promise<PdfFile> {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    /** In scope, as the estimate list is: out of it reads as not found. */
    const [visible] = await tx.select({ id: schema.estimate.id }).from(schema.estimate)
      .where(and(eq(schema.estimate.id, input.id), estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor)))
      .limit(1);
    if (!visible) throw new NotFoundError("Estimate");
    return proposalFile(tx, await proposalWithin(tx, ctx, input.id));
  });
}

/** The customer's copy, from their estimate link, peeked like the page. */
export async function proposalPdfForToken(db: Database, input: { token: string }): Promise<PdfFile> {
  const grant = await peek(db, input.token);
  const estimateId = requireScope(grant, "estimate");
  return inGrant(db, grant, async (tx, ctx) => proposalFile(tx, await proposalWithin(tx, ctx, estimateId)));
}

/**
 * A signed estimate from the customer's account link or sign in: one of their
 * own that they approved (approved, or since converted to a job), as the
 * proposal prints it with who approved it and when. An estimate still waiting,
 * declined or expired is not a signed copy, and another customer's is the same
 * not found as one that does not exist.
 */
export async function proposalPdfForAccount(db: Database, input: { token: string; estimateId: string }): Promise<PdfFile> {
  const grant = await peek(db, input.token);
  const customerId = customerOf(grant);
  return inGrant(db, grant, async (tx, ctx) => {
    const [signed] = await tx.select({ id: schema.estimate.id }).from(schema.estimate)
      .where(and(
        eq(schema.estimate.id, input.estimateId),
        eq(schema.estimate.customerId, customerId),
        inArray(schema.estimate.status, ["approved", "converted"]),
        isNotNull(schema.estimate.decidedAt),
      )).limit(1);
    if (!signed) throw new NotFoundError("Estimate");
    return proposalFile(tx, await proposalWithin(tx, ctx, signed.id));
  });
}

/* ----------------------------------------------------------- statement */

/** A statement as its PDF prints it. Exported for the statement email, which already holds one. */
export async function statementFileWithin(
  tx: Database, organizationId: string, statement: Statement,
): Promise<PdfFile> {
  const zone = await timezoneOf(tx, organizationId);
  const company = await companyOf(tx, organizationId);
  const safeName = statement.customerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "customer";
  return {
    filename: `statement-${safeName}-${statement.from}-to-${statement.to}.pdf`,
    bytes: pdf.statementPdf({
      ...statement,
      company: { ...company, name: company.name || statement.organizationName },
      asOf: time.dateIn(new Date(), zone),
      generatedAt: new Date(),
    }, RENDER),
  };
}

export function statementPdf(
  ctx: ServiceContext, input: { id: string; from?: string | undefined; to?: string | undefined },
): Promise<PdfFile> {
  return guardedRead(ctx, "invoice:read", async (tx) => statementFileWithin(
    tx, ctx.actor.organizationId,
    await buildStatement(tx, ctx.actor.organizationId, input.id, input),
  ));
}

/** The customer's own statement, from their account link or their sign in. */
export async function statementPdfForToken(
  db: Database, input: { token: string; from?: string | undefined; to?: string | undefined },
): Promise<PdfFile> {
  const grant = await peek(db, input.token);
  const customerId = customerOf(grant);
  return inGrant(db, grant, async (tx) => statementFileWithin(
    tx, grant.organizationId,
    await buildStatement(tx, grant.organizationId, customerId, input),
  ));
}

/* -------------------------------------------------------------- report */

/**
 * A report run as a PDF, with the chart the screen would draw.
 *
 * The chart is decided by `chartFor` from the run's own columns and rows,
 * the same call the report screen and the print view make, with the same
 * rule for which measures may be added up across a second grouping. So the
 * picture in the attachment cannot differ from the one on the screen.
 */
export function reportFile(input: {
  company: pdf.Company;
  name: string;
  question: string | null;
  period: string;
  ranAs: string | null;
  result: ReportResult;
  /** The measures that may be summed across a grouping the chart folds away. */
  additive: reporting.Additivity;
  filename: string;
}): PdfFile {
  const decision = reporting.chartFor(input.result, { additive: input.additive });
  return {
    filename: input.filename,
    bytes: pdf.reportPdf({
      company: input.company,
      name: input.name,
      question: input.question,
      period: input.period,
      ranAs: input.ranAs,
      columns: input.result.columns,
      rows: input.result.rows,
      truncated: input.result.truncated,
      chart: decision.ok ? decision.plan : null,
      chartNote: decision.ok ? null : decision.reason,
      generatedAt: new Date(),
    }, RENDER),
  };
}
