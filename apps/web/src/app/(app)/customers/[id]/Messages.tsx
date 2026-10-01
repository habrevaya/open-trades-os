"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { textCustomer } from "./actions";

/**
 * Start a text to this customer.
 *
 * The box is offered only when they have a number and the caller may send;
 * the send itself decides consent, so a STOP is a sentence here rather than
 * a box that pretends to work.
 */
export function TextCustomer({ customerId }: { customerId: string }) {
  const [state, actionForm, pending] = useKeptAction(textCustomer, null);
  return (
    <form {...actionForm} className="mt-3">
      <input type="hidden" name="customerId" value={customerId} />
      <label className="block">
        <span className="sr-only">Message</span>
        <textarea
          name="body" rows={2} required
          placeholder="Text them"
          className="w-full rounded border border-steel-300 px-3 py-2 text-sm"
        />
      </label>
      {state && "error" in state ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>
      ) : null}
      <button
        type="submit" disabled={pending}
        className="mt-2 inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Sending" : "Send text"}
      </button>
    </form>
  );
}
