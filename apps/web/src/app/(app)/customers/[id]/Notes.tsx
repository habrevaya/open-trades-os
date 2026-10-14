import { customerNotes, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { addNote, editNote, pinNote } from "./note-actions";

type Note = Awaited<ReturnType<typeof customerNotes.list>>["data"][number];

/**
 * NOTES ON THIS CUSTOMER
 *
 * Dated and signed, pinned ones first. Added to rather than rewritten: the
 * person who wrote a note can fix it for a few minutes, and after that the
 * note offers "Add a correction", which writes a new note naming it. A note
 * marked for the technician says so, because that is what decides whether
 * the person at the door reads it.
 *
 * `before` is the page of older notes asked for in the address bar, so the
 * list is a link somebody can send rather than a button that loses its place.
 */
export async function Notes({
  ctx, customerId, timezone, before,
}: {
  ctx: ServiceContext;
  customerId: string;
  timezone: string;
  before?: string | undefined;
}) {
  const notes = await customerNotes.list(ctx, { id: customerId, limit: 25, cursor: before });
  const canWrite = can(ctx.actor, "customer:write");
  const all = [...notes.pinned, ...notes.data];

  return (
    <section id="notes" aria-label="Notes" className="mt-8">
      <h2 className="text-base font-semibold">Notes</h2>
      {notes.fieldOnly && (
        <p className="mt-1 text-sm text-ink-500">Only the notes the office marked for the technician.</p>
      )}

      {canWrite && (
        <ActionForm action={addNote} submit="Add note" tone="quiet" hidden={{ customerId }}
                    className="mt-3 max-w-xl space-y-2">
          <TextArea label="New note" name="body" rows={3} maxLength={4000} required
                    placeholder="What the next person should know" />
          <Checks />
        </ActionForm>
      )}

      {all.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">{before ? "No older notes." : "No notes yet."}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {all.map((note) => (
            <li key={note.id} aria-label={`Note from ${formatIn(note.notedAt, timezone)}`}
                className="rounded-md border border-steel-200 bg-canvas p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span>{formatIn(note.notedAt, timezone)}</span>
                <span>{byline(note)}</span>
                {note.pinned && <Chip tone="info">Pinned</Chip>}
                {note.forField && <Chip tone="neutral">Technician sees this</Chip>}
                {note.correctsNoteId && <Chip tone="neutral">A correction</Chip>}
                {note.editedAt && <span>Fixed by its writer</span>}
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-900">{note.body}</p>

              {canWrite && (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <ActionForm action={pinNote} submit={note.pinned ? "Unpin" : "Pin to the top"} tone="quiet"
                              hidden={{ customerId, id: note.id, pinned: note.pinned ? "no" : "yes" }}
                              className="flex items-center gap-2" />
                  {note.editableUntil ? (
                    <details className="w-full">
                      <summary className="cursor-pointer text-sm text-ink-700 underline underline-offset-4">
                        Fix this note (until {formatIn(note.editableUntil, timezone, { hour: "numeric", minute: "2-digit" })})
                      </summary>
                      <ActionForm action={editNote} submit="Save the fix" tone="quiet"
                                  hidden={{ customerId, id: note.id }} className="mt-2 max-w-xl space-y-2">
                        <TextArea label="Note" name="body" rows={3} maxLength={4000} required defaultValue={note.body} />
                        <label className="flex items-center gap-2 text-sm text-ink-700">
                          <input type="checkbox" name="forField" defaultChecked={note.forField} className="h-4 w-4" />
                          Show it to the technician on their visits
                        </label>
                      </ActionForm>
                    </details>
                  ) : (
                    <details className="w-full">
                      <summary className="cursor-pointer text-sm text-ink-700 underline underline-offset-4">
                        Add a correction
                      </summary>
                      <ActionForm action={addNote} submit="Add the correction" tone="quiet"
                                  hidden={{ customerId, correctsNoteId: note.id }} className="mt-2 max-w-xl space-y-2">
                        <TextArea label="What is right" name="body" rows={3} maxLength={4000} required />
                        <Checks forField={note.forField} />
                      </ActionForm>
                    </details>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex gap-4 text-sm">
        {before && <a href={`/customers/${customerId}#notes`} className="underline underline-offset-4">Newest notes</a>}
        {notes.nextCursor && (
          <a href={`/customers/${customerId}?notesBefore=${encodeURIComponent(notes.nextCursor)}#notes`}
             className="underline underline-offset-4">Older notes</a>
        )}
      </div>
    </section>
  );
}

/** Who wrote it, in the words a person reads. */
function byline(note: Note): string {
  if (note.origin === "carried") return "Carried over from the old notes box";
  if (note.origin === "imported") return note.externalRef ? `Brought in from ${note.externalRef.source}` : "Brought in from a file";
  return note.author?.name ? `by ${note.author.name}` : "by somebody who has left";
}

function Checks({ forField = false }: { forField?: boolean }) {
  return (
    <div className="flex flex-wrap gap-4">
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" name="forField" defaultChecked={forField} className="h-4 w-4" />
        Show it to the technician on their visits
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" name="pinned" className="h-4 w-4" />
        Keep it at the top
      </label>
    </div>
  );
}
