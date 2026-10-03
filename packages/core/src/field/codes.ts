/**
 * SIGNING THE PHONE IN WITH A CODE
 *
 * A technician who has never been given a password, or has forgotten the one
 * they were given in March, still has a phone and an email address. A six
 * digit code sent to either is a sign in they can do in a truck with gloves
 * on, and it is not a weaker door than the password beside it, because of the
 * numbers below.
 *
 * The rules are here, without a database, so each one is a line somebody can
 * read and a test somebody can run. The storage, which keeps only a hash of
 * the code and spends it in one statement, is in the database functions the
 * API calls.
 */

/** Six digits: typeable on a phone keypad, and a million to guess from. */
export const CODE_LENGTH = 6;

/**
 * Ten minutes. Long enough for a text that arrives slowly in a basement and
 * for somebody to walk to where they left the phone; short enough that a
 * code read off a lock screen later is already dead.
 */
export const CODE_TTL_MINUTES = 10;

/**
 * Five wrong guesses and the code is spent, the same number the password
 * lockout counts to. With a million possible codes, five guesses is a one in
 * two hundred thousand chance, and getting another code to guess at is
 * itself limited below.
 */
export const CODE_MAX_ATTEMPTS = 5;

/**
 * Three codes in fifteen minutes for one person. Somebody who asked twice
 * because the first was slow is served; somebody asking forty times to get
 * forty sets of five guesses is not, and nor is somebody using the form to
 * send forty texts to a technician's phone.
 */
export const CODES_PER_WINDOW = 3;
export const CODE_WINDOW_MINUTES = 15;

/** Asking and trying, per address, per minute: generous for a person, small for a script. */
export const CODE_REQUESTS_PER_ADDRESS_PER_MINUTE = 5;
export const CODE_TRIES_PER_ADDRESS_PER_MINUTE = 10;

/**
 * A fresh code from a source of random integers.
 *
 * The source is injected rather than imported, because this package does not
 * reach for the platform's randomness and a test wants to know which code it
 * got. The API passes `crypto.randomInt`, which is uniform; `Math.random` is
 * not acceptable here and nothing in this file would notice if it were used.
 */
export function newCode(randomBelow: (max: number) => number): string {
  return String(randomBelow(10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/**
 * What a person typed, as a code, or null.
 *
 * Forgiving about what a phone keyboard and a pasted text produce, "123 456",
 * "123-456", a stray space, and strict about everything else, so a
 * five digit typo is refused as a typo rather than counted as a wrong guess
 * against the code.
 */
export function normalizeCode(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/**
 * The text or the email body.
 *
 * The code first, because that is what a phone shows in a notification and
 * what it offers to paste. The warning last, because the one way a code like
 * this is lost is somebody being talked into reading it out.
 */
export function codeMessage(company: string, code: string): string {
  return `${code} is your ${company} sign in code for the field app. `
    + `It works once, for ${CODE_TTL_MINUTES} minutes. `
    + "Nobody from the office will ever ask you for it.";
}
