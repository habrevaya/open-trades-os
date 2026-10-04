import type { branches } from "@opentradesos/api/services";
import { ActionForm } from "@/components/ActionForm";
import { setJobBranch } from "./branch-actions";

/**
 * WHICH BRANCH THIS JOB IS IN
 *
 * Nothing at all for a company with no branches, because a box asking which
 * branch a one shop company's job is in is a question with one answer.
 *
 * A choice for somebody who sees the whole company and may edit jobs. A plain
 * statement for everybody else, including a branch manager: their branch is
 * the only one they can put work in, and moving work out of it is the
 * office's call (the service refuses it in words if they try another way).
 */
export function Branch({
  jobId, current, options, writes,
}: {
  jobId: string;
  current: string | null;
  options: branches.BranchOptions;
  writes: boolean;
}) {
  if (options.branches.length === 0 && current === null) return null;
  const name = options.branches.find((b) => b.id === current)?.name;

  if (!writes || options.narrowed) {
    return (
      <p className="mt-4 text-sm text-ink-700">
        <span className="text-ink-500">Branch: </span>{name ?? (current ? "A retired branch" : "None yet")}
      </p>
    );
  }

  return (
    <ActionForm
      action={setJobBranch} tone="quiet" submit="Save branch" done="Saved."
      className="mt-4 flex flex-wrap items-end gap-3" hidden={{ jobId }}
    >
      <label className="text-sm">
        <span className="block font-medium text-ink-700">Branch</span>
        <select name="businessUnitId" defaultValue={current ?? ""} className="mt-1 h-9 rounded border border-steel-300 px-2">
          <option value="">No branch (only people who see the whole company see it)</option>
          {options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
    </ActionForm>
  );
}
