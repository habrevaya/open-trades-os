import { phoneAddress } from "../comms/index.js";

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

/* ------------------------------------------------------ a skill's own expiry */

export type SkillExpiryState = "none" | "current" | "expiring" | "expired";

export interface SkillExpiryStanding {
  state: SkillExpiryState;
  /** Whole days from today to the expiry, negative once it has passed. Null with no expiry. */
  daysRemaining: number | null;
  sentence: string;
}

const DAY_MS = 86_400_000;

/**
 * WHERE A SKILL RECORD STANDS AGAINST ITS OWN EXPIRY.
 *
 * Read the way a certification's expiry is: the day it expires is still a good
 * day, so it is expired from the day after. Expiring means within its notice
 * period, which is what puts it on the list of what to renew. Both dates are
 * calendar dates and are compared as such, never as instants.
 */
export function skillExpiryStanding(input: {
  skill: string; expiresOn: string | null; today: string; leadDays: number;
}): SkillExpiryStanding {
  if (input.expiresOn === null) {
    return { state: "none", daysRemaining: null, sentence: `${input.skill} does not expire.` };
  }
  const days = Math.round((Date.parse(`${input.expiresOn}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / DAY_MS);
  if (days < 0) {
    return {
      state: "expired", daysRemaining: days,
      sentence: `${input.skill} ran out on ${input.expiresOn}, ${-days} ${-days === 1 ? "day" : "days"} ago.`,
    };
  }
  if (days <= input.leadDays) {
    return {
      state: "expiring", daysRemaining: days,
      sentence: days === 0 ? `${input.skill} runs out today.` : `${input.skill} runs out on ${input.expiresOn}, in ${days} ${days === 1 ? "day" : "days"}.`,
    };
  }
  return { state: "current", daysRemaining: days, sentence: `${input.skill} is good until ${input.expiresOn}.` };
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

/**
 * How long an invite's link works, from the moment it was sent, when the
 * company has not said otherwise. A week is long enough for somebody who is
 * away to get to it and short enough that a link left in an inbox does not
 * stay a way into the company for long.
 */
export const INVITE_DAYS = 7;

/** The fewest and the most days a company may make an invite's link last. A month is the longest: a credential left lying about for longer than that is the risk this limit is for. */
export const INVITE_DAYS_FEWEST = 1;
export const INVITE_DAYS_MOST = 30;

/** Why a lifetime for the link is refused, or null when it is a whole number of days from one to thirty. */
export function inviteDaysProblem(days: unknown): string | null {
  if (typeof days !== "number" || !Number.isInteger(days) || days < INVITE_DAYS_FEWEST || days > INVITE_DAYS_MOST) {
    return `Give the number of days as a whole number from ${INVITE_DAYS_FEWEST} to ${INVITE_DAYS_MOST}.`;
  }
  return null;
}

/** The lifetime a company saved, or the usual seven days for anything that is not a good number. */
export function inviteDaysOf(saved: unknown): number {
  return inviteDaysProblem(saved) === null ? saved as number : INVITE_DAYS;
}

/** "1 day", "7 days". */
export const inviteDaysWords = (days: number): string => `${days} ${days === 1 ? "day" : "days"}`;

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


/* ------------------------------------------------- a person's own address and phone */

/**
 * WHERE THE COMPANY CAN REACH A PERSON, AS THEY KEEP IT THEMSELVES.
 *
 * A home address and a phone number go stale the day somebody moves or changes
 * carrier, and the office is the last to hear. The person keeps their own; the
 * office reads it and sees each change with the day it was made.
 *
 * The phone is kept in E.164 like every other number here, so it dials and texts
 * the same everywhere. An address is all of street, town, state and ZIP or none of
 * it: a street with no ZIP is an address nobody can mail a tax form to, and the
 * person would not notice until one went missing. United States addresses only.
 */
export interface OwnContact {
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export const NO_OWN_CONTACT: OwnContact = {
  phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
};

export type OwnContactCheck = { ok: true; contact: OwnContact } | { ok: false; reason: string };

const tidy = (value: string | null | undefined): string | null => {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text === "" ? null : text;
};

export function checkOwnContact(input: {
  phone?: string | null | undefined;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postalCode?: string | null | undefined;
}): OwnContactCheck {
  const typedPhone = tidy(input.phone);
  let phone: string | null = null;
  if (typedPhone) {
    const e164 = phoneAddress(typedPhone);
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      return { ok: false, reason: `${typedPhone} is not a phone number. Type it as you would dial it, for example (512) 555-0143.` };
    }
    phone = e164;
  }
  const address = {
    addressLine1: tidy(input.addressLine1),
    addressLine2: tidy(input.addressLine2),
    city: tidy(input.city),
    state: tidy(input.state),
    postalCode: tidy(input.postalCode),
  };
  for (const [key, value] of Object.entries(address)) {
    if (value && value.length > 120) return { ok: false, reason: `Keep each line of the address to a hundred and twenty characters (${key}).` };
  }
  const started = Object.values(address).some((value) => value !== null);
  if (started) {
    if (!address.addressLine1 || !address.city || !address.state || !address.postalCode) {
      return {
        ok: false,
        reason: "An address needs the street, the town, the state and the ZIP code. Leave every address box empty to keep no address.",
      };
    }
    if (!/^[A-Za-z]{2}$/.test(address.state)) {
      return { ok: false, reason: "Give the state as two letters, like TX." };
    }
    address.state = address.state.toUpperCase();
    if (!/^\d{5}(-\d{4})?$/.test(address.postalCode)) {
      return { ok: false, reason: "The ZIP code is five digits, like 78701, or nine with a dash." };
    }
  }
  return { ok: true, contact: { phone, ...address } };
}

/** The address on one line, or null when there is none. */
export function ownAddressLine(contact: OwnContact): string | null {
  if (!contact.addressLine1) return null;
  const town = [contact.city, [contact.state, contact.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [contact.addressLine1, contact.addressLine2, town].filter(Boolean).join(", ");
}

/** A phone number as a person reads it: `(512) 555-0143` for a North American number, as stored otherwise. */
export function ownPhoneWords(phone: string | null): string {
  if (!phone) return "none";
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

export interface OwnContactChange {
  field: "phone" | "address";
  /** "none" when there was nothing. */
  before: string;
  after: string;
}

/**
 * What differs between two versions, in words the office reads: the phone and the
 * address, each only if it changed. The first version a person ever saves is
 * compared with nothing, so it reads "none" to what they typed.
 */
export function ownContactChanges(before: OwnContact | null, after: OwnContact): OwnContactChange[] {
  const was = before ?? NO_OWN_CONTACT;
  const changes: OwnContactChange[] = [];
  if (was.phone !== after.phone) {
    changes.push({ field: "phone", before: ownPhoneWords(was.phone), after: ownPhoneWords(after.phone) });
  }
  const wasAddress = ownAddressLine(was);
  const nowAddress = ownAddressLine(after);
  if (wasAddress !== nowAddress) {
    changes.push({ field: "address", before: wasAddress ?? "none", after: nowAddress ?? "none" });
  }
  return changes;
}
