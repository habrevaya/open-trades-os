import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, customers, properties, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { sellAgreement } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SELLING AN AGREEMENT
 *
 * Two steps on one page: find the customer, then pick the plan, the address
 * it covers and the day it starts. The sale writes everything the first term
 * owes in one go (the visits with their due dates, the instalments and the
 * deferred revenue behind each), so the confirmation is the agreement's own
 * screen with all of it on.
 *
 * A customer opened from somewhere else arrives with `?customer=`.
 */
export default async function SellAgreementPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; q?: string }>;
}) {
  const user = await requireSetupUser();
  if (!can(user.actor, "membership:write")) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const { customer: customerId, q } = await searchParams;

  if (!customerId) {
    const found = q ? (await customers.list(ctx, { limit: 20, includeInactive: false, q })).data : [];
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <Crumb href="/agreements">Agreements</Crumb>
        <div className="mt-1"><PageHeader title="Sell an agreement" /></div>
        <form action="/agreements/new" className="mt-4 flex gap-2">
          <input type="search" name="q" defaultValue={q ?? ""} placeholder="Customer name, phone or email"
                 aria-label="Find the customer" className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm" />
          <button type="submit" className="h-10 rounded border border-steel-300 px-3 text-sm hover:bg-steel-100">Find</button>
        </form>
        {q && found.length === 0 ? (
          <Empty title={`Nobody matches "${q}"`}>Add them as a customer first, then sell them a plan.</Empty>
        ) : null}
        {found.length > 0 ? (
          <ul className="mt-4 divide-y divide-steel-200 rounded-md border border-steel-200">
            {found.map((c) => (
              <li key={c.id}>
                <a href={`/agreements/new?customer=${c.id}`} className="block px-4 py-2.5 text-sm hover:bg-steel-100">
                  <span className="font-medium">{c.name}</span>
                  {c.phone || c.email ? <span className="ml-2 text-ink-500">{[c.phone, c.email].filter(Boolean).join(", ")}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const customer = await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [plans, addresses, held] = await Promise.all([
    agreements.plans(ctx),
    properties.list(ctx, { limit: 50, customerId }).then((r) => r.data),
    agreements.list(ctx, { customerId }),
  ]);
  const running = held.filter((row) => row.agreement.status === "active");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/agreements/new">Sell an agreement</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Sell {customer.name} a plan</h1>
      {running.length > 0 ? (
        <p role="note" className="mt-3 rounded border border-steel-200 bg-canvas-raised p-3 text-sm text-ink-700">
          Already on {running.map((r) => r.planName).join(" and ")}. A customer on two plans gets the better one&apos;s
          benefits on any one job, never both.
        </p>
      ) : null}
      {plans.length === 0 ? (
        <Empty title="Nothing is on sale">
          <a href="/agreements/plans" className="underline underline-offset-4">Define a plan</a> first.
        </Empty>
      ) : (
        <>
          <ul className="mt-4 space-y-1 text-sm text-ink-700" aria-label="Plans on sale">
            {plans.map((plan) => (
              <li key={plan.id}>
                <span className="font-medium text-ink-900">{plan.name}</span>: <Money value={plan.price} /> for {plan.termMonths} months,
                {` ${plan.includedVisitsPerTerm} visit${plan.includedVisitsPerTerm === 1 ? "" : "s"}`}
                {plan.discountRate && Number(plan.discountRate) > 0 ? `, ${agreements.percentOf(plan.discountRate)} off work` : ""}
              </li>
            ))}
          </ul>
          <ActionForm action={sellAgreement} submit="Sell agreement" hidden={{ customerId }} className="mt-6 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Plan" name="planId" options={plans.map((p) => ({ value: p.id, label: p.name }))} />
              <Select label="Covers" name="propertyId" options={[
                ...addresses.map((p) => ({ value: p.id, label: [p.addressLine1, p.city].filter(Boolean).join(", ") })),
                { value: "", label: "Them, at any address" },
              ]} />
              <TextField label="Starts" name="startedOn" type="date" defaultValue={todayIn(user.organizationTimezone)} />
              <TextField label="A price they agreed instead (optional)" name="price" inputMode="decimal"
                         placeholder="Leave empty for the plan's price" />
            </div>
            <p className="text-xs text-ink-500">
              The price and the discount are fixed on the agreement now. Changing the plan later does not change them.
            </p>
          </ActionForm>
        </>
      )}
    </div>
  );
}
