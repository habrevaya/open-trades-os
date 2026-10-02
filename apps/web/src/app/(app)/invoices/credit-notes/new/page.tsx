import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, NotFoundError } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { REASON_OPTIONS } from "../labels";
import { giveCredit } from "../actions";

export const dynamic = "force-dynamic";

/**
 * A CREDIT THAT IS NOT ABOUT ONE INVOICE.
 *
 * Goodwill after a bad visit, or what is owed back at the end of a contract.
 * Crediting a particular invoice starts from that invoice instead, where each
 * line can be credited and the tax comes back at the rate it was charged.
 */
export default async function NewCreditPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const user = await requireSetupUser();
  assertCan(user.actor, "invoice:credit");
  const { customer: customerId } = await searchParams;
  if (!customerId) notFound();
  const customer = await customers.get({ actor: user.actor, db: getDb() }, { id: customerId })
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href={`/customers/${customer.id}`}>{customer.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Give {customer.name} a credit</h1>
      <p className="mt-2 text-sm text-ink-700">
        It sits on their account until it is used on an invoice. To take something off one invoice,
        open that invoice and credit it there instead.
      </p>
      <ActionForm action={giveCredit} submit="Give credit" hidden={{ customerId: customer.id }}>
        <TextField label="What it is for" name="name" required maxLength={200} placeholder="Credit for the second visit" />
        <TextField label="Amount" name="amount" required inputMode="decimal" placeholder="50.00" />
        <Select label="Why" name="reason" options={REASON_OPTIONS} defaultValue="goodwill" />
        <TextArea label="Note" name="note" maxLength={2000} />
      </ActionForm>
    </div>
  );
}
