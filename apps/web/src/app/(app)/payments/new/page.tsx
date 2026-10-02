import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, customers, NotFoundError } from "@opentradesos/api/services";
import { assertCan, money } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { todayIn } from "@/lib/dates";
import { recordPaymentFromOffice } from "../actions";
import { METHODS } from "@/lib/payment-form";

export const dynamic = "force-dynamic";

/**
 * RECORD A PAYMENT
 *
 * Money that arrived some way other than a card on the customer's link: a
 * cheque in the post, cash in the driveway, a bank transfer. Against one
 * invoice, several, or none, in which case it is held for the customer.
 */
export default async function RecordPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; invoice?: string; back?: string }>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "payment:collect");
  const ctx = { actor: user.actor, db: getDb() };
  const { customer: customerId, invoice: invoiceId, back } = await searchParams;
  if (!customerId) notFound();

  const customer = await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const open = (await billing.list(ctx, { limit: 100, customerId, status: ["open", "partially_paid"] })).data;
  const chosen = open.find((i) => i.id === invoiceId);
  const edit = (v: string | undefined) => money.edit(money.money(v ?? "0", "USD"));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href={`/customers/${customerId}`}>{customer.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Record a payment</h1>
      <p className="mt-1 text-sm text-ink-700">
        A card is taken from the invoice instead, so the processor confirms it.
      </p>

      <ActionForm action={recordPaymentFromOffice} submit="Record payment"
                  hidden={{ customerId, ...(back ? { back } : {}) }} className="mt-6 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="How it was paid" name="method" options={METHODS} />
          <TextField label="Amount received" name="amount" required inputMode="decimal"
                     defaultValue={chosen ? edit(chosen.balance) : undefined} placeholder="0.00" />
          <TextField label="Received on" name="receivedOn" type="date" defaultValue={todayIn(user.organizationTimezone)} />
          <TextField label="Cheque number" name="checkNumber" maxLength={50} />
        </div>
        <TextField label="Notes" name="notes" maxLength={1000} />

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">What it pays</legend>
          {open.length === 0 ? (
            <p className="text-sm text-ink-500">
              Nothing is owed, so the whole amount is held for {customer.name} as a credit.
            </p>
          ) : (
            open.map((inv) => (
              <label key={inv.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-48 flex-1">
                  Apply to invoice {inv.number} <span className="text-ink-500">(owes <Money value={inv.balance} />)</span>
                </span>
                <input name={`apply.${inv.id}`} inputMode="decimal" placeholder="0.00"
                       aria-label={`Apply to invoice ${inv.number}`}
                       defaultValue={inv.id === chosen?.id ? edit(inv.balance) : undefined}
                       className="h-9 w-32 rounded border border-steel-300 bg-canvas px-2 font-mono text-sm" />
              </label>
            ))
          )}
          <p className="text-xs text-ink-500">
            Whatever is not applied here is held for the customer as a deposit, and can be applied to an
            invoice later or given back.
          </p>
        </fieldset>
      </ActionForm>
    </div>
  );
}
