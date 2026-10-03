import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { PlanFields } from "./PlanFields";
import { definePlan } from "./actions";

export const dynamic = "force-dynamic";

const BILLED: Record<string, string> = {
  monthly: "monthly", quarterly: "quarterly", semiannual: "twice a year", annual: "yearly", one_time: "up front",
};

/**
 * WHAT IS ON SALE
 *
 * Every plan with its price, its visits, the member discount and the perks,
 * retired ones below the rest because their members are still on them. A
 * plan was `POST /v1/agreement-plans` and nothing else; the form to define
 * one is here, and each row opens the plan to edit or retire it.
 */
export default async function PlansPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const writes = can(user.actor, "membership:write");
  const plans = await agreements.plans(ctx, { includeInactive: true });
  const ordered = [...plans].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Plans"
        count={plans.length}
        action={writes ? <a href="/agreements/new" className="text-sm text-ink-700 hover:underline">Sell one</a> : undefined}
      />

      {ordered.length === 0 ? (
        <Empty title="No plans yet">
          A plan is a price, a term and the visits it includes, with whatever members get besides. Define the first below.
        </Empty>
      ) : (
        <Table head={<><Th>Plan</Th><Th className="text-right">Price</Th><Th>Visits</Th><Th>Members get</Th><Th>State</Th></>}>
          {ordered.map((plan) => (
            <tr key={plan.id}>
              <Td>
                <a href={`/agreements/plans/${plan.id}`} className="font-medium hover:underline">{plan.name}</a>
                {plan.code ? <span className="ml-2 font-mono text-xs text-ink-500">{plan.code}</span> : null}
              </Td>
              <Td className="text-right">
                <Money value={plan.price} /> <span className="text-xs text-ink-500">billed {BILLED[plan.billingFrequency] ?? plan.billingFrequency}</span>
              </Td>
              <Td className="text-ink-700">{plan.includedVisitsPerTerm} in {plan.termMonths} months</Td>
              <Td className="text-ink-700">
                {[
                  plan.discountRate && Number(plan.discountRate) > 0 ? `${agreements.percentOf(plan.discountRate)} off` : null,
                  plan.priorityDispatch ? "seen first" : null,
                  plan.waivesDiagnosticFee ? "no diagnostic fee" : null,
                  plan.waivesAfterHoursRate ? "no after hours rate" : null,
                ].filter(Boolean).join(", ") || "Nothing besides the visits"}
              </Td>
              <Td><Chip tone={plan.active ? "success" : "neutral"}>{plan.active ? "on sale" : "retired"}</Chip></Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section aria-label="Define a plan" className="mt-10 rounded-md border border-steel-200 bg-canvas p-5">
          <h2 className="text-base font-semibold">Define a plan</h2>
          <ActionForm action={definePlan} submit="Define plan" className="mt-4 space-y-6">
            <PlanFields />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
