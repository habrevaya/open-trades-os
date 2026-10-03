import { phoneAddress } from "../comms/index.js";

/**
 * THE AD PLATFORMS, THE ANALYTICS PROPERTY AND THE REVIEW LISTING, SPOKEN TO
 * DIRECTLY
 *
 * Until this module the product measured marketing from its own side only: a
 * spend file somebody downloaded, a conversion file somebody uploaded. Both
 * still work and are still the answer for an operator who cannot get a
 * platform's developer approval. This is the half for the operator who can:
 * spend pulled every few hours, booked and paid jobs told back to the account
 * that bought the click, reviews read as they land and answered from here,
 * and Local Services leads in the lead inbox.
 *
 * The decisions live here and are pure. Which identifiers a platform may be
 * sent for one customer, under the company's setting and the customer's own
 * choice. How each platform wants an email or a phone number written before
 * it is hashed, because a hash of the wrong spelling matches nobody and fails
 * in silence. What key makes a send impossible to count twice. Which of the
 * company's tracking campaigns a platform's campaign is. Which customer a
 * review is probably from, said as a suggestion and never as a fact.
 *
 * WHAT THIS MODULE DOES NOT DO is speak HTTP. The adapters in the API package
 * do, against fakes in every test, because none of these platforms can be
 * reached without the operator's own developer approval: a Google Ads
 * developer token, Meta app review for the scopes that read another
 * business's ads, Google's separate approval for the Business Profile API.
 */

/* ------------------------------------------------------------ providers */

export type AdsProvider =
  | "google_ads"
  | "google_lsa"
  | "meta_ads"
  | "ga4"
  | "google_business_profile";

/** Who a person signs in with to grant access. GA4's Measurement Protocol has no sign in at all. */
export type OAuthFamily = "google" | "meta";

/** What a platform is told about. A lead when a job is booked, a purchase when it is paid. */
export type EventKind = "lead" | "purchase";

export interface ProviderSpec {
  provider: AdsProvider;
  label: string;
  /** Null for a provider that authenticates with an API secret rather than a person's sign in. */
  oauth: OAuthFamily | null;
  /** Exactly what is asked for on the consent screen, and nothing broader. */
  scopes: readonly string[];
  pullsSpend: boolean;
  pullsLeads: boolean;
  pullsReviews: boolean;
  sends: readonly EventKind[];
  /**
   * The lead source keys whose work this platform may be told about.
   *
   * A platform is told about a job only when one of the job's own touches came
   * from it. Telling every platform about every job is what most setups do,
   * because it is easiest, and it lets Google and Meta each claim the same
   * furnace and both bid as if they had sold it. `any` is the analytics
   * property, which is the website's own record and not a buyer of clicks.
   */
  answersFor: readonly string[] | "any";
  /**
   * Whether a hashed email or phone may ever go. False for GA4, whose terms
   * forbid sending anything that identifies a person, hashed or not.
   */
  personalData: boolean;
}

export const PROVIDERS: Readonly<Record<AdsProvider, ProviderSpec>> = {
  google_ads: {
    provider: "google_ads",
    label: "Google Ads",
    oauth: "google",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    pullsSpend: true,
    pullsLeads: false,
    pullsReviews: false,
    sends: ["purchase"],
    answersFor: ["google_ads"],
    personalData: true,
  },
  google_lsa: {
    provider: "google_lsa",
    label: "Google Local Services Ads",
    oauth: "google",
    /**
     * The same scope as Google Ads. Local Services leads are read through the
     * Google Ads API's `local_services_lead` resource, so one OAuth client and
     * one developer token serve both.
     */
    scopes: ["https://www.googleapis.com/auth/adwords"],
    pullsSpend: true,
    pullsLeads: true,
    pullsReviews: false,
    sends: [],
    answersFor: ["google_lsa"],
    personalData: false,
  },
  meta_ads: {
    provider: "meta_ads",
    label: "Meta Ads",
    oauth: "meta",
    scopes: ["ads_read", "ads_management"],
    pullsSpend: true,
    pullsLeads: false,
    pullsReviews: false,
    sends: ["lead", "purchase"],
    answersFor: ["meta_ads"],
    personalData: true,
  },
  ga4: {
    provider: "ga4",
    label: "Google Analytics 4",
    oauth: null,
    scopes: [],
    pullsSpend: false,
    pullsLeads: false,
    pullsReviews: false,
    sends: ["lead", "purchase"],
    answersFor: "any",
    personalData: false,
  },
  google_business_profile: {
    provider: "google_business_profile",
    label: "Google Business Profile",
    oauth: "google",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    pullsSpend: false,
    pullsLeads: false,
    pullsReviews: true,
    sends: [],
    answersFor: [],
    personalData: false,
  },
};

export const ADS_PROVIDERS = Object.keys(PROVIDERS) as AdsProvider[];

export const isAdsProvider = (value: string): value is AdsProvider =>
  (ADS_PROVIDERS as string[]).includes(value);

/** Whether a job credited to this lead source may be told to this platform. */
export function answersFor(provider: AdsProvider, source: string): boolean {
  const spec = PROVIDERS[provider].answersFor;
  return spec === "any" || spec.includes(source);
}

/* ------------------------------------------------------------- sign in */

export const OAUTH_ENDPOINTS: Readonly<Record<OAuthFamily, { authorize: string; token: string }>> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  meta: {
    authorize: "https://www.facebook.com/v21.0/dialog/oauth",
    token: "https://graph.facebook.com/v21.0/oauth/access_token",
  },
};

/** How long a person has between pressing "Sign in" and coming back. */
export const AUTHORIZATION_MINUTES = 15;

/**
 * The address a person is sent to, to grant access.
 *
 * Google is asked for OFFLINE access with the consent screen forced. Without
 * `prompt=consent`, a second connection by somebody who already granted once
 * comes back with an access token and no refresh token, and the connection
 * works for an hour and then never again, which is the failure nobody sees
 * until the next morning's spend is missing.
 */
export function authorizeUrl(input: {
  family: OAuthFamily;
  /** Overridable so a test can send the browser to a fake. */
  endpoint?: string | undefined;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}): string {
  const base = input.endpoint ?? OAUTH_ENDPOINTS[input.family].authorize;
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
  });
  if (input.family === "google") {
    params.set("scope", input.scopes.join(" "));
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    params.set("include_granted_scopes", "true");
  } else {
    params.set("scope", input.scopes.join(","));
  }
  return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
}

/* ------------------------------------------------------------ cadence */

/**
 * How often each thing is fetched or sent, in minutes.
 *
 * Spend every six hours, because a day's cost is revised for a day or two and
 * nobody decides anything on the hour. Local Services leads every ten
 * minutes, because a lead is a person waiting for a call back and speed to
 * lead is the whole game. Reviews hourly, which is inside every reply window
 * the policy can set. Conversions every quarter of an hour.
 */
export const CADENCE_MINUTES = { spend: 360, leads: 10, reviews: 60, conversions: 15 } as const;
export type Pull = keyof typeof CADENCE_MINUTES;

export const isDue = (lastStartedAt: Date | null, now: Date, minutes: number): boolean =>
  lastStartedAt === null || now.getTime() - lastStartedAt.getTime() >= minutes * 60_000;

/** How far back the first spend pull reaches, and the most any pull asks for. */
export const FIRST_PULL_DAYS = 30;
export const MAX_PULL_DAYS = 90;
/**
 * Days asked for again on every pull. A platform revises yesterday's cost
 * (late clicks, invalid clicks credited back), and a figure fetched once at
 * six in the morning is a figure that is wrong by the afternoon.
 */
export const REVISIT_DAYS = 3;

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The days a spend pull asks for.
 *
 * From the day after the last complete pull, less the revisit days, to today
 * in the company's calendar; never more than ninety days, so a connection
 * left switched off for a year does not ask for a year in one request.
 */
export function spendWindow(input: { today: string; lastThrough: string | null }): { from: string; to: string } {
  const earliest = addDays(input.today, -(MAX_PULL_DAYS - 1));
  const wanted = input.lastThrough === null
    ? addDays(input.today, -(FIRST_PULL_DAYS - 1))
    : addDays(input.lastThrough, -(REVISIT_DAYS - 1));
  const from = wanted < earliest ? earliest : wanted > input.today ? input.today : wanted;
  return { from, to: input.today };
}

/* --------------------------------------------------------------- money */

/**
 * A platform's micros as an amount, exactly.
 *
 * Google reports cost in millionths of the account currency as an integer in
 * a string. Dividing it as a float is how 0.1 plus 0.2 ends up in an ad
 * spend total. Our money is four decimal places, so micros are rounded half
 * up to the ten thousandth, in integers.
 */
export function microsToAmount(micros: string | number): string {
  const text = String(micros).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`"${text}" is not a whole number of micros.`);
  const negative = text.startsWith("-");
  const value = BigInt(negative ? text.slice(1) : text);
  const remainder = value % 100n;
  const units = value / 100n + (remainder >= 50n ? 1n : 0n);
  const whole = units / 10_000n;
  const fraction = (units % 10_000n).toString().padStart(4, "0");
  const sign = negative && units !== 0n ? "-" : "";
  return `${sign}${whole.toString()}.${fraction}`;
}

/* ----------------------------------------------------------- campaigns */

/**
 * The lead source a platform's campaign spends under.
 *
 * A Local Services campaign lives in a Google Ads account and is reported by
 * the same query, and it is a different product with a different cost per
 * lead. Filing it under Google Ads would blend the two numbers an owner most
 * needs apart.
 */
export function sourceOfPlatformCampaign(provider: AdsProvider, channelType: string | null): string {
  if (provider === "meta_ads") return "meta_ads";
  if (provider === "google_lsa") return "google_lsa";
  return channelType === "LOCAL_SERVICES" ? "google_lsa" : "google_ads";
}

const fold = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The company's tracking campaign a platform's campaign is, when the names
 * agree.
 *
 * By the tracking campaign's name or its utm tag, ignoring case and spacing,
 * the same rule the spend file follows. Exactly one match or nothing: a
 * platform campaign whose name is one tracking campaign's name and another's
 * tag is a question for a person, and guessing puts a budget on the wrong
 * line.
 */
export function matchCampaign(
  name: string,
  ours: readonly { id: string; name: string; utm: string | null }[],
): string | null {
  const wanted = fold(name);
  if (wanted === "") return null;
  const hits = new Set(ours
    .filter((c) => fold(c.name) === wanted || (c.utm !== null && fold(c.utm) === wanted))
    .map((c) => c.id));
  return hits.size === 1 ? [...hits][0]! : null;
}

/** The key a pulled spend row is found by again: one platform campaign, one day. */
export const spendKey = (account: string, campaignId: string, day: string): string =>
  `${account}:${campaignId}:${day}`;

/* --------------------------------------------------------- identifiers */

/**
 * Whose rules an identifier is written to before it is hashed.
 *
 * They differ, and a hash of the wrong spelling is a hash of somebody else:
 * the platform matches nobody, says nothing, and the conversion is simply
 * never credited.
 *
 *   Google: email trimmed and lower cased, and for gmail.com and
 *   googlemail.com the dots before the @ removed, because Gmail ignores
 *   them. Phone in E.164 with its plus sign.
 *
 *   Meta: email trimmed and lower cased and nothing else. Phone as digits
 *   with the country code and no plus sign.
 */
export type Flavour = "google" | "meta";

export function normaliseEmail(raw: string | null | undefined, flavour: Flavour): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(email);
  if (!match) return null;
  const [, local, domain] = match;
  if (flavour === "google" && (domain === "gmail.com" || domain === "googlemail.com")) {
    return `${local!.replace(/\./g, "")}@${domain}`;
  }
  return email;
}

export function normalisePhone(raw: string | null | undefined, flavour: Flavour): string | null {
  if (!raw) return null;
  const e164 = phoneAddress(raw);
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return null;
  return flavour === "google" ? e164 : e164.slice(1);
}

/**
 * SHA-256, as lower case hex.
 *
 * Through Web Crypto, which Node and every browser carry, so this package
 * stays free of Node's own modules and the screens can import it.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The visitor's Google Analytics client id, from the `_ga` cookie the
 * company's own analytics tag set: `GA1.1.1234567890.1712345678` carries
 * `1234567890.1712345678`. Anything else is refused rather than stored,
 * because this arrives from the open internet.
 */
export function gaClientIdFromCookie(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  const value = cookie.trim();
  const fromCookie = /^GA\d\.\d+\.(\d{1,20}\.\d{1,20})$/.exec(value);
  if (fromCookie) return fromCookie[1]!;
  return isGaClientId(value) ? value : null;
}

export const isGaClientId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,20}\.\d{1,20}$/.test(value);

/** Meta's browser id, the `_fbp` cookie its own pixel sets: `fb.1.1712345678901.123456789`. */
export const isMetaBrowserId = (value: unknown): value is string =>
  typeof value === "string" && /^fb\.\d\.\d{10,16}\.\d{1,25}$/.test(value);

/**
 * Meta's click id as the Conversions API wants it: `fb.1.<when>.<fbclid>`,
 * where "when" is the moment the click was first seen, in milliseconds.
 */
export const metaClickParam = (fbclid: string, seenAt: Date): string => `fb.1.${seenAt.getTime()}.${fbclid}`;

/* -------------------------------------------------------------- consent */

/**
 * What the company lets go to a platform, per connection.
 *
 *   `never`: no email and no phone, hashed or otherwise. Click ids only.
 *   `consented`: hashed email and phone only for a customer who said yes to
 *   their details being used to measure advertising.
 *   `unless_refused`: hashed email and phone for every customer who has not
 *   said no, which is what Google's enhanced conversions and Meta's
 *   Conversions API assume, and which the company's own privacy notice has to
 *   say.
 *
 * The default is `consented`. The cost of being too careful is a conversion
 * matched on its click id alone; the cost of the other default is a
 * company's customer list in an ad platform without anybody having decided
 * it should be.
 */
export type PersonalDataMode = "never" | "consented" | "unless_refused";
export const PERSONAL_DATA_MODES: readonly PersonalDataMode[] = ["never", "consented", "unless_refused"];
export const DEFAULT_PERSONAL_DATA_MODE: PersonalDataMode = "consented";

export const PERSONAL_DATA_LABEL: Readonly<Record<PersonalDataMode, string>> = {
  never: "Never send email or phone, only click ids",
  consented: "Send hashed email and phone only for customers who said yes",
  unless_refused: "Send hashed email and phone unless the customer said no",
};

/** A customer's own answer, or null for one never asked. */
export type AdDataChoice = "granted" | "refused";

export type Identifier = "click_id" | "email" | "phone" | "client_id" | "browser_id";

export type WithheldReason =
  | "customer_refused"
  | "nothing_to_match"
  | "no_client_id"
  | "no_credit"
  | "nothing_invoiced";

export const WITHHELD: Readonly<Record<WithheldReason, string>> = {
  customer_refused: "The customer said their details are not to be used for advertising, so nothing about them was sent.",
  nothing_to_match: "There was nothing the platform could match the job on: no click id, and the company's setting or the customer's answer allows no email or phone.",
  no_client_id: "The visitor's analytics id was never captured, so Google Analytics could not tie the job to a visit.",
  no_credit: "The company's attribution model gives this platform none of this job, so telling it about the job would credit work it did not win.",
  nothing_invoiced: "Nothing has been invoiced on the job, and a conversion worth nothing teaches the account the click was worthless.",
};

export interface ShareInput {
  provider: AdsProvider;
  mode: PersonalDataMode;
  choice: AdDataChoice | null;
  have: Readonly<Record<Identifier, boolean>>;
}

export type ShareDecision =
  | {
    send: true;
    identifiers: Identifier[];
    /**
     * What the platform is told about consent for using this person's data
     * in advertising: Google's `adUserData` and GA4's `ad_user_data`. Granted
     * only when the company sends personal data for everybody, or this
     * customer said yes.
     */
    adUserData: "GRANTED" | "DENIED";
  }
  | { send: false; reason: WithheldReason; because: string };

/**
 * What may go to one platform about one customer, and what may not.
 *
 * A customer who said no gets nothing sent at all, not even a click id: a
 * click id joined to a booked job at an address is the customer, whatever the
 * platform calls it. Otherwise click ids and browser ids go, because they are
 * the platform's own identifiers handed back, and an email or phone goes,
 * hashed, only when the company's setting and the customer's answer both
 * allow it. A send with nothing to match on is withheld, with the reason, and
 * still written down.
 */
export function decideShare(input: ShareInput): ShareDecision {
  if (input.choice === "refused") {
    return { send: false, reason: "customer_refused", because: WITHHELD.customer_refused };
  }
  const spec = PROVIDERS[input.provider];
  const personal = spec.personalData && input.mode !== "never"
    && (input.mode === "unless_refused" || input.choice === "granted");
  const adUserData = input.mode !== "never" && (input.mode === "unless_refused" || input.choice === "granted")
    ? "GRANTED" as const : "DENIED" as const;

  if (input.provider === "ga4") {
    if (!input.have.client_id) return { send: false, reason: "no_client_id", because: WITHHELD.no_client_id };
    return { send: true, identifiers: ["client_id"], adUserData };
  }

  const identifiers: Identifier[] = [];
  if (input.have.click_id) identifiers.push("click_id");
  if (input.provider === "meta_ads" && input.have.browser_id) identifiers.push("browser_id");
  if (personal && input.have.email) identifiers.push("email");
  if (personal && input.have.phone) identifiers.push("phone");
  if (identifiers.length === 0) return { send: false, reason: "nothing_to_match", because: WITHHELD.nothing_to_match };
  return { send: true, identifiers, adUserData };
}

/* ---------------------------------------------------------- idempotency */

/**
 * The id a send carries to the platform, which is the same every time it is
 * made for the same job.
 *
 * The unique index on the send table stops this product counting a job
 * twice. This stops the PLATFORM counting it twice when a send is repeated
 * after a crash between the request and the record of it: Google
 * deduplicates click conversions on `orderId`, Meta deduplicates events on
 * `event_id`, and Google Analytics reports one purchase per
 * `transaction_id`.
 */
export const eventId = (kind: EventKind, jobId: string): string => `ots_${kind}_${jobId}`;

/** A send that failed in transit is tried again on this ladder, then left for a person. */
export const MAX_SEND_ATTEMPTS = 6;
const RETRY_MINUTES = [5, 30, 120, 360, 1440];

export function retryAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_SEND_ATTEMPTS) return null;
  const minutes = RETRY_MINUTES[Math.min(Math.max(attempts - 1, 0), RETRY_MINUTES.length - 1)]!;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * How far back a job may have been booked and still be sent.
 *
 * Google refuses a click conversion more than ninety days after the click,
 * and Meta refuses an event more than seven days old, so a job paid in the
 * fourth month is told to nobody. Lead events are sent when the job is
 * booked, so they look back only a little in case the worker was down.
 */
export const LOOKBACK_DAYS: Readonly<Record<EventKind, number>> = { lead: 7, purchase: 90 };

/** A click conversion's time, the way Google's API reads it: `2026-04-01 14:05:00+00:00`. */
export const googleDateTime = (at: Date): string =>
  `${at.toISOString().slice(0, 19).replace("T", " ")}+00:00`;

/* --------------------------------------------------------------- reviews */

const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** A star rating as Google writes it ("FOUR") or as a number, or null for one that is neither. */
export function starRating(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  if (typeof value === "string") return STARS[value.trim().toUpperCase()] ?? null;
  return null;
}

export interface MatchCandidate {
  customerId: string;
  customerName: string;
  jobId: string | null;
  /** When the work was finished. Candidates are jobs finished shortly before the review. */
  finishedAt: Date;
}

export interface MatchSuggestion {
  customerId: string;
  jobId: string | null;
  because: string;
}

/** How long after a finished job a review is still likely to be about it. */
export const MATCH_WINDOW_DAYS = 45;

const nameTokens = (name: string): string[] =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s.-]/g, " ").split(/[\s.-]+/).filter(Boolean);

/**
 * Which customer a review is probably from, as a SUGGESTION.
 *
 * Never written onto the review by itself. A review is public speech by
 * somebody who chose what to call themselves, and "J. Smith" with a
 * finished job last week is a likely match and not a fact: tying it to the
 * wrong customer puts a stranger's one star on a technician's record and a
 * recovery call to somebody who never complained. So a person confirms it.
 *
 * Strong when every word of the reviewer's name is in the customer's name,
 * and when it is a first name and a last initial ("John D."). A first name
 * alone is too common to suggest anybody. The job has to have been finished
 * in the forty five days before the review, and when two customers fit
 * equally, nobody is suggested, because choosing one of them is a guess.
 */
export function suggestReviewMatch(
  review: { authorName: string | null; postedAt: Date },
  candidates: readonly MatchCandidate[],
): MatchSuggestion | null {
  if (!review.authorName) return null;
  const said = nameTokens(review.authorName);
  if (said.length < 2) return null;
  const windowStart = review.postedAt.getTime() - MATCH_WINDOW_DAYS * 86_400_000;

  const fits = candidates.filter((c) =>
    c.finishedAt.getTime() <= review.postedAt.getTime() && c.finishedAt.getTime() >= windowStart);

  const scored = fits.map((c) => {
    const theirs = nameTokens(c.customerName);
    const full = said.every((token) => token.length > 1 && theirs.includes(token));
    const first = said[0]!;
    const last = said[said.length - 1]!;
    const initial = said.length === 2 && last.length === 1
      && theirs[0] === first && theirs.length >= 2 && theirs[theirs.length - 1]!.startsWith(last);
    return { c, score: full ? 2 : initial ? 1 : 0 };
  }).filter((s) => s.score > 0);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  const people = new Set(top.map((s) => s.c.customerId));
  if (people.size !== 1) return null;
  /** The most recent finished job of that customer, which is the one a review is usually about. */
  const pick = top.sort((a, b) => b.c.finishedAt.getTime() - a.c.finishedAt.getTime())[0]!.c;
  const days = Math.max(0, Math.round((review.postedAt.getTime() - pick.finishedAt.getTime()) / 86_400_000));
  return {
    customerId: pick.customerId,
    jobId: pick.jobId,
    because: `Signed "${review.authorName.trim()}", and ${pick.customerName} had a job finished `
      + `${days === 0 ? "the same day" : days === 1 ? "the day before" : `${days} days before`} the review.`,
  };
}
