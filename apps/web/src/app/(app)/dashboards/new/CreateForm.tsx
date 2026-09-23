"use client";

import { useActionState } from "react";
import { createDashboard } from "../actions";

export function CreateForm() {
  const [state, submit, pending] = useActionState(createDashboard, null);

  return (
    <form action={submit} className="mt-6 flex flex-col gap-4">
      <label className="text-sm">
        <span className="block text-ink-700">Name</span>
        <input
          name="name" required placeholder="Monday morning"
          className="mt-1 h-9 w-full rounded border border-steel-300 px-2"
        />
      </label>
      <label className="text-sm">
        <span className="block text-ink-700">What it is for</span>
        <input
          name="description" placeholder="What the owner checks before the week starts"
          className="mt-1 h-9 w-full rounded border border-steel-300 px-2"
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
          {pending ? "Creating" : "Create it"}
        </button>
        <a href="/dashboards" className="text-sm text-ink-500 hover:text-ink-900">Cancel</a>
        {state && "error" in state && state.error ? (
          <span role="alert" className="text-sm text-red-600">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}
