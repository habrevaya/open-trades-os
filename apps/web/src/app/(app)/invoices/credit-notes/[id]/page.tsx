import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, creditNotes, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { label, tone } from "@/lib/labels";
import { formatDay } from "@/lib/dates";
import { CREDIT_REASON, CREDIT_STATUS, CREDIT_TONE } from "../labels";
import { actOnCreditNote } from "../actions";

export const dynamic = "force-dynamic";

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const note = await creditNotes.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const tz = user.organizationTimezone;
  const credits = can(user.actor, "invoice:credit");
  const usable = note.status === "open" || note.status === "partially_applied";
  /** Invoices this customer still owes on: the only ones a credit can go against. */
  const owing = credits && usable
    ? (await billing.list(ctx, { limit: 100, customerId: note.customerId, status: ["open", "partially_paid"] })).data
    : [];
  const hidden = { creditNoteId: note.id };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/invoices/credit-notes">Credit notes</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Credit note <span className="font-mono tabular-nums">{note.number}</span>
        </h1>
        <Chip tone={tone(CREDIT_TONE, note.status)}>{label(CREDIT_STATUS, note.status)}</Chip>
      </div>

      <Facts>
        <Fact label="Customer">
          <a href={`/customers/${note.customerId}`} className="hover:underline">{note.customerName}</a>
        </Fact>
        <Fact label="Against invoice">
          {note.invoiceId ? <a href={`/invoices/${note.invoiceId}`} className="hover:underline">{note.invoiceNumber}</a> : null}
        </Fact>
        <Fact label="Why">{label(CREDIT_REASON, note.reason)}</Fact>
        <Fact label="Note">{note.note}</Fact>
        <Fact label="Issued">{note.issuedOn ? formatDay(note.issuedOn, tz) : null}</Fact>
        <Fact label="Credit"><Money value={note.total} /></Fact>
        <Fact label="Used">{Number(note.amountApplied) === 0 ? null : <Money value={note.amountApplied} />}</Fact>
        <Fact label="Not yet used">{usable ? <Money value={note.balance} /> : null}</Fact>
      </Facts>

      <Table label="What is credited" head={
        <>
          <Th>Line</Th>
          <Th className="text-right">Qty</Th>
          <Th className="text-right">Unit</Th>
          <Th className="text-right">Tax</Th>
          <Th className="text-right">Amount</Th>
        </>
      }>
        {note.lines.map((line) => (
          <tr key={line.id}>
            <Td>
              <span className="font-medium">{line.name}</span>
              {line.invoiceLineId ? <span className="ml-2 text-xs text-ink-500">from the invoice</span> : null}
            </Td>
            <Td className="text-right font-mono tabular-nums">{Number(line.quantity)}</Td>
            <Td className="text-right"><Money value={line.unitPrice} /></Td>
            <Td className="text-right">{Number(line.taxAmount) === 0 ? null : <Money value={line.taxAmount} />}</Td>
            <Td className="text-right"><Money value={line.lineTotal} /></Td>
          </tr>
        ))}
      </Table>

      <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-ink-500">Subtotal</dt><dd className="text-right"><Money value={note.subtotal} /></dd>
        <dt className="text-ink-500">Tax given back</dt><dd className="text-right"><Money value={note.taxTotal} /></dd>
        <dt className="font-medium">Credit</dt><dd className="text-right font-medium"><Money value={note.total} /></dd>
      </dl>

      {note.applications.length > 0 && (
        <section aria-label="Where it went">
          <h2 className="mt-10 text-base font-semibold">Where it went</h2>
          <Table label="Where it went" head={<><Th>Invoice</Th><Th>On</Th><Th className="text-right">Amount</Th></>}>
            {note.applications.map((a) => (
              <tr key={a.id}>
                <Td className="font-mono tabular-nums">
                  <a href={`/invoices/${a.invoiceId}`} className="hover:underline">{a.invoiceNumber}</a>
                </Td>
                <Td className="text-ink-700">{a.appliedOn ? formatDay(a.appliedOn, tz) : ""}</Td>
                <Td className="text-right"><Money value={a.amount} /></Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {credits && (
        <div className="mt-8 space-y-4">
          {note.status === "draft" && (
            <section aria-label="Draft" className="rounded-md border border-steel-200 p-4">
              <p className="text-sm text-ink-700">
                A draft: nothing comes off anything until it is issued.
              </p>
              <div className="mt-3 flex flex-wrap items-start gap-3">
                <ActionForm action={actOnCreditNote} submit="Issue credit note" hidden={{ ...hidden, op: "issue" }} className="space-y-2" />
                <ActionForm action={actOnCreditNote} submit="Delete draft" tone="danger" hidden={{ ...hidden, op: "delete" }} className="space-y-2" />
              </div>
            </section>
          )}

          {usable && (
            <section aria-label="Use this credit" className="rounded-md border border-steel-200 p-4">
              <h2 className="text-sm font-semibold">Use it on an invoice</h2>
              {owing.length === 0 ? (
                <p className="mt-1 text-sm text-ink-700">
                  {note.customerName} owes nothing right now. The credit stays on their account until they do.
                </p>
              ) : (
                <ActionForm action={actOnCreditNote} submit="Use credit" hidden={{ ...hidden, op: "apply" }}
                            className="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                  <Select label="Invoice" name="invoiceId" options={owing.map((i) => ({
                    value: i.id, label: `Invoice ${i.number}, owes $${Number(i.balance).toFixed(2)}`,
                  }))} />
                  <TextField label="Amount" name="amount" inputMode="decimal" required
                             defaultValue={Number(note.balance).toFixed(2)} />
                </ActionForm>
              )}
            </section>
          )}

          {usable && Number(note.amountApplied) === 0 && (
            <details className="rounded-md border border-steel-200 p-4">
              <summary className="cursor-pointer text-sm font-medium">Void this credit note</summary>
              <p className="mt-2 text-sm text-ink-700">
                It was raised in error. The revenue and the tax go back as they were. Only a credit nothing has used can be voided.
              </p>
              <ActionForm action={actOnCreditNote} submit="Void credit note" tone="danger" hidden={{ ...hidden, op: "void" }}
                          className="mt-3 space-y-3">
                <TextField label="Why it is being voided" name="reason" required maxLength={500} />
              </ActionForm>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
