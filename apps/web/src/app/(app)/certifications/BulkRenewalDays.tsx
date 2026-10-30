"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { setRenewalDaysForTicked } from "./bulk-actions";

/**
 * Set the days ahead on every ticked card at once. The ticks are in the list below, each a checkbox
 * that names this form, so the per card buttons there stay forms of their own.
 */
export const BULK_FORM = "bulk-renewal-days";

export function BulkRenewalDays() {
  const [state, form, pending] = useKeptAction(setRenewalDaysForTicked, null);
  return (
    <form id={BULK_FORM} {...form} className="mt-2 flex flex-wrap items-end gap-3 rounded-md border border-steel-200 bg-canvas p-3">
      <label className="grid gap-1 text-sm text-ink-700">
        Days ahead for the ticked cards
        <input name="renewalLeadDays" inputMode="numeric" placeholder="Blank follows each kind's number"
               className="h-9 w-64 rounded border border-steel-300 px-2 text-sm" />
      </label>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : "Set days ahead on the ticked cards"}
      </button>
      <p className="basis-full text-xs text-ink-500">
        Tick the cards below that expire. All or nothing: if one cannot take a number, nothing changes and it is named.
      </p>
      {state?.done && state.message ? <p role="status" className="basis-full text-sm text-ink-700">{state.message}</p> : null}
      {state && !state.done && state.error ? <p role="alert" className="basis-full text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
