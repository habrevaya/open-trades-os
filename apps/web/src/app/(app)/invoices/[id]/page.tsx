import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, customers, invoiceDelivery, jobs, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { INVOICE_STATUS, INVOICE_TONE, label, tone } from "@/lib/labels";
import { formatDay, formatIn } from "@/lib/dates";
import { InvoiceActions } from "./Panels";
import { actOnInvoice } from "../actions";

export const dynamic = "force-dynamic";

const DELIVERY_STATE: Record<string, string> = {
  interrupted: "Interrupted", refused: "Refused", link_issued: "Link handed over", queued: "Queued",
  sent: "Sent", delivered: "Delivered", bounced: "Bounced", failed: "Failed",
};

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const invoice = await billing.get(ctx, { id })
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    });
  const [customer, job, deliveries] = await Promise.all([
    customers.get(ctx, { id: invoice.customerId }).catch(() => null),
    invoice.jobId && can(user.actor, "job:read") ? jobs.get(ctx, { id: invoice.jobId }).catch(() => null) : null,
    invoiceDelivery.history(ctx, { invoiceId: id }).then((r) => r.deliveries),
  ]);
  const tz = user.organizationTimezone;
  const zero = (v: string) => Number(v) === 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/invoices">Invoices</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Invoice <span className="font-mono tabular-nums">{invoice.number}</span>
        </h1>
        <Chip tone={tone(INVOICE_TONE, invoice.status)}>{label(INVOICE_STATUS, invoice.status)}</Chip>
      </div>

      <Facts>
        <Fact label="Customer">
          {customer ? <a href={`/customers/${customer.id}`} className="hover:underline">{customer.name}</a> : null}
        </Fact>
        <Fact label="Job">
          {job ? <a href={`/jobs/${job.id}`} className="hover:underline">{job.number} {job.summary}</a> : null}
        </Fact>
        <Fact label="Issued">{invoice.issuedOn ? formatDay(invoice.issuedOn, tz) : null}</Fact>
        <Fact label="Due">{invoice.dueOn ? formatDay(invoice.dueOn, tz) : null}</Fact>
        <Fact label="PO number">{invoice.purchaseOrderNumber}</Fact>
        <Fact label="Total"><Money value={invoice.total} /></Fact>
        <Fact label="Paid">{zero(invoice.amountPaid) ? null : <Money value={invoice.amountPaid} />}</Fact>
        <Fact label="Balance"><Money value={invoice.balance} /></Fact>
        <Fact label="Note">{invoice.memo}</Fact>
      </Facts>

      <Table head={
        <>
          <Th>Line</Th>
          <Th className="text-right">Qty</Th>
          <Th className="text-right">Unit</Th>
          <Th className="text-right">Discount</Th>
          <Th className="text-right">Amount</Th>
        </>
      }>
        {invoice.lines.map((line) => (
          <tr key={line.id}>
            <Td>
              <span className="font-medium">{line.name}</span>
              {line.taxable ? <span className="ml-2 text-xs text-ink-500">taxable</span> : null}
              {line.description ? <p className="mt-0.5 text-ink-700">{line.description}</p> : null}
            </Td>
            <Td className="text-right font-mono tabular-nums">{Number(line.quantity)}</Td>
            <Td className="text-right"><Money value={line.unitPrice} /></Td>
            <Td className="text-right">{zero(line.discountAmount) ? null : <Money value={line.discountAmount} />}</Td>
            <Td className="text-right"><Money value={line.lineTotal} /></Td>
          </tr>
        ))}
      </Table>

      <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-ink-500">Subtotal</dt><dd className="text-right"><Money value={invoice.subtotal} /></dd>
        {zero(invoice.discountTotal) ? null : (
          <><dt className="text-ink-500">Discounts</dt><dd className="text-right">-<Money value={invoice.discountTotal} /></dd></>
        )}
        <dt className="text-ink-500">Tax</dt><dd className="text-right"><Money value={invoice.taxTotal} /></dd>
        <dt className="font-medium">Total</dt><dd className="text-right font-medium"><Money value={invoice.total} /></dd>
      </dl>

      <InvoiceActions
        action={actOnInvoice}
        invoice={{
          id: invoice.id, number: invoice.number, status: invoice.status,
          amountPaid: invoice.amountPaid ?? "0", balance: invoice.balance ?? "0",
        }}
        allowed={{
          write: can(user.actor, "invoice:write"),
          send: can(user.actor, "invoice:send"),
          void: can(user.actor, "invoice:void"),
          writeOff: can(user.actor, "invoice:writeoff"),
        }}
        customerEmail={customer?.email ?? null}
        sentBefore={deliveries.length > 0}
      />

      {deliveries.length > 0 && (
        <section aria-label="Sent">
          <h2 className="mt-10 text-base font-semibold">Sent</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-700">
            {deliveries.map((d) => (
              <li key={d.id}>
                {formatIn(d.createdAt, tz)}:{" "}
                {d.channel === "portal_link" ? "a link handed over" : `emailed to ${d.destination ?? "nobody"}`}
                {" · "}{label(DELIVERY_STATE, d.state)}
                {d.failureReason || d.error ? <span className="text-red-600"> ({d.failureReason ?? d.error})</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
