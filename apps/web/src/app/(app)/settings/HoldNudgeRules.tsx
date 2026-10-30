import { work } from "@opentradesos/core";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { addHoldNudgeRule, removeHoldNudgeRule } from "./actions";

/**
 * THE HOLD NUDGE, WHERE IT DIFFERS BY WHY THE JOB IS WAITING OR BY BRANCH
 *
 * Under the company's own numbers ("Jobs on hold"). Each rule says what is
 * different for one reason, one branch or both, and nothing about the rest,
 * which stay as the company has them.
 */
export interface HoldNudgeRuleLine { id: string; summary: string }
export interface HoldNudgePerson { userId: string; name: string }

/** The choices for "who gets the task", in one list: the same words on both forms. */
export function holdAssignOptions(people: HoldNudgePerson[]): { value: string; label: string }[] {
  return [
    { value: "nobody", label: "Nobody in particular (the office queue)" },
    { value: "placed_by", label: "Whoever put the job on hold" },
    { value: "branch_manager", label: "The manager of the job's branch" },
    ...work.HOLD_NUDGE_ROLES.map((role) => ({ value: `role:${role}`, label: `Everybody who is ${roleName(role)}` })),
    ...people.map((p) => ({ value: `person:${p.userId}`, label: p.name })),
  ];
}

const roleName = (role: work.HoldNudgeRole): string => ({
  owner: "an owner", admin: "an administrator", office_manager: "an office manager", branch_manager: "a branch manager",
  dispatcher: "a dispatcher", csr: "on the customer service team", accountant: "an accountant",
})[role];

export function HoldNudgeRules({ rules, branches, people }: {
  rules: HoldNudgeRuleLine[]; branches: { id: string; name: string }[]; people: HoldNudgePerson[];
}) {
  return (
    <section aria-label="Hold nudges by reason and branch" className="mt-4 rounded-md border border-steel-200 p-4">
      <h2 className="font-medium text-ink-900">Different for some jobs on hold</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        A job waiting on the weather can wait longer than one waiting on a part. Add a rule for one reason, one branch,
        or both, and say only what is different. Anything you leave out stays as the company has it above. If more than
        one rule fits a job, the rule for its reason in its branch comes first, then the rule for its reason, then the
        rule for its branch. A rule applies to nudges raised from now on.
      </p>
      {rules.length === 0 ? (
        <p className="mt-3 text-sm text-ink-700">No rules yet. Every job on hold is nudged as the company says above.</p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 rounded border border-steel-200">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
              <span className="max-w-prose text-sm text-ink-900">{rule.summary}</span>
              <ActionForm action={removeHoldNudgeRule} submit="Take away" tone="quiet" hidden={{ id: rule.id }} className="m-0" />
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={addHoldNudgeRule} submit="Add rule" className="mt-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Why the job is waiting" name="reason" className="block w-64"
                  options={[{ value: "", label: "Any reason" }, ...work.HOLD_REASONS.map((r) => ({ value: r.value, label: r.label }))]} />
          <Select label="Branch" name="businessUnitId" className="block w-56"
                  options={[{ value: "", label: "Any branch" }, ...branches.map((b) => ({ value: b.id, label: b.name }))]} />
        </div>
        <p className="text-sm text-ink-500">
          Leave a box empty to keep what the company has. Tick "never" to turn that part off for these jobs.
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <NumberWithNever label="Days on hold before a nudge" name="days" never="Never nudge for these" min={1} max={90} />
          <NumberWithNever label="Days to do it by" name="dueDays" never="No due date" min={0} max={30} />
          <NumberWithNever label="Remind again every (days)" name="repeatDays" never="Never remind again" min={1} max={90} />
        </div>
        <Select label="Who gets the task" name="assignTo" className="block max-w-md"
                options={[{ value: "", label: "As the company has it" }, ...holdAssignOptions(people)]} />
      </ActionForm>
    </section>
  );
}

function NumberWithNever({ label, name, never, min, max }: { label: string; name: string; never: string; min: number; max: number }) {
  return (
    <div>
      <TextField label={label} name={name} type="number" min={min} max={max} step={1} className="block w-48" />
      <label className="mt-1 flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" name={`${name}Never`} /> {never}
      </label>
    </div>
  );
}
