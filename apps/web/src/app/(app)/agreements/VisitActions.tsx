"use client";

import { useActionState } from "react";
import { bookVisit, deliverVisit } from "./actions";

/**
 * Book an owed visit, or record that it happened.
 *
 * Two buttons and no dialog. Booking makes the job and opens it, because the
 * next thing anybody does with a booked visit is schedule it, and a
 * confirmation between those two steps is a click that answers nothing.
 */
export function VisitActions({
  agreementId, agreementVisitId, booked, delivered,
}: {
  agreementId: string;
  agreementVisitId: string;
  booked: boolean;
  delivered: boolean;
}) {
  const [bookState, book, booking] = useActionState(bookVisit, null);
  const [deliverState, deliver, delivering] = useActionState(deliverVisit, null);
  const error = (bookState && "error" in bookState && bookState.error)
    || (deliverState && "error" in deliverState && deliverState.error);

  if (delivered) return <span className="text-sm text-ink-500">delivered</span>;

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
        <button type="submit" disabled={delivering}
                className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60">
          {delivering ? "Recording" : "Delivered"}
        </button>
      </form>
      {error ? <span role="alert" className="text-sm text-red-600">{error}</span> : null}
    </div>
  );
}
