import { unlistedPrices } from "./guardrails.js";

/**
 * SHOWING AN ANSWER AS IT IS WRITTEN
 *
 * The website chat and the field assistant show a reply while the model is
 * still writing it, the way the phone assistant speaks one (`streamReply`).
 * What is shown is held to the rule a whole answer is held to, a sentence at a
 * time: a sentence is shown only once it is finished, and the first one that
 * names an amount nobody published (or, for the field assistant, an amount
 * not in the records it was given) stops the showing there, so that amount is
 * never on the screen. Everything else about the answer (who it cites, what
 * it does, whether it is sent at all) is decided on the whole answer, and
 * what was shown while it was written is replaced by that.
 */

/** How far an answer has been shown while it was written. */
export interface Shown {
  /** How much of the written words has been dealt with. */
  upTo: number;
  /** What may be shown so far: whole sentences, as written. */
  text: string;
  /** A sentence named an amount it may not: nothing more is shown from this answer. */
  stopped: boolean;
}

export const SHOWN_START: Shown = { upTo: 0, text: "", stopped: false };

/** The most shown this way: the longest a reply or an answer may be. */
export const MAX_SHOWN = 1500;

/**
 * The answer as far as it may be shown, after more of it has been written.
 * `changed` says whether there is more to show than before, so a caller
 * writes or sends only when there is.
 */
export function showAsWritten(
  state: Shown, written: string, allowedPrices: readonly string[], maxLength = MAX_SHOWN,
): { state: Shown; changed: boolean } {
  if (state.stopped) return { state, changed: false };
  let { upTo, text } = state;
  let changed = false;
  /** A sentence ends at its stop and the space after it, or at the end of a line. */
  const boundary = /[.!?]+["')\]]*\s+|\n+/g;
  boundary.lastIndex = upTo;
  for (let match = boundary.exec(written); match; match = boundary.exec(written)) {
    const end = match.index + match[0].length;
    const piece = written.slice(upTo, end);
    if (unlistedPrices(piece, allowedPrices).length > 0) return { state: { upTo, text, stopped: true }, changed };
    if ((text + piece).trimEnd().length > maxLength) break;
    if (piece.trim() !== "") {
      text += piece;
      changed = true;
    }
    upTo = end;
  }
  return { state: { upTo, text, stopped: false }, changed };
}

/** What is shown, trimmed for the screen. */
export const shownText = (state: Shown): string => state.text.trim();
