import { ActionForm, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

const hours = (value: string | number) => {
  const n = Number(value);
  return `${Number.isInteger(n) ? n : n.toFixed(2)} crew ${n === 1 ? "hour" : "hours"}`;
};

/**
 * CREW HOURS AGAINST THE BUDGET
 *
 * What the job was budgeted, people times hours, and what the crew has
 * punched on it so far, each person separately: the two numbers the budgeted
 * hour variance compares. The budget is set before the work and fixed from
 * the first punch, so the form goes away then and the page says why: hours the
 * customer agreed to add go on a change order, which the figure takes off.
 */
export function CrewBudget({
  jobId, budget, writes, action,
}: {
  jobId: string;
  budget: { budgetedHours: string | null; crewHours: string; approvedChangeHours: string; punchStillRunning: boolean; locked: boolean };
  writes: boolean;
  action: Action;
}) {
  const used = Number(budget.crewHours);
  /**
   * Most jobs are never budgeted in hours (a service call is not), so a job
   * with no budget shows a closed "Budget the crew hours" for whoever may set
   * one and nothing for anybody else.
   */
  if (!budget.budgetedHours) {
    if (!writes || budget.locked) return null;
    return (
      <details className="mt-4 rounded-md border border-steel-200 p-4">
        <summary className="cursor-pointer text-sm font-medium">Budget the crew hours</summary>
        <ActionForm action={action} submit="Save the budget" hidden={{ jobId }} className="mt-3 space-y-3">
          <TextField label="Crew hours budgeted (people times hours, with the drive)" name="budgetedHours" inputMode="decimal" />
          <p className="text-xs text-ink-500">
            Set it before the work: it is fixed once an hour is punched on the job. The budgeted hour variance reads it.
          </p>
        </ActionForm>
      </details>
    );
  }
  return (
    <section aria-label="Crew hours" className="mt-6 text-sm">
      <h2 className="text-base font-semibold">Crew hours</h2>
      <p className="mt-1">
        Budgeted {hours(budget.budgetedHours)}. {used > 0 ? <>Punched so far: {hours(used)}.</> : "Nothing punched yet."}
        {Number(budget.approvedChangeHours) > 0
          ? <> Change orders the customer approved add {hours(budget.approvedChangeHours)}.</> : null}
        {budget.punchStillRunning ? " Somebody is still on the clock." : null}
      </p>
      {writes && !budget.locked ? (
        <ActionForm action={action} submit="Save the budget" tone="quiet" hidden={{ jobId }}
                    className="mt-2 flex flex-wrap items-end gap-3">
          <TextField label="Crew hours budgeted (people times hours, with the drive)" name="budgetedHours"
                     inputMode="decimal" defaultValue={budget.budgetedHours ? String(Number(budget.budgetedHours)) : ""}
                     className="block w-72" />
        </ActionForm>
      ) : null}
      {budget.locked ? (
        <p className="mt-1 text-xs text-ink-500">
          The budget is fixed now that hours are punched on the job. If the customer agrees to more work, put the
          hours on a change order.
        </p>
      ) : null}
    </section>
  );
}
