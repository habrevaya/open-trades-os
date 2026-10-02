import type { ReactNode } from "react";
import { Chip, Money } from "@opentradesos/ui";
import { money } from "@opentradesos/core";

export const PROJECT_STATUS: Record<string, string> = {
  planning: "Planning", active: "Active", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled",
};
export const PHASE_STATUS: Record<string, string> = {
  not_started: "Not started", in_progress: "In progress", blocked: "Blocked", complete: "Complete",
};
const PHASE_TONE: Record<string, "neutral" | "info" | "warning" | "success"> = {
  not_started: "neutral", in_progress: "info", blocked: "warning", complete: "success",
};

export interface ProjectViewData {
  name: string;
  status: string;
  description: string | null;
  startsOn: string | null;
  targetCompletionOn: string | null;
  contractValue: string | null;
  unscheduledValue: string | null;
  phaseList: {
    id: string; sequence: number; name: string; status: string; dependsOnPhaseId: string | null;
    billingValue: string | null; startsOn: string | null; endsOn: string | null; jobIds: string[];
  }[];
  draws: {
    id: string; sequence: number; label: string; projectPhaseId: string | null;
    percent: string | null; amount: string; invoiceId: string | null; raisedAt: Date | string | null;
  }[];
}

export interface BudgetData {
  contractValue: string | null;
  budgetCost: string | null;
  revenue: string;
  materialCost: string;
  labourCost: string;
  grossMargin: string;
  costVariance: string | null;
  billedToDate: string;
  leftToBill: string | null;
  scheduledHours: string;
  actualHours: string;
  provisional: string[];
}

/**
 * A project: its phases in order with what each waits for, the billing
 * schedule against the contract, and, for whoever may read cost, budget
 * against actual. The controls are passed in so this renders in a test.
 */
export function ProjectView({
  project, budget, phaseControls, drawControls,
}: {
  project: ProjectViewData;
  budget: BudgetData | null;
  phaseControls?: (phase: ProjectViewData["phaseList"][number]) => ReactNode;
  drawControls?: (draw: ProjectViewData["draws"][number]) => ReactNode;
}) {
  const phaseName = new Map(project.phaseList.map((p) => [p.id, p.name]));
  return (
    <>
      {project.description && <p className="mt-2 max-w-prose text-sm text-ink-700">{project.description}</p>}
      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div><dt className="text-ink-500">Contract</dt><dd>{project.contractValue ? <Money value={project.contractValue} /> : "Not set"}</dd></div>
        <div><dt className="text-ink-500">Dates</dt><dd>{project.startsOn ?? "?"} to {project.targetCompletionOn ?? "?"}</dd></div>
        {project.unscheduledValue && Number(project.unscheduledValue) > 0 && (
          <div><dt className="text-ink-500">Not yet in a draw</dt><dd><Money value={project.unscheduledValue} /></dd></div>
        )}
      </dl>

      <h2 className="mt-8 text-base font-semibold">Phases</h2>
      {project.phaseList.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No phases yet.</p>
      ) : (
        <ol className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {project.phaseList.map((phase) => (
            <li key={phase.id} className="bg-canvas p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-sm tabular-nums text-ink-500">{phase.sequence}</span>
                <span className="flex-1 font-medium">{phase.name}</span>
                {phase.billingValue && <span className="text-sm tabular-nums"><Money value={phase.billingValue} /></span>}
                <Chip tone={PHASE_TONE[phase.status] ?? "neutral"}>{PHASE_STATUS[phase.status] ?? phase.status}</Chip>
              </div>
              <p className="ml-8 mt-1 text-xs text-ink-500">
                {phase.dependsOnPhaseId && <>Waits for {phaseName.get(phase.dependsOnPhaseId) ?? "another phase"}. </>}
                {phase.jobIds.length === 0
                  ? "No job yet."
                  : phase.jobIds.map((id, i) => (
                    <a key={id} href={`/jobs/${id}`} className="mr-2 underline underline-offset-4">Job {i + 1}</a>
                  ))}
              </p>
              {phaseControls && <div className="ml-8 mt-2">{phaseControls(phase)}</div>}
            </li>
          ))}
        </ol>
      )}

      <h2 className="mt-8 text-base font-semibold">Billing schedule</h2>
      {project.draws.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No draws planned.</p>
      ) : (
        <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {project.draws.map((draw) => (
            <li key={draw.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
              <span className="flex-1">
                {draw.label}
                {draw.projectPhaseId && <span className="text-ink-500"> · {phaseName.get(draw.projectPhaseId)}</span>}
                {draw.percent && <span className="text-ink-500"> · {(Number(draw.percent) * 100).toFixed(0)}%</span>}
              </span>
              <span className="tabular-nums"><Money value={draw.amount} /></span>
              {draw.invoiceId
                ? <a href={`/invoices/${draw.invoiceId}`} className="underline underline-offset-4">Invoiced</a>
                : drawControls ? drawControls(draw) : <Chip tone="neutral">Planned</Chip>}
            </li>
          ))}
        </ul>
      )}

      {budget && (
        <section aria-label="Budget against actual" className="mt-8">
          <h2 className="text-base font-semibold">Budget against actual</h2>
          {budget.provisional.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-700">
              {budget.provisional.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          <dl className="mt-2 grid grid-cols-2 gap-3 rounded-md border border-steel-200 bg-canvas p-4 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-500">Billed</dt><dd><Money value={budget.billedToDate} /></dd></div>
            <div><dt className="text-ink-500">Left to bill</dt><dd>{budget.leftToBill ? <Money value={budget.leftToBill} /> : "No schedule"}</dd></div>
            <div><dt className="text-ink-500">Budgeted cost</dt><dd>{budget.budgetCost ? <Money value={budget.budgetCost} /> : "Not set"}</dd></div>
            <div><dt className="text-ink-500">Cost so far</dt><dd>
              <Money value={money.toString(money.add(money.money(budget.materialCost, "USD"), money.money(budget.labourCost, "USD")))} />
            </dd></div>
            {/* Budget less actual: positive is room left, negative is an overrun. */}
            <div><dt className="text-ink-500">{budget.costVariance?.startsWith("-") ? "Over budget by" : "Under budget by"}</dt>
              <dd className={budget.costVariance?.startsWith("-") ? "text-red-600" : undefined}>
                {budget.costVariance
                  ? <Money value={budget.costVariance.replace(/^-/, "")} />
                  : "No budget"}
              </dd></div>
            <div><dt className="text-ink-500">Gross margin</dt><dd><Money value={budget.grossMargin} /></dd></div>
            <div><dt className="text-ink-500">Hours, planned and actual</dt><dd>{Number(budget.scheduledHours)} / {Number(budget.actualHours)}</dd></div>
          </dl>
        </section>
      )}
    </>
  );
}
