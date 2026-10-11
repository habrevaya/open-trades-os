import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { sendToBooksAgain } from "@/lib/books-actions";

export interface DeletedInBooksFlag {
  linkId: string;
  books: string;
  noticedAt: string;
}

/**
 * A RECORD THE BOOKS NO LONGER HOLD
 *
 * Said on the record itself, because that is where somebody looks when the
 * books and this product disagree: it was sent, it was deleted over there,
 * and nothing has been sent again or reversed here. Somebody who runs the
 * sync can send it again from here; anybody else is told the bookkeeper has
 * a task about it.
 */
export function DeletedInBooks({
  flag, what, path, timezone, canSend,
}: {
  flag: DeletedInBooksFlag;
  /** "This journal", "This use of the credit". */
  what: string;
  /** The page to refresh after sending it again. */
  path: string;
  timezone: string;
  canSend: boolean;
}) {
  return (
    <div role="note" className="mt-2 rounded border border-amber-700 bg-amber-tint px-3 py-2 text-sm text-ink-900">
      <p>
        {what} was deleted in {flag.books}. We noticed on {formatIn(flag.noticedAt, timezone)}. Nothing has been sent
        again or taken back here, and the bookkeeper has a task to decide which is right.
      </p>
      {canSend ? (
        <ActionForm action={sendToBooksAgain} submit={`Send it to ${flag.books} again`} tone="quiet"
                    hidden={{ linkId: flag.linkId, path }} className="mt-2" />
      ) : null}
    </div>
  );
}
