"use client";

import { useActionState, useState } from "react";
import { bookVisit, deliverVisit, skipVisit, unskipVisit } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";

/**
 * Book an owed visit, record that it happened, or record that the member
 * does not want it.
 *
 * SKIP ASKS FOR A REASON AND THE OTHERS DO NOT, which is the one place a
 * dialog earns its click here. Booking and delivering are recoverable and
 * self evidently true. A skip is the record of why somebody did not get what
 * they paid for, read a year later when they say they never agreed to it,
 * and a skip button with no reason produces a column full of nothing.
 *
 * IT SAYS WHAT HAPPENS TO THE MONEY. "Skipped" reads as finished with, and
 * in the ledger it is not: the slice stays deferred and unrecognised until
 * the term ends. Somebody clicking this is often the same person who will
 * later wonder why the unearned balance did not move.
 */
export function VisitActions({
  agreementId, agreementVisitId, booked, delivered, skipped, skipReason,
}: {
  agreementId: string;
  agreementVisitId: string;
  booked: boolean;
  delivered: boolean;
  skipped: boolean;
  skipReason: string | null;
}) {
  const [bookState, book, booking] = useActionState(bookVisit, null);
  const [deliverState, deliver, delivering] = useActionState(deliverVisit, null);
  const [skipState, skip, skipping] = useActionState(skipVisit, null);
  const [unskipState, unskip, unskipping] = useActionState(unskipVisit, null);
  const [asking, setAsking] = useState(false);

  const error = [bookState, deliverState, skipState, unskipState]
    .map((state) => (state && "error" in state ? state.error : null))
    .find(Boolean);

  if (delivered) return <span className="text-sm text-ink-500">delivered</span>;

  if (skipped) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-500">
          skipped{skipReason ? `: ${skipReason}` : ""}
        </span>
        <form action={unskip}>
          <input type="hidden" name="agreementVisitId" value={agreementVisitId} />
          <input type="hidden" name="agreementId" value={agreementId} />
          <button type="submit" disabled={unskipping} className={BUTTON}>
            {unskipping ? "Restoring" : "Put it back"}
          </button>
        </form>
        {error ? <span role="alert" className="text-sm text-red-600">{error}</span> : null}
      </div>
    );
  }

  if (asking) {
    return (
      <form action={skip} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="agreementVisitId" value={agreementVisitId} />
        <input type="hidden" name="agreementId" value={agreementId} />
        <label className="sr-only" htmlFor={`reason-${agreementVisitId}`}>
          Why this visit is being skipped
        </label>
        <input
          id={`reason-${agreementVisitId}`}
          name="reason"
          required
          autoFocus
          placeholder="Why? The member reads this back to you one day."
          className="h-8 min-w-64 rounded border border-steel-300 px-2 text-sm"
        />
        <button type="submit" disabled={skipping} className={BUTTON}>
          {skipping ? "Recording" : "Skip it"}
        </button>
        <button type="button" onClick={() => setAsking(false)} className={BUTTON}>
          Cancel
        </button>
        {/*
          Said before the click, not after. Somebody skipping a visit is
          deciding about the schedule and does not expect to have decided
          anything about the ledger, which is precisely why it belongs here.
        */}
        <span className="text-xs text-ink-500">
          The money stays deferred. Skipping does not earn it.
        </span>
        {error ? <span role="alert" className="text-sm text-red-600">{error}</span> : null}
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!booked && (
        <form action={book}>
          <input type="hidden" name="agreementVisitId" value={agreementVisitId} />
          <button type="submit" disabled={booking}
                  className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
            {booking ? "Booking" : "Book it"}
          </button>
        </form>
      )}
      <form action={deliver}>
        <input type="hidden" name="agreementVisitId" value={agreementVisitId} />
        <input type="hidden" name="agreementId" value={agreementId} />
        <button type="submit" disabled={delivering} className={BUTTON}>
          {delivering ? "Recording" : "Delivered"}
        </button>
      </form>
      {/*
        Not offered on a booked visit. There is a job on it, and a job is a
        technician in a van on a morning: skipping without touching the
        schedule sends somebody to a house nobody is expecting them at. The
        service refuses it too, and saying so here means the office never
        reaches the refusal.
      */}
      {!booked && (
        <button type="button" onClick={() => setAsking(true)} className={BUTTON}>
          Member declined
        </button>
      )}
      {error ? <span role="alert" className="text-sm text-red-600">{error}</span> : null}
    </div>
  );
}
