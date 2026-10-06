"use client";

import { useState } from "react";
import { membership } from "@opentradesos/core";
import { useKeptAction } from "@/lib/use-kept-action";
import { cancelAgreement } from "./actions";

/**
 * Cancelling, with the decisions it actually involves.
 *
 * The reason is required because a cancellation without one is
 * indistinguishable from a mistake, and because the reason is the whole of a
 * win-back campaign. It is chosen from a list so the retention figures can
 * tell a move or a house sale from a customer the company lost; words can go
 * with any of them, and "something else" needs them.
 *
 * A move or a sale offers to end the customer's link to the address the
 * agreement covers, which is what tells a later lapse there from churn.
 * Ticked by default, because that is what a move means, and offered rather
 * than done, because the office may know they kept it as a rental.
 *
 * Keeping the prepayment is a policy question rather than a technical one, so
 * it is a choice on the form rather than a default an accountant has to
 * discover from the ledger.
 */
export function CancelForm({ id, coversAnAddress }: { id: string; coversAnAddress: boolean }) {
  const [state, submitForm, pending] = useKeptAction(cancelAgreement, null);
  const [code, setCode] = useState("");
  const left = membership.leftTheHome(code as membership.CancellationCode);

  return (
    <form {...submitForm} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-ink-700">Why</span>
          <select
            name="reasonCode" required value={code} onChange={(event) => setCode(event.target.value)}
            className="mt-1 h-9 w-64 rounded border border-steel-300 px-2"
          >
            <option value="" disabled>Choose a reason</option>
            {membership.CANCELLATION_CODES.map((c) => (
              <option key={c} value={c}>{membership.CANCELLATION_LABEL[c]}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">{code === "other" ? "In their words" : "Anything to add"}</span>
          <input
            name="reason" required={code === "other"} placeholder={code === "other" ? "Why they cancelled" : ""}
            className="mt-1 h-9 w-64 rounded border border-steel-300 px-2"
          />
        </label>
      </div>
      {left && coversAnAddress ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="endPropertyLink" value="1" defaultChecked className="h-4 w-4" />
          They have left the address: end their link to it today
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="keepThePrepayment" value="1" className="h-4 w-4" />
          We keep what they have paid
        </label>
        <button type="submit" disabled={pending}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
          {pending ? "Cancelling" : "Cancel this agreement"}
        </button>
      </div>
      {state && "error" in state && state.error ? (
        <span role="alert" className="text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
