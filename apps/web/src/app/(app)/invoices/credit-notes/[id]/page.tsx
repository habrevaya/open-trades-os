import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, creditNotes, creditPayouts, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { label, tone } from "@/lib/labels";
import { formatDay, formatIn, todayIn } from "@/lib/dates";
import { CREDIT_REASON, CREDIT_STATUS, CREDIT_TONE } from "../labels";
import { actOnCreditNote } from "../actions";

export const dynamic = "force-dynamic";

const PAYOUT_METHOD: Record<string, string> = {
  card: "Back to their card", cash: "Cash", check: "Cheque", other: "Another way",
};
const PAYOUT_STATUS: Record<string, string> = {
  pending: "With the card processor", paid: "Paid back", failed: "Did not go",
};
const PAYOUT_TONE: Record<string, "info" | "success" | "danger"> = {
  pending: "info", paid: "success", failed: "danger",
};

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
  /**
   * Paying a credit back is sending money, so it is `payment:refund`, a
   * different decision from raising the credit. The card payments it could
   * go back through are read only for somebody who may do it.
   */
  const refunds = can(user.actor, "payment:refund") && can(user.actor, "payment:read");
  const cards = refunds && usable ? (await creditPayouts.refundablePayments(ctx, { id: note.id })).payments : [];

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
        <Fact label="Paid back">{Number(note.amountPaidOut) === 0 ? null : <Money value={note.amountPaidOut} />}</Fact>
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

      {note.payouts.length > 0 && (
        <section aria-label="Paid back">
          <h2 className="mt-10 text-base font-semibold">Paid back</h2>
          <Table label="Paid back" head={<><Th>How</Th><Th>When</Th><Th>State</Th><Th className="text-right">Amount</Th></>}>
            {note.payouts.map((p) => (
              <tr key={p.id}>
                <Td>
                  {PAYOUT_METHOD[p.method]}
                  {p.reference ? <span className="ml-2 text-xs text-ink-500">{p.reference}</span> : null}
                  {p.failureReason ? <p className="mt-0.5 text-xs text-red-600">{p.failureReason}</p> : null}
                </Td>
                <Td className="text-ink-700">{p.paidOn ? formatDay(p.paidOn, tz) : formatIn(p.createdAt, tz)}</Td>
                <Td><Chip tone={PAYOUT_TONE[p.status]}>{PAYOUT_STATUS[p.status]}</Chip></Td>
                <Td className="text-right"><Money value={p.amount} /></Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {refunds && usable && (
        <details className="mt-8 rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Pay it back to {note.customerName}</summary>
          <p className="mt-2 text-sm text-ink-700">
            For a credit they cannot use on another invoice. Back to their card goes through your card processor as a
            refund of a payment they made by card, and shows as paid back once the processor says the money moved.
            Cash or a cheque is recorded as handed over.
          </p>
          <ActionForm action={actOnCreditNote} submit="Pay it back"
                      hidden={{ ...hidden, op: "payout", formKey: crypto.randomUUID() }}
                      className="mt-3 grid gap-3 sm:grid-cols-2 sm:items-end">
            <Select label="How" name="method" options={[
              ...(cards.length > 0 ? [{ value: "card", label: "Back to their card" }] : []),
              { value: "check", label: "Cheque" },
              { value: "cash", label: "Cash" },
              { value: "other", label: "Another way" },
            ]} />
            <TextField label="Amount" name="amount" inputMode="decimal" required
                       defaultValue={Number(note.balance).toFixed(2)} />
            {cards.length > 0 && (
              <Select label="Card payment it goes back through" name="paymentId" options={cards.map((p) => ({
                value: p.id,
                label: `${formatIn(p.receivedAt, tz)}, ${p.method === "ach" ? "bank" : "card"} payment of $${Number(p.amount).toFixed(2)}, up to $${Number(p.refundable).toFixed(2)} back`,
              }))} />
            )}
            <TextField label="Cheque number or note" name="reference" maxLength={200} />
            <TextField label="Paid on, for cash or a cheque" name="paidOn" type="date"
                       defaultValue={todayIn(tz)} max={todayIn(tz)} />
          </ActionForm>
          {cards.length === 0 && (
            <p className="mt-2 text-xs text-ink-500">
              {note.customerName} has no card payment with anything left to refund, so it can only go back by cash or cheque.
            </p>
          )}
        </details>
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

          {usable && Number(note.amountApplied) === 0 && Number(note.amountPaidOut) === 0 && (
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
