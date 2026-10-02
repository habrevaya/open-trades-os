import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, properties } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm } from "../ActionForm";

export const dynamic = "force-dynamic";

const input = "h-9 w-full rounded border border-steel-300 px-2 text-sm";

/**
 * Starting a project: the customer first, then which of their addresses,
 * then what it is worth. Two steps because the addresses depend on the
 * customer, and a page that lists every property in the company invites
 * filing a remodel at the wrong house.
 */
export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "job:write");
  const ctx = { actor: user.actor, db: getDb() };
  const query = await searchParams;
  const customerId = typeof query["customer"] === "string" ? query["customer"] : null;

  const everyone = (await customers.list(ctx, { limit: 100, includeInactive: false })).data;
  const addresses = customerId
    ? (await properties.list(ctx, { limit: 50, customerId })).data
    : [];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href="/projects">Projects</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Start a project</h1>

      <form method="get" className="mt-6 flex items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm font-medium text-ink-700">Customer
          <select name="customer" defaultValue={customerId ?? ""} className={input} required>
            <option value="" disabled>Choose</option>
            {everyone.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm">Next</button>
      </form>

      {customerId && (addresses.length === 0 ? (
        <p className="mt-6 text-sm text-ink-700">This customer has no address yet. Add one on their page first.</p>
      ) : (
        <ActionForm op="create" label="Start project" className="mt-6 grid gap-3">
          <input type="hidden" name="customerId" value={customerId} />
          <label className="grid gap-1 text-sm font-medium text-ink-700">Address
            <select name="propertyId" className={input} required>
              {addresses.map((p) => (
                <option key={p.id} value={p.id}>{[p.addressLine1, p.city].filter(Boolean).join(", ")}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink-700">Name
            <input name="name" required placeholder="Kitchen remodel" className={input} />
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink-700">What it is
            <textarea name="description" rows={2} className="w-full rounded border border-steel-300 px-2 py-1.5 text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm font-medium text-ink-700">Starts
              <input name="startsOn" type="date" className={input} />
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink-700">Target completion
              <input name="targetCompletionOn" type="date" className={input} />
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink-700">Contract value
              <input name="contractValue" inputMode="decimal" placeholder="48000.00" className={input} />
            </label>
            <label className="grid gap-1 text-sm font-medium text-ink-700">Budgeted cost (optional)
              <input name="budgetCost" inputMode="decimal" className={input} />
            </label>
          </div>
        </ActionForm>
      ))}
    </div>
  );
}
