"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { setRenewalDaysForTicked } from "./bulk-actions";

/**
 * Set the days ahead on every ticked card at once. The ticks are in the list below, each a checkbox
 * that names this form, so the per card buttons there stay forms of their own.
 */
export const BULK_FORM = "bulk-renewal-days";

/** Every box in the list below that this form owns: one per card that expires. */
const boxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${BULK_FORM}"][name="id"]`));

/**
 * `most` is the most cards one change takes (the service's own limit, passed from the page so the two
 * cannot differ). "Tick every card" ticks the first `most` in the order the list shows them and says so
 * when there are more, because the service refuses a longer set whole.
 */
export function BulkRenewalDays({ most }: { most: number }) {
  const [state, form, pending] = useKeptAction(setRenewalDaysForTicked, null);
  const [note, setNote] = useState<string | null>(null);
  const tickEvery = () => {
    const all = boxes();
    all.forEach((box, i) => { box.checked = i < most; });
    setNote(all.length === 0 ? "No card below expires, so there is nothing to tick."
      : all.length > most
        ? `Ticked the first ${most} of ${all.length} cards, which is the most one change takes. Set those, then tick the rest.`
        : `Ticked ${all.length === 1 ? "the 1 card" : `all ${all.length} cards`}.`);
  };
  const clearTicks = () => {
    boxes().forEach((box) => { box.checked = false; });
    setNote("Cleared every tick.");
  };
  return (
    <form id={BULK_FORM} {...form} className="mt-2 flex flex-wrap items-end gap-3 rounded-md border border-steel-200 bg-canvas p-3">
      <label className="grid gap-1 text-sm text-ink-700">
        Days ahead for the ticked cards
        <input name="renewalLeadDays" inputMode="numeric" placeholder="Blank follows each kind's number"
               className="h-9 w-64 rounded border border-steel-300 px-2 text-sm" />
      </label>
      <button type="button" onClick={tickEvery}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
        Tick every card
      </button>
      <button type="button" onClick={clearTicks}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
        Clear the ticks
      </button>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : "Set days ahead on the ticked cards"}
      </button>
      <p className="basis-full text-xs text-ink-500">
        Tick the cards below that expire, one by one or with "Tick every card". All or nothing: if one cannot take a number, nothing changes and it is named.
      </p>
      {note ? <p role="status" className="basis-full text-sm text-ink-700">{note}</p> : null}
      {state?.done && state.message ? <p role="status" className="basis-full text-sm text-ink-700">{state.message}</p> : null}
      {state && !state.done && state.error ? <p role="alert" className="basis-full text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
