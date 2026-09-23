"use client";

import { useActionState } from "react";
import { publishAutomation } from "../actions";
import { Builder, type StepOption } from "../Builder";

export function EditForm({
  id, events, steps, initial,
}: {
  id: string;
  events: string[];
  steps: StepOption[];
  initial: React.ComponentProps<typeof Builder>["initial"];
}) {
  const [state, submit, pending] = useActionState(publishAutomation, null);

  return (
    <form action={submit} className="mt-4">
      <input type="hidden" name="id" value={id} />
      <Builder events={events} steps={steps} initial={initial} />

      {state && "error" in state && state.error ? (
        <p role="alert" className="mt-4 rounded-md border border-red-600 bg-red-tint p-3 text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state && "done" in state && state.done ? (
        <p className="mt-4 text-sm text-ink-700">Published.</p>
      ) : null}

      <button
        type="submit" disabled={pending}
        className="mt-6 inline-flex h-9 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60"
      >
        {pending ? "Publishing" : "Publish a new version"}
      </button>
    </form>
  );
}
