import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notFound } from "next/navigation";
import { portalLayout, NotFoundError } from "@opentradesos/api/services";
import { ActionForm } from "@/components/ActionForm";
import { can, assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { LayoutEditor } from "./LayoutEditor";
import { removePlanLayout, saveLayout, savePlanLayout } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WHAT A CUSTOMER'S ACCOUNT PAGE SHOWS, AND IN WHAT ORDER
 *
 * Starts from the layout your trade pack set up, as the customer sees it now,
 * then every block you could add. Moving, hiding and renaming is saved as your
 * own layout, which a trade pack upgrade never writes over.
 */
export default async function PortalLayoutPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const { plan: planId } = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };
  const writes = can(user.actor, "settings:write");
  const { plans } = await portalLayout.plansWithLayouts(ctx);
  const layout = planId
    ? await portalLayout.getForPlan(ctx, { planId }).catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    })
    : await portalLayout.get(ctx);
  const plan = layout.plan;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/portal">Customer portal</Crumb>
      <h1 className="mt-1 text-xl font-semibold">
        {plan ? `What ${plan.name} members see on their account` : "What customers see on their account"}
      </h1>

      {plans.length > 0 && (
        <nav aria-label="Whose page" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span className="text-ink-500">For</span>
          {plan
            ? <a href="/settings/portal/layout" className="text-blue-600 underline underline-offset-4">Everyone</a>
            : <span className="font-medium text-ink-900">Everyone</span>}
          {plans.map((p) => (
            p.planId === plan?.id
              ? <span key={p.planId} className="font-medium text-ink-900">{p.name} members</span>
              : <a key={p.planId} href={`/settings/portal/layout?plan=${p.planId}`} className="text-blue-600 underline underline-offset-4">
                {p.name} members{p.ownLayout ? " (own page)" : ""}
              </a>
          ))}
        </nav>
      )}

      {plan ? (
        <p className="mt-2 max-w-2xl text-sm text-ink-700">
          {plan.ownLayout
            ? "Members of this plan see this page. Everyone else sees the company's page."
            : "Members of this plan see the company's page, the same as everyone. Change anything below and save to give them a page of their own, starting from the company's."}
          {" "}A member is a customer with an active or past due agreement on the plan. A customer on more than one plan
          with its own page opens on the page of the plan they have had longest and can switch to the others from a line
          under their name.
        </p>
      ) : (
        <p className="mt-2 max-w-2xl text-sm text-ink-700">
          {layout.startedFrom
            ? `This started from the ${layout.startedFrom} layout your trade pack set up. `
            : "No trade pack has set this up, so it starts from what every account shows. "}
          Put the blocks in the order you want, untick the ones customers should not see, and change any heading.
          The bills are always shown, because customers need to see what they owe.
          {layout.changed ? " A trade pack upgrade keeps your changes." : ""}
          {plans.length > 0 ? " Members of a plan with a page of its own see that one instead." : ""}
        </p>
      )}
      {writes ? (
        <>
          <LayoutEditor rows={layout.blocks} save={plan ? savePlanLayout : saveLayout}
                        hidden={plan ? { planId: plan.id } : undefined} />
          {plan?.ownLayout && (
            <ActionForm action={removePlanLayout} submit="Use the company's page for this plan" tone="quiet"
                        hidden={{ planId: plan.id }} className="mt-3" />
          )}
        </>
      ) : (
        <ol className="mt-4 space-y-1 text-sm">
          {layout.blocks.map((b) => (
            <li key={b.kind}>{b.title}{b.visible ? "" : " (hidden)"}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
