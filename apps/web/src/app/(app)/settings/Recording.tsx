"use client";

import { useActionState } from "react";
import { setRecordingPolicy, removeRecordingPolicy } from "./actions";

export interface DeclaredPolicy {
  jurisdiction: string;
  rule: string;
  announcementRequired: boolean;
  note: string;
}

/**
 * CALL RECORDING
 *
 * `telephony.mayRecord` was written, tested and exported, and nothing called
 * it. The `call` table carried a `recording_consent` column under a comment
 * promising an operator could answer a question about a 2024 call, and
 * nothing wrote it. This screen is the half that was missing: the place the
 * operator states what they believe the rule is, so the refusals can quote
 * them rather than invent a position.
 *
 * The screen never states a rule itself. There is no default for Texas, no
 * list of one party states, no helpful preset. Every one of those would be
 * this product taking a legal position on somebody else's behalf, and the
 * person who would find out it was wrong is the contractor, not us.
 *
 * With nothing declared, every call resolves to unknown, which needs
 * everybody's agreement and an announcement. That is the loudest safe
 * default: the cost of it is a recording that was not made, and the cost of
 * the other one is a recording that should not exist.
 */
export function Recording({ policies }: { policies: readonly DeclaredPolicy[] }) {
  const [state, action, pending] = useActionState<
    { done?: boolean; note?: string; error?: string },
    FormData
  >(setRecordingPolicy, {});

  const [removeState, remove] = useActionState<
    { done?: boolean; note?: string; error?: string },
    FormData
  >(removeRecordingPolicy, {});

  return (
    <section className="mt-8 rounded-md border border-steel-200 p-4">
      <h2 className="font-medium text-ink-900">Call recording</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        What you believe the rule is in each place you work. The product
        applies the strictest rule any party to a call brings to it, and
        refuses to record when your own declaration does not cover somebody on
        the line. This is your statement, not legal advice from us: with
        nothing declared here, every call needs everybody{"'"}s agreement and
        an announcement.
      </p>

      {policies.length === 0 ? (
        <p className="mt-3 rounded border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700">
          Nothing declared. Recording is refused on every call until a party
          to it is somewhere you have declared a rule for.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 border-y border-steel-200">
          {policies.map((policy) => (
            <li key={policy.jurisdiction} className="flex flex-wrap items-start gap-3 py-3">
              <span className="w-24 font-medium text-ink-900">{policy.jurisdiction}</span>
              <span className="w-40 text-sm text-ink-700">
                {policy.rule === "all_party" ? "Every party must agree" : "One party is enough"}
                {policy.announcementRequired ? ", announce first" : ""}
              </span>
              <span className="min-w-48 flex-1 text-sm text-ink-500">{policy.note}</span>
              <form action={remove}>
                <input type="hidden" name="jurisdiction" value={policy.jurisdiction} />
                <button
                  type="submit"
                  className="h-8 rounded border border-steel-300 px-3 text-sm"
                >
                  Withdraw
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Place</span>
          <input
            name="jurisdiction"
            placeholder="TX"
            className="h-10 w-28 rounded border border-steel-300 px-3 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Rule</span>
          <select name="rule" className="h-10 w-56 rounded border border-steel-300 px-3 text-sm">
            {/*
              All party first, so the pointer lands on the stricter option.
              A select that opens on the permissive answer is a default in
              everything but name.
            */}
            <option value="all_party">Every party must agree</option>
            <option value="one_party">One party is enough</option>
          </select>
        </label>

        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" name="announcementRequired" defaultChecked />
          <span className="text-sm text-ink-700">Announce before recording</span>
        </label>

        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Why you say so</span>
          <input
            name="note"
            placeholder="Counsel advised this in March."
            className="h-10 rounded border border-steel-300 px-3 text-sm"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded border border-steel-300 px-4 text-sm font-medium"
        >
          {pending ? "Saving" : "Declare"}
        </button>
      </form>

      {/*
        The note is required by the service, and this says why before the
        refusal does. It is what the next person reads when they are deciding
        whether to turn recording on, and a blank one tells them nothing.
      */}
      <p className="mt-2 text-sm text-ink-500">
        The note is shown to whoever reads this screen next. Say where the
        position came from.
      </p>

      {(state.error ?? removeState.error) && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {state.error ?? removeState.error}
        </p>
      )}
      {(state.done ?? removeState.done) && (
        <p className="mt-2 text-sm text-ink-500" role="status">
          {state.note ?? removeState.note ?? "Saved."}
        </p>
      )}
    </section>
  );
}
