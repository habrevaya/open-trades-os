"use client";

import { useActionState } from "react";
import { saveReport } from "../actions";

/**
 * Keeping the report you just built.
 *
 * The form resubmits the definition rather than an id, because the thing on
 * screen is the query string and nothing has been stored yet. Every field of
 * it is carried as a hidden input so the action reads the definition through
 * the same parser the page did, and a saved report always matches the one
 * whose result the person was looking at when they pressed save.
 */
export function SaveReport({ query }: { query: string }) {
  const [state, save, saving] = useActionState(saveReport, null);
  /**
   * From the canonical query the server built, not from the address bar.
   *
   * The address bar still carries the three fields the "add a filter" row
   * submitted, and the server has already packed those into `filter=`.
   * Carrying both would save a report with the filter applied twice.
   */
  const carried = [...new URLSearchParams(query).entries()];

  return (
    <form action={save} className="mt-8 rounded-md border border-steel-200 bg-canvas p-4">
      {carried.map(([key, value], index) => (
        <input key={`${key}-${index}`} type="hidden" name={key} value={value} />
      ))}

      <h2 className="text-sm font-medium text-ink-700">Save this report</h2>
      <p className="mt-1 text-xs text-ink-500">
        Everybody who can read reports will see it. What they see when they run
        it is still their own work, not yours.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-ink-700">Name</span>
          <input
            name="name" required placeholder="Overdue by customer"
            className="mt-1 h-9 w-64 rounded border border-steel-300 px-2"
          />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">What it answers</span>
          <input
            name="description" placeholder="Who are we chasing this month?"
            className="mt-1 h-9 w-72 rounded border border-steel-300 px-2"
          />
        </label>
        <button
          type="submit" disabled={saving}
          className="inline-flex h-9 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60"
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>

      {state && "error" in state && state.error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>
      ) : null}
    </form>
  );
}
