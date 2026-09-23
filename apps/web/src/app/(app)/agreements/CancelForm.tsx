"use client";

import { useActionState } from "react";
import { cancelAgreement } from "./actions";

/**
 * Cancelling, with the two decisions it actually involves.
 *
 * The reason is required because a cancellation without one is
 * indistinguishable from a mistake, and because the reason is the whole of a
 * win-back campaign. Keeping the prepayment is a policy question rather than
 * a technical one, so it is a choice on the form rather than a default an
 * accountant has to discover from the ledger.
 */
export function CancelForm({ id }: { id: string }) {
  const [state, submit, pending] = useActionState(cancelAgreement, null);

  return (
    <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="text-sm">
        <span className="block text-ink-700">Why</span>
        <input
          name="reason" required placeholder="Sold the house"
          className="mt-1 h-9 w-64 rounded border border-steel-300 px-2"
        />
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="keepThePrepayment" value="1" className="h-4 w-4" />
        We keep what they have paid
      </label>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Cancelling" : "Cancel this agreement"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
