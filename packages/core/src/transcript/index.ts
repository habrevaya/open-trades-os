/**
 * WHAT HAPPENS TO A TRANSCRIPT AFTER SOMEBODY ELSE MAKES IT
 *
 * Nothing in this file transcribes anything. A provider does that, over a
 * network, for money, and it is the least interesting part. Everything that
 * makes a transcript useful or dangerous happens afterwards, on our side, and
 * all of it is a pure function of the segments plus a policy: whether the
 * output is coherent enough to store, what has to be destroyed before it is
 * stored, who each voice belongs to, how it is shaped for search and for a
 * summariser, and whether it is good enough to act on without a person.
 *
 * Pure on purpose. A decision about whether a call transcript may be acted on
 * automatically is the kind of thing that gets argued about a year later, and
 * an argument you can settle by reading a test is a short argument. There is
 * no database access, no clock and no model call in here, so every rule below
 * is exhaustively testable with a literal.
 *
 * HOW THIS RELATES TO THE FIELD REDACTION IN `access`
 *
 * `access.redact` removes a field from a record on its way out, for an actor
 * who lacks a permission. It assumes the value is safe to keep in the
 * database and unsafe only for that reader. That assumption is right for a
 * cost or a pay rate and it is wrong for a card number: a primary account
 * number in a text column is a problem for the company that stores it, not
 * for whoever reads it back. So this is a different mechanism with a
 * different shape, and the two do not compete. Redaction here is destructive,
 * happens once at ingest, before the row exists, and applies to everybody
 * including the owner. There is no permission that reveals it, because after
 * this runs there is nothing left to reveal.
 */

// ---------------------------------------------------------------------------
// 1. The transcript as data
// ---------------------------------------------------------------------------

/**
 * One stretch of speech, after normalisation.
 *
 * `speaker` is the provider's own label, kept verbatim. Mapping it onto a
 * role this product understands is a separate step with separate inputs,
 * because the mapping is a fact about the call and the label is a fact about
 * the provider's diarisation, and merging the two loses the ability to say
 * "the provider thought this was a fourth voice".
 */
export interface Segment {
  speaker: string;
  /** Milliseconds from the start of the recording. */
  startMs: number;
  endMs: number;
  text: string;
  /** The provider's own confidence, normalised to 0 through 1 inclusive. */
  confidence: number;
}

/**
 * What a provider actually hands over, before we have checked any of it.
 *
 * The numeric fields accept a string because several providers send them as
 * strings, and a caller that has to remember to coerce is a caller that
 * forgets once. Coercion happens here, under a rule, rather than through
 * `Number()` at four call sites with four different behaviours for "".
 */
export interface RawSegment {
  speaker?: string | null | undefined;
  startMs?: number | string | null | undefined;
  endMs?: number | string | null | undefined;
  text?: string | null | undefined;
  confidence?: number | string | null | undefined;
}

/**
 * Everything that makes provider output unusable.
 *
 * Each one carries the segment index, because a person debugging a provider
 * integration is looking at a list of two hundred segments and "invalid
 * transcript" tells them nothing they can act on.
 */
export type TranscriptDefect =
  | { kind: "no_segments" }
  | { kind: "missing_speaker"; index: number }
  | { kind: "empty_text"; index: number }
  | { kind: "unreadable_number"; index: number; field: "startMs" | "endMs" | "confidence" }
  | { kind: "negative_offset"; index: number; startMs: number }
  | { kind: "ends_before_start"; index: number; startMs: number; endMs: number }
  | { kind: "confidence_out_of_range"; index: number; confidence: number }
  | { kind: "overlapping_segments"; index: number; startMs: number; previousIndex: number; previousEndMs: number };

export type NormalizeResult =
  | { ok: true; segments: Segment[] }
  | { ok: false; defects: TranscriptDefect[] };

/**
 * WHY A MALFORMED TRANSCRIPT IS REFUSED RATHER THAN REPAIRED.
 *
 * Every defect below has an obvious repair. Clamp the confidence into range,
 * swap the two offsets round, nudge an overlap forward by a millisecond, drop
 * the empty segment. Each repair is one line and each one is wrong, because
 * of what a transcript is used for: it is quoted back to a customer, pasted
 * into a dispute, and read as the record of what somebody said. A transcript
 * that is obviously broken gets looked at. A transcript that was quietly
 * straightened out gets believed.
 *
 * The specific failure this prevents: a provider changes its output shape,
 * our repairs absorb the change, and for six weeks every call is timed
 * slightly wrong and nobody notices until an operator scrubs the audio to a
 * timestamp and hears the wrong sentence. The cost of refusing is a loud
 * integration failure on the day of the change, which is the cheapest day.
 *
 * Every defect is collected rather than the first one returned, because
 * fixing a provider mapping one refusal at a time is a slow afternoon.
 */
export function normalizeSegments(raw: readonly RawSegment[]): NormalizeResult {
  if (raw.length === 0) {
    /**
     * An empty list is refused rather than accepted as "a call where nobody
     * spoke". Those two are genuinely different, and a provider returning
     * nothing is overwhelmingly the second kind of nothing: a failed job, an
     * unsupported audio codec, an empty file. Storing it as an empty
     * transcript makes a failed transcription look like a silent customer.
     */
    return { ok: false, defects: [{ kind: "no_segments" }] };
  }

  const defects: TranscriptDefect[] = [];
  const built: Segment[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]!;

    const speaker = typeof item.speaker === "string" ? item.speaker.trim() : "";
    if (speaker === "") defects.push({ kind: "missing_speaker", index });

    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text === "") defects.push({ kind: "empty_text", index });

    const startMs = readNumber(item.startMs);
    const endMs = readNumber(item.endMs);
    const confidence = readNumber(item.confidence);

    if (startMs === null) defects.push({ kind: "unreadable_number", index, field: "startMs" });
    if (endMs === null) defects.push({ kind: "unreadable_number", index, field: "endMs" });
    if (confidence === null) defects.push({ kind: "unreadable_number", index, field: "confidence" });
    if (startMs === null || endMs === null || confidence === null) continue;

    if (startMs < 0) defects.push({ kind: "negative_offset", index, startMs });

    /**
     * Equal offsets are allowed and a backwards pair is not. A zero length
     * segment is a provider emitting a token it could not place, which is
     * ugly but says nothing false. An end before a start says the person
     * finished speaking before they began, and anything that computes a
     * duration from it gets a negative number that then poisons a weighted
     * average somewhere far away from here.
     */
    if (endMs < startMs) defects.push({ kind: "ends_before_start", index, startMs, endMs });

    /**
     * Range is checked rather than clamped. A confidence of 1.4 is not a very
     * confident segment, it is a field holding something that is not a
     * confidence: a percentage, a log probability, a provider's own scale.
     * Clamping it to 1 turns a units bug into a transcript we trust more than
     * any other.
     */
    if (confidence < 0 || confidence > 1) {
      defects.push({ kind: "confidence_out_of_range", index, confidence });
    }

    built.push({ speaker, startMs: Math.round(startMs), endMs: Math.round(endMs), text, confidence });
  }

  /**
   * Ordered by start offset before the overlap check, because a provider that
   * emits per speaker rather than in time order is common and harmless:
   * sorting chooses a reading order and changes no value. What follows is the
   * check that cannot be fixed by sorting.
   */
  const ordered = [...built].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    /**
     * Touching is fine, overlapping is refused. Real people talk over each
     * other constantly, so this is not a claim that overlap cannot happen: it
     * is a claim that a single flat list of segments cannot represent it. Two
     * segments occupying the same instant have no reading order, and picking
     * one is picking what the transcript says happened. A provider that
     * genuinely captures crosstalk emits a track per channel, and the fix is
     * to normalise one channel at a time, which the refusal says.
     */
    if (current.startMs < previous.endMs) {
      defects.push({
        kind: "overlapping_segments",
        index: i,
        startMs: current.startMs,
        previousIndex: i - 1,
        previousEndMs: previous.endMs,
      });
    }
  }

  if (defects.length > 0) return { ok: false, defects };
  return { ok: true, segments: ordered };
}

/**
 * A number from a provider, or null.
 *
 * `Number("")` is 0 and `Number(null)` is 0, which is how an absent offset
 * becomes a segment at the start of the recording. Both are refused here.
 */
function readNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Refusal text a person can act on, naming the segment and the repair. */
export function describeDefect(defect: TranscriptDefect): string {
  switch (defect.kind) {
    case "no_segments":
      return "The provider returned no segments. That is a failed transcription, not a silent call, and storing it as an empty transcript would make the two look identical.";
    case "missing_speaker":
      return `Segment ${defect.index} has no speaker label. Speaker roles are assigned from these labels, and inventing one would invent who said it.`;
    case "empty_text":
      return `Segment ${defect.index} has no words. Drop segments with no text before normalising: a segment with a duration and nothing in it claims somebody spoke and said nothing.`;
    case "unreadable_number":
      return `Segment ${defect.index} has no usable ${defect.field}. Send a number or a numeric string: an absent value would otherwise read as zero.`;
    case "negative_offset":
      return `Segment ${defect.index} starts at ${defect.startMs}ms, before the recording does. Check whether the provider is sending offsets relative to something other than the start of the audio.`;
    case "ends_before_start":
      return `Segment ${defect.index} ends at ${defect.endMs}ms and starts at ${defect.startMs}ms. Check the field mapping: these are almost always swapped.`;
    case "confidence_out_of_range":
      return `Segment ${defect.index} has a confidence of ${defect.confidence}, which is outside 0 to 1. Convert the provider's scale before normalising rather than clamping it, or every downstream quality check silently trusts this call more than any other.`;
    case "overlapping_segments":
      return `Segment ${defect.index} starts at ${defect.startMs}ms while segment ${defect.previousIndex} runs to ${defect.previousEndMs}ms. A flat segment list has no way to represent two people talking at once. If the provider gives a track per channel, normalise one channel at a time.`;
  }
}

// ---------------------------------------------------------------------------
// 2. Redaction. The most important thing in this file.
// ---------------------------------------------------------------------------

/**
 * WHY THIS IS THE PART THAT MATTERS
 *
 * Contractors take card numbers over the phone. Not occasionally: it is how a
 * deposit gets paid when the customer is at work and the truck is outside the
 * house. Turn on call recording and transcription, and within a week there
 * are primary account numbers sitting in a text column in a database that was
 * scoped, backed up, replicated and exported to a warehouse on the assumption
 * that it holds job notes. That is the single largest liability this feature
 * creates, and it is created by shipping the feature, not by any mistake
 * anyone makes afterwards.
 *
 * So redaction happens before the row is written, it is destructive, and the
 * original is never returned by anything in this module.
 *
 * WHAT A MARKER IS AND WHY IT IS NOT A DELETION
 *
 * Each digit is replaced by a mask character and the separators are left
 * alone, so the text keeps its exact length. Deleting would shift every
 * character after it, and character offsets are how a search hit is pointed
 * back at a segment and therefore at a moment in the audio. A transcript
 * whose offsets no longer agree with the recording is one where clicking a
 * search result plays the wrong sentence, and the person listening concludes
 * the recording is of a different call.
 *
 * The mask deliberately does not say what it covered. The report says that.
 * A screenshot of a transcript should not annotate where the card number was.
 */

export type RedactionCategory =
  | "card_number"
  | "card_security_code"
  | "ssn"
  | "bank_routing_number"
  | "bank_account_number";

export const REDACTION_CATEGORIES: readonly RedactionCategory[] = [
  "card_number", "card_security_code", "ssn", "bank_routing_number", "bank_account_number",
];

/**
 * Why we believed it. Useful for tuning the detectors and for answering "why
 * did it mask my job number", and it leaks nothing: it is one of three words.
 */
export type RedactionBasis = "checksum" | "format" | "context";

export const MASK_CHARACTER = "#";

/**
 * A record that something was removed, and nothing else.
 *
 * THERE IS NO FIELD HERE FOR THE VALUE, AND THERE MUST NEVER BE ONE. A
 * redaction log that contains what it redacted is strictly worse than no
 * redaction at all: the transcript is now clean, so nobody worries about it,
 * and the card number has been copied into an audit table that is even less
 * likely to be reviewed. Position and length are enough to highlight the
 * masked run in a viewer, which is the only thing a person needs.
 */
export interface RedactionSite {
  segmentIndex: number;
  /** Character offset within that segment's text. */
  start: number;
  length: number;
  category: RedactionCategory;
  basis: RedactionBasis;
}

export interface RedactionReport {
  redacted: boolean;
  sites: readonly RedactionSite[];
  countsByCategory: Record<RedactionCategory, number>;
}

export interface RedactedTranscript {
  segments: Segment[];
  report: RedactionReport;
}

/**
 * LUHN, AND WHY IT IS LOAD BEARING HERE.
 *
 * A rule that masks any sixteen digit run would work, in the sense that no
 * card number would survive it. It would also mask the equipment serial
 * number, the model number, the permit number, the purchase order and the
 * invoice number, all of which are long digit strings that get read aloud on
 * exactly these calls and all of which are the reason somebody goes back to
 * the transcript later. Masking the serial number off a warranty call
 * destroys the only useful thing in it.
 *
 * Luhn is the check digit every card carries. It costs nothing, it needs no
 * network, and it turns "any long number" into "a number that could be a
 * card". It is not proof: roughly one random digit string in ten passes by
 * chance, so some invoice numbers will still be masked. That is the right
 * direction to be wrong in, and it is a tenth of the wrongness.
 */
export function luhn(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The shortest and longest a real card number is. */
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;

/**
 * The ABA check digit on a bank routing number, plus the prefix ranges the
 * Federal Reserve actually issues.
 *
 * The checksum alone has the same one in ten false positive rate as Luhn, and
 * nine digit numbers are much commoner in a trades conversation than sixteen
 * digit ones: a permit number, a licence number, a parcel id. Requiring the
 * prefix to be in an issued range as well cuts that down to something a
 * dispatcher will not notice.
 */
function abaChecksum(digits: string): boolean {
  if (!/^[0-9]{9}$/.test(digits)) return false;
  const at = (i: number) => digits.charCodeAt(i) - 48;
  const sum =
    3 * (at(0) + at(3) + at(6)) +
    7 * (at(1) + at(4) + at(7)) +
    1 * (at(2) + at(5) + at(8));
  return sum % 10 === 0;
}

function routingPrefixIsIssued(digits: string): boolean {
  const prefix = Number(digits.slice(0, 2));
  return (prefix >= 0 && prefix <= 12) ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80;
}

/**
 * The words that make a nearby number mean something.
 *
 * Kept deliberately short. Every entry widens what gets masked, and a list
 * that grows until it contains "number" masks the job number on every call.
 */
const CARD_WORDS = [
  "card", "visa", "mastercard", "master card", "amex", "american express",
  "discover", "credit", "debit",
];
const CVV_WORDS = [
  "cvv", "cvc", "csc", "security code", "verification code", "three digits",
  "back of the card", "on the back",
];
const SSN_WORDS = ["social security", "social", "ssn"];
const ROUTING_WORDS = ["routing", "aba", "transit"];
const ACCOUNT_WORDS = ["account number", "acct", "checking account", "savings account", "bank account"];

function mentions(haystackLower: string, words: readonly string[]): boolean {
  return words.some((word) => haystackLower.includes(word));
}

export interface RedactionContext {
  /**
   * Text from just before this, used as evidence and never modified.
   *
   * The reason this exists: the security code is almost never in the same
   * breath as the card number. It is "and the three digits on the back?"
   * followed by a segment containing nothing but "four one nine". Looking
   * only at the segment in hand means the one field PCI is most emphatic
   * about is the one field we never catch.
   */
  priorText?: string | undefined;
  /**
   * Whether a card number was just found, within the last couple of
   * segments. Arms the security code detector without needing the words,
   * because "and the code?" is often just "and?".
   */
  cardSeenRecently?: boolean | undefined;
}

export interface FoundRedaction {
  category: RedactionCategory;
  basis: RedactionBasis;
  start: number;
  length: number;
}

export interface TextRedaction {
  text: string;
  found: readonly FoundRedaction[];
}

/**
 * A maximal run of digits, allowing a single space or hyphen between them.
 *
 * Single separator only, on purpose: "4111 1111 1111 1111" is one run and
 * "be there between 8 and 9" is two runs of one digit, because the words in
 * between break it. A looser separator class merges two sentences into one
 * twenty digit number and then starts looking for cards inside it.
 */
const DIGIT_RUN = /[0-9](?:[ -]?[0-9])*/g;

/**
 * Find and mask everything we can recognise in one piece of text.
 *
 * Runs are disjoint by construction and each run gets at most one category,
 * so there is no question of two detectors fighting over the same characters.
 */
export function redactText(text: string, context: RedactionContext = {}): TextRedaction {
  const window = `${context.priorText ?? ""}\n${text}`.toLowerCase();
  const cardContext = mentions(window, CARD_WORDS);
  const cvvArmed = mentions(window, CVV_WORDS) || context.cardSeenRecently === true;
  const ssnContext = mentions(window, SSN_WORDS);
  const routingContext = mentions(window, ROUTING_WORDS);
  const accountContext = mentions(window, ACCOUNT_WORDS);

  const found: FoundRedaction[] = [];
  const characters = [...text];

  for (const match of text.matchAll(DIGIT_RUN)) {
    const runText = match[0];
    const runStart = match.index;
    const positions: number[] = [];
    for (let i = 0; i < runText.length; i += 1) {
      const code = runText.charCodeAt(i);
      if (code >= 48 && code <= 57) positions.push(i);
    }
    const digits = positions.map((i) => runText[i]!).join("");
    const length = digits.length;

    let hit: { category: RedactionCategory; basis: RedactionBasis; from: number; to: number } | null = null;

    const card = findCardSpan(digits);
    if (card) {
      hit = { category: "card_number", basis: "checksum", from: positions[card.from]!, to: positions[card.to]! };
    } else if (length >= CARD_MIN_DIGITS && length <= CARD_MAX_DIGITS && cardContext) {
      /**
       * A card length run sitting next to the word "card" that fails Luhn.
       * Almost always a real card with one digit misheard, which is a thing
       * speech recognition does constantly with "five" and "nine". It is
       * still a card number for every purpose that matters: it is still
       * cardholder data, it still has to not be in the database, and the
       * person who said it still said it. Masked on the context alone.
       */
      hit = { category: "card_number", basis: "context", from: positions[0]!, to: positions[length - 1]! };
    } else if (length === 9) {
      const whole = { from: positions[0]!, to: positions[length - 1]! };
      if (/^[0-9]{3}-[0-9]{2}-[0-9]{4}$/.test(runText)) {
        // The shape is diagnostic on its own. Nothing else in a trades
        // conversation is written three, two, four.
        hit = { category: "ssn", basis: "format", ...whole };
      } else if (ssnContext) {
        hit = { category: "ssn", basis: "context", ...whole };
      } else if (routingContext) {
        hit = { category: "bank_routing_number", basis: "context", ...whole };
      } else if (abaChecksum(digits) && routingPrefixIsIssued(digits)) {
        hit = { category: "bank_routing_number", basis: "checksum", ...whole };
      } else if (accountContext) {
        hit = { category: "bank_account_number", basis: "context", ...whole };
      }
    } else if (length >= 8 && length <= 17 && accountContext) {
      /**
       * Account numbers have no checksum and no fixed length, so there is
       * nothing to check: context is all there is. Without somebody saying
       * the word, an account number is indistinguishable from a job number,
       * and it goes through unmasked. Said plainly in the misses list.
       */
      hit = { category: "bank_account_number", basis: "context", from: positions[0]!, to: positions[length - 1]! };
    } else if ((length === 3 || length === 4) && cvvArmed) {
      /**
       * Three digits is the single most ambiguous thing in a transcript: it
       * is a house number, a part number, a price, a temperature. It is only
       * treated as a security code when something nearby says card, which is
       * why the detector is armed rather than always on.
       */
      hit = { category: "card_security_code", basis: "context", from: positions[0]!, to: positions[length - 1]! };
    }

    if (!hit) continue;

    for (let i = hit.from; i <= hit.to; i += 1) {
      const code = runText.charCodeAt(i);
      if (code >= 48 && code <= 57) characters[runStart + i] = MASK_CHARACTER;
    }
    found.push({
      category: hit.category,
      basis: hit.basis,
      start: runStart + hit.from,
      length: hit.to - hit.from + 1,
    });
  }

  return { text: characters.join(""), found };
}

/**
 * Where a card number sits inside a run of digits, by Luhn.
 *
 * The two cases are deliberately asymmetric and the asymmetry is the whole
 * design:
 *
 *   A run that is ITSELF card length is tested as a whole and nothing else.
 *   No substring search. Searching inside a sixteen digit run for a passing
 *   thirteen digit window finds one most of the time by chance, which would
 *   make the Luhn check decorative and put us straight back to masking every
 *   invoice number.
 *
 *   A run LONGER than any card cannot be a card, so the only question left is
 *   whether one is embedded in it: the card read straight into the expiry
 *   date with no pause, which is how people actually read a card out. Here a
 *   substring search is the only option, and the false positive risk is
 *   accepted, because a twenty five digit blob was not carrying much meaning
 *   anyway. Longest match wins, so the expiry is not mistaken for the card.
 */
function findCardSpan(digits: string): { from: number; to: number } | null {
  const length = digits.length;
  if (length < CARD_MIN_DIGITS) return null;
  if (length <= CARD_MAX_DIGITS) {
    return luhn(digits) ? { from: 0, to: length - 1 } : null;
  }
  for (let size = CARD_MAX_DIGITS; size >= CARD_MIN_DIGITS; size -= 1) {
    for (let from = 0; from + size <= length; from += 1) {
      if (luhn(digits.slice(from, from + size))) return { from, to: from + size - 1 };
    }
  }
  return null;
}

/**
 * Redact a whole transcript, carrying context forward across segments.
 *
 * Offsets are untouched by construction: this only ever replaces characters
 * with the mask, so every `startMs` and `endMs` comes out the way it went in
 * and every segment's text is exactly as long as it was.
 */
export function redactTranscript(segments: readonly Segment[]): RedactedTranscript {
  const sites: RedactionSite[] = [];
  const out: Segment[] = [];
  /**
   * How long the security code detector stays armed after a card number.
   * Two segments: long enough for "and the code on the back" and an answer,
   * short enough that it is not still armed when the conversation has moved
   * on to the model number.
   */
  const CVV_ARMED_SEGMENTS = 2;
  let sinceCard = Number.POSITIVE_INFINITY;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const previous = segments[index - 1];
    const result = redactText(segment.text, {
      priorText: previous?.text,
      cardSeenRecently: sinceCard <= CVV_ARMED_SEGMENTS,
    });

    for (const item of result.found) {
      sites.push({ segmentIndex: index, start: item.start, length: item.length, category: item.category, basis: item.basis });
    }
    out.push({ ...segment, text: result.text });

    sinceCard = result.found.some((f) => f.category === "card_number") ? 1 : sinceCard + 1;
  }

  const countsByCategory = Object.fromEntries(
    REDACTION_CATEGORIES.map((category) => [category, sites.filter((s) => s.category === category).length]),
  ) as Record<RedactionCategory, number>;

  return { segments: out, report: { redacted: sites.length > 0, sites, countsByCategory } };
}

/** What a mask covered, in words, for a viewer's tooltip. */
export function describeRedactionCategory(category: RedactionCategory): string {
  switch (category) {
    case "card_number": return "A card number was removed here.";
    case "card_security_code": return "A card security code was removed here.";
    case "ssn": return "A social security number was removed here.";
    case "bank_routing_number": return "A bank routing number was removed here.";
    case "bank_account_number": return "A bank account number was removed here.";
  }
}

// ---------------------------------------------------------------------------
// 3. Speaker resolution
// ---------------------------------------------------------------------------

/**
 * Who the product thinks was on the call.
 *
 * `caller` placed it and `answerer` picked it up, which is direction neutral
 * on purpose: on an inbound call the shop is the answerer and on an outbound
 * one the shop is the caller, and a role named "customer" would be wrong half
 * the time in a way nobody catches until a summary says the customer promised
 * to arrive on Tuesday.
 */
export type SpeakerRole = "caller" | "answerer" | "third_party" | "unknown";

export const ROLE_LABEL: Record<SpeakerRole, string> = {
  caller: "Caller",
  answerer: "Answerer",
  third_party: "Third party",
  unknown: "Unidentified",
};

export interface ResolvedSegment extends Segment {
  role: SpeakerRole;
}

export type SpeakerRefusal =
  | { kind: "no_mapping" }
  | { kind: "duplicate_role"; role: "caller" | "answerer"; labels: string[] };

export type SpeakerResult =
  | {
      ok: true;
      segments: ResolvedSegment[];
      /**
       * Provider labels nobody told us about. Not an error and not empty in
       * practice: diarisation finds a fourth voice when the radio is on in
       * the truck or somebody is put on speaker.
       */
      unexpectedLabels: string[];
      /** Labels in the mapping the transcript never used. Usually a stale mapping. */
      unusedLabels: string[];
    }
  | { ok: false; refusal: SpeakerRefusal };

/**
 * Map provider labels onto roles, from a mapping the caller supplies.
 *
 * THE MAPPING IS AN INPUT AND NEVER A GUESS. The tempting rule is "Speaker 0
 * is whoever spoke first, and on an inbound call that is the person who
 * answered". It is right most of the time and it is wrong exactly when it
 * matters: when the customer speaks over the greeting, when the auto attendant
 * counts as a speaker, when the call was transferred. A role is an assertion
 * about who said something, and this module will not manufacture one. The
 * caller knows the channel, the direction and who was logged in, so the
 * caller decides.
 *
 * An unexpected label becomes `unknown` rather than being refused or quietly
 * folded into `third_party`. Refusing loses the call over a cough. Folding it
 * in asserts a person was there. `unknown` is honest and it is a flag: a
 * quotation attributed to `unknown` must never be rendered as "the customer
 * said", and `unexpectedLabels` is what a caller checks to decide whether a
 * person should look at this one.
 */
export function resolveSpeakers(
  segments: readonly Segment[],
  mapping: Readonly<Record<string, SpeakerRole>>,
): SpeakerResult {
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    return { ok: false, refusal: { kind: "no_mapping" } };
  }

  /**
   * Two labels claiming the same singular role is refused, because there is
   * exactly one person who placed the call and exactly one who answered it.
   * A mapping that says otherwise was built for a different call or from a
   * bad join, and everything downstream would be a confident statement about
   * who said what, built on it. `third_party` may repeat: two people in the
   * room is ordinary.
   */
  for (const role of ["caller", "answerer"] as const) {
    const labels = entries.filter(([, value]) => value === role).map(([label]) => label);
    if (labels.length > 1) return { ok: false, refusal: { kind: "duplicate_role", role, labels } };
  }

  const used = new Set<string>();
  const unexpected = new Set<string>();
  const resolved = segments.map((segment) => {
    const role = mapping[segment.speaker];
    if (role === undefined) {
      unexpected.add(segment.speaker);
      return { ...segment, role: "unknown" as const };
    }
    used.add(segment.speaker);
    return { ...segment, role };
  });

  return {
    ok: true,
    segments: resolved,
    unexpectedLabels: [...unexpected],
    unusedLabels: entries.map(([label]) => label).filter((label) => !used.has(label)),
  };
}

export function describeSpeakerRefusal(refusal: SpeakerRefusal): string {
  switch (refusal.kind) {
    case "no_mapping":
      return "No speaker mapping was supplied. Pass one built from the call's direction and the answering user: this will not guess which provider label is the customer, because a guess reads as a fact in every summary afterwards.";
    case "duplicate_role":
      return `The mapping gives the ${refusal.role} role to more than one provider label (${refusal.labels.join(", ")}). Exactly one person placed the call and one answered it, so this mapping belongs to a different call or came from a bad join.`;
  }
}

// ---------------------------------------------------------------------------
// 4. Search and summary shaping
// ---------------------------------------------------------------------------

/** `mm:ss`, or `h:mm:ss` once a call runs past an hour. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export interface SearchSpan {
  segmentIndex: number;
  /** Half open, over the search document's text. */
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

export interface SearchDocument {
  text: string;
  spans: readonly SearchSpan[];
}

/**
 * The form that goes into a full text index.
 *
 * NO TIMESTAMPS IN THE TEXT. Writing "[02:14]" into the indexed string is the
 * obvious way to keep the link back to the audio and it quietly ruins the
 * index: every timestamp is a token, so searching for a unit number like
 * "214" matches the clock on a hundred unrelated calls, and the operator
 * concludes search is broken. The link is kept out of band instead, as a span
 * table, which is exact rather than approximate and costs one array.
 */
export function searchDocument(segments: readonly Segment[]): SearchDocument {
  const spans: SearchSpan[] = [];
  let text = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index > 0) text += "\n";
    const charStart = text.length;
    text += segment.text;
    spans.push({ segmentIndex: index, charStart, charEnd: text.length, startMs: segment.startMs, endMs: segment.endMs });
  }
  return { text, spans };
}

/**
 * Turn a character offset from a search hit back into a moment in the audio.
 *
 * This is the whole reason the span table exists: a result the operator can
 * click to hear the sentence. Returns null for an offset in the whitespace
 * between segments rather than snapping to the nearest one, because snapping
 * would point at a sentence nobody matched.
 */
export function locate(document: SearchDocument, charOffset: number): SearchSpan | null {
  return document.spans.find((span) => charOffset >= span.charStart && charOffset < span.charEnd) ?? null;
}

export interface Elision {
  droppedCount: number;
  startMs: number;
  endMs: number;
}

export type FitResult =
  | { ok: true; kept: Segment[]; elision: Elision | null }
  | { ok: false; refusal: { kind: "budget_below_one_segment"; budgetChars: number; smallestSegmentChars: number } };

/** The rendered line for one segment, which is also what it costs in budget. */
function lineFor(segment: Segment | ResolvedSegment): string {
  const who = "role" in segment ? ROLE_LABEL[segment.role] : segment.speaker;
  return `[${formatTimestamp(segment.startMs)}] ${who}: ${segment.text}`;
}

/**
 * Room reserved for the notice that says material was removed. Fixed and
 * generous rather than computed, so the budget is never overshot by the very
 * sentence that explains the budget.
 */
const ELISION_RESERVE = 96;

/**
 * Cut a transcript down to fit a context window, by dropping WHOLE SEGMENTS
 * FROM THE MIDDLE.
 *
 * Two decisions here and both are about what a summariser does with what it
 * is given.
 *
 * NEVER MID SEGMENT. Truncating a transcript at a character boundary is the
 * default everywhere and it is the worst available option, because a language
 * model does not notice that a sentence stopped. "The compressor is under
 * warranty until" becomes a summary that states the compressor is under
 * warranty, full stop, in a confident sentence an office manager then repeats
 * to a customer. A half fact presented whole is worse than a missing fact,
 * because a missing fact gets looked up.
 *
 * FROM THE MIDDLE. The start of a service call is why they rang and where
 * they are. The end is what was agreed: the date, the price, the promise.
 * The middle is diagnosis, hold music and repetition. Dropping the tail to
 * fit is how a summary loses the appointment it was run to find.
 *
 * The budget is in CHARACTERS, not tokens, because counting tokens needs a
 * tokeniser and this package has no dependencies and no model. A caller
 * sizing this for a model should convert conservatively and leave room for
 * the prompt.
 */
export function fitToBudget(segments: readonly Segment[], budgetChars: number): FitResult {
  const costs = segments.map((segment) => lineFor(segment).length + 1);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= budgetChars) return { ok: true, kept: [...segments], elision: null };

  const available = budgetChars - ELISION_RESERVE;
  let low = 0;
  let high = segments.length - 1;
  let used = 0;
  let fromHead = true;

  while (low <= high) {
    const preferred = fromHead ? low : high;
    const other = fromHead ? high : low;
    let taken: number | null = null;
    if (used + costs[preferred]! <= available) taken = preferred;
    else if (preferred !== other && used + costs[other]! <= available) taken = other;
    if (taken === null) break;

    used += costs[taken]!;
    if (taken === low) low += 1; else high -= 1;
    fromHead = !fromHead;
  }

  if (low === 0 && high === segments.length - 1) {
    /**
     * Not one whole segment fits. Refused rather than returning a cut
     * sentence, which is the entire point of this function: there is no
     * budget so small that a confidently wrong summary becomes acceptable.
     * The caller raises the budget or summarises in pieces.
     */
    return {
      ok: false,
      refusal: {
        kind: "budget_below_one_segment",
        budgetChars,
        smallestSegmentChars: Math.min(...costs),
      },
    };
  }

  const dropped = segments.slice(low, high + 1);
  const first = dropped[0];
  const last = dropped[dropped.length - 1];
  return {
    ok: true,
    kept: [...segments.slice(0, low), ...segments.slice(high + 1)],
    elision: first && last ? { droppedCount: dropped.length, startMs: first.startMs, endMs: last.endMs } : null,
  };
}

/**
 * The labelled, timestamped form handed to a summariser.
 *
 * The elision notice is not decoration. A model given a transcript with a
 * silent gap in it narrates straight across the gap, because nothing told it
 * there was one; told explicitly that eleven minutes are missing, it hedges,
 * which is the correct behaviour and the only one available to it.
 */
export function renderForSummary(
  segments: readonly (Segment | ResolvedSegment)[],
  elision: Elision | null = null,
): string {
  const lines = segments.map(lineFor);
  if (!elision) return lines.join("\n");

  const notice = `[... ${elision.droppedCount} segments omitted, ${formatTimestamp(elision.startMs)} to ${formatTimestamp(elision.endMs)} ...]`;
  /**
   * Placed where the cut actually happened rather than at the top, so the
   * model can see which side of it a statement came from.
   */
  const head = segments.findIndex((segment) => segment.startMs > elision.endMs);
  const at = head === -1 ? lines.length : head;
  return [...lines.slice(0, at), notice, ...lines.slice(at)].join("\n");
}

// ---------------------------------------------------------------------------
// 5. Quality
// ---------------------------------------------------------------------------

export interface QualityThresholds {
  /** Below this overall, nothing should happen without a person. */
  meanFloor: number;
  /** How long a bad patch has to be before it counts as one. */
  windowMs: number;
  /** How bad it has to be over that window. */
  windowFloor: number;
}

/**
 * Starting values, exported so they can be argued with and tuned per
 * provider. They are a policy, not a measurement: a confidence number means
 * something slightly different for every engine, and anybody switching
 * providers should re-derive these against a few hundred calls rather than
 * assuming they carry over.
 *
 * 0.80 mean: below this the transcript reads as broken to a person, and
 * acting on it automatically means booking against sentences nobody said.
 *
 * 15 seconds at 0.55: long enough that it is not one misheard word, short
 * enough to catch a single address or a single phone number.
 */
export const DEFAULT_QUALITY: QualityThresholds = { meanFloor: 0.8, windowMs: 15_000, windowFloor: 0.55 };

export type QualityConcern =
  | { kind: "low_mean"; mean: number; floor: number }
  | { kind: "low_patch"; startMs: number; endMs: number; confidence: number; floor: number };

export interface QualityAssessment {
  /** Weighted by how long each segment lasted. See below for why. */
  meanConfidence: number;
  worstWindow: { startMs: number; endMs: number; confidence: number } | null;
  concerns: QualityConcern[];
  /** True only when there is nothing to be concerned about at all. */
  actOnAutomatically: boolean;
}

/**
 * The mean confidence, weighted by duration.
 *
 * An unweighted mean treats "mm hm" and a thirty second explanation of where
 * the gate key is as equally informative. A call is full of short
 * acknowledgements and a provider is extremely confident about all of them,
 * so an unweighted mean drifts upward with every "yeah" and reports a healthy
 * number for a transcript whose actual content is a mess.
 *
 * A zero length segment contributes nothing, which is right: it is a token
 * the provider could not place.
 */
export function weightedMeanConfidence(segments: readonly Segment[]): number {
  let weighted = 0;
  let duration = 0;
  for (const segment of segments) {
    const span = Math.max(0, segment.endMs - segment.startMs);
    weighted += segment.confidence * span;
    duration += span;
  }
  if (duration > 0) return weighted / duration;
  // Every segment has zero length. Fall back to the plain mean rather than
  // returning zero, which would read as "certainly wrong" instead of "we
  // cannot weight this".
  return segments.length === 0 ? 0 : segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length;
}

/**
 * THE WORST STRETCH, WHICH IS THE NUMBER THAT ACTUALLY MATTERS.
 *
 * A mean hides exactly the failure that costs money. A transcript that is
 * excellent for three minutes and garbage for thirty seconds has a fine mean,
 * around 0.93, and gets acted on. And the thirty seconds is never random: it
 * is the part where somebody read out a street name the model has never seen,
 * over a speakerphone, in a truck, with the engine running. The address, the
 * gate code, the phone number, the part number. The mean is high precisely
 * because the rest of the call was pleasantries.
 *
 * Windows are anchored at segment starts, so every window considered contains
 * speech and a long silence cannot manufacture a bad patch. Confidence within
 * a window is weighted by how much of each segment overlaps it, so a segment
 * straddling the edge counts for the part that is inside.
 */
export function worstWindow(
  segments: readonly Segment[],
  windowMs: number,
): { startMs: number; endMs: number; confidence: number } | null {
  if (segments.length === 0 || windowMs <= 0) return null;

  let worst: { startMs: number; endMs: number; confidence: number } | null = null;
  for (const anchor of segments) {
    const startMs = anchor.startMs;
    const endMs = startMs + windowMs;
    let weighted = 0;
    let duration = 0;
    for (const segment of segments) {
      const overlap = Math.min(segment.endMs, endMs) - Math.max(segment.startMs, startMs);
      if (overlap <= 0) continue;
      weighted += segment.confidence * overlap;
      duration += overlap;
    }
    if (duration <= 0) continue;
    const confidence = weighted / duration;
    if (!worst || confidence < worst.confidence) worst = { startMs, endMs, confidence };
  }
  return worst;
}

/**
 * Whether a person has to listen to this one.
 *
 * Both checks run and both are reported, because "it is bad overall" and
 * "there is one bad patch" send an operator to different places in the audio.
 */
export function assessQuality(
  segments: readonly Segment[],
  thresholds: QualityThresholds = DEFAULT_QUALITY,
): QualityAssessment {
  const meanConfidence = weightedMeanConfidence(segments);
  const window = worstWindow(segments, thresholds.windowMs);
  const concerns: QualityConcern[] = [];

  if (meanConfidence < thresholds.meanFloor) {
    concerns.push({ kind: "low_mean", mean: meanConfidence, floor: thresholds.meanFloor });
  }
  if (window && window.confidence < thresholds.windowFloor) {
    concerns.push({
      kind: "low_patch",
      startMs: window.startMs,
      endMs: window.endMs,
      confidence: window.confidence,
      floor: thresholds.windowFloor,
    });
  }

  return { meanConfidence, worstWindow: window, concerns, actOnAutomatically: concerns.length === 0 };
}

/** What to put in front of the person who has to decide whether to listen. */
export function describeConcern(concern: QualityConcern): string {
  switch (concern.kind) {
    case "low_mean":
      return `The whole transcript is unreliable: ${concern.mean.toFixed(2)} confidence against a floor of ${concern.floor.toFixed(2)}. Listen to the recording before acting on anything in it.`;
    case "low_patch":
      return `A stretch from ${formatTimestamp(concern.startMs)} to ${formatTimestamp(concern.endMs)} is unreliable at ${concern.confidence.toFixed(2)} confidence, against a floor of ${concern.floor.toFixed(2)}. The rest of the call may read fine. Listen to that stretch: it is usually where an address or a phone number was given.`;
  }
}
