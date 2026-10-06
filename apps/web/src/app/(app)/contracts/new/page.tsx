import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm, TextField, Select } from "@/components/ActionForm";
import { ContractTermFields } from "../ContractTerms";
import { createContract } from "../actions";

export const dynamic = "force-dynamic";

/**
 * SETTING UP A CONTRACT
 *
 * With a client, a home warranty network or a manufacturer: anybody whose
 * schedule prices work instead of our price book, whose clocks we are held
 * to, or who pays for work somebody else receives. The contract is with a
 * customer record, so their invoices age against somebody; a warranty
 * company is added as a customer first, like anyone else who pays.
 */
export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const user = await requireSetupUser();
  assertCan(user.actor, "contract:write");
  const { customer } = await searchParams;
  const people = (await customers.list({ actor: user.actor, db: getDb() }, { limit: 200, includeInactive: false })).data
    .map((c) => ({ value: c.id as string, label: c.name as string }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/contracts">Contracts</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Set up a contract</h1>
      <ActionForm action={createContract} submit="Set up the contract">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="With" name="customerId" options={people} defaultValue={customer ?? ""} />
          <TextField label="Name" name="name" required placeholder="Network agreement 2026" />
          <TextField label="Their contract number" name="contractNumber" />
        </div>
        <ContractTermFields />
      </ActionForm>
    </div>
  );
}
