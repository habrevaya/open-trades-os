/**
 * M24. THE PERSON: ONBOARDING AND CONTINUING EDUCATION
 *
 * Two small pieces of arithmetic about people, kept here so the screen, the
 * API and the tests all count the same way.
 *
 * ONBOARDING IS DONE WHEN EVERY REQUIRED LINE IS. Not when a percentage gets
 * near a hundred: the line nobody ticked is the I-9 or the fall protection
 * training, and a progress bar at ninety per cent reads as finished.
 *
 * CONTINUING EDUCATION COUNTS THE CURRENT CYCLE. The hours a renewal needs
 * are hours earned since the licence was last issued, and the eight hours
 * done for the previous renewal do not count twice. Hours are counted in
 * hundredths as whole numbers, because 0.1 + 0.2 hours arriving in a renewal
 * check as 0.30000000000000004 is a person told they are short.
 */

export interface OnboardingLine {
  readonly required: boolean;
  readonly doneAt: Date | string | null;
}

export interface OnboardingProgress {
  readonly total: number;
  readonly done: number;
  readonly required: number;
  readonly requiredDone: number;
  /** Every required line done. A person with no lines at all is not complete: nothing was asked. */
  readonly complete: boolean;
  readonly sentence: string;
}

export function onboardingProgress(lines: readonly OnboardingLine[]): OnboardingProgress {
  const done = lines.filter((l) => l.doneAt !== null).length;
  const required = lines.filter((l) => l.required).length;
  const requiredDone = lines.filter((l) => l.required && l.doneAt !== null).length;
  const complete = lines.length > 0 && requiredDone === required;
  return {
    total: lines.length,
    done,
    required,
    requiredDone,
    complete,
    sentence: lines.length === 0
      ? "Not started. Start onboarding to copy the checklist for their role."
      : complete
        ? `Done: all ${required} required ${required === 1 ? "line" : "lines"} ticked.`
        : `${requiredDone} of ${required} required ${required === 1 ? "line" : "lines"} done, ${required - requiredDone} still to do.`,
  };
}

/** Hours to hundredths. A decimal string, never a float, for the reason above. */
export function hundredths(hours: string): bigint {
  const text = hours.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new RangeError(`Not a number of hours: ${JSON.stringify(hours)}`);
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

export const hoursLabel = (h: bigint): string => {
  const whole = h / 100n;
  const frac = h % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
};

export interface CeEntry {
  readonly completedOn: string;
  readonly hours: string;
}

export interface CeProgress {
  /** Null when the certification asks for none. */
  readonly required: string | null;
  readonly logged: string;
  readonly remaining: string | null;
  readonly met: boolean | null;
  /** The first day of the cycle counted, when there is one. */
  readonly since: string | null;
  readonly sentence: string;
}

/**
 * Hours toward the next renewal of one certification for one person.
 *
 * `since` is the day the current holding was issued (null when there is no
 * issue date, in which case every hour logged counts, and the sentence says
 * so). `by` is when the holding expires, for the sentence.
 */
export function ceProgress(input: {
  required: string | null;
  entries: readonly CeEntry[];
  since: string | null;
  by: string | null;
}): CeProgress {
  const counted = input.entries.filter((e) => input.since === null || e.completedOn >= input.since);
  const logged = counted.reduce((sum, e) => sum + hundredths(e.hours), 0n);
  if (input.required === null) {
    return {
      required: null, logged: hoursLabel(logged), remaining: null, met: null, since: input.since,
      sentence: `${hoursLabel(logged)} hours logged. This certification asks for no continuing education.`,
    };
  }
  const need = hundredths(input.required);
  const remaining = need > logged ? need - logged : 0n;
  const window = input.since ? ` since it was issued on ${input.since}` : " (no issue date recorded, so every hour logged is counted)";
  const by = input.by ? ` before it expires on ${input.by}` : "";
  return {
    required: hoursLabel(need),
    logged: hoursLabel(logged),
    remaining: hoursLabel(remaining),
    met: remaining === 0n,
    since: input.since,
    sentence: remaining === 0n
      ? `${hoursLabel(logged)} of ${hoursLabel(need)} hours${window}. Enough for the renewal.`
      : `${hoursLabel(logged)} of ${hoursLabel(need)} hours${window}. ${hoursLabel(remaining)} more needed${by}.`,
  };
}

/* ------------------------------------------------------ signing a document */

/**
 * HOW A PERSON SIGNS SOMETHING THE OFFICE GAVE THEM: by typing their name or
 * by drawing it, and exactly one of the two.
 *
 * A typed name is a signature, the same as on a proposal: what makes it worth
 * anything is the record kept beside it (who was signed in, when, from where,
 * and a hash of the words they were shown), not the strokes. Both at once is
 * refused rather than one quietly preferred, because the record says which
 * way somebody signed and "both" is not an answer to that.
 */
export type SignatureMethod = "typed" | "drawn";

export type SignatureCheck =
  | { ok: true; method: SignatureMethod; signerName: string }
  | { ok: false; reason: string };

export function checkSignature(input: {
  typedName?: string | null | undefined;
  drawn: boolean;
  /** The person's own name as the company has it, which a drawn signature is recorded under. */
  ownName: string;
}): SignatureCheck {
  const typed = (input.typedName ?? "").trim();
  if (typed !== "" && input.drawn) {
    return { ok: false, reason: "Sign one way: type your name, or draw your signature, not both." };
  }
  if (input.drawn) return { ok: true, method: "drawn", signerName: input.ownName };
  if (typed === "") return { ok: false, reason: "Type your full name, or draw your signature, to sign." };
  if (typed.length < 2) return { ok: false, reason: "Type your full name to sign. One letter is an initial, not a name." };
  if (typed.length > 200) return { ok: false, reason: "That is longer than a name. Type your full name to sign." };
  return { ok: true, method: "typed", signerName: typed };
}

/* ----------------------------------------------------------------- invites */

/** How long an invite's link works, from the moment it was sent. */
export const INVITE_DAYS = 7;

export type InviteEmail = "sent" | "queued" | "failed" | "not_sent";

export interface InviteStanding {
  readonly expired: boolean;
  readonly sentence: string;
}

/**
 * Where an invite stands, in the words the team list shows beside somebody who
 * has not signed in yet. Expired is the one an owner has to act on, so it says
 * what to do about it.
 */
export function inviteStanding(input: {
  expiresAt: Date;
  now: Date;
  email: InviteEmail;
  /** Why it was not emailed, when it was not. */
  emailNote?: string | null | undefined;
  /** The day the link stops working, as the company writes a date. */
  expiresOn: string;
}): InviteStanding {
  if (input.expiresAt.getTime() <= input.now.getTime()) {
    return { expired: true, sentence: `The invite ran out on ${input.expiresOn}. Send a new one.` };
  }
  const how = input.email === "sent"
    ? "Emailed"
    : input.email === "queued"
      ? "Waiting to be emailed"
      : input.email === "failed"
        ? `The email did not go${input.emailNote ? ` (${input.emailNote})` : ""}, so send them the link yourself`
        : `Not emailed${input.emailNote ? ` (${input.emailNote})` : ""}, so send them the link yourself`;
  return { expired: false, sentence: `${how}. The link works until ${input.expiresOn}.` };
}
