import { format, money, round } from "../money/index.js";
import { openOnly, unlistedPrices, wantsAPerson, type OpenWindow } from "./guardrails.js";

/**
 * THE PHONE ASSISTANT'S TURN, DECIDED IN CODE
 *
 * A caller says something; the carrier's speech to text hands it over as
 * words; the assistant answers with words the carrier reads aloud. Between
 * those two, this file decides everything that is not the model's to decide:
 * what it says before anybody is asked anything, when a caller is put through
 * to a person without asking the model at all, and what a model's answer
 * turns into on a live call.
 *
 * Pure, so the rules a caller lives under can be read and tested without a
 * carrier, a socket or a model.
 *
 * THE SAME FOUR PROMISES AS THE CHAT, said aloud:
 *
 *   It SAYS IT IS AUTOMATED, and that the call is written down, before
 *   anything else, in words no model wrote.
 *
 *   It PUTS THE CALLER THROUGH when they ask for a person, decided here
 *   before the model is asked, and when it has used its turns, and whenever
 *   the model is unsure or cannot be reached.
 *
 *   It QUOTES NO PRICE THE COMPANY DID NOT PUBLISH. An answer naming any other
 *   amount is not said; the caller is put through to a person instead.
 *
 *   It OFFERS ONLY OPEN WINDOWS, and a booking it takes is a request the
 *   office confirms.
 */

/**
 * The first words of every call the assistant answers.
 *
 * Said by the carrier before the caller can speak, and not interruptible,
 * because the two facts in it (a machine is answering, and the call is
 * written down) are the two a caller must have before they say anything.
 */
export function voiceDisclosure(company: string): string {
  return `Thanks for calling ${company}. You are speaking with an automated assistant, not a person, `
    + "and this call is written down for our office. Say person at any time to be put through to someone.";
}

export function openingWords(company: string, greeting: string): string {
  return `${voiceDisclosure(company)} ${speakable(greeting) || "How can I help you today?"}`;
}

export const NOT_HEARD = "Sorry, I did not catch that. Could you say it again?";
export const PUTTING_THROUGH = "Of course. Putting you through to someone now. Please hold.";
export const UNSURE = "I am not able to help with that myself, so I will put you through to someone. Please hold.";
export const LOOKING = "One moment while I look that up.";

/**
 * Words the carrier can read aloud.
 *
 * A model writes for a screen: a bulleted list, a bold word, a link, an
 * ampersand. A computer voice reads "asterisk asterisk" and "h t t p s colon
 * slash slash", which is the moment a caller decides the company is a
 * robot in the bad sense. So the marks are taken out, links are dropped, and
 * the length is held to what somebody will listen to on a phone.
 */
export function speakable(text: string, maxLength = 600): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_#`>|~]/g, "")
    .replace(/&/g, " and ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  const cut = cleaned.slice(0, maxLength);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (stop > maxLength / 3 ? cut.slice(0, stop + 1) : cut).trim();
}

/** Words that mean "a person, please" on a phone, beyond what a chat hears. */
const SPOKEN_ASKS = [
  /\b(operator|receptionist|front desk|dispatcher)\b/i,
  /^\s*(a\s+)?(person|human|someone|somebody|agent|representative)\s*(please)?\s*[.!?]*\s*$/i,
  /\b(put|transfer|connect)\s+me\s+(through|to)\b/i,
];

export const asksForPerson = (utterance: string): boolean =>
  wantsAPerson(utterance) || SPOKEN_ASKS.some((pattern) => pattern.test(utterance));

export type BeforeModel =
  /** Put the caller through, saying this first. */
  | { kind: "transfer"; reason: string; say: string }
  /** Ask them to say it again, without spending a model call on nothing. */
  | { kind: "again"; say: string }
  /** Hand it to the model. */
  | { kind: "ask" };

/**
 * What happens to the caller's words before the model is asked anything.
 *
 * `misses` is how many times running the assistant has failed to hear
 * anything; the third time a caller is put through rather than asked to
 * repeat themselves to a machine for ever.
 */
export function beforeModel(input: {
  utterance: string; turnsTaken: number; turnLimit: number; misses: number;
}): BeforeModel {
  const said = input.utterance.trim();
  if (said === "") {
    return input.misses >= 2
      ? { kind: "transfer", reason: "The assistant could not hear the caller.", say: PUTTING_THROUGH }
      : { kind: "again", say: NOT_HEARD };
  }
  if (asksForPerson(said)) return { kind: "transfer", reason: "The caller asked for a person.", say: PUTTING_THROUGH };
  if (input.turnsTaken >= input.turnLimit) {
    return {
      kind: "transfer",
      reason: `The assistant reached its limit of ${input.turnLimit} replies on one call.`,
      say: PUTTING_THROUGH,
    };
  }
  return { kind: "ask" };
}

/**
 * A key pressed while talking to the assistant.
 *
 * Zero is the key every phone system in the country has trained people to
 * press for a person, so it is honoured whatever the assistant was saying.
 * Every other key means nothing here and is ignored rather than guessed at.
 */
export function keyPressed(digit: string): BeforeModel | null {
  return digit.trim() === "0"
    ? { kind: "transfer", reason: "The caller pressed 0 for a person.", say: PUTTING_THROUGH }
    : null;
}

export interface BookingAsked {
  bookableServiceId: string;
  date: string;
  arrivalWindowId: string;
  contactName: string;
  phone: string;
  address: { line1: string; line2?: string | undefined; city: string; state: string; postalCode: string };
  notes: string | null;
}

export type VoiceDecision =
  | { kind: "say"; text: string }
  | { kind: "look_up"; query: { phone: string | null; name: string | null; postalCode: string | null }; text: string }
  | { kind: "book"; request: BookingAsked; window: OpenWindow; text: string }
  | { kind: "message"; callerName: string | null; callbackNumber: string | null; message: string; text: string }
  /** `place` is one of the places the company allowed, when the assistant chose one over a person. */
  | { kind: "transfer"; reason: string; text: string; place?: { id: string; label: string } | undefined }
  | { kind: "hang_up"; text: string }
  /** Something the model said that is not said, and the reason for the log. */
  | { kind: "refused"; reason: string; then: Exclude<VoiceDecision, { kind: "refused" }> };

/**
 * What a model's answer becomes on a live call.
 *
 * The answer has already been checked against its schema and against the
 * person the assistant acts as (`admitCall`); this holds it to the company's
 * records and to the call itself.
 */
export function decideVoice(input: {
  action: string;
  args: Record<string, unknown>;
  /** Every price the company published: online booking prices and the chosen price book items. */
  allowedPrices: readonly string[];
  windows: readonly OpenWindow[];
  callerNumber: string | null;
  bookingTaken: boolean;
  messageTaken: boolean;
  /** Whether this turn already looked somebody up. One look per turn: the second is a loop. */
  lookedUp: boolean;
  /** The places the company lets it send a caller. Any other place named is refused. */
  places?: readonly { id: string; label: string }[] | undefined;
}): VoiceDecision {
  const words = (key: string) => (typeof input.args[key] === "string" ? speakable(input.args[key] as string) : "");
  const said = words("text");

  /**
   * Every amount it would say is checked first, whatever the action, because a
   * goodbye can quote a price as easily as a reply can.
   */
  const unlisted = unlistedPrices(said, input.allowedPrices);
  if (unlisted.length > 0) {
    return {
      kind: "refused",
      reason: `An answer quoted ${unlisted.map((p) => format(round(money(p), 2))).join(", ")}, which is not a published price. It was not said; the caller was put through to a person.`,
      then: { kind: "transfer", reason: "The assistant would have quoted a price you have not published.", text: UNSURE },
    };
  }

  switch (input.action) {
    case "reply":
      return said ? { kind: "say", text: said } : { kind: "say", text: NOT_HEARD };

    case "look_up_customer": {
      if (input.lookedUp) {
        return {
          kind: "refused",
          reason: "The assistant asked to look the caller up twice in one turn.",
          then: { kind: "say", text: "I could not find you from that. Could you tell me your address instead?" },
        };
      }
      const text = (key: string) => (typeof input.args[key] === "string" && (input.args[key] as string).trim() !== ""
        ? (input.args[key] as string).trim() : null);
      return { kind: "look_up", query: { phone: text("phone"), name: text("name"), postalCode: text("postalCode") }, text: said || LOOKING };
    }

    case "create_booking_request": {
      if (input.bookingTaken) {
        return { kind: "transfer", reason: "The caller wanted a second booking on one call.", text: PUTTING_THROUGH };
      }
      const args = input.args as {
        bookableServiceId: string; date: string; arrivalWindowId: string; contactName: string;
        phone?: string; notes?: string;
        address: { line1: string; line2?: string; city: string; state: string; postalCode: string };
      };
      const [open] = openOnly([{ date: args.date, arrivalWindowId: args.arrivalWindowId }], args.bookableServiceId, input.windows);
      if (!open) {
        return { kind: "say", text: "Sorry, that time is not open. Could you pick one of the other times?" };
      }
      const phone = args.phone?.trim() || input.callerNumber;
      if (!phone) {
        return { kind: "say", text: "What is the best phone number to confirm the booking with?" };
      }
      return {
        kind: "book",
        window: open,
        text: said || "Thank you. I have asked the office for that time, and they will confirm it with you.",
        request: {
          bookableServiceId: args.bookableServiceId,
          date: args.date,
          arrivalWindowId: args.arrivalWindowId,
          contactName: args.contactName,
          phone,
          address: {
            line1: args.address.line1, city: args.address.city, state: args.address.state,
            postalCode: args.address.postalCode,
            ...(args.address.line2 ? { line2: args.address.line2 } : {}),
          },
          notes: args.notes?.trim() || null,
        },
      };
    }

    case "take_message": {
      if (input.messageTaken) return { kind: "say", text: said || "I have passed that on as well." };
      const args = input.args as { callerName?: string; callbackNumber?: string; message: string };
      return {
        kind: "message",
        callerName: args.callerName?.trim() || null,
        callbackNumber: args.callbackNumber?.trim() || input.callerNumber,
        message: args.message.trim(),
        text: said || "Thank you. I have passed that to the office, and someone will call you back.",
      };
    }

    case "transfer": {
      const reason = String(input.args["reason"] ?? "The assistant asked for a person.");
      const named = typeof input.args["place"] === "string" ? input.args["place"].trim() : "";
      if (named === "") return { kind: "transfer", reason, text: said || PUTTING_THROUGH };
      const place = (input.places ?? []).find((p) => p.id === named);
      if (!place) {
        return {
          kind: "refused",
          reason: `The assistant tried to send a caller to "${named.slice(0, 64)}", which is not one of the places it may send callers. It put them through to a person instead.`,
          then: { kind: "transfer", reason, text: PUTTING_THROUGH },
        };
      }
      return { kind: "transfer", reason, text: said || "Of course. Let me send you to the right place. Please hold.", place };
    }

    case "end_call":
      return { kind: "hang_up", text: said || "Thanks for calling. Goodbye." };

    default:
      return {
        kind: "refused",
        reason: `The model answered with "${input.action.slice(0, 60)}", which the phone assistant cannot do.`,
        then: { kind: "transfer", reason: "The assistant was unsure.", text: UNSURE },
      };
  }
}

/* ------------------------------------------------- speaking as it writes */

/**
 * The words of a string field in JSON that is still being written, as far as
 * they have got, or null before the field has begun. Only a field at the top
 * of the object counts, and an escape cut off at the end is left for the next
 * piece rather than guessed at.
 */
export function partialString(json: string, key: string): string | null {
  let depth = 0;
  let i = 0;
  const n = json.length;
  const readString = (from: number): { text: string; end: number; done: boolean } => {
    let text = "";
    let j = from;
    while (j < n) {
      const c = json[j]!;
      if (c === "\"") return { text, end: j + 1, done: true };
      if (c === "\\") {
        const e = json[j + 1];
        if (e === undefined) return { text, end: j, done: false };
        if (e === "u") {
          const hex = json.slice(j + 2, j + 6);
          if (hex.length < 4) return { text, end: j, done: false };
          text += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        text += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
        j += 2;
        continue;
      }
      text += c;
      j += 1;
    }
    return { text, end: j, done: false };
  };
  while (i < n) {
    const c = json[i]!;
    if (c === "{" || c === "[") { depth += 1; i += 1; continue; }
    if (c === "}" || c === "]") { depth -= 1; i += 1; continue; }
    if (c === "\"") {
      const name = readString(i + 1);
      if (!name.done) return null;
      let k = name.end;
      while (k < n && /\s/.test(json[k]!)) k += 1;
      if (depth === 1 && json[k] === ":" && name.text === key) {
        k += 1;
        while (k < n && /\s/.test(json[k]!)) k += 1;
        if (json[k] !== "\"") return null;
        return readString(k + 1).text;
      }
      i = name.end;
      continue;
    }
    i += 1;
  }
  return null;
}

/** How far a reply has been spoken while the model was still writing it. */
export interface Streamed {
  /** How much of the written words has been dealt with. */
  upTo: number;
  /** What has been said aloud so far. */
  said: string;
  /** A sentence named a price nobody published: nothing more is said from this answer. */
  stopped: boolean;
}

export const STREAM_START: Streamed = { upTo: 0, said: "", stopped: false };

/**
 * The whole sentences written since the last ones spoken, each ready to say,
 * as the model writes a reply.
 *
 * A sentence is spoken only once it is finished (its stop and the space after
 * it have been written), so a price is never cut in half, and each is held to
 * the same rules as a whole answer before it is said: made speakable, and
 * stopped at the first one naming a price the company has not published,
 * which is never said. Everything after a stop is left to the whole answer's
 * check, which puts the caller through. At most the length a whole answer may
 * have is said this way.
 */
export function streamReply(state: Streamed, written: string, allowedPrices: readonly string[]): { state: Streamed; speak: string[] } {
  if (state.stopped) return { state, speak: [] };
  const speak: string[] = [];
  let { upTo, said } = state;
  const boundary = /[.!?]+["')\]]*\s+/g;
  boundary.lastIndex = upTo;
  for (let match = boundary.exec(written); match; match = boundary.exec(written)) {
    const end = match.index + match[0].length;
    const piece = speakable(written.slice(upTo, end));
    if (piece && unlistedPrices(piece, allowedPrices).length > 0) return { state: { upTo, said, stopped: true }, speak };
    if (piece && said.length + piece.length > 600) break;
    if (piece) {
      speak.push(piece);
      said = said ? `${said} ${piece}` : piece;
    }
    upTo = end;
  }
  return { state: { upTo, said, stopped: false }, speak };
}

/** The rest of a reply once it is whole, after what was already said while it was written. */
export function restOfReply(state: Streamed, whole: string): string {
  return speakable(whole.slice(state.upTo));
}
