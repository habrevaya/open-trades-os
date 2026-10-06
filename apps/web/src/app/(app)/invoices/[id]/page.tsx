import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  agreements, billing, creditNotes, customers, invoiceDelivery, jobs, payments, tips, NotFoundError,
  claims as claimService, entitlements, financing, customFields, fieldSales,
} from "@opentradesos/api/services";
import { can, claims, rates, tax, work } from "@opentradesos/core";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { INVOICE_STATUS, INVOICE_TONE, label, tone } from "@/lib/labels";
import { formatDay, formatIn } from "@/lib/dates";
import { InvoiceActions } from "./Panels";
import { actOnInvoice } from "../actions";
import { startCardPayment } from "../../payments/actions";
import { PayNow } from "../../../(portal)/PayNow";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { fileClaim } from "../claims/actions";
import { CREDIT_REASON, CREDIT_STATUS, CREDIT_TONE, REASON_OPTIONS } from "../credit-notes/labels";
import { creditInvoice } from "../credit-notes/actions";
import { FinancingPanel } from "@/components/FinancingPanel";

export const dynamic = "force-dynamic";

const DELIVERY_STATE: Record<string, string> = {
  interrupted: "Interrupted", refused: "Refused", link_issued: "Link handed over", exported: "In a file", queued: "Queued",
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
  const credited = (await creditNotes.list(ctx, { limit: 50, invoiceId: id })).data;
  /** Tips that came with payments on this invoice, and the technicians they are held for. */
  const tipped = (await tips.forInvoice(ctx, { invoiceId: id })).tips;
  /** The customer's signature, when they signed for it on the technician's phone. */
  const signed = await fieldSales.signatureOn(ctx, { subject: "invoice", subjectId: id });
  /** A bank payment on its way, or one the bank refused this month, so nobody chases or charges twice. */
  const bank = can(user.actor, "payment:read")
    ? (await payments.bankPayments(ctx, { invoiceId: id })).bankPayments
    : [];
  const memberIds = invoice.lines.map((l) => l.memberAgreementId).filter((x): x is string => Boolean(x));
  const plans = memberIds.length > 0 && can(user.actor, "customer:read")
    ? await agreements.planNamesFor(ctx, { agreementIds: memberIds })
    : new Map<string, string>();
  /**
   * A credit can be raised on anything issued and still standing, paid
   * included: what a paid invoice no longer owes stays on the account.
   */
  const creditable = can(user.actor, "invoice:credit")
    && ["open", "partially_paid", "paid"].includes(invoice.status);
  const tz = user.organizationTimezone;
  const owed = (invoice.status === "open" || invoice.status === "partially_paid") && Number(invoice.balance ?? "0") > 0;
  const collects = owed && can(user.actor, "payment:collect");
  /**
   * A card only when a processor is connected to take it. Whoever may not
   * read the integration settings is offered the button anyway, and the
   * service says plainly if there is nothing to take the card with.
   */
  const cards = collects && (can(user.actor, "integration:read")
    ? (await payments.status(ctx)).connected
    : true);
  const zero = (v: string) => Number(v) === 0;
  /** A claim on this invoice, or whether one could be filed: a third party's invoice on a covered job. */
  const [claim] = can(user.actor, "invoice:read") && invoice.jobId
    ? (await claimService.list(ctx, { jobId: invoice.jobId })).filter((c) => c.invoiceId === invoice.id)
    : [];
  const coveredBy = invoice.jobId && can(user.actor, "job:read")
    ? await entitlements.forJob(ctx, { jobId: invoice.jobId })
    : null;
  /** Financing on this invoice: the monthly figure for the balance and every application. */
  const loan = invoice.status === "draft" ? null : await financing.forInvoice(ctx, { invoiceId: id });
  const claimable = !claim && can(user.actor, "invoice:write") && job !== null && coveredBy?.profile.billsAThirdParty === true
    && invoice.customerId !== job.customerId && invoice.status !== "draft" && invoice.status !== "void";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/invoices">Invoices</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Invoice <span className="font-mono tabular-nums">{work.documentNumber(invoice.numberPrefix, invoice.number)}</span>
        </h1>
        <div className="flex items-center gap-3">
          <a href={`/invoices/${invoice.id}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <Chip tone={tone(INVOICE_TONE, invoice.status)}>{label(INVOICE_STATUS, invoice.status)}</Chip>
        </div>
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
        <Fact label="Credited">{zero(invoice.amountCredited ?? "0") ? null : <Money value={invoice.amountCredited ?? "0"} />}</Fact>
        <Fact label="Balance"><Money value={invoice.balance} /></Fact>
        <Fact label="Note">{invoice.memo}</Fact>
        <Fact label="Signed for">
          {signed ? (
            <>
              {signed.signerName}, {formatIn(signed.signedAt, tz)}{signed.onSite ? ", on the technician's phone" : ""}
              {signed.imageKey
                ? <> (<a href={`/files/${signed.imageKey}`} className="text-blue-600 underline underline-offset-4">signature</a>)</>
                : signed.onSite ? " (the drawn signature has not arrived yet)" : null}
            </>
          ) : null}
        </Fact>
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
              {line.taxable ? (
                <span className="ml-2 text-xs text-ink-500">
                  {Number(line.taxRate) > 0
                    ? <>tax {tax.rateToPercent(line.taxRate)}%: <Money value={line.taxAmount} /></>
                    : line.taxSource === "exempt" ? "taxable, customer exempt" : "taxable, no tax charged"}
                </span>
              ) : null}
              {line.description ? <p className="mt-0.5 text-ink-700">{line.description}</p> : null}
              {/* Never silently: the plan that took money off this line, and how much. */}
              {Number(line.memberDiscountAmount ?? "0") > 0 ? (
                <p className="mt-0.5 text-xs text-ink-500">
                  Member discount
                  {line.memberAgreementId && plans.get(line.memberAgreementId) ? `, ${plans.get(line.memberAgreementId)}` : ""}
                  : <Money value={line.memberDiscountAmount!} />
                </p>
              ) : null}
              {/*
                Whose price it is, on every line that recorded one. The first
                question a commercial client asks of a rejected invoice, and the
                answer has to be on the document rather than in somebody's head.
              */}
              {line.priceAuthority ? (
                <p className="mt-0.5 text-xs text-ink-500">
                  Priced by {rates.authorityLabel(line.priceAuthority)}
                  {line.priceNote ? `: ${line.priceNote}` : ""}
                </p>
              ) : null}
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

      {/*
        THE CLAIM, for an invoice to a third party on a covered job. Filed
        here because this invoice is the receivable the claim is about; once
        filed, the claim is its own document with its own page.
      */}
      {claim ? (
        <p className="mt-6 text-sm text-ink-700">
          Claimed from {claim.payerName}
          {claim.externalReference ? ` (${claim.externalReference})` : ""}:{" "}
          <a href={`/invoices/claims/${claim.id}`} className="underline">{claims.CLAIM_STATUS_LABEL[claim.status].toLowerCase()}</a>.
        </p>
      ) : claimable ? (
        <section aria-label="Claim" className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">File the claim</h2>
          <p className="mt-1 text-sm text-ink-700">
            This invoice is to whoever covers the work. Filing the claim records
            their reference and meets the contract&rsquo;s claim deadline.
          </p>
          <ActionForm action={fileClaim} submit="File the claim" hidden={{ invoiceId: invoice.id }}
                      className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Their claim or authorisation number" name="externalReference" />
          </ActionForm>
        </section>
      ) : null}

      {bank.length > 0 && (
        <section aria-label="Bank payments" className="mt-6 space-y-2">
          {bank.map((b) => (
            <p key={b.id} role={b.status === "failed" ? "alert" : "status"}
               className={`rounded-md border p-3 text-sm ${b.status === "failed" ? "border-red-600 bg-red-tint text-red-600" : "border-steel-200 bg-steel-100 text-ink-700"}`}>
              {b.status === "pending"
                ? <>A bank payment of <Money value={b.amount} /> from the customer is on its way, started {formatIn(b.startedAt, tz)}. Bank payments take a few business days; the invoice shows paid when the bank confirms it, and cannot be paid again until then.</>
                : <>A bank payment of <Money value={b.amount} /> started {formatIn(b.startedAt, tz)} did not go through{b.reason ? `: ${b.reason}` : "."} Nothing was recorded as paid. Ask the customer for another way to pay.</>}
            </p>
          ))}
        </section>
      )}

      {collects && (
        <section aria-label="Take payment" className="mt-8 rounded-md border border-steel-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Take payment</h2>
            <a href={`/payments/new?customer=${invoice.customerId}&invoice=${id}&back=/invoices/${id}`}
               className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
              Record a payment
            </a>
          </div>
          <p className="mt-1 text-sm text-ink-700">Cash, a cheque or a bank transfer, recorded against this invoice.</p>
          {cards && (
            <div className="mt-4 max-w-md">
              <p className="mb-2 text-sm text-ink-700">
                Or take a card now. It shows as paid when the processor confirms the money moved.
              </p>
              <PayNow start={startCardPayment.bind(null, invoice.customerId, id)}
                      balance={`$${Number(invoice.balance ?? "0").toFixed(2)}`} label={`invoice ${invoice.number}`}
                      cta={`Take card payment of $${Number(invoice.balance ?? "0").toFixed(2)}`} />
            </div>
          )}
        </section>
      )}

      {loan && (loan.connected ? (owed || loan.applications.length > 0) : collects) ? (
        <FinancingPanel
          subject={{ invoiceId: id }}
          connected={loan.connected}
          lender={loan.lender}
          offers={[{
            optionId: null, name: null, total: invoice.balance ?? "0",
            sentence: loan.offer?.sentence ?? null, applicable: loan.applicable,
          }]}
          applications={loan.applications}
          canSend={collects}
          timezone={tz}
        />
      ) : null}

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

      {tipped.length > 0 && (
        <section aria-label="Tips">
          <h2 className="mt-10 text-base font-semibold">Tips</h2>
          <p className="mt-1 text-sm text-ink-700">
            Added by the customer when they paid. Not part of the invoice: held for the technicians and
            paid out through payroll.
          </p>
          <Table label="Tips on this invoice" head={
            <><Th>Paid</Th><Th>For</Th><Th>Passed on</Th><Th className="text-right">Tip</Th></>
          }>
            {tipped.flatMap((t) => t.shares.map((share) => (
              <tr key={`${t.paymentId}-${share.technicianId}`}>
                <Td>{formatIn(t.receivedAt, tz, { dateStyle: "medium" })}</Td>
                <Td>{share.technicianName}</Td>
                <Td className="text-ink-700">{share.paidAt ? formatIn(share.paidAt, tz, { dateStyle: "medium" }) : "Not yet"}</Td>
                <Td className="text-right"><Money value={share.amount} /></Td>
              </tr>
            )))}
          </Table>
        </section>
      )}

      {credited.length > 0 && (
        <section aria-label="Credit notes">
          <h2 className="mt-10 text-base font-semibold">Credit notes</h2>
          <Table label="Credit notes on this invoice" head={
            <><Th className="w-20">Number</Th><Th>Why</Th><Th>Status</Th><Th className="text-right">Credit</Th></>
          }>
            {credited.map((n) => (
              <tr key={n.id} className="hover:bg-steel-100">
                <Td className="font-mono tabular-nums">
                  <a href={`/invoices/credit-notes/${n.id}`} className="hover:underline">{n.number}</a>
                </Td>
                <Td className="text-ink-700">{label(CREDIT_REASON, n.reason)}</Td>
                <Td><Chip tone={tone(CREDIT_TONE, n.status)}>{label(CREDIT_STATUS, n.status)}</Chip></Td>
                <Td className="text-right"><Money value={n.total} /></Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {creditable && (
        <details className="mt-4 rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Credit this invoice</summary>
          <p className="mt-2 text-sm text-ink-700">
            The bill asked for too much. Say how much comes off each line; the tax comes back at
            the rate the line was charged, and it comes off what is still owed.
          </p>
          <ActionForm action={creditInvoice} submit="Issue credit note" hidden={{ invoiceId: invoice.id }}
                      className="mt-3 space-y-3">
            <div className="space-y-2">
              {invoice.lines.map((line) => (
                <label key={line.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span>
                    <span className="font-medium">{line.name}</span>
                    <span className="ml-2 text-ink-500">charged <Money value={line.lineTotal} /></span>
                  </span>
                  <input name={`line:${line.id}`} inputMode="decimal" placeholder="0.00"
                         aria-label={`Credit on ${line.name}`}
                         className="h-9 w-32 rounded border border-steel-300 bg-canvas px-3 text-right text-sm" />
                </label>
              ))}
            </div>
            <Select label="Why" name="reason" options={REASON_OPTIONS} />
            <TextArea label="Note" name="note" rows={2} maxLength={2000} />
          </ActionForm>
        </details>
      )}

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
      <CustomFieldsPanel
        entityType="invoice" id={id}
        definitions={await customFields.formFields(ctx, "invoice")}
        values={await customFields.valuesFor(ctx, { entityType: "invoice", id })}
        canWrite={can(user.actor, "invoice:write")}
        back={`/invoices/${id}`}
      />
    </div>
  );
}
