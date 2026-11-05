import { payExtras as px } from "@opentradesos/core";
import type { tipRules } from "@opentradesos/api/services";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { removeJobTipRule, setJobTipRule } from "./tip-rule-actions";

type JobTipRuleData = Awaited<ReturnType<typeof tipRules.forJob>>;

/**
 * HOW A TIP ON THIS JOB IS SHARED, ON THE JOB'S OWN PAGE
 *
 * Says the rule a tip arriving today would be shared by and where it comes
 * from (this job's own, its kind of work's, a crew's, the people's own or
 * the company's), worked out exactly as a tip is shared. Whoever declares
 * what people are owed (`payroll:configure`) can give the job a rule of its
 * own here, or take it off, without going to Pay rules for its number.
 */
export function JobTipRule({ jobId, data, configures }: { jobId: string; data: JobTipRuleData; configures: boolean }) {
  const { own, today } = data;
  return (
    <section aria-labelledby="job-tip-rule" className="mt-6">
      <h2 id="job-tip-rule" className="text-base font-semibold">How a tip on this job is shared</h2>
      <p className="mt-1 text-sm text-ink-700">
        A tip that arrived today: <span className="font-medium text-ink-900">{today.ruleLabel}</span>.
        {" "}That is {today.sourceLabel}.
        {today.people.length > 0 ? ` Shared between ${today.people.join(", ")}.` : " Nobody is on the job's visits yet, so there is nobody to share it with."}
      </p>
      {today.note ? <p className="mt-1 text-sm text-ink-700">{today.note}</p> : null}
      {own ? (
        <p className="mt-2 text-sm text-ink-700">
          This job has its own rule: {own.ruleLabel}.{own.note ? ` Why: ${own.note}` : ""}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-700">This job has no rule of its own.</p>
      )}
      <p className="mt-1 text-sm text-ink-700">
        A change applies from the next tip. Tips already shared keep the rule they were shared by.
      </p>
      {configures ? (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <ActionForm action={setJobTipRule} submit={own ? "Change this job's rule" : "Give this job its own rule"}
                      hidden={{ jobId }} className="flex flex-wrap items-end gap-3">
            <Select label="Share tips on this job" name="rule" defaultValue={own?.rule ?? "lead"}
                    options={px.TIP_SPLIT_RULES.map((rule) => ({ value: rule, label: px.TIP_SPLIT_LABEL[rule] }))} />
            <TextField label="Why (optional)" name="note" defaultValue={own?.note ?? ""} />
          </ActionForm>
          {own ? (
            <ActionForm action={removeJobTipRule} submit="Take this job's rule off" tone="quiet"
                        hidden={{ jobId, id: own.id }} className="flex items-end" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
