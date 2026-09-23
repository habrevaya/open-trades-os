"use client";

import { useActionState } from "react";
import { satisfyObligation, waiveObligation } from "./actions";

/**
 * Met, or deliberately not met.
 *
 * Both ask for words and the service refuses either without them. The reason
 * is the same in both directions: a scorecard built from rows recording only
 * that somebody clicked cannot be shown to the customer holding the contract
 * it came from, and a waiver with no reason is indistinguishable from
 * forgetting.
 */
export function ObligationActions({ id }: { id: string }) {
  const [satisfied, satisfy, satisfying] = useActionState(satisfyObligation, null);
  const [waived, waive, waiving] = useActionState(waiveObligation, null);
  const error = (satisfied && "error" in satisfied && satisfied.error)
    || (waived && "error" in waived && waived.error);

  return (
    <div className="mt-3">
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}

      <div className="flex flex-wrap items-end gap-2">
        <form action={satisfy} className="flex items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input
            name="satisfiedByEvent"
            placeholder="What satisfied it"
            className="h-8 w-56 rounded border border-steel-300 px-2 text-sm"
          />
          <button
            type="submit"
            disabled={satisfying}
            className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60"
          >
            {satisfying ? "Saving" : "Met"}
          </button>
        </form>

        <form action={waive} className="flex items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input
            name="reason"
            placeholder="Why it will not be met"
            className="h-8 w-56 rounded border border-steel-300 px-2 text-sm"
          />
          <button
            type="submit"
            disabled={waiving}
            className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60"
          >
            {waiving ? "Saving" : "Waive"}
          </button>
        </form>
      </div>
    </div>
  );
}
