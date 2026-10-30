import type { FieldQueue } from "./queue";

/**
 * ASKING THE OFFICE FOR A PART
 *
 * The technician at the unit says what part it needs, in their own words, and
 * the office orders it and puts the job on hold against the order. The phone
 * never places a hold: a hold names the purchase order, which is the office's.
 * Queued like everything else, so it is asked with no signal and sent when
 * there is one; the server raises one office task naming the job, the part
 * and who asked.
 */

/** The longest the part's words may be; the server refuses more. */
export const PART_WORDS_MAX = 300;
export const PART_NOTE_MAX = 1000;

/** The part and the note as typed, checked the way the server checks them, or what is wrong in words. */
export function checkPartRequest(
  part: string, note: string,
): { ok: true; part: string; note: string | null } | { ok: false; problem: string } {
  const said = part.trim();
  if (said === "") return { ok: false, problem: "Say what part you need, in a few words." };
  if (said.length > PART_WORDS_MAX) return { ok: false, problem: `Say the part in ${PART_WORDS_MAX} characters or fewer. Put the rest in the note.` };
  const more = note.trim();
  if (more.length > PART_NOTE_MAX) return { ok: false, problem: `Keep the note to ${PART_NOTE_MAX} characters or fewer.` };
  return { ok: true, part: said, note: more === "" ? null : more };
}

/** Queue the request. Its id is made here, so a retry names the same request and the server writes it once. */
export async function recordPartRequest(
  queue: FieldQueue, input: { visitId: string; requestId: string; part: string; note: string | null },
) {
  return queue.enqueue({
    kind: "part.request",
    subjectId: input.requestId,
    payload: { visitId: input.visitId, part: input.part, ...(input.note ? { note: input.note } : {}) },
  });
}
