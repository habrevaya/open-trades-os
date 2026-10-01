"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { setEnabled } from "./actions";

/**
 * On, or off, in one press.
 *
 * The reason the screen exists. An automation misbehaving is something
 * somebody needs to stop in seconds, not after a deploy and not through a
 * database client, and a confirmation dialog on the STOP direction would be
 * exactly the wrong place for one.
 */
export function EnableSwitch({ id, enabled }: { id: string; enabled: boolean }) {
  const [state, submitForm, pending] = useKeptAction(setEnabled, null);

  return (
    <form {...submitForm} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
      <button
        type="submit" disabled={pending}
        className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60"
      >
        {pending ? "Saving" : enabled ? "Turn off" : "Turn on"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
