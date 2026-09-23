"use client";

import { useActionState } from "react";
import { authorizeJob, setCoverage } from "./actions";

/**
 * The two decisions that stop an invoice: who authorised how much, and who is
 * paying for it.
 *
 * Both live on the job rather than on the invoice, because both are made
 * before anybody invoices and usually by somebody else. Whoever raises the
 * invoice finds out about them by being refused, which is exactly the wrong
 * moment unless the job says so first.
 */
export function Authorize({
  jobId, current,
}: {
  jobId: string;
  current: { amount: string | null; grantedByName: string | null; externalReference: string | null } | null;
}) {
  const [state, submit, pending] = useActionState(authorizeJob, null);

  return (
    <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <label className="text-sm">
        <span className="block text-ink-700">Authorised up to</span>
        <input
          name="amount" inputMode="decimal" placeholder="500.00"
          defaultValue={current?.amount ?? ""}
          className="mt-1 h-9 w-32 rounded border border-steel-300 px-2 font-mono"
        />
      </label>
      <label className="text-sm">
        <span className="block text-ink-700">By</span>
        <input
          name="grantedByName" placeholder="Meridian, Dana"
          defaultValue={current?.grantedByName ?? ""}
          className="mt-1 h-9 w-48 rounded border border-steel-300 px-2"
        />
      </label>
      <label className="text-sm">
        <span className="block text-ink-700">Their reference</span>
        <input
          name="authorizationReference" placeholder="WO-44812"
          defaultValue={current?.externalReference ?? ""}
          className="mt-1 h-9 w-40 rounded border border-steel-300 px-2"
        />
      </label>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : current ? "Raise it" : "Authorise"}
      </button>
      <span className="pb-2 text-xs text-ink-500">
        {/*
          Said where the field is. An empty box reading as a zero ceiling
          would refuse every invoice on the job, which is the opposite of
          what the person typing nothing meant.
        */}
        Leave the amount empty for &ldquo;bill what it costs&rdquo;.
      </span>
      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}

export function Coverage({
  jobId, sources, current,
}: {
  jobId: string;
  sources: { key: string; label: string; description: string }[];
  current: { source: string; externalReference: string | null } | null;
}) {
  const [state, submit, pending] = useActionState(setCoverage, null);

  return (
    <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <label className="text-sm">
        <span className="block text-ink-700">Who is paying</span>
        <select
          name="source" defaultValue={current?.source ?? "customer"}
          className="mt-1 h-9 rounded border border-steel-300 px-2"
        >
          <option value="">Nobody has decided</option>
          {sources.map((source) => (
            <option key={source.key} value={source.key}>{source.label}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-ink-700">Claim or reference</span>
        <input
          name="coverageReference" placeholder="44812"
          defaultValue={current?.externalReference ?? ""}
          className="mt-1 h-9 w-40 rounded border border-steel-300 px-2"
        />
      </label>
      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : "Save"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
