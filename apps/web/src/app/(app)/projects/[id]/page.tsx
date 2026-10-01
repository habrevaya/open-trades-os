import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ActionForm } from "../ActionForm";
import { PHASE_STATUS, PROJECT_STATUS, ProjectView } from "../ProjectView";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/** What a phase may move to next, in the order work goes. */
const NEXT: Record<string, string[]> = {
  not_started: ["in_progress", "blocked"],
  in_progress: ["complete", "blocked"],
  blocked: ["in_progress"],
  complete: ["in_progress"],
};

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const project = await projects.handlers.getProject(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  /**
   * Budget against actual for whoever may read cost and the financial
   * reports. The service refuses a caller scoped to some of the company's
   * jobs rather than narrowing, so that refusal hides the section too.
   */
  const budget = can(user.actor, "job.cost:read") && can(user.actor, "report.financial:read")
    ? await projects.handlers.getProjectProfitability(ctx, { id }).catch(() => null)
    : null;
  const writes = can(user.actor, "job:write");
  const bills = can(user.actor, "invoice:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/projects">Projects</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Chip tone="neutral">{PROJECT_STATUS[project.status] ?? project.status}</Chip>
      </div>

      {writes && (
        <div className="mt-3 flex flex-wrap gap-3">
          <ActionForm op="status" projectId={id} label="Change status" tone="quiet">
            <select name="status" defaultValue={project.status} className={input}>
              {Object.entries(PROJECT_STATUS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </ActionForm>
          {project.phaseList.some((p) => p.jobIds.length === 0) && (
            <ActionForm op="materialise" projectId={id} label="Create a job for each phase without one" tone="quiet" />
          )}
        </div>
      )}

      <ProjectView
        project={project}
        budget={budget}
        phaseControls={writes ? (phase) => (
          <ActionForm op="phase-status" projectId={id} label="Move" tone="quiet" className="flex items-center gap-2">
            <input type="hidden" name="phaseId" value={phase.id} />
            <select name="status" className={input}>
              {(NEXT[phase.status] ?? []).map((s) => <option key={s} value={s}>{PHASE_STATUS[s]}</option>)}
            </select>
          </ActionForm>
        ) : undefined}
        drawControls={bills ? (draw) => (
          <ActionForm op="raise" projectId={id} label="Raise invoice" tone="quiet">
            <input type="hidden" name="drawId" value={draw.id} />
          </ActionForm>
        ) : undefined}
      />

      {writes && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Add a phase</h2>
          <ActionForm op="phase" projectId={id} label="Add phase" className="mt-2 flex flex-wrap items-end gap-2">
            <input name="name" required placeholder="Rough-in" className={input} />
            <input name="billingValue" inputMode="decimal" placeholder="Billing value" className={`${input} w-32`} />
            <input name="budgetCost" inputMode="decimal" placeholder="Budgeted cost" className={`${input} w-32`} />
            <select name="dependsOnPhaseId" defaultValue="" className={input}>
              <option value="">Waits for nothing</option>
              {project.phaseList.map((p) => <option key={p.id} value={p.id}>Waits for {p.name}</option>)}
            </select>
          </ActionForm>
        </section>
      )}

      {bills && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Plan a draw</h2>
          <ActionForm op="draw" projectId={id} label="Plan draw" className="mt-2 flex flex-wrap items-end gap-2">
            <input name="label" required placeholder="Deposit, 30% on rough-in…" className={input} />
            <select name="phaseId" defaultValue="" className={input}>
              <option value="">Whole project</option>
              {project.phaseList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input name="percent" inputMode="decimal" placeholder="% of phase" className={`${input} w-28`} />
            <input name="amount" inputMode="decimal" placeholder="or an amount" className={`${input} w-32`} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
