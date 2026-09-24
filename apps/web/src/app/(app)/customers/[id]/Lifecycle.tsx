"use client";

import { useActionState, useState } from "react";
import { removeCustomer, mergeCustomer } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";

/**
 * REMOVING A RECORD, OR JOINING IT TO ANOTHER
 *
 * Two operations that look similar and are opposites. Removing discards a
 * record; merging re-parents one. Which is right depends entirely on whether
 * money has moved, so the page asks that first and shows one or the other
 * rather than both with a rule in a tooltip.
 *
 * WHAT WOULD GO IS LISTED BEFORE THE CLICK. A delete refused afterwards,
 * with a list of reasons, is a worse version of the same information, and a
 * delete that succeeds and quietly takes eleven other rows is worse again.
 */
export function Lifecycle({
  id, name, deletable, blockedBy, wouldRemove, candidates,
}: {
  id: string;
  name: string;
  deletable: boolean;
  blockedBy: { label: string; n: number }[];
  wouldRemove: { label: string; n: number }[];
  candidates: { id: string; name: string }[];
}) {
  const [removeState, remove, removing] = useActionState(removeCustomer, null);
  const [mergeState, merge, merging] = useActionState(mergeCustomer, null);
  const [confirming, setConfirming] = useState(false);
  const [joining, setJoining] = useState(false);

  const error = [removeState, mergeState]
    .map((state) => (state && "error" in state ? state.error : null))
    .find(Boolean);
  const moved = mergeState && "moved" in mergeState ? mergeState.moved : null;

  return (
    <div className="mt-10 border-t border-steel-200 pt-6">
      <h2 className="text-base font-semibold">This record</h2>

      {moved && moved.length > 0 && (
        <p className="mt-2 rounded-md border border-green-700/20 bg-green-tint p-3 text-sm text-ink-900">
          Merged. {moved.join(", ")} now belong to {name}.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {deletable ? (
          <button type="button" onClick={() => setConfirming((was) => !was)} className={BUTTON}>
            {confirming ? "Keep it" : "Remove this record"}
          </button>
        ) : (
          /*
            No button at all, rather than a disabled one. The reason is the
            useful part and a disabled control makes somebody hunt for it.
          */
          <p className="max-w-prose text-sm text-ink-700">
            This customer has {blockedBy.map((b) => `${b.n} ${b.label}`).join(", ")}, so they
            cannot be removed: money that has moved has to stay explicable. If
            this is a duplicate, merge them into the real record instead.
          </p>
        )}

        {candidates.length > 0 && (
          <button type="button" onClick={() => setJoining((was) => !was)} className={BUTTON}>
            {joining ? "Cancel" : "Merge another record into this one"}
          </button>
        )}
      </div>

      {confirming && (
        <form action={remove} className="mt-3 rounded-md border border-red-600/20 bg-red-tint p-3">
          <input type="hidden" name="id" value={id} />
          <p className="text-sm text-ink-900">
            {wouldRemove.length === 0
              ? `Nothing else points at ${name}.`
              : `This also takes ${wouldRemove.map((w) => `${w.n} ${w.label}`).join(", ")}.`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="remove-reason">Why</label>
            <input id="remove-reason" name="reason" required
                   placeholder="Why this record is going"
                   className="h-8 min-w-72 rounded border border-steel-300 px-2 text-sm" />
            <button type="submit" disabled={removing} className={BUTTON}>
              {removing ? "Removing" : "Remove it"}
            </button>
          </div>
        </form>
      )}

      {joining && (
        <form action={merge} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-steel-200 p-3">
          <input type="hidden" name="keepId" value={id} />
          <div>
            <label htmlFor="merge-id" className="block text-xs text-ink-500">
              {/*
                Named in the direction the click means. "Merge X into this
                one" and "merge this one into X" are opposite operations and
                a control labelled just "merge" makes somebody guess which.
              */}
              Which record is the duplicate
            </label>
            <select id="merge-id" name="mergeId" required
                    className="mt-1 h-8 min-w-64 rounded border border-steel-300 px-2 text-sm">
              <option value="">Pick one</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={merging} className={BUTTON}>
            {merging ? "Merging" : `Merge into ${name}`}
          </button>
          <span className="text-xs text-ink-500">
            Everything moves here. The duplicate is kept and points at this
            record, so old links still work.
          </span>
        </form>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
