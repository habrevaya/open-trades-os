"use client";

import { useActionState } from "react";
import { work } from "@opentradesos/core";
import { setPriority } from "./actions";

/**
 * How urgent, with what each level means to a dispatcher.
 *
 * The meanings are on the screen rather than in a manual because the only
 * reason to set one is to change what somebody does with the job today, and a
 * scale of bare words is one every office interprets differently by the
 * second week.
 */
export function Priority({ jobId, current }: { jobId: string; current: number }) {
  const [state, submit, pending] = useActionState(setPriority, null);

  return (
    <form action={submit} className="mt-6 flex flex-wrap items-end gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <label className="text-sm">
        <span className="block font-medium text-ink-700">How urgent</span>
        <select
          name="priority" defaultValue={String(current)}
          className="mt-1 h-9 rounded border border-steel-300 px-2"
        >
          {work.JOB_PRIORITY.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}: {level.meaning}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : "Save"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
