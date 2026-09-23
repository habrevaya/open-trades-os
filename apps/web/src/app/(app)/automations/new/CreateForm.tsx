"use client";

import { useActionState } from "react";
import { createAutomation } from "../actions";
import { Builder, type StepOption, type DwellShape } from "../Builder";

export function CreateForm({
  events, steps, shapes,
}: { events: string[]; steps: StepOption[]; shapes: DwellShape[] }) {
  const [state, submit, pending] = useActionState(createAutomation, null);

  return (
    <form action={submit} className="mt-6">
      <Builder events={events} steps={steps} shapes={shapes} />

      {state && "error" in state && state.error ? (
        <p role="alert" className="mt-4 rounded-md border border-red-600 bg-red-tint p-3 text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit" disabled={pending}
        className="mt-6 inline-flex h-9 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60"
      >
        {pending ? "Saving" : "Save, switched off"}
      </button>
    </form>
  );
}
