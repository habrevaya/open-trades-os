import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, rates } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { inGrant, mintGrant, peek, requireScope } from "./portal";
import { remember, replayed } from "./once";

/**
 * INVOICES FOR A PAYER WHO DOES NOT READ EMAIL
 *
 * A home warranty company or a facilities client's accounts payable does not
 * want a PDF per invoice in an inbox. It wants every invoice addressed to it
 * in one place, and frequently a file it can load into its own system. This
 * file gives it both, per payer:
 *
 *   a portal link that lists everything addressed to them or paid by them,
 *   open first, with each line and who priced it;
 *
 *   an export of their open invoices as CSV or XML, in the format their
 *   contract names, recorded against each invoice as delivered so the
 *   undelivered list stops naming invoices that went out in a file.
 *
 * WHAT THIS IS NOT. It is not EDI, cXML or a facilities network's API. There
 * is no connection to any network here: the file is handed to a person, who
 * uploads it to the payer's portal or emails it. The `cxml`, `edi` and
 * `fm_network_api` channels on `invoice_delivery` stay unused, because using
 * them for a file somebody downloaded would claim a submission that never
 * happened.
 */

export type ExportFormat = "csv" | "xml";
export const FORMATS: readonly ExportFormat[] = ["csv", "xml"];

/** Invoices this payer owes or has paid: addressed to them, or naming them as payer. */
const payerIs = (customerId: string) =>
  sql`coalesce(${schema.invoice.payerCustomerId}, ${schema.invoice.customerId}) = ${customerId}`;

interface ExportInvoice {
  id: string;
  number: number;
  issuedOn: string | null;
  dueOn: string | null;
  purchaseOrderNumber: string | null;
  jobNumber: number | null;
  customerName: string;
  siteAddress: string;
  claimReference: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  status: string;
  lines: Array<{
    name: string; description: string | null; quantity: string; unitPrice: string;
    discountAmount: string; lineTotal: string; priceAuthority: string | null; priceNote: string | null;
  }>;
}

async function invoicesFor(
  tx: Database, customerId: string, options: { openOnly: boolean },
): Promise<ExportInvoice[]> {
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const rows = await tx.select({
    invoice: schema.invoice,
    customerName: schema.customer.name,
    jobNumber: schema.job.number,
    line1: schema.property.addressLine1,
    city: schema.property.city,
    state: schema.property.state,
    claimReference: schema.coverageClaim.externalReference,
  }).from(schema.invoice)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
    .leftJoin(schema.job, eq(schema.job.id, schema.invoice.jobId))
    .leftJoin(schema.property, eq(schema.property.id, schema.invoice.propertyId))
    .leftJoin(schema.coverageClaim, eq(schema.coverageClaim.invoiceId, schema.invoice.id))
    .where(and(
      payerIs(customerId),
      isNull(schema.invoice.deletedAt),
      options.openOnly
        ? inArray(schema.invoice.status, ["open", "partially_paid"])
        : or(
            inArray(schema.invoice.status, ["open", "partially_paid"]),
            and(eq(schema.invoice.status, "paid"), gte(schema.invoice.issuedOn, since)),
          ),
    ))
    .orderBy(asc(schema.invoice.dueOn), asc(schema.invoice.number));

  const ids = rows.map((r) => r.invoice.id);
  const lines = ids.length === 0 ? [] : await tx.select().from(schema.invoiceLine)
    .where(inArray(schema.invoiceLine.invoiceId, ids))
    .orderBy(asc(schema.invoiceLine.sortOrder));

  return rows.map((row) => ({
    id: row.invoice.id,
    number: row.invoice.number,
    issuedOn: row.invoice.issuedOn,
    dueOn: row.invoice.dueOn,
    purchaseOrderNumber: row.invoice.purchaseOrderNumber,
    jobNumber: row.jobNumber,
    customerName: row.customerName,
    siteAddress: [row.line1, row.city, row.state].filter(Boolean).join(", "),
    claimReference: row.claimReference,
    subtotal: row.invoice.subtotal,
    discountTotal: row.invoice.discountTotal,
    taxTotal: row.invoice.taxTotal,
    total: row.invoice.total,
    amountPaid: row.invoice.amountPaid,
    balance: row.invoice.balance,
    status: row.invoice.status,
    /**
     * Built field by field rather than passed through, so our cost on a line
     * is never in a file or on a page a payer can read.
     */
    lines: lines.filter((l) => l.invoiceId === row.invoice.id).map((l) => ({
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount,
      lineTotal: l.lineTotal,
      priceAuthority: l.priceAuthority,
      priceNote: l.priceNote,
    })),
  }));
}

/* ------------------------------------------------------------- the file */

const amount = (value: string) => m.edit(m.round(m.money(value, "USD"), 2));
const quantity = (value: string) => m.toString(m.money(value, "USD")).replace(/\.?0+$/, "") || "0";

/** One field, quoted when it has to be, with quotes doubled. RFC 4180. */
function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  /**
   * A leading = + - or @ is quoted with a leading apostrophe as well,
   * because the person opening this file opens it in a spreadsheet, and a
   * line description starting with "=" is a formula the payer's clerk
   * would run.
   */
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "invoice_number", "issued_on", "due_on", "purchase_order", "job_number", "claim_reference",
  "customer", "site_address", "line_number", "description", "quantity", "unit_price",
  "line_discount", "line_total", "price_authority", "invoice_subtotal", "invoice_tax",
  "invoice_total", "invoice_balance",
] as const;

/**
 * One row per invoice line, with the invoice's own figures repeated on each.
 *
 * Flat, because every accounts payable import takes flat rows and none of
 * them takes nesting. The header row names every column, so a payer whose
 * system wants a different order maps it once.
 */
export function toCsv(invoices: readonly ExportInvoice[]): string {
  const rows: string[] = [CSV_COLUMNS.join(",")];
  for (const invoice of invoices) {
    for (const [i, line] of invoice.lines.entries()) {
      rows.push([
        invoice.number, invoice.issuedOn, invoice.dueOn, invoice.purchaseOrderNumber, invoice.jobNumber,
        invoice.claimReference, invoice.customerName, invoice.siteAddress, i + 1,
        [line.name, line.description].filter(Boolean).join(": "),
        quantity(line.quantity), amount(line.unitPrice), amount(line.discountAmount), amount(line.lineTotal),
        rates.authorityLabel(line.priceAuthority),
        amount(invoice.subtotal), amount(invoice.taxTotal), amount(invoice.total), amount(invoice.balance),
      ].map(csvField).join(","));
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

const xmlText = (value: string | number | null) => (value === null ? "" : String(value))
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
  // Characters XML 1.0 cannot carry at all. Dropped rather than escaped, because there is no escape for them.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/**
 * A plain XML document of the same invoices.
 *
 * Our own shape, documented in the module page, and NOT cXML or any
 * network's schema: claiming a standard this does not validate against
 * would be worse than naming it for what it is.
 */
export function toXml(invoices: readonly ExportInvoice[], meta: { supplier: string; payer: string; generatedAt: Date }): string {
  const element = (name: string, value: string | number | null) => `<${name}>${xmlText(value)}</${name}>`;
  const body = invoices.map((invoice) => [
    `  <Invoice number="${xmlText(invoice.number)}">`,
    `    ${element("IssuedOn", invoice.issuedOn)}${element("DueOn", invoice.dueOn)}`,
    `    ${element("PurchaseOrder", invoice.purchaseOrderNumber)}${element("JobNumber", invoice.jobNumber)}${element("ClaimReference", invoice.claimReference)}`,
    `    ${element("Customer", invoice.customerName)}${element("SiteAddress", invoice.siteAddress)}`,
    "    <Lines>",
    ...invoice.lines.map((line, i) => [
      `      <Line number="${i + 1}">`,
      `        ${element("Description", [line.name, line.description].filter(Boolean).join(": "))}`,
      `        ${element("Quantity", quantity(line.quantity))}${element("UnitPrice", amount(line.unitPrice))}`
        + `${element("Discount", amount(line.discountAmount))}${element("LineTotal", amount(line.lineTotal))}`,
      `        ${element("PriceAuthority", rates.authorityLabel(line.priceAuthority))}`,
      "      </Line>",
    ].join("\n")),
    "    </Lines>",
    `    ${element("Subtotal", amount(invoice.subtotal))}${element("Tax", amount(invoice.taxTotal))}`
      + `${element("Total", amount(invoice.total))}${element("Balance", amount(invoice.balance))}`,
    "  </Invoice>",
  ].join("\n"));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Invoices supplier="${xmlText(meta.supplier)}" payer="${xmlText(meta.payer)}" generated="${meta.generatedAt.toISOString()}" currency="USD">`,
    ...body,
    "</Invoices>",
    "",
  ].join("\n");
}

/** The format this payer's contract names, when one does. */
async function formatOf(tx: Database, organizationId: string, customerId: string): Promise<ExportFormat | null> {
  const [row] = await tx.select({ format: schema.serviceContract.invoiceFormat }).from(schema.serviceContract)
    .where(and(
      eq(schema.serviceContract.organizationId, organizationId),
      eq(schema.serviceContract.customerId, customerId),
      eq(schema.serviceContract.active, true),
      isNull(schema.serviceContract.deletedAt),
      sql`${schema.serviceContract.invoiceFormat} is not null`,
    ))
    .orderBy(desc(schema.serviceContract.createdAt)).limit(1);
  return (row?.format as ExportFormat | undefined) ?? null;
}

async function customerOf(tx: Database, customerId: string) {
  const [row] = await tx.select({ id: schema.customer.id, name: schema.customer.name }).from(schema.customer)
    .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Customer");
  return row;
}

export interface InvoiceFile {
  fileName: string;
  contentType: string;
  format: ExportFormat;
  body: string;
  invoiceCount: number;
}

/**
 * The payer's open invoices as a file, recorded as delivered.
 *
 * The format is the contract's when it names one, and a format asked for
 * that disagrees with the contract is refused: the contract is what the
 * payer's accounts payable will accept, and a file they cannot load is an
 * invoice they did not receive.
 */
export async function exportInvoices(
  ctx: ServiceContext, input: { customerId: string; format?: ExportFormat | undefined },
): Promise<InvoiceFile> {
  return guardedWrite(ctx, "invoice:send", async (tx) => {
    const seen = await replayed<InvoiceFile>(tx, ctx, "invoice_export");
    if (seen) return seen;

    const payer = await customerOf(tx, input.customerId);
    const named = await formatOf(tx, ctx.actor.organizationId, payer.id);
    if (named && input.format && input.format !== named) {
      throw new ConflictError(`${payer.name}'s contract takes ${named.toUpperCase()}. Export that, or change the contract.`);
    }
    const format = input.format ?? named;
    if (!format) {
      throw new ConflictError(`Nothing says which file ${payer.name} takes. Choose CSV or XML, or set it on their contract.`);
    }

    const invoices = await invoicesFor(tx, payer.id, { openOnly: true });
    if (invoices.length === 0) throw new ConflictError(`${payer.name} has no open invoices to export.`);

    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const slug = payer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "payer";
    const file: InvoiceFile = {
      fileName: `${stamp}_${slug}-invoices.${format}`,
      contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/xml; charset=utf-8",
      format,
      body: format === "csv"
        ? toCsv(invoices)
        : toXml(invoices, { supplier: org?.name ?? "", payer: payer.name, generatedAt: now }),
      invoiceCount: invoices.length,
    };

    await tx.insert(schema.invoiceDelivery).values(invoices.map((invoice) => ({
      organizationId: ctx.actor.organizationId,
      invoiceId: invoice.id,
      channel: "manual" as const,
      destination: `${format.toUpperCase()} file for ${payer.name}`,
      externalReference: file.fileName,
      submittedAt: now,
    })));
    await audit(tx, ctx, "invoice.exported", "customer", payer.id, null,
      { format, fileName: file.fileName, invoices: invoices.map((i) => i.number) });
    await remember(tx, ctx, "invoice_export", payer.id, file);
    return file;
  });
}

/**
 * A link to every invoice this payer owes or has paid this year.
 *
 * A grant of its own scope, reaching this one payer and nothing else, and
 * recorded against each open invoice as a link handed over, so the
 * undelivered list sees that somebody gave it to them.
 */
export async function issuePortalLink(
  ctx: ServiceContext, input: { customerId: string; expiresInDays?: number | undefined },
): Promise<{ url: string; expiresAt: string; invoiceCount: number }> {
  return guardedWrite(ctx, "portal:grant", async (tx) => {
    const seen = await replayed<{ url: string; expiresAt: string; invoiceCount: number }>(tx, ctx, "payer_portal_link");
    if (seen) return seen;
    const payer = await customerOf(tx, input.customerId);
    const { row, url } = await mintGrant(tx, {
      organizationId: ctx.actor.organizationId,
      customerId: payer.id,
      scope: "payer",
      subjectId: payer.id,
      expiresInDays: input.expiresInDays ?? 90,
    });
    const open = await invoicesFor(tx, payer.id, { openOnly: true });
    if (open.length > 0) {
      await tx.insert(schema.invoiceDelivery).values(open.map((invoice) => ({
        organizationId: ctx.actor.organizationId,
        invoiceId: invoice.id,
        channel: "portal_link" as const,
        destination: `Payer link for ${payer.name}`,
        portalGrantId: row.id,
        submittedAt: new Date(),
      })));
    }
    await audit(tx, ctx, "portal.grant.issued", "portal_grant", row.id, null, { scope: "payer", subjectId: payer.id });
    const answer = { url, expiresAt: row.expiresAt.toISOString(), invoiceCount: open.length };
    await remember(tx, ctx, "payer_portal_link", row.id, answer);
    return answer;
  });
}

/* ------------------------------------------------------------ the payer */

export interface PayerPortal {
  organizationName: string;
  payerName: string;
  owed: string;
  invoices: Array<Omit<ExportInvoice, "id" | "lines"> & {
    lines: Array<Omit<ExportInvoice["lines"][number], "priceAuthority"> & { priceAuthority: string }>;
  }>;
}

/**
 * The payer's page, for somebody holding the link.
 *
 * `peek`, so a clerk opening it every morning does not spend it. Their open
 * invoices first, then what they paid in the last year, each with the lines
 * and who priced them: the question a payer's clerk asks of a commercial
 * invoice is whether it matches their schedule.
 */
export async function viewPortal(db: Database, input: { token: string }): Promise<PayerPortal> {
  const grant = await peek(db, input.token);
  const payerId = requireScope(grant, "payer");
  return inGrant(db, grant, async (tx) => {
    const payer = await customerOf(tx, payerId);
    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, grant.organizationId)).limit(1);
    const invoices = await invoicesFor(tx, payerId, { openOnly: false });
    const owed = m.sum(invoices.filter((i) => i.status === "open" || i.status === "partially_paid")
      .map((i) => m.money(i.balance, "USD")), "USD");
    return {
      organizationName: org?.name ?? "",
      payerName: payer.name,
      owed: m.toString(owed),
      invoices: invoices.map(({ id: _id, lines, ...invoice }) => ({
        ...invoice,
        lines: lines.map((line) => ({ ...line, priceAuthority: rates.authorityLabel(line.priceAuthority) })),
      })),
    };
  });
}

/** The same open invoices as a CSV, for the payer holding the link. Read only: nothing is recorded. */
export async function portalCsv(db: Database, input: { token: string }): Promise<string> {
  const grant = await peek(db, input.token);
  const payerId = requireScope(grant, "payer");
  return inGrant(db, grant, async (tx) => toCsv(await invoicesFor(tx, payerId, { openOnly: true })));
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  exportPayerInvoices: (ctx: ServiceContext, input: { customerId: string; format?: ExportFormat | undefined }) =>
    exportInvoices(ctx, input),
  issuePayerPortalLink: (ctx: ServiceContext, input: { customerId: string; expiresInDays?: number | undefined }) =>
    issuePortalLink(ctx, input),
  viewPayerPortal: (db: Database, input: { token: string }) => viewPortal(db, input),
} as const;
