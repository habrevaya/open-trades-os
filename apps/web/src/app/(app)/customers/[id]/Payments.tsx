import { Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";
import { METHODS, METHOD_LABEL } from "@/lib/payment-form";
import { Table, Th, Td } from "@/components/Table";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface PaymentRow {
  id: string;
  method: string;
  amount: string;
  refundedAmount: string;
  unappliedAmount: string;
  receivedOn: string;
  checkNumber: string | null;
  processorPaymentId: string | null;
  allocations: { invoiceNumber: number | null; amount: string }[];
}

export interface OpenInvoice { id: string; number: number; balance: string }

/**
 * THE MONEY A CUSTOMER HAS PAID, and what is still held for them.
 *
 * Held money (a deposit, a cheque for more than was owed) is a liability
 * until it is applied to an invoice or given back, and both are here
 * beside it, so the office does not have to remember it exists. The
 * actions are passed in so this renders in a test.
 */
export function Payments({
  customerId, payments, open, apply, refund, canCollect, canRefund,
}: {
  customerId: string;
  payments: PaymentRow[];
  open: OpenInvoice[];
  apply: Action;
  refund: Action;
  canCollect: boolean;
  canRefund: boolean;
}) {
  return (
    <section aria-label="Payments">
      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Payments</h2>
        {canCollect && (
          <a href={`/payments/new?customer=${customerId}`}
             className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
            Record a payment
          </a>
        )}
      </div>
      {payments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">Nothing paid yet.</p>
      ) : (
        <Table head={<><Th>Received</Th><Th>How</Th><Th className="text-right">Amount</Th><Th>Paid towards</Th><Th className="text-right">Held</Th></>}>
          {payments.map((p) => (
            <tr key={p.id}>
              <Td className="text-ink-700">{p.receivedOn}</Td>
              <Td>
                {METHOD_LABEL[p.method] ?? p.method}
                {p.checkNumber ? <span className="text-ink-500"> #{p.checkNumber}</span> : null}
                {Number(p.refundedAmount) > 0
                  ? <span className="block text-xs text-ink-500">Refunded <Money value={p.refundedAmount} /></span>
                  : null}
              </Td>
              <Td className="text-right"><Money value={p.amount} /></Td>
              <Td className="text-ink-700">
                {p.allocations.filter((a) => Number(a.amount) > 0).map((a) => `#${a.invoiceNumber}`).join(", ") || "Nothing yet"}
              </Td>
              <Td className="text-right">
                {Number(p.unappliedAmount) > 0 ? <Money value={p.unappliedAmount} /> : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {canCollect && payments.filter((p) => Number(p.unappliedAmount) > 0).map((p) => (
        <details key={`apply-${p.id}`} className="mt-3 rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Apply <Money value={p.unappliedAmount} /> held from the {p.receivedOn} payment
          </summary>
          {open.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">Nothing is owed to apply it to yet.</p>
          ) : (
            <ActionForm action={apply} submit="Apply held money" hidden={{ customerId, paymentId: p.id }}
                        className="mt-3 space-y-2">
              {open.map((inv) => (
                <label key={inv.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="min-w-48 flex-1">
                    Invoice {inv.number} <span className="text-ink-500">(owes <Money value={inv.balance} />)</span>
                  </span>
                  <input name={`apply.${inv.id}`} inputMode="decimal" placeholder="0.00"
                         aria-label={`Apply held money to invoice ${inv.number}`}
                         className="h-9 w-32 rounded border border-steel-300 bg-canvas px-2 font-mono text-sm" />
                </label>
              ))}
            </ActionForm>
          )}
        </details>
      ))}

      {canRefund && payments.filter((p) => Number(p.amount) - Number(p.refundedAmount) > 0).map((p) => {
        const throughProcessor = Boolean(p.processorPaymentId) && (p.method === "card" || p.method === "card_present");
        return (
          <details key={`refund-${p.id}`} className="mt-3 rounded-md border border-steel-200 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Refund the {p.receivedOn} payment of <Money value={p.amount} />
            </summary>
            <ActionForm action={refund} submit={throughProcessor ? "Refund through the processor" : "Record refund"}
                        tone="danger"
                        hidden={{ customerId, paymentId: p.id, ...(throughProcessor ? { through: "processor" } : {}) }}
                        className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Amount refunded" name="amount" inputMode="decimal" required={!throughProcessor}
                           placeholder={throughProcessor ? "All that is left" : "0.00"} />
                {!throughProcessor && <Select label="How it went back" name="method" options={METHODS} />}
                {!throughProcessor && <TextField label="Refund cheque number" name="checkNumber" maxLength={50} />}
                <TextField label="Why" name="reason" required={!throughProcessor} maxLength={500} />
              </div>
            </ActionForm>
          </details>
        );
      })}
    </section>
  );
}
