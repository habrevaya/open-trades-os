"use client";

import { useActionState } from "react";
import { deleteDashboard } from "../../actions";

/**
 * The name is in the confirmation, because a dashboard is shared: everybody
 * in the company sees the same list, so the person deleting one is usually
 * deleting somebody else's.
 *
 * The reports survive it. A dashboard is a layout pointing at them, and
 * saying so here is the difference between a click somebody makes and a
 * click they avoid for a fortnight.
 */
export function DeleteDashboard({ id, name }: { id: string; name: string }) {
  const [state, remove, removing] = useActionState(deleteDashboard, null);

  return (
    <form
      action={remove}
      onSubmit={(event) => {
        if (!confirm(`Delete "${name}"? The reports on it are not touched.`)) event.preventDefault();
      }}
      className="flex items-center gap-3"
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={removing}
              className="text-sm text-ink-500 hover:text-red-600 hover:underline disabled:opacity-60">
        {removing ? "Deleting" : "Delete this dashboard"}
      </button>
      <span className="text-xs text-ink-500">The reports on it are not deleted.</span>
      {state && "error" in state && state.error ? (
        <span role="alert" className="text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
