"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState } from "react";

/**
 * The two server actions are PASSED IN rather than imported.
 *
 * `./actions` is a `"use server"` module, so importing it from a client component
 * pulls `server-only` into anything that loads this file, including a render test,
 * which then fails to collect. Every other screen built over a service does it
 * this way for the same reason, and the cost is two props.
 */
type State = { error?: string; moved?: string[] } | null;
type Action = (previous: State, form: FormData) => Promise<State>;

/**
 * What a candidate reads as in the dropdown.
 *
 * Exported so a render test can check it without opening the form, which is
 * behind a toggle: a destructive control that is open by default is one somebody
 * submits by accident.
 */
export const candidateLabel = (candidate: { name: string; because: string }): string =>
  `${candidate.name}: ${candidate.because}`;

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
  removeAction, mergeAction, id, name, deletable, blockedBy, wouldRemove, candidates,
}: {
  removeAction: Action;
  mergeAction: Action;
  id: string;
  name: string;
  deletable: boolean;
  blockedBy: { label: string; n: number }[];
  wouldRemove: { label: string; n: number }[];
  /** Each one carries WHY it is a candidate, which is what the decision turns on. */
  candidates: { id: string; name: string; because: string }[];
}) {
  const [removeState, removeForm, removing] = useKeptAction(removeAction, null);
  const [mergeState, mergeForm, merging] = useKeptAction(mergeAction, null);
  const [confirming, setConfirming] = useState(false);
  const [joining, setJoining] = useState(false);

  const error = [removeState, mergeState].map((state) => state?.error).find(Boolean);
  const moved = mergeState?.moved ?? null;

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

        {candidates.length > 0 ? (
          <button type="button" onClick={() => setJoining((was) => !was)} className={BUTTON}>
            {joining ? "Cancel" : `Merge a duplicate into this one (${candidates.length})`}
          </button>
        ) : (
          /*
            Said rather than left as an absent button. A missing control reads as
            a feature somebody does not have access to, and the truth is more
            useful: nothing matches, so there is nothing to merge.
          */
          <p className="text-sm text-ink-500">
            No other record shares this phone number or email, or has a close enough name, so there
            is nothing to merge.
          </p>
        )}
      </div>

      {confirming && (
        <form {...removeForm} className="mt-3 rounded-md border border-red-600/20 bg-red-tint p-3">
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
        <form {...mergeForm} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-steel-200 p-3">
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
              {/*
                The reason is in the label, not behind a hover. "Same phone
                number" is what makes somebody confident, and a bare list of
                names is a list they have to verify somewhere else.
              */}
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidateLabel(candidate)}
                </option>
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
