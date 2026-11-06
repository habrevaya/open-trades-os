import { Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** A deposit as `GET /v1/deposits` reads it back. */
export interface HeldDeposit {
  id: string;
  status: string;
  amountRequested: string;
  amountReceived: string;
  amountApplied: string;
  amountRefunded: string;
  amountForfeited: string;
  /** Received, less applied, refunded and kept. */
  outstanding: string;
  appliedInvoiceId: string | null;
}

/** An issued invoice of the same customer with money still owing on it. */
export interface OwingInvoice { id: string; number: string; balance: string }

const positive = (v: string) => Number(v) > 0;
const dollars = (v: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v));

/** What happened to a deposit, in the words the office uses. */
export function depositState(d: HeldDeposit): string {
  if (d.status === "requested") return "Asked for, not paid yet";
  if (d.status === "refunded") return positive(d.outstanding) ? "Partly given back" : "Given back";
  if (d.status === "forfeited") return positive(d.outstanding) ? "Partly kept" : "Kept";
  if (d.status === "applied") return positive(d.outstanding) ? "Partly applied, the rest is held" : "Applied to an invoice";
  return "Held";
}

/** Money is still held and the deposit is open to be applied, given back or kept. */
export function isHeld(d: HeldDeposit): boolean {
  return (d.status === "held" || d.status === "applied") && positive(d.outstanding);
}

/**
 * MONEY HELD FOR THE CUSTOMER, and what the office can do with it.
 *
 * The same three things wherever a deposit shows (the estimate, the invoice
 * and the customer): put it against an invoice, give it back, or keep it.
 * Each is the API's own call with the API's own permission, and each says
 * what it does to the money before the button, because "apply", "refund" and
 * "forfeit" are three different things in the books and on the customer's
 * bank statement.
 *
 * Giving back and keeping take everything still held. The service closes a
 * deposit after one refund or one forfeit, so a part refunded here would
 * leave the rest stuck where nothing could apply it or give it back.
 */
export function DepositsPanel({
  deposits, invoices, allowed, apply, dispose, back, here,
}: {
  deposits: HeldDeposit[];
  /** The invoices a deposit can go against. On an invoice page, that invoice alone. */
  invoices: OwingInvoice[];
  allowed: { apply: boolean; refund: boolean };
  apply: Action;
  dispose: Action;
  /** The page to show again afterwards. */
  back: string;
  /** Set on an invoice page: the invoice is this one, so it is not asked for. */
  here?: OwingInvoice;
}) {
  const shown = deposits.filter((d) => positive(d.amountReceived));
  if (shown.length === 0) return null;
  const choices = here ? [here] : invoices;

  return (
    <section aria-label="Deposits held" className="mt-8">
      <h2 className="text-base font-semibold">Deposits</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-700">
        A deposit is money the customer paid before the work. Until it goes on an invoice, given back or kept,
        you owe it to them.
      </p>
      <ul className="mt-3 space-y-3">
        {shown.map((d) => (
          <li key={d.id} data-testid="deposit" className="rounded-md border border-steel-200 p-4">
            <p className="text-sm">
              <span className="font-medium">{depositState(d)}.</span>{" "}
              Paid <Money value={d.amountReceived} />
              {positive(d.amountApplied) ? <>, <Money value={d.amountApplied} /> applied to invoices</> : null}
              {positive(d.amountRefunded) ? <>, <Money value={d.amountRefunded} /> given back</> : null}
              {positive(d.amountForfeited) ? <>, <Money value={d.amountForfeited} /> kept</> : null}
              {". "}
              {positive(d.outstanding)
                ? <>Still held: <span className="font-medium"><Money value={d.outstanding} /></span>.</>
                : "Nothing is held now."}
              {d.appliedInvoiceId ? (
                <> <a href={`/invoices/${d.appliedInvoiceId}`} className="underline underline-offset-4">Last applied to this invoice</a></>
              ) : null}
            </p>

            {isHeld(d) && allowed.apply ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">Apply to an invoice</summary>
                <p className="mt-2 max-w-prose text-sm text-ink-700">
                  No new money comes in. The deposit pays the invoice: its balance goes down by what is still held,
                  or by the whole balance if that is less. Whatever is left stays held for the next invoice. The
                  customer owes less, and you owe them less.
                </p>
                {choices.length > 0 ? (
                  <ActionForm action={apply} submit={here ? "Apply to this invoice" : "Apply deposit"}
                              hidden={{ depositId: d.id, back, ...(here ? { invoiceId: here.id } : {}) }}
                              className="mt-3 space-y-3">
                    {here ? (
                      <p className="text-sm">
                        Invoice {here.number}, owing <Money value={here.balance} />.
                      </p>
                    ) : (
                      <Select label="Invoice" name="invoiceId"
                              options={choices.map((i) => ({
                                value: i.id, label: `Invoice ${i.number}, owing ${dollars(i.balance)}`,
                              }))} />
                    )}
                  </ActionForm>
                ) : (
                  <p className="mt-2 text-sm text-ink-700">
                    This customer has no issued invoice with money owing. Issue one, then apply the deposit to it.
                  </p>
                )}
              </details>
            ) : null}

            {isHeld(d) && allowed.refund ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">Refund or forfeit</summary>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold">Give it back</h3>
                    <p className="mt-1 text-sm text-ink-700">
                      Records that you paid the customer back the <Money value={d.outstanding} /> still held. This
                      does not send any money and does not refund a card: pay them back yourself, by check,
                      transfer or in your card processor. Your cash goes down by that much. It is not a sale, so
                      no income changes.
                    </p>
                    <ActionForm action={dispose} submit="Record the refund" tone="quiet"
                                hidden={{ depositId: d.id, disposition: "refund", back }}
                                className="mt-3 space-y-3">
                      <TextField label="Why it is going back" name="reason" required maxLength={1000}
                                 placeholder="They cancelled before we ordered the unit." />
                    </ActionForm>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Keep it</h3>
                    <p className="mt-1 text-sm text-ink-700">
                      Keeps the <Money value={d.outstanding} /> still held, under the terms the customer agreed to.
                      No money moves: you already have it. It counts as income now, and you no longer owe it to
                      them. It cannot be undone here.
                    </p>
                    <ActionForm action={dispose} submit="Keep the deposit" tone="danger"
                                hidden={{ depositId: d.id, disposition: "forfeit", back }}
                                className="mt-3 space-y-3">
                      <TextField label="Why you are keeping it" name="reason" required maxLength={1000}
                                 placeholder="Cancelled the day before install. Their terms keep the deposit." />
                    </ActionForm>
                  </div>
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
