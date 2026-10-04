/**
 * THE BROWSER AS A PHONE
 *
 * A person in the office answers and places the company's calls from the
 * office app, through the carrier's own browser library. The carrier knows
 * that browser by an identity this product chooses, and everything here is
 * about that identity and the few rules around it, kept pure so they can be
 * tested without a carrier or a browser.
 */

/**
 * The name the carrier knows a person's browser by.
 *
 * Derived from the user id rather than their name or email: a name changes and
 * is not unique, and an email in a carrier's logs is a personal detail sitting
 * on somebody else's servers. The carrier allows letters, digits and
 * underscores, so the dashes go.
 */
export function softphoneIdentity(userId: string): string {
  return `u_${userId.toLowerCase().replace(/[^0-9a-f]/g, "")}`;
}

/** The user id a browser identity names, or null when it is not one of ours. */
export function userOfIdentity(identity: string): string | null {
  const match = /^(?:client:)?u_([0-9a-f]{32})$/.exec(identity.trim());
  if (!match) return null;
  const hex = match[1]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How a browser is named inside a dial: the carrier's own prefix. */
export const clientAddress = (userId: string): string => `client:${softphoneIdentity(userId)}`;

export const isClientAddress = (address: string): boolean => address.startsWith("client:");

/**
 * How long a browser counts as able to take a call after it last said so.
 *
 * The office app says it is still there once a minute while "Take calls here"
 * is on. Two missed beats and it is treated as gone: a laptop closed at five
 * must not have the next morning's first call ring into nothing while the
 * person's own phone stays silent.
 */
export const PRESENCE_SECONDS = 150;

export function isOnline(lastSeenAt: Date, available: boolean, now: Date): boolean {
  return available && now.getTime() - lastSeenAt.getTime() <= PRESENCE_SECONDS * 1000;
}

/**
 * A number somebody typed into the dial pad, as the carrier dials it, or why not.
 *
 * North American numbers may be typed the way people write them; anything
 * else must be written in full with its country code, because guessing a
 * country for an eleven digit number is how somebody rings the wrong
 * continent on the company's bill. Short codes and emergency numbers are
 * refused: a browser is not a phone the emergency services can locate, and
 * a call to 911 from it would arrive with the company's number and none of
 * the caller's whereabouts.
 */
export function dialable(typed: string): { ok: true; e164: string } | { ok: false; reason: string } {
  const text = typed.trim();
  const digits = text.replace(/[^\d]/g, "");
  if (/^(911|112|999|000)$/.test(digits) || /^(1)?911$/.test(digits)) {
    return {
      ok: false,
      reason: "Emergency calls cannot be made from the browser: the emergency services would not know where you are. Use a phone.",
    };
  }
  if (text.startsWith("+")) {
    return /^\+[1-9]\d{7,14}$/.test(`+${digits}`)
      ? { ok: true, e164: `+${digits}` }
      : { ok: false, reason: `"${text}" is not a number a phone can dial.` };
  }
  if (digits.length === 10 && /^[2-9]/.test(digits)) return { ok: true, e164: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) return { ok: true, e164: `+${digits}` };
  return {
    ok: false,
    reason: `"${text}" is not a number a phone can dial. Write a US number with its area code, or any other with + and its country code.`,
  };
}
