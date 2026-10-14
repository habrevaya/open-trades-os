/**
 * NOTES ON A CUSTOMER
 *
 * "Prefers mornings", "the side gate sticks", "disputed the March invoice,
 * Dana agreed to take $40 off the next one". The things somebody in the
 * office learns on the phone and the next person needs to know before they
 * pick it up.
 *
 * DATED AND SIGNED, AND ADDED TO RATHER THAN REWRITTEN. A note is a record of
 * what somebody said on a day, and a box anybody can overwrite is a record of
 * whatever the last person typed. So a note can be corrected by its author for
 * a short while after writing it (the typo spotted as it is saved), and after
 * that a correction is a new note that names the one it corrects. Nothing
 * deletes one. That is the conservative reading of what a customer file is,
 * and it is what makes "who told the customer that" answerable a year later.
 *
 * Pure, so the screen, the API and the import all hold the same rules.
 */

/** Long enough for a phone call written up properly, short enough not to be a document. */
export const MAX_NOTE_LENGTH = 4000;

/**
 * How long after writing a note its author may still change it.
 *
 * Long enough to fix what was mistyped while the call is still fresh, short
 * enough that nobody else has read it and acted on it yet. After this the
 * note stands, and a correction is a new note.
 */
export const EDIT_WINDOW_MINUTES = 15;

export type NoteVerdict =
  | { ok: true; body: string }
  | { ok: false; message: string };

/**
 * A note as somebody typed it, cleaned, or why it cannot be one.
 *
 * Only the ends are trimmed. Line breaks inside are kept, because a note
 * written as three short lines was written that way to be read that way.
 */
export function normalizeNote(raw: string): NoteVerdict {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body === "") return { ok: false, message: "Write something in the note first." };
  if (body.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      message: `A note can be ${MAX_NOTE_LENGTH} characters and this one is ${body.length}. Split it into two notes.`,
    };
  }
  return { ok: true, body };
}

/** Where a note came from. Only a typed note has an author who may change it. */
export type NoteOrigin = "typed" | "carried" | "imported";

/** The last moment a note may be changed, or null for a note nobody may change. */
export function editableUntil(note: { origin: string; createdAt: Date }): Date | null {
  if (note.origin !== "typed") return null;
  return new Date(note.createdAt.getTime() + EDIT_WINDOW_MINUTES * 60_000);
}

export type EditVerdict = { ok: true } | { ok: false; message: string };

/**
 * Whether this person may change this note now.
 *
 * Only its author, and only inside the window. A note brought in from a file
 * or carried over from the old notes box has no author here, so nobody may
 * change it: it says what the old system said.
 */
export function mayEdit(
  note: { origin: string; authorUserId: string | null; createdAt: Date },
  userId: string,
  now: Date,
): EditVerdict {
  if (note.origin === "imported") {
    return { ok: false, message: "This note came in from a file, so it stays as the file said. Add a new note to correct it." };
  }
  if (note.origin === "carried") {
    return { ok: false, message: "This note was carried over from the old notes box, so it stays as it was. Add a new note to correct it." };
  }
  if (note.authorUserId !== userId) {
    return { ok: false, message: "Only the person who wrote a note can change it. Add a new note to correct it." };
  }
  const until = editableUntil(note)!;
  if (now.getTime() > until.getTime()) {
    return {
      ok: false,
      message: `A note can be changed for ${EDIT_WINDOW_MINUTES} minutes after it is written, and this one is older. Add a new note to correct it.`,
    };
  }
  return { ok: true };
}
