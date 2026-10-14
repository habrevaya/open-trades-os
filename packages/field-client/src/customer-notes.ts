import type { FieldCustomerNote } from "./wire";

/**
 * THE OFFICE'S NOTES ON THE CUSTOMER, AS THE PHONE SHOWS THEM
 *
 * What somebody in the office learned about this customer and marked for
 * whoever goes out (M03): "dog is friendly, gate sticks", "owner wants the
 * old part back". They ride in the day with the visit, so they are there in a
 * basement with no signal, and a note marked afterwards arrives on the next
 * sync. The phone only reads them: a note is written and fixed in the office,
 * and the rest of the customer's notes never leave it.
 *
 * The server already sends pinned notes first and newest first. The phone
 * sorts again anyway, because a day saved by an older build of the app or a
 * server that changed its mind about the order must not put a pinned
 * instruction below a month old remark.
 */
export const CUSTOMER_NOTES_LIMIT = 20;

/** Pinned first, then newest first, a stable order for notes written in the same instant, at most `limit`. */
export function customerNotesToShow(
  notes: readonly FieldCustomerNote[] | undefined, limit = CUSTOMER_NOTES_LIMIT,
): FieldCustomerNote[] {
  return (notes ?? []).map((note, i) => ({ note, i }))
    .sort((a, b) =>
      Number(b.note.pinned) - Number(a.note.pinned)
      || Date.parse(b.note.notedAt) - Date.parse(a.note.notedAt)
      || a.i - b.i)
    .map((x) => x.note)
    .slice(0, limit);
}

/**
 * The small line under a note: "Pinned. Dana, Oct 3, 2026". The date is read in the company's own zone, so a
 * note written on a Texas evening is not dated tomorrow.
 */
export function customerNoteLine(note: FieldCustomerNote, zone: string): string {
  const when = new Date(note.notedAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: zone,
  });
  return `${note.pinned ? "Pinned. " : ""}${note.by ? `${note.by}, ` : ""}${when}`;
}
