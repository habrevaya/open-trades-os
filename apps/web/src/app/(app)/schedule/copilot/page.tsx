import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { agents, agentDispatch } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { askCopilot, applyPlan, setPlanAside } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SCHEDULE → COPILOT
 *
 * The board already works out who may take each open visit and what each
 * choice costs in driving and lateness. The copilot reads that answer and
 * says it in plain words, one sentence per visit, and the dispatcher ticks
 * what to apply. It never applies anything itself.
 */

interface Plan {
  date: string;
  summary: string;
  assignments: {
    visitId: string; customerName: string; window: string | null;
    technicianId: string; technicianName: string; why: string;
    addedDriveMinutes: number | null; matchesOptimiser: boolean;
  }[];
  dropped: string[];
  nobodyMay: string[];
}

export default async function CopilotPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : todayIn(user.organizationTimezone);

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Dispatch copilot" />
        <Empty title="Not shown to your role">The copilot reads the board, which needs the View visits permission.</Empty>
      </div>
    );
  }

  const [on, listed] = await Promise.all([
    agents.isOn(ctx, "dispatch"),
    agentDispatch.handlers.listDispatchPlans(ctx, { date, limit: 5 }),
  ]);
  const latest = listed.drafts.find((d) => d.status === "proposed" || d.status === "applied");
  const plan = latest?.draft as unknown as Plan | undefined;
  const dispatches = can(user.actor, "visit:dispatch");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Dispatch copilot" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Who should take the day&apos;s open visits, explained. It chooses only among the people the board allows
        (skills, time off) using the board&apos;s own drive times, and you decide what to apply.
      </p>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Day</span>
          <input type="date" name="date" defaultValue={date} className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <button type="submit" className="inline-flex h-10 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">Show</button>
        <a href={`/schedule?date=${date}`} className="text-sm underline underline-offset-4">Open the board for this day</a>
      </form>

      {!on ? (
        <Empty title="The copilot is off">An owner can turn it on under <a href="/settings/agents" className="underline underline-offset-4">Settings, AI agents</a>.</Empty>
      ) : (
        <ActionForm action={askCopilot} submit={latest ? "Ask again" : "Ask the copilot"} hidden={{ date }} className="mt-6" />
      )}

      {latest && plan ? (
        <section aria-label="The copilot's plan" className="mt-8 rounded-md border border-steel-200 p-4">
          <p className="text-sm text-ink-900">{plan.summary}</p>
          {plan.nobodyMay.length > 0 ? (
            <p className="mt-2 text-sm text-amber-700">Nobody the board allows can take: {plan.nobodyMay.join(", ")}.</p>
          ) : null}
          {plan.dropped.length > 0 ? (
            <p className="mt-2 text-xs text-ink-500">Left out because the board does not allow them: {plan.dropped.join(" ")}</p>
          ) : null}
          {latest.status === "applied" ? (
            <p className="mt-3 text-sm">Applied. <a href={`/schedule?date=${date}`} className="underline underline-offset-4">See the board</a></p>
          ) : plan.assignments.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">Nothing to apply.</p>
          ) : (
            <ActionForm action={applyPlan} submit="Apply ticked" hidden={{ id: latest.id }} className="mt-4 space-y-3">
              <ul className="space-y-2">
                {plan.assignments.map((a) => (
                  <li key={a.visitId}>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="visitIds" value={a.visitId} defaultChecked disabled={!dispatches} className="mt-1" />
                      <span>
                        <span className="font-medium">{a.customerName}</span>
                        {a.window ? <span className="text-ink-500">, {a.window}</span> : null}
                        {": "}{a.technicianName}
                        {a.addedDriveMinutes !== null ? <span className="text-ink-500"> (+{a.addedDriveMinutes} min driving)</span> : null}
                        {" "}{a.matchesOptimiser ? null : <Chip tone="warning">Not the optimiser&apos;s pick</Chip>}
                        <span className="block text-ink-700">{a.why}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </ActionForm>
          )}
          {latest.status === "proposed" && dispatches ? (
            <ActionForm action={setPlanAside} submit="Set aside" hidden={{ id: latest.id }} tone="quiet" className="mt-3" />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
