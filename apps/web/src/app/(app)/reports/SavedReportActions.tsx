"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { deleteReport } from "./actions";

/**
 * Deleting a saved report, with the name in the confirmation.
 *
 * A saved report is shared: everybody in the company sees the same list, so
 * the person deleting one is usually deleting somebody else's. The name in
 * the prompt is the difference between "are you sure" and knowing what you
 * are about to take away.
 */
export function SavedReportActions({ id, name }: { id: string; name: string }) {
  const [state, removeForm, removing] = useKeptAction(deleteReport, null);

  return (
    <form
      {...removeForm}
      onSubmit={(event) => {
        if (!confirm(`Delete "${name}"? Everybody loses it.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={removing} className="text-ink-500 hover:text-red-600 hover:underline disabled:opacity-60">
        {removing ? "Deleting" : "Delete"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="ml-2 text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
