import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { PlanFields } from "../PlanFields";
import { editPlan, setPlanOnSale } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE PLAN, TO EDIT
 *
 * How many members are on it is said at the top, because that is what an
 * edit reaches, and each part of the form says who a change to it reaches.
 * Retiring takes it off sale and leaves everybody on it exactly as they are.
 */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const plan = await agreements.getPlan(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const writes = can(user.actor, "membership:write");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/agreements/plans">Plans</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{plan.name}</h1>
        <Chip tone={plan.active ? "success" : "neutral"}>{plan.active ? "on sale" : "retired"}</Chip>
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {plan.members === 1 ? "1 member is" : `${plan.members} members are`} on this plan now.
        {plan.active ? null : " It is retired: they keep it, and nobody new can be sold it."}
      </p>

      {writes ? (
        <>
          <ActionForm action={editPlan} submit="Save plan" done="Saved." hidden={{ id }} className="mt-6 space-y-6">
            <PlanFields plan={plan} editing />
          </ActionForm>
          <section aria-label={plan.active ? "Retire" : "Put back on sale"} className="mt-10 rounded-md border border-steel-200 p-4">
            <h2 className="text-sm font-semibold">{plan.active ? "Retire this plan" : "Put it back on sale"}</h2>
            <p className="mt-1 text-sm text-ink-700">
              {plan.active
                ? "It stops being sold. Everybody on it keeps their price, their term and their visits."
                : "It can be sold again from today, at the price above."}
            </p>
            <ActionForm action={setPlanOnSale} submit={plan.active ? "Retire plan" : "Put back on sale"}
                        tone={plan.active ? "danger" : "quiet"} hidden={{ id, active: plan.active ? "0" : "1" }}
                        className="mt-3" />
          </section>
        </>
      ) : (
        <p className="mt-6 text-sm text-ink-500">Somebody who can sell agreements can change this plan.</p>
      )}
    </div>
  );
}
