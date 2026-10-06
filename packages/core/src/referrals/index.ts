/**
 * REFERRALS
 *
 * The cheapest work a trades company gets is the work a happy customer sends
 * it, and the commonest way to lose track of it is a referral that arrives as
 * "my neighbour said to call you" and is written down nowhere. A referral
 * here is three things: a code in a link the customer can share, a touch
 * credited to `referral_customer` naming who sent the visitor, and a reward
 * the referrer earns when the person they sent pays for their first job.
 *
 * The decisions are pure: what a code looks like, what the company's reward
 * settings may be, and whether a reward is due.
 */

/**
 * The letters a code is made of: no 0 and O, no 1, I and L, no U and V.
 * Codes are read aloud over the phone and typed into one, and a code nobody
 * can read back is a referral that is never credited.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
export const CODE_LENGTH = 6;

/** A new code, from whatever randomness the caller supplies. */
export function newReferralCode(random: () => number, length = CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * A code as somebody typed it, made comparable: upper case, with spaces and
 * dashes gone. Null when what is left could not be a code at all, so a
 * stray `ref=` on a link is ignored rather than looked up.
 */
export function normaliseCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length < 4 || code.length > 12) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** The link a customer shares. The booking page reads `ref` and so does the website snippet. */
export function referralLink(appBase: string, companySlug: string, code: string): string {
  return `${appBase.replace(/\/$/, "")}/book/${encodeURIComponent(companySlug)}?ref=${encodeURIComponent(code)}`;
}

/* --------------------------------------------------------------- rewards */

export const REWARD_KINDS = ["credit_note", "owed", "none"] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export const REWARD_KIND: Record<RewardKind, { label: string; meaning: string }> = {
  credit_note: {
    label: "A credit on their account",
    meaning: "A credit note is issued to the referrer and comes off their next invoice.",
  },
  owed: {
    label: "An amount we pay them",
    meaning: "The amount is recorded as owed to the referrer, and marked paid when somebody pays it.",
  },
  none: {
    label: "No reward",
    meaning: "Referrals are tracked and credited, and nothing is given for them.",
  },
};

export interface ReferralSettings {
  reward: RewardKind;
  /** A decimal string in the company's currency. Ignored when the reward is none. */
  amount: string;
}

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = { reward: "none", amount: "0" };

export type ReferralSettingsCheck = { ok: true; settings: ReferralSettings } | { ok: false; reason: string };

/**
 * Whether these settings can be saved.
 *
 * A reward of nothing is refused unless the kind is `none`: a credit note for
 * zero dollars is a document that says the company thanked somebody and gave
 * them nothing. A ceiling, because a slipped digit in a reward is paid to
 * every referrer until somebody notices.
 */
export function checkReferralSettings(input: { reward?: unknown; amount?: unknown }): ReferralSettingsCheck {
  const reward = String(input.reward ?? "none");
  if (!(REWARD_KINDS as readonly string[]).includes(reward)) {
    return { ok: false, reason: `"${reward}" is not a kind of reward. One of: ${REWARD_KINDS.join(", ")}.` };
  }
  if (reward === "none") return { ok: true, settings: { reward: "none", amount: "0" } };
  const amount = String(input.amount ?? "").trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    return { ok: false, reason: "Say the reward in dollars and cents, more than nothing: 25 or 25.00." };
  }
  if (Number(amount) > 10_000) {
    return { ok: false, reason: "A referral reward over ten thousand dollars is almost certainly a typing slip." };
  }
  return { ok: true, settings: { reward: reward as RewardKind, amount } };
}

export type RewardDecision =
  | { grant: true; kind: "credit_note" | "owed"; amount: string }
  | { grant: false; reason: string };

/**
 * Whether a referrer has earned a reward for the person they sent.
 *
 * Due when the referred customer's FIRST job is paid in full, once. Not on the
 * booking, because a booking can be cancelled and a reward already given
 * cannot be taken back without an awkward phone call; not on any job, because
 * the second job is the company's own work keeping a customer.
 */
export function rewardDue(input: {
  settings: ReferralSettings;
  referrerId: string;
  referredId: string;
  alreadyRewarded: boolean;
  firstJobPaid: boolean;
}): RewardDecision {
  if (input.settings.reward === "none") return { grant: false, reason: "This company gives no reward for a referral." };
  if (input.referrerId === input.referredId) return { grant: false, reason: "Nobody refers themselves." };
  if (input.alreadyRewarded) return { grant: false, reason: "This referral has already been rewarded." };
  if (!input.firstJobPaid) return { grant: false, reason: "The first job is not paid in full yet." };
  return { grant: true, kind: input.settings.reward, amount: input.settings.amount };
}
