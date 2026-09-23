"use client";

import { useActionState } from "react";
import { billInstalment } from "./actions";

export function BillButton({
  agreementId, agreementBillingId,
}: { agreementId: string; agreementBillingId: string }) {
  const [state, submit, pending] = useActionState(billInstalment, null);

  return (
    <form action={submit}>
      <input type="hidden" name="agreementBillingId" value={agreementBillingId} />
      <input type="hidden" name="agreementId" value={agreementId} />
      <button type="submit" disabled={pending}
              className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Invoicing" : "Invoice it"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="ml-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
