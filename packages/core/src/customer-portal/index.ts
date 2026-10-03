import { type Money, add, compare, format, isNegative, isPositive, isZero, money, multiply, round, split, subtract, zero } from "../money/index.js";
import { phoneAddress } from "../comms/index.js";

/**
 * THE CUSTOMER SIGNED IN
 *
 * Until now every way into the portal was a link somebody in the office sent.
 * This module holds the pure decisions behind the three things a customer can
 * now do for themselves: sign in with a code sent to the address the company
 * already has for them, tip the technician when they pay, and see the
 * photographs of their own job.
 *
 * Nothing here touches a database, a processor or a clock it was not handed,
 * so every rule below can be tested without any of them.
 */

/* ---------------------------------------------------------------- sign in */

/** Six digits: short enough to read off a lock screen, long enough to not be guessed in five tries. */
export const CODE_LENGTH = 6;

/**
 * Ten minutes. Long enough for an email to arrive behind a greylisting
 * server, short enough that a code read over somebody's shoulder at breakfast
 * is dead by lunch.
 */
export const CODE_TTL_MINUTES = 10;

/**
 * Five wrong guesses and the code is dead. One in two hundred thousand of
 * guessing it, which is the whole security of a six digit code: the space is
 * small and the number of tries is what keeps it safe.
 */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * How long a sign in lasts on one browser.
 *
 * A week. Signing in again costs a homeowner one code, and a session that
 * outlives the week it was opened in is a session left signed in on the
 * family tablet with a saved card behind it.
 */
export const SESSION_DAYS = 7;

/**
 * Ceilings on asking for codes, each over its own window.
 *
 * Per address, so a stranger cannot fill somebody's phone with texts by
 * typing their number over and over. Per network address, so one script
 * cannot walk a list of numbers. Generous for a person who mistyped twice,
 * small for anything automated.
 */
export const LIMITS = {
  codesPerAddress: { limit: 3, windowSeconds: 15 * 60 },
  codesPerAddressDaily: { limit: 10, windowSeconds: 24 * 60 * 60 },
  codesPerIp: { limit: 10, windowSeconds: 60 * 60 },
  checksPerIp: { limit: 30, windowSeconds: 15 * 60 },
} as const;

export type SignInChannel = "email" | "sms";

export interface SignInAddress {
  channel: SignInChannel;
  /** Normalised: lower case for an email, E.164 for a phone. What is stored and compared. */
  address: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What somebody typed into the one box, as an address a code can go to.
 *
 * One box rather than a choice of two, because a customer knows what they
 * gave the company and does not want to be asked which kind it was. An at
 * sign means email; digits that make a phone number mean a text; anything
 * else is refused here rather than looked up.
 */
export function signInAddress(typed: string): SignInAddress | null {
  const trimmed = typed.trim();
  if (trimmed === "" || trimmed.length > 254) return null;
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return EMAIL.test(email) ? { channel: "email", address: email } : null;
  }
  const phone = phoneAddress(trimmed);
  return /^\+\d{8,15}$/.test(phone) ? { channel: "sms", address: phone } : null;
}

/**
 * A fresh code, from whatever randomness the caller supplies.
 *
 * The caller passes a cryptographic source. Taking it as a parameter keeps
 * this module free of node and lets the test hand it a fixed sequence.
 */
export function newCode(randomDigit: () => number): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += String(Math.abs(Math.trunc(randomDigit())) % 10);
  return code;
}

/**
 * A code as somebody typed it, made comparable. Spaces and dashes go,
 * because a phone shows "482 913" and people copy what they see. Null when
 * what is left is not six digits, so a typo is refused without being counted
 * as a guess against the code.
 */
export function normaliseCode(typed: string): string | null {
  const code = typed.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code) ? code : null;
}

/** The words the code goes out in. Short, because a text over 160 characters is two texts. */
export function codeMessage(companyName: string, code: string): { subject: string; text: string } {
  const name = companyName.trim() || "Your service company";
  return {
    subject: `Your ${name} sign in code`,
    text: `${code} is your ${name} sign in code. It works once, for ${CODE_TTL_MINUTES} minutes. `
      + "If you did not ask for it, ignore this message.",
  };
}

/* ---------------------------------------------------------------- tipping */

export interface TipSettings {
  /** Off until the company turns it on. A tip prompt nobody chose is a surprise on somebody's bill. */
  enabled: boolean;
  /** The percentages offered as buttons, smallest first. A customer can always type their own amount. */
  presets: number[];
}

export const DEFAULT_TIP_SETTINGS: TipSettings = { enabled: false, presets: [10, 15, 20] };

/** Percentages a company may offer. Above half the bill is a typo, not a suggestion. */
const MAX_PRESET = 50;

export type TipSettingsCheck = { ok: true; settings: TipSettings } | { ok: false; reason: string };

/**
 * Settings as somebody saved them, checked.
 *
 * Whole percentages only, one to four of them, none over fifty, no repeats.
 * Sorted, so the buttons read in order whatever order they were typed in.
 */
export function checkTipSettings(input: { enabled?: unknown; presets?: unknown }): TipSettingsCheck {
  const enabled = input.enabled === true;
  const raw = input.presets === undefined ? DEFAULT_TIP_SETTINGS.presets : input.presets;
  if (!Array.isArray(raw)) return { ok: false, reason: "Give the suggested tips as a list of percentages." };
  if (raw.length === 0 || raw.length > 4) {
    return { ok: false, reason: "Offer between one and four suggested tips." };
  }
  const presets: number[] = [];
  for (const value of raw) {
    const n = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PRESET) {
      return { ok: false, reason: `A suggested tip is a whole percentage from 1 to ${MAX_PRESET}.` };
    }
    if (presets.includes(n)) return { ok: false, reason: `${n}% is suggested twice.` };
    presets.push(n);
  }
  presets.sort((a, b) => a - b);
  return { ok: true, settings: { enabled, presets } };
}

/**
 * Whatever is stored, read safely.
 *
 * A malformed value reads as tipping OFF rather than as an error: a settings
 * blob somebody edited by hand must never be what puts a tip prompt in front
 * of a customer.
 */
export function readTipSettings(stored: unknown): TipSettings {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_TIP_SETTINGS };
  const checked = checkTipSettings(stored as { enabled?: unknown; presets?: unknown });
  return checked.ok ? checked.settings : { ...DEFAULT_TIP_SETTINGS };
}

/** What each suggested percentage comes to on this amount, to the cent. */
export function tipChoices(base: Money, presets: readonly number[]): { percent: number; amount: Money }[] {
  return presets.map((percent) => ({
    percent,
    amount: round(multiply(base, String(percent / 100)), 2),
  }));
}

export type TipCheck = { ok: true; tip: Money } | { ok: false; reason: string };

/**
 * A tip a customer typed, against what they are paying.
 *
 * Refused when the company does not take tips, when it is negative, when it
 * has fractions of a cent, and when it is more than the bill. The last one is
 * the one that matters: a stray zero turns a twenty dollar tip into two
 * hundred on somebody's card, and no technician wants to be the reason for
 * that phone call.
 */
export function checkTip(typed: string, base: Money, settings: TipSettings): TipCheck {
  const trimmed = typed.trim();
  if (trimmed === "" || /^0+(\.0+)?$/.test(trimmed)) return { ok: true, tip: zero(base.currency) };
  if (!settings.enabled) return { ok: false, reason: "This company does not take tips online." };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, reason: "A tip is an amount in dollars and cents, like 15 or 12.50." };
  }
  const tip = money(trimmed, base.currency);
  if (isNegative(tip)) return { ok: false, reason: "A tip cannot be less than nothing." };
  if (compare(tip, base) > 0) {
    return { ok: false, reason: `A tip can be at most the amount being paid, ${format(round(base, 2))}.` };
  }
  return { ok: true, tip };
}

/**
 * A tip split evenly between the technicians on the job, to the cent.
 *
 * Evenly, because the customer tipped "the crew" and did not say otherwise,
 * and anything cleverer (by hours, by lead) is a pay policy this product has
 * not asked the company about. Sorted by id so the odd cent always lands on
 * the same person for the same inputs. An empty list is the caller's
 * problem: a tip with nobody to give it to must be refused before it is
 * taken, not split into nothing after.
 */
export function splitTip(tip: Money, technicianIds: readonly string[]): { technicianId: string; amount: Money }[] {
  const people = [...new Set(technicianIds)].sort();
  if (people.length === 0 || isZero(tip)) return [];
  const parts = split(tip, people.length, 2);
  return people.map((technicianId, i) => ({ technicianId, amount: parts[i] ?? zero(tip.currency) }));
}

/**
 * What arrived, divided between the invoice and the tip.
 *
 * The processor's amount is the authority, as it is everywhere else money
 * lands, and it can differ from what was asked for: a charge adjusted in the
 * processor's own dashboard, a partial capture. When it does, THE INVOICE IS
 * PAID FIRST and the tip takes what is left, up to what the customer chose.
 * A customer who meant to pay their bill and add something for the
 * technician did not mean the technician to be paid while the bill stays
 * open. Anything beyond both is the customer's money paid ahead, which the
 * settlement path already holds as unapplied.
 */
export function settleTip(input: { reported: Money; invoicePart: Money; tip: Money }): { applied: Money; tip: Money } {
  const reported = input.reported;
  if (!isPositive(input.tip)) return { applied: reported, tip: zero(reported.currency) };
  const afterInvoice = subtract(reported, input.invoicePart);
  if (!isPositive(afterInvoice)) return { applied: reported, tip: zero(reported.currency) };
  const tip = compare(afterInvoice, input.tip) < 0 ? afterInvoice : input.tip;
  return { applied: subtract(reported, tip), tip };
}

/** The whole of what the card is charged: the balance and the tip. */
export const chargeFor = (balance: Money, tip: Money): Money => add(balance, tip);

/* ------------------------------------------------------------ job photos */

/**
 * Which job photographs a customer may see.
 *
 * `chosen`, the default, shows only the ones somebody in the office marked
 * for the customer. `all` shows every photograph on the job. There is no
 * third setting that shows them without either, because a technician
 * photographs a breaker panel with a family's alarm code written on it as
 * readily as a finished install.
 */
export type PhotoSharing = "chosen" | "all";

export function photoShown(sharing: PhotoSharing, photo: { kind: string; sharedAt: Date | null }): boolean {
  if (photo.kind !== "photo") return false;
  return sharing === "all" || photo.sharedAt !== null;
}

/* -------------------------------------------------------------- settings */

export interface PortalSettings {
  tipping: TipSettings;
  jobPhotos: PhotoSharing;
  /**
   * Whether a signed in customer may save a bank account and pay from it.
   * Off until the company turns it on, for two reasons a card does not
   * have: the company has to switch bank debits on with its processor too,
   * and money from a bank arrives days later and can still fail, which the
   * company should choose to live with rather than discover.
   */
  bankAccounts: boolean;
}

/** The portal's settings out of the company's settings blob, defaulting to everything off. */
export function readPortalSettings(stored: unknown): PortalSettings {
  const blob = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const photos = blob["jobPhotos"];
  return {
    tipping: readTipSettings(blob["tipping"]),
    jobPhotos: photos === "all" ? "all" : "chosen",
    bankAccounts: blob["bankAccounts"] === true,
  };
}

/* ------------------------------------------------- blocks and capacity */

export * from "./blocks.js";
export * from "./capacity.js";
