import {
  type Money, type CurrencyCode,
  add, allocate, isNegative, isZero, zero,
} from "../money/index.js";

/**
 * WHICH JOBS CAME FROM WHICH MONEY
 *
 * A home services company spends on Google, on a yard sign, on a direct mail
 * drop and on a van wrap, and the only question the owner actually has is
 * which of those four brought in work. Every product in this category answers
 * it with a text box on the customer record labelled "how did you hear about
 * us", and every one of those text boxes contains "google", "Google",
 * "google ads" and "GoogleAds" within a month. The report built on it is not
 * slightly wrong. It is wrong in a way that hides the answer completely,
 * because the one campaign that works is split four ways and comes third.
 *
 * So four things live here, and all four are pure functions of data that was
 * recorded. No database, no clock, no fetch. Every decision returns either a
 * result or a refusal carrying a sentence somebody can act on.
 *
 *   A CATALOGUE OF LEAD SOURCES, closed and declared, with the aliases that
 *   map real world spelling onto it. Free text goes in one end, a key from a
 *   known list comes out, and anything unplaceable is refused rather than
 *   invented.
 *
 *   TOUCH PARSING AND ATTRIBUTION. UTMs, click ids, a tracked phone number
 *   and a referrer become one normalised touch, and a set of touches becomes
 *   a credited source under a named model. Each model says out loud what it
 *   is wrong about, because every one of them is wrong about something and a
 *   number presented without that caveat gets a budget moved.
 *
 *   A LEAD FORM AS DATA. Fields, types, required flags and validation rules
 *   that are values in a list, never a string that becomes code. Same
 *   argument as report definitions and workflow conditions, and it bites
 *   harder here: a lead form is the one page in a self hosted install that is
 *   open to the whole internet, and a user supplied regular expression on it
 *   is a denial of service anybody can trigger.
 *
 *   SPEND AND RETURN. Cost per lead, cost per booked job, return on ad spend,
 *   and careful, explicit handling of the three cases that break every
 *   spreadsheet version of this: no leads, no jobs, and no recorded spend.
 *
 * Money never touches a float. Ratios are computed on the underlying integers
 * and revenue is split with `allocate`, so the credited amounts add back up
 * to the invoice exactly.
 */

/* -------------------------------------------------------------------------
 * 1. THE LEAD SOURCE CATALOGUE
 * ---------------------------------------------------------------------- */

/**
 * Where work comes from, as a closed list.
 *
 * WHY THIS IS NOT A TEXT COLUMN. The text column is the default choice, it is
 * what the office asks for, and it destroys the only report the owner wanted.
 * Three CSRs typing what a customer said produce "google", "Google", "google
 * ads", "GoogleAds", "googl" and "online". Grouped by that column, the
 * campaign that booked forty thousand dollars appears as six rows of seven
 * thousand and ranks below the yard signs. Nobody notices, because every row
 * is plausible.
 *
 * The cost of closing the list is real and is worth naming: a contractor who
 * runs a radio spot on a station we did not think of cannot add their own
 * source. That is a gap, and the answer to it is a campaign attached to a
 * catalogue source, not a new string. A campaign is free text on purpose,
 * because a campaign is a label. A source is a dimension, and a dimension
 * that anybody can spell freely is not a dimension.
 *
 * `direct` and `unknown` are both in the list and they are NOT the same
 * thing, which is the distinction most systems collapse:
 *
 *   `direct` means we looked and there was genuinely nothing: they typed the
 *   domain, or they had us in their phone already.
 *
 *   `unknown` means something WAS recorded and we could not place it. That is
 *   a job for a person: add the alias, and next month the report is right.
 *   Folding it into `direct` makes a data quality problem look like customer
 *   loyalty, which is the most flattering possible way to be wrong.
 */
export type LeadSourceKey =
  | "google_ads"
  | "google_lsa"
  | "bing_ads"
  | "meta_ads"
  | "organic_search"
  | "google_business_profile"
  | "organic_social"
  | "email"
  | "marketplace"
  | "referral_customer"
  | "referral_trade"
  | "repeat_customer"
  | "yard_sign"
  | "vehicle_wrap"
  | "direct_mail"
  | "door_hanger"
  | "radio"
  | "television"
  | "home_show"
  | "direct"
  | "unknown";

/**
 * How a source is grouped on a report, and whether a click can carry a tag.
 *
 * `taggable` is the field that earns its place. A yard sign cannot carry a
 * UTM and never will, so a yard sign will never appear in the attribution
 * numbers no matter how good the tracking gets. It shows up as a brand search
 * three days later, credited to Google. Marking the untaggable sources says
 * so in the data instead of leaving every owner to rediscover it.
 */
export type SourceCategory =
  | "paid_digital"
  | "organic_digital"
  | "referral"
  | "offline"
  | "owned"
  | "unattributed";

export interface LeadSourceSpec {
  key: LeadSourceKey;
  label: string;
  /** What it means to whoever is choosing it on a screen. */
  meaning: string;
  category: SourceCategory;
  /** Whether money is normally spent against it, so a blank spend is notable. */
  paid: boolean;
  /**
   * Whether a visit from this source can carry a UTM or a click id. False for
   * everything physical, which is exactly the spend that gets credited to
   * somebody else's channel.
   */
  taggable: boolean;
}

export const LEAD_SOURCES: LeadSourceSpec[] = [
  {
    key: "google_ads",
    label: "Google Ads",
    meaning: "A paid search or display click from Google. Billed by the click.",
    category: "paid_digital", paid: true, taggable: true,
  },
  {
    key: "google_lsa",
    label: "Local Services Ads",
    meaning: "Google's pay per lead ads with the green tick. Billed by the lead, not the click, so its cost per lead is a price rather than an outcome.",
    category: "paid_digital", paid: true, taggable: true,
  },
  {
    key: "bing_ads",
    label: "Microsoft Ads",
    meaning: "Paid search on Bing. Small, older, and usually the cheapest booked job in the account.",
    category: "paid_digital", paid: true, taggable: true,
  },
  {
    key: "meta_ads",
    label: "Meta Ads",
    meaning: "Paid on Facebook or Instagram. Demand we created rather than demand we caught.",
    category: "paid_digital", paid: true, taggable: true,
  },
  {
    key: "organic_search",
    label: "Organic search",
    meaning: "They found us in the unpaid results. No click cost, which is not the same as no cost.",
    category: "organic_digital", paid: false, taggable: true,
  },
  {
    key: "google_business_profile",
    label: "Google Business Profile",
    meaning: "The map listing. Usually the highest intent traffic a local contractor gets.",
    category: "organic_digital", paid: false, taggable: true,
  },
  {
    key: "organic_social",
    label: "Social",
    meaning: "An unpaid post or a neighbourhood group. Often a referral wearing a different hat.",
    category: "organic_digital", paid: false, taggable: true,
  },
  {
    key: "email",
    label: "Email",
    meaning: "A campaign or a reminder we sent. Almost always to somebody who is already a customer.",
    category: "owned", paid: false, taggable: true,
  },
  {
    key: "marketplace",
    label: "A lead marketplace",
    meaning: "Angi, Thumbtack, a home warranty network. Paid per lead and usually sold to three other companies at the same time.",
    category: "paid_digital", paid: true, taggable: true,
  },
  {
    key: "referral_customer",
    label: "Referred by a customer",
    meaning: "An existing customer sent them. The highest closing rate in the business and the hardest to buy more of.",
    category: "referral", paid: false, taggable: false,
  },
  {
    key: "referral_trade",
    label: "Referred by another trade",
    meaning: "A builder, a realtor, a plumber we work with. May carry a fee, which is why it is a party role as well as a source.",
    category: "referral", paid: false, taggable: false,
  },
  {
    key: "repeat_customer",
    label: "An existing customer",
    meaning: "They have been here before. Not marketing at all, and counting it as marketing flatters every channel that never touched them.",
    category: "owned", paid: false, taggable: false,
  },
  {
    key: "yard_sign",
    label: "Yard sign",
    meaning: "A sign on a job we did nearby. Cannot be tagged, so it gets credited to whatever they searched afterwards.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "vehicle_wrap",
    label: "The van",
    meaning: "They saw the truck. The cheapest advertising a contractor owns and the least measurable.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "direct_mail",
    label: "Direct mail",
    meaning: "A postcard or a letter to a list. Measurable only if the piece carries its own number or code.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "door_hanger",
    label: "Door hanger",
    meaning: "Left on a door, usually beside a job in progress.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "radio",
    label: "Radio",
    meaning: "A spot on a station. Bought on reach, measured on faith unless it has its own number.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "television",
    label: "Television",
    meaning: "A television spot, including streaming. Same measurement problem as radio.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "home_show",
    label: "A show or an event",
    meaning: "A stand at a home show or a fair. Spend is a lump, leads arrive in two days, jobs land three months later.",
    category: "offline", paid: true, taggable: false,
  },
  {
    key: "direct",
    label: "Direct",
    meaning: "Nothing was recorded and nothing was expected: they typed the address, or they already had our number. A real answer, not a missing one.",
    category: "unattributed", paid: false, taggable: false,
  },
  {
    key: "unknown",
    label: "Not recognised",
    meaning: "Something was recorded and we could not place it. Somebody should look at it and add the alias, and until they do it must not be counted as anything else.",
    category: "unattributed", paid: false, taggable: false,
  },
];

export const LEAD_SOURCE_KEYS: LeadSourceKey[] = LEAD_SOURCES.map((s) => s.key);

const BY_KEY = new Map<LeadSourceKey, LeadSourceSpec>(LEAD_SOURCES.map((s) => [s.key, s]));

export const leadSource = (key: LeadSourceKey): LeadSourceSpec => BY_KEY.get(key)!;

/**
 * A key outside the list is shown rather than swallowed.
 *
 * Same rule as the party roles and the job priority scale next door: a row
 * that arrived from an import came from somewhere, and a reader is better
 * served by seeing it than by a blank where a source should be.
 */
export function leadSourceLabel(key: string): string {
  return LEAD_SOURCES.find((s) => s.key === key)?.label ?? key.replace(/_/g, " ");
}

/**
 * Squash a piece of free text down to the only part that carries meaning.
 *
 * Letters and digits, lower case, everything else gone. That is what turns
 * "Google Ads", "google-ads", "google_ads", "GoogleAds" and "  GOOGLE ADS  "
 * into one token, which is the entire reason the alias table is small enough
 * to read.
 */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The aliases, as data.
 *
 * Every entry here is a spelling somebody has actually put in a utm_source or
 * said to a CSR. It grows, and growing it is a one line change that fixes
 * every historical report built from the raw text, which is the payoff for
 * keeping the resolved key separate from what was typed.
 */
const SOURCE_ALIASES: Record<string, LeadSourceKey> = {
  googleads: "google_ads", adwords: "google_ads", googleadwords: "google_ads",
  gads: "google_ads", googlecpc: "google_ads", googlepaid: "google_ads",
  googlesearchads: "google_ads", ppc: "google_ads",

  lsa: "google_lsa", localservicesads: "google_lsa", localservices: "google_lsa",
  googlelsa: "google_lsa", googleguaranteed: "google_lsa", googlelocalservices: "google_lsa",

  bingads: "bing_ads", microsoftads: "bing_ads", msads: "bing_ads",
  microsoftadvertising: "bing_ads", bingcpc: "bing_ads",

  facebookads: "meta_ads", fbads: "meta_ads", metaads: "meta_ads",
  instagramads: "meta_ads", igads: "meta_ads", meta: "meta_ads", fb: "meta_ads",

  organic: "organic_search", seo: "organic_search", search: "organic_search",
  googleorganic: "organic_search", duckduckgo: "organic_search", ddg: "organic_search",
  yahoo: "organic_search", ecosia: "organic_search", brave: "organic_search",

  gbp: "google_business_profile", googlebusinessprofile: "google_business_profile",
  googlemybusiness: "google_business_profile", gmb: "google_business_profile",
  googlemaps: "google_business_profile", maps: "google_business_profile",

  social: "organic_social", nextdoor: "organic_social", facebookgroup: "organic_social",
  neighbourhoodgroup: "organic_social", neighborhoodgroup: "organic_social",

  newsletter: "email", mailer: "email", resend: "email", mailchimp: "email",

  angi: "marketplace", angieslist: "marketplace", homeadvisor: "marketplace",
  thumbtack: "marketplace", porch: "marketplace", yelp: "marketplace",
  networx: "marketplace", modernize: "marketplace",

  referral: "referral_customer", wordofmouth: "referral_customer",
  friend: "referral_customer", neighbour: "referral_customer", neighbor: "referral_customer",
  customerreferral: "referral_customer",

  realtor: "referral_trade", builder: "referral_trade", generalcontractor: "referral_trade",
  gc: "referral_trade", tradereferral: "referral_trade", partner: "referral_trade",
  propertymanager: "referral_trade",

  repeat: "repeat_customer", existingcustomer: "repeat_customer",
  previouscustomer: "repeat_customer", pastcustomer: "repeat_customer",

  yardsign: "yard_sign", lawnsign: "yard_sign", sign: "yard_sign",
  vehiclewrap: "vehicle_wrap", truck: "vehicle_wrap", van: "vehicle_wrap",
  vanwrap: "vehicle_wrap", sawthetruck: "vehicle_wrap", trucksignage: "vehicle_wrap",
  directmail: "direct_mail", postcard: "direct_mail", mail: "direct_mail",
  eddm: "direct_mail", letter: "direct_mail",
  doorhanger: "door_hanger", doorknocker: "door_hanger", flyer: "door_hanger",
  radio: "radio", radiospot: "radio", podcast: "radio",
  tv: "television", television: "television", ctv: "television", streamingtv: "television",
  homeshow: "home_show", tradeshow: "home_show", fair: "home_show", event: "home_show",

  direct: "direct", none: "direct", typedin: "direct",
};

/**
 * The vendors whose name alone does not say whether we paid.
 *
 * `utm_source=google` is the single commonest tag in the wild and it means
 * nothing on its own: it is organic search, a paid click and the map listing,
 * depending on the medium beside it. Guessing paid overstates the ad account
 * and moves budget toward a channel that was working for free. Guessing
 * organic hides the ad spend entirely. So the pair is resolved together, and
 * where the medium is missing the answer is deliberately left open for the
 * click id to settle.
 */
const AMBIGUOUS_VENDORS: Record<string, { paid: LeadSourceKey; unpaid: LeadSourceKey }> = {
  google: { paid: "google_ads", unpaid: "organic_search" },
  bing: { paid: "bing_ads", unpaid: "organic_search" },
  microsoft: { paid: "bing_ads", unpaid: "organic_search" },
  facebook: { paid: "meta_ads", unpaid: "organic_social" },
  instagram: { paid: "meta_ads", unpaid: "organic_social" },
  youtube: { paid: "meta_ads", unpaid: "organic_social" },
  linkedin: { paid: "meta_ads", unpaid: "organic_social" },
  tiktok: { paid: "meta_ads", unpaid: "organic_social" },
  email: { paid: "email", unpaid: "email" },
};

const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paidsearch", "paid", "cpm", "cpv", "display", "banner",
  "retargeting", "remarketing", "paidsocial", "cpa", "affiliate",
]);

const UNPAID_MEDIUMS = new Set([
  "organic", "seo", "natural", "social", "socialorganic", "referral",
  "email", "newsletter", "none", "notset",
]);

export type SourceResolution =
  | { ok: true; source: LeadSourceKey; matched: "alias" | "key" | "vendor_and_medium" }
  | { ok: false; reason: "empty" | "unrecognised"; detail: string; suggestions: LeadSourceKey[] };

/**
 * Turn whatever was written down into a key from the catalogue.
 *
 * Refuses instead of guessing, and the refusal carries suggestions so the
 * person looking at it can pick one rather than invent another spelling. A
 * resolver that fell back to `unknown` silently would be a text column again
 * with extra steps: the whole value of this function is that somebody is
 * told when the catalogue has a gap.
 *
 * `medium` is optional and only consulted for the vendors whose name alone is
 * ambiguous. Passing it costs nothing and is the difference between crediting
 * the ad account and crediting the SEO that has been working for free.
 */
export function resolveSource(source: string, medium?: string | null): SourceResolution {
  const token = squash(source);
  if (token === "") {
    return {
      ok: false, reason: "empty",
      detail: "No source was given. Leave it unrecorded rather than guessing: an empty source is a fact and a wrong one is not.",
      suggestions: [],
    };
  }

  const mediumToken = squash(medium ?? "");
  const vendor = AMBIGUOUS_VENDORS[token];
  if (vendor) {
    if (PAID_MEDIUMS.has(mediumToken)) {
      return { ok: true, source: vendor.paid, matched: "vendor_and_medium" };
    }
    if (UNPAID_MEDIUMS.has(mediumToken)) {
      return { ok: true, source: vendor.unpaid, matched: "vendor_and_medium" };
    }
    /**
     * A bare vendor with no usable medium. Not resolvable here on purpose:
     * `parseTouch` gets a second chance with the click id, which settles it
     * properly, and anything that has neither deserves to be looked at.
     */
    return {
      ok: false, reason: "unrecognised",
      detail: `"${source}" could be paid or unpaid. Tag the medium (cpc or organic) so the ad account is not credited with work the free listing brought in.`,
      suggestions: [vendor.paid, vendor.unpaid],
    };
  }

  const alias = SOURCE_ALIASES[token];
  if (alias) return { ok: true, source: alias, matched: "alias" };

  const direct = LEAD_SOURCE_KEYS.find((key) => squash(key) === token);
  if (direct) return { ok: true, source: direct, matched: "key" };

  return {
    ok: false, reason: "unrecognised",
    detail: `"${source}" is not a source we know. Add it to the alias list if it is real, so every report going back also gets it right.`,
    suggestions: suggestSources(token),
  };
}

/**
 * Near misses, by shared substring rather than edit distance.
 *
 * Deliberately crude. The job is to put "did you mean Google Ads" in front of
 * somebody, not to be a spell checker, and a crude list that is obviously
 * incomplete invites the person to read the catalogue, which is the outcome
 * we want anyway.
 */
function suggestSources(token: string): LeadSourceKey[] {
  if (token.length < 3) return [];
  const hits: LeadSourceKey[] = [];
  for (const spec of LEAD_SOURCES) {
    const key = squash(spec.key);
    const label = squash(spec.label);
    if (key.includes(token) || token.includes(key) || label.includes(token) || token.includes(label)) {
      hits.push(spec.key);
    }
  }
  return hits.slice(0, 3);
}

/* -------------------------------------------------------------------------
 * 2. TOUCHES
 * ---------------------------------------------------------------------- */

/** The five tags, exactly as they were written, kept for audit. */
export interface Utm {
  source?: string | undefined;
  medium?: string | undefined;
  campaign?: string | undefined;
  term?: string | undefined;
  content?: string | undefined;
}

/**
 * How we decided what this touch was, which is as important as the answer.
 *
 * A report that cannot separate "they tagged it" from "we inferred it from
 * the referring host" cannot tell an owner how much of their attribution is
 * actually evidence. Most of it is not.
 */
export type TouchBasis =
  | "utm"
  | "click_id"
  | "tracked_number"
  | "referrer"
  | "none";

export interface Touch {
  at: Date;
  source: LeadSourceKey;
  basis: TouchBasis;
  utm: Utm;
  /** The host of the referring page, lower case, without `www.`. */
  referrerHost: string | null;
  /** The click id we found, if any: gclid, msclkid, fbclid. */
  clickId: string | null;
  /** The campaign, free text on purpose. A label, never a dimension. */
  campaign: string | null;
  /**
   * What was written when we could not place it. Present only when the source
   * came out `unknown`, and it is the list somebody works through to add the
   * next alias.
   */
  unrecognised?: string | undefined;
}

export interface TouchInput {
  at: Date;
  /** The landing page query string, with or without the leading `?`. */
  query?: string | null | undefined;
  /** What the browser reported as the referring page. */
  referrer?: string | null | undefined;
  /**
   * The tracked number they dialled, when this touch is a phone call. Dynamic
   * number insertion means the number itself is the tag, and it is the only
   * tag a yard sign or a van can carry.
   */
  trackedNumber?: string | null | undefined;
  /** Which number belongs to which source. Data, declared by the office. */
  numberMap?: Record<string, LeadSourceKey> | undefined;
  /** Our own hostnames, so a page of ours is not counted as a referral. */
  ownHosts?: string[] | undefined;
}

/**
 * Read a query string without ever throwing.
 *
 * Hand rolled rather than handed to a URL parser, for one reason: a lead form
 * is reached by whatever a real browser, a scanner and a broken email client
 * put in the address bar, and `decodeURIComponent("%E0%A4%A")` throws. A
 * throw here is a lost lead, which is a customer who filled in a form and
 * never heard back. So a value that will not decode is kept exactly as it
 * arrived, and the touch still gets recorded.
 *
 * First occurrence of a key wins. A duplicated `utm_source` is usually a
 * redirect chain appending a second one, and the first is the one the click
 * actually carried.
 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = query.replace(/^[?#]/, "");
  if (text === "") return out;

  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeLoosely(rawKey).toLowerCase().trim();
    if (key === "") continue;
    // `__proto__` in a query string is free and the damage is not. Same rule
    // as the workflow condition paths next door.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = decodeLoosely(rawValue).trim();
  }
  return out;
}

function decodeLoosely(text: string): string {
  const plussed = text.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plussed);
  } catch {
    return plussed;
  }
}

/**
 * The host out of a referrer, without a URL parser.
 *
 * Referrers arrive as `https://www.google.com/`, as `android-app://com.google.
 * android.googlequicksearchbox`, as a bare host, and as rubbish. None of those
 * should throw and none of them should be trusted to have a scheme.
 */
export function referrerHost(referrer: string): string | null {
  const text = referrer.trim();
  if (text === "") return null;
  const afterScheme = text.replace(/^[a-z0-9.+-]+:\/\//i, "");
  const host = afterScheme.split(/[/?#]/)[0] ?? "";
  const withoutAuth = host.includes("@") ? (host.split("@").pop() ?? "") : host;
  const withoutPort = withoutAuth.split(":")[0] ?? "";
  const lowered = withoutPort.toLowerCase().replace(/^www\./, "");
  return lowered === "" ? null : lowered;
}

/**
 * Referring hosts we can place, as data.
 *
 * Matched on a trailing segment so `google.co.uk` and `mail.google.com` both
 * land, and ordered most specific first because a mail host is not the search
 * engine it shares a domain with.
 */
const REFERRER_MAP: { host: string; source: LeadSourceKey }[] = [
  { host: "mail.google.com", source: "email" },
  { host: "business.google.com", source: "google_business_profile" },
  { host: "maps.google.com", source: "google_business_profile" },
  { host: "google.com", source: "organic_search" },
  { host: "google.", source: "organic_search" },
  { host: "bing.com", source: "organic_search" },
  { host: "duckduckgo.com", source: "organic_search" },
  { host: "search.yahoo.com", source: "organic_search" },
  { host: "ecosia.org", source: "organic_search" },
  { host: "facebook.com", source: "organic_social" },
  { host: "instagram.com", source: "organic_social" },
  { host: "nextdoor.com", source: "organic_social" },
  { host: "youtube.com", source: "organic_social" },
  { host: "linkedin.com", source: "organic_social" },
  { host: "reddit.com", source: "organic_social" },
  { host: "angi.com", source: "marketplace" },
  { host: "angieslist.com", source: "marketplace" },
  { host: "homeadvisor.com", source: "marketplace" },
  { host: "thumbtack.com", source: "marketplace" },
  { host: "yelp.com", source: "marketplace" },
  { host: "porch.com", source: "marketplace" },
];

function sourceForReferrer(host: string): LeadSourceKey | null {
  for (const entry of REFERRER_MAP) {
    if (host === entry.host || host.endsWith(`.${entry.host}`) || host.startsWith(entry.host)) {
      return entry.source;
    }
  }
  return null;
}

/** Click ids, and the source each one proves. */
const CLICK_IDS: { param: string; source: LeadSourceKey }[] = [
  { param: "gclid", source: "google_ads" },
  // Auto-tagging on iOS drops gclid and sends these instead. A parser that
  // only knows gclid loses most of the iPhone traffic, which in this trade is
  // most of the homeowners.
  { param: "gbraid", source: "google_ads" },
  { param: "wbraid", source: "google_ads" },
  { param: "msclkid", source: "bing_ads" },
  { param: "fbclid", source: "meta_ads" },
  { param: "ttclid", source: "meta_ads" },
];

/**
 * One visit, one call or one form fill, turned into a touch.
 *
 * ORDER OF EVIDENCE, and it is deliberate:
 *
 *   1. A UTM pair that resolves. Somebody tagged this on purpose and the
 *      whole point of tagging is that it beats inference.
 *   2. A click id. Proof of a paid click, and the thing that settles a bare
 *      `utm_source=google` with no medium.
 *   3. The tracked number they dialled. This is how anything physical gets
 *      measured at all: a yard sign with its own number is the only yard sign
 *      that will ever appear in a report.
 *   4. The referring host.
 *   5. Nothing, which is `direct`.
 *
 * A UTM that was present and did not resolve produces `unknown`, not `direct`
 * and not a fallback to the referrer. That is the difference between "we have
 * a gap in our alias list" and "they came straight to us", and collapsing the
 * two makes a data problem look like brand strength.
 */
export function parseTouch(input: TouchInput): Touch {
  const params = parseQuery(input.query ?? "");
  const utm: Utm = {
    source: params["utm_source"] || undefined,
    medium: params["utm_medium"] || undefined,
    campaign: params["utm_campaign"] || undefined,
    term: params["utm_term"] || undefined,
    content: params["utm_content"] || undefined,
  };

  const clickEntry = CLICK_IDS.find((c) => (params[c.param] ?? "") !== "");
  const clickId = clickEntry ? (params[clickEntry.param] ?? null) : null;

  const host = input.referrer ? referrerHost(input.referrer) : null;
  const own = (input.ownHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""));
  /**
   * A referrer of our own is not a referral. Somebody moving from our pricing
   * page to our booking page is one session, and counting it as a referral
   * from ourselves is how "our own website" becomes the top lead source.
   */
  const externalHost = host && !own.some((o) => host === o || host.endsWith(`.${o}`)) ? host : null;

  const base = {
    at: input.at,
    utm,
    referrerHost: externalHost,
    clickId,
    campaign: utm.campaign ?? null,
  };

  if (utm.source) {
    const resolved = resolveSource(utm.source, utm.medium ?? null);
    if (resolved.ok) return { ...base, source: resolved.source, basis: "utm" };
    if (clickEntry) return { ...base, source: clickEntry.source, basis: "click_id" };
    return { ...base, source: "unknown", basis: "utm", unrecognised: utm.source };
  }

  if (clickEntry) return { ...base, source: clickEntry.source, basis: "click_id" };

  if (input.trackedNumber) {
    const digits = onlyDigits(input.trackedNumber);
    const map = input.numberMap ?? {};
    for (const [number, source] of Object.entries(map)) {
      if (onlyDigits(number) === digits) return { ...base, source, basis: "tracked_number" };
    }
    /**
     * A number we do not recognise is `unknown`, not `direct`. A call came in
     * on a line somebody bought and forgot to record, and the fix is a row in
     * the number map, which only happens if the report says so.
     */
    return { ...base, source: "unknown", basis: "tracked_number", unrecognised: input.trackedNumber };
  }

  if (externalHost) {
    const fromReferrer = sourceForReferrer(externalHost);
    if (fromReferrer) return { ...base, source: fromReferrer, basis: "referrer" };
    // A real site we do not have in the list linked to us. That is a referral
    // and naming the host is more useful than calling it unknown.
    return { ...base, source: "unknown", basis: "referrer", unrecognised: externalHost };
  }

  return { ...base, source: "direct", basis: "none" };
}

const onlyDigits = (text: string): string => {
  const digits = text.replace(/\D/g, "");
  // A North American number written with the country code is the same number.
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

/* -------------------------------------------------------------------------
 * 3. ATTRIBUTION MODELS
 * ---------------------------------------------------------------------- */

export type AttributionModelKey =
  | "first_touch"
  | "last_touch"
  | "last_non_direct"
  | "linear"
  | "position_based";

export interface AttributionModelSpec {
  key: AttributionModelKey;
  label: string;
  /** What the model does, in one sentence somebody can repeat in a meeting. */
  meaning: string;
  /**
   * WHAT IT IS WRONG ABOUT. Required, not optional, and shown on screen
   * beside the number. Every model here is wrong in a specific, nameable way,
   * and a figure presented without its caveat is the thing that moves a
   * budget onto the wrong channel.
   */
  wrongAbout: string;
}

export const ATTRIBUTION_MODELS: Record<AttributionModelKey, AttributionModelSpec> = {
  first_touch: {
    key: "first_touch",
    label: "First touch",
    meaning: "All of it to whatever brought them here the first time.",
    wrongAbout:
      "It overcredits the top of the funnel forever. A blog post somebody read two years ago keeps taking credit for work that was won by the estimate, the price and the technician who turned up, and nothing that happens after the first click can ever change the number.",
  },
  last_touch: {
    key: "last_touch",
    label: "Last touch",
    meaning: "All of it to the last thing they did before they became a lead.",
    wrongAbout:
      "It overcredits the brand search somebody does after seeing a yard sign. The sign did the work, the homeowner typed the company name into Google, and the ad account books the job. Branded search is the most overrated line in most contractor ad accounts for exactly this reason.",
  },
  last_non_direct: {
    key: "last_non_direct",
    label: "Last non direct",
    meaning: "The last touch that was actually identifiable, ignoring direct visits.",
    wrongAbout:
      "It assumes a direct visit is never the cause, and for a repeat customer with the number in their phone the direct visit is the whole story. It also keeps crediting a channel that touched them once, months ago, simply because nothing else was ever tagged.",
  },
  linear: {
    key: "linear",
    label: "Even split",
    meaning: "Every touch gets an equal share.",
    wrongAbout:
      "It treats a banner impression and the quote request as equally responsible, which they are not. It also rewards noise: a channel that retargets somebody eleven times gets eleven shares of a job it did not win.",
  },
  position_based: {
    key: "position_based",
    label: "First and last weighted",
    meaning: "Forty per cent to the first touch, forty to the last, the rest shared by the middle.",
    wrongAbout:
      "The weights are a convention, not a measurement. Nobody has ever shown that the first touch is worth forty per cent, and dressing a guess in decimals makes it look like a finding.",
  },
};

export const ATTRIBUTION_MODEL_KEYS = Object.keys(ATTRIBUTION_MODELS) as AttributionModelKey[];

export interface SourceCredit {
  source: LeadSourceKey;
  /**
   * An integer share, in whatever units this model produced. Integers rather
   * than a percentage, because these are fed to `allocate` to split real money
   * and a percentage rounded to two places does not add back up to the
   * invoice.
   */
  parts: number;
  /** How many touches this source contributed. */
  touches: number;
  /** For display only, to two places. Never feed this back into arithmetic. */
  percent: string;
}

export type AttributionDecision =
  | {
      ok: true;
      model: AttributionModelKey;
      credits: SourceCredit[];
      totalParts: number;
      touchCount: number;
      /** The one source a single line report shows. */
      primary: LeadSourceKey;
      /** Set when the model had to do something the reader should know about. */
      note?: string | undefined;
    }
  | { ok: false; reason: "no_touches"; detail: string };

/**
 * Credit a set of touches to sources under one named model.
 *
 * NO TOUCHES IS A REFUSAL, and this is the most important line in the file.
 * In the trades it is also the commonest case by a distance: the customer
 * rang the number on the van, or the office typed the job straight in, and
 * nothing was ever recorded. Every instinct in a reporting system is to give
 * that to `direct`, because it makes the pie chart add up to a hundred. It is
 * a lie with a specific cost: `direct` becomes the largest source in the
 * business, an owner concludes their brand is carrying them, and the channel
 * that actually books the work is underfunded. So this returns a refusal, the
 * caller shows "not attributed", and somebody can go and ask the customer.
 *
 * The touches are sorted by time, stably, so two recorded in the same
 * millisecond keep the order they arrived in. A page view and the form post
 * that follows it routinely share a timestamp, and flipping them swaps first
 * and last touch, which changes the answer.
 */
export function attribute(model: AttributionModelKey, touches: Touch[]): AttributionDecision {
  if (touches.length === 0) {
    return {
      ok: false, reason: "no_touches",
      detail: "Nothing was recorded for this lead, so no channel can be credited. That is the honest answer: attributing it to direct would make an untracked phone call look like brand loyalty. Ask the customer and set a source by hand.",
    };
  }

  const ordered = [...touches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const weights = weigh(model, ordered);

  let note: string | undefined;
  if (weights.fellBack) {
    note = "Every touch was direct, so there was no non direct touch to credit. Shown as direct, and it should be read as untracked rather than as brand.";
  }

  const bySource = new Map<LeadSourceKey, { parts: number; touches: number; last: number }>();
  weights.parts.forEach((parts, index) => {
    const touch = ordered[index];
    if (!touch || parts <= 0) return;
    const existing = bySource.get(touch.source);
    const at = touch.at.getTime();
    if (existing) {
      existing.parts += parts;
      existing.touches += 1;
      existing.last = Math.max(existing.last, at);
    } else {
      bySource.set(touch.source, { parts, touches: 1, last: at });
    }
  });

  const totalParts = [...bySource.values()].reduce((sum, v) => sum + v.parts, 0);

  const credits: SourceCredit[] = [...bySource.entries()]
    .map(([source, v]) => ({
      source,
      parts: v.parts,
      touches: v.touches,
      percent: percentOf(v.parts, totalParts),
      last: v.last,
    }))
    /**
     * Biggest first, then the more recent touch, then the key. Fully
     * deterministic on purpose: a report whose row order depends on map
     * insertion looks different every time somebody refreshes it, and people
     * stop trusting the whole screen over that.
     */
    .sort((a, b) => b.parts - a.parts || b.last - a.last || a.source.localeCompare(b.source))
    .map(({ source, parts, touches: count, percent }) => ({ source, parts, touches: count, percent }));

  return {
    ok: true,
    model,
    credits,
    totalParts,
    touchCount: ordered.length,
    primary: credits[0]!.source,
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * The share each touch gets, as integers.
 *
 * Position based scales its own weights rather than rounding: with `n`
 * touches the first and last get `40 * (n - 2)` and each middle touch gets
 * exactly 20, so the split is whole numbers at any length. Rounding a third
 * of twenty per cent three ways is how a report ends up at 99.99.
 */
function weigh(model: AttributionModelKey, ordered: Touch[]): { parts: number[]; fellBack: boolean } {
  const n = ordered.length;
  const none = () => new Array<number>(n).fill(0);

  switch (model) {
    case "first_touch": {
      const parts = none();
      parts[0] = 1;
      return { parts, fellBack: false };
    }
    case "last_touch": {
      const parts = none();
      parts[n - 1] = 1;
      return { parts, fellBack: false };
    }
    case "last_non_direct": {
      const parts = none();
      for (let i = n - 1; i >= 0; i -= 1) {
        if (ordered[i]!.source !== "direct") {
          parts[i] = 1;
          return { parts, fellBack: false };
        }
      }
      /**
       * Everything was direct. Credit the last one and say so, rather than
       * refusing: we do have touches, and a refusal here would throw away the
       * fact that somebody visited at all. The note is what stops a reader
       * mistaking it for a measured result.
       */
      parts[n - 1] = 1;
      return { parts, fellBack: true };
    }
    case "linear":
      return { parts: new Array<number>(n).fill(1), fellBack: false };
    case "position_based": {
      if (n === 1) return { parts: [100], fellBack: false };
      /**
       * Two touches get half each rather than forty and forty. There is no
       * middle for the remaining twenty to go to, and quietly dropping it
       * would leave a job only eighty per cent credited.
       */
      if (n === 2) return { parts: [50, 50], fellBack: false };
      const middles = n - 2;
      const parts = new Array<number>(n).fill(20);
      parts[0] = 40 * middles;
      parts[n - 1] = 40 * middles;
      return { parts, fellBack: false };
    }
  }
}

/**
 * A percentage for a screen, computed on integers.
 *
 * Two decimal places, half up, and never a float. Trivial arithmetic, but
 * floats are banned in this codebase for a reason and a percentage is exactly
 * the sort of "it is only for display" number that gets fed back into a
 * spreadsheet by an owner two weeks later.
 */
export function percentOf(part: number, total: number): string {
  if (total <= 0) return "0.00";
  const scaled = BigInt(Math.round(part)) * 10_000n;
  const divisor = BigInt(Math.round(total));
  let whole = scaled / divisor;
  if ((scaled % divisor) * 2n >= divisor) whole += 1n;
  const negative = whole < 0n;
  const abs = negative ? -whole : whole;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Split a job's value across the credited sources.
 *
 * Uses `allocate`, so the parts add back up to the job exactly. This is not
 * fussiness: attributed revenue is summed across hundreds of jobs on a report
 * that an owner compares against the invoice total, and a cent lost per job
 * per source is a visible discrepancy by the end of a quarter, which costs
 * more trust than the report was ever worth.
 *
 * Allocated at cent precision by default, because these numbers are shown and
 * exported as currency. Splitting at full scale gives parts that each round
 * down and no longer sum to the total.
 */
export function creditRevenue(
  credits: SourceCredit[],
  value: Money,
  precision = 2,
): { source: LeadSourceKey; amount: Money }[] {
  if (credits.length === 0) return [];
  const shares = allocate(value, credits.map((c) => String(c.parts)), precision);
  return credits.map((c, i) => ({ source: c.source, amount: shares[i] ?? zero(value.currency) }));
}

/**
 * Run several models over the same touches and say where they disagree.
 *
 * Built because the disagreement is the finding. When first touch and last
 * touch name the same channel, the answer is boring and safe. When they name
 * different ones, somebody is about to cut the channel that starts every job,
 * and the honest thing a report can do is put both numbers on the screen
 * instead of picking a house model and calling it the truth.
 */
export function compareModels(
  models: AttributionModelKey[],
  touches: Touch[],
): { model: AttributionModelKey; decision: AttributionDecision }[] {
  return models.map((model) => ({ model, decision: attribute(model, touches) }));
}

export function modelsAgree(results: { decision: AttributionDecision }[]): boolean {
  const primaries = results.map((r) => (r.decision.ok ? r.decision.primary : null));
  const first = primaries[0];
  return primaries.every((p) => p !== null && p === first);
}

/* -------------------------------------------------------------------------
 * 4. THE LEAD FORM, AS DATA
 * ---------------------------------------------------------------------- */

/**
 * A form definition is DATA, and its validation rules are data too.
 *
 * The same argument as report definitions and workflow conditions, and the
 * stakes are higher here than in either. A lead form is the one page in a self
 * hosted install that is deliberately exposed to the entire internet, with no
 * login in front of it. Two things follow.
 *
 *   A VALIDATION RULE MUST NOT BE A REGULAR EXPRESSION SOMEBODY TYPED. Give
 *   an office manager a "pattern" box and sooner or later it holds something
 *   with nested quantifiers, and then a single form post with a forty
 *   character value pins a CPU core until the process is killed. The
 *   contractor's whole system goes down and the request that did it looks
 *   entirely ordinary in the log. So patterns come from a named catalogue
 *   compiled in this file, and the definition may only choose one.
 *
 *   A FIELD TYPE MUST NOT BE A FUNCTION. Nothing in a stored definition is
 *   ever evaluated. The definition names things; this file decides what they
 *   mean.
 *
 * The cost is the usual one: a contractor cannot express every rule they can
 * imagine. What they can express is every rule a trades lead form actually
 * needs, and the list below is that, including the two fields every one of
 * these forms has and most form builders handle badly: where the property is,
 * and what is wrong with it.
 */
export type FieldType =
  | "text"
  | "long_text"
  | "email"
  | "phone"
  | "service_address"
  | "choice"
  | "multi_choice"
  | "number"
  | "date"
  | "consent"
  | "hidden"
  | "honeypot";

/** Named patterns, compiled here. A definition picks one; it never supplies one. */
export type PatternKey = "us_zip" | "digits" | "letters_and_spaces" | "us_state";

const PATTERNS: Record<PatternKey, { test: RegExp; expected: string }> = {
  us_zip: { test: /^\d{5}(-\d{4})?$/, expected: "a five digit ZIP, or ZIP+4" },
  digits: { test: /^\d+$/, expected: "digits only" },
  letters_and_spaces: { test: /^[\p{L}][\p{L}\s'.-]*$/u, expected: "letters, spaces, apostrophes and hyphens" },
  us_state: { test: /^[A-Za-z]{2}$/, expected: "a two letter state code" },
};

export type FieldRule =
  | { rule: "min_length"; value: number }
  | { rule: "max_length"; value: number }
  | { rule: "min"; value: number }
  | { rule: "max"; value: number }
  | { rule: "pattern"; value: PatternKey };

export interface FormOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Shown under the field. The place to say why you are asking. */
  help?: string | undefined;
  rules?: FieldRule[] | undefined;
  /** For `choice` and `multi_choice`. A submitted value outside this is refused. */
  options?: FormOption[] | undefined;
}

export interface FormDefinition {
  key: string;
  title: string;
  fields: FormField[];
  /**
   * How quickly a submission is treated as a robot, in seconds.
   *
   * A person cannot read a form, type an address and describe a broken water
   * heater in under three seconds. A script can. Measured only when the page
   * reported when it was opened: refusing because that timestamp is missing
   * would throw away real leads from browsers that blocked the script, and a
   * lost lead costs far more than a spam row somebody deletes.
   */
  minimumFillSeconds?: number | undefined;
}

export interface ServiceAddress {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  postalCode: string;
}

export type CleanValue = string | number | boolean | string[] | ServiceAddress;

export type FieldRefusalReason =
  | "required"
  | "unknown_field"
  | "wrong_type"
  | "not_an_option"
  | "too_short"
  | "too_long"
  | "too_small"
  | "too_large"
  | "bad_email"
  | "bad_phone"
  | "incomplete_address"
  | "bad_date"
  | "pattern"
  | "consent_required";

export interface FieldRefusal {
  field: string;
  reason: FieldRefusalReason;
  /** Written for the homeowner filling the form in, not for a developer. */
  message: string;
}

export type SubmissionDecision =
  | { ok: true; values: Record<string, CleanValue> }
  | { ok: false; reason: "invalid"; refusals: FieldRefusal[] }
  | { ok: false; reason: "spam"; detail: string };

export interface Submission {
  values: Record<string, unknown>;
  /** When the form was opened, if the page could tell us. */
  startedAt?: Date | undefined;
}

/**
 * Check a submission against a definition.
 *
 * EVERY field is checked before anything is returned, and all the refusals
 * come back together. Returning the first one makes somebody fix their phone
 * number, submit, and be told about the address, which is the point at which
 * a homeowner with a leak gives up and rings the next company on the list.
 *
 * `now` is a parameter with a default, like everywhere else in this codebase,
 * so the spam timing test is a pure function of its inputs and can be tested
 * without waiting three seconds.
 */
export function checkSubmission(
  form: FormDefinition,
  submission: Submission,
  now: Date = new Date(),
): SubmissionDecision {
  const refusals: FieldRefusal[] = [];
  const values: Record<string, CleanValue> = {};
  const known = new Set(form.fields.map((f) => f.key));

  /**
   * A honeypot is a field no person can see and no person fills in. Anything
   * in it came from a script that filled in every input on the page. Refused
   * as spam, separately from the validation refusals, because the caller
   * should accept it silently and drop it rather than show an error: telling
   * the robot which field gave it away is how the next version gets past.
   */
  for (const field of form.fields) {
    if (field.type !== "honeypot") continue;
    const raw = submission.values[field.key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      return { ok: false, reason: "spam", detail: "A hidden field was filled in, which only an automated submission does." };
    }
  }

  const minimum = form.minimumFillSeconds;
  if (minimum !== undefined && submission.startedAt) {
    const elapsed = (now.getTime() - submission.startedAt.getTime()) / 1000;
    if (elapsed < minimum) {
      return {
        ok: false, reason: "spam",
        detail: `Submitted ${elapsed.toFixed(1)} seconds after the form was opened, which is faster than a person can type an address.`,
      };
    }
  }

  /**
   * A field we were not expecting is refused, not dropped.
   *
   * It means the page somebody submitted and the definition we hold disagree,
   * which happens when a form is edited and a browser still has the old one
   * cached. Dropping the value silently loses whatever the customer typed in
   * it, and the customer has no idea: they answered the question and the
   * answer went nowhere.
   */
  for (const key of Object.keys(submission.values)) {
    if (!known.has(key)) {
      refusals.push({
        field: key, reason: "unknown_field",
        message: `This form has no field called "${key}". It may have been changed since the page was opened: reload and try again.`,
      });
    }
  }

  for (const field of form.fields) {
    if (field.type === "honeypot") continue;
    const outcome = checkField(field, submission.values[field.key]);
    if (outcome.ok) {
      if (outcome.value !== undefined) values[field.key] = outcome.value;
    } else {
      refusals.push(...outcome.refusals);
    }
  }

  if (refusals.length > 0) return { ok: false, reason: "invalid", refusals };
  return { ok: true, values };
}

type FieldOutcome =
  | { ok: true; value: CleanValue | undefined }
  | { ok: false; refusals: FieldRefusal[] };

const blank = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "") ||
  (Array.isArray(raw) && raw.length === 0);

function refuse(field: FormField, reason: FieldRefusalReason, message: string): FieldOutcome {
  return { ok: false, refusals: [{ field: field.key, reason, message }] };
}

function checkField(field: FormField, raw: unknown): FieldOutcome {
  if (blank(raw)) {
    if (!field.required) return { ok: true, value: undefined };
    /**
     * A consent box gets its own wording. "Required" on a tick box reads as a
     * bug, and the honest sentence is that we will not text somebody who did
     * not say we could. The comms module refuses the send anyway; this is the
     * same rule said at the point where it is still a choice.
     */
    if (field.type === "consent") {
      return refuse(field, "consent_required", `Tick "${field.label}" if we may contact you. We will not send anything if you would rather we did not.`);
    }
    return refuse(field, "required", `${field.label} is needed.`);
  }

  switch (field.type) {
    case "hidden":
      /**
       * Tracking values ride along: utm_source, a gclid, the id of the page.
       * Never required, never validated against a catalogue, and deliberately
       * not resolved here. It is stored as written and `resolveSource` places
       * it later, so a tag we do not recognise yet still arrives intact and
       * can be fixed retrospectively by adding an alias.
       */
      return { ok: true, value: String(raw).slice(0, 500) };

    case "consent": {
      if (typeof raw !== "boolean") {
        return refuse(field, "wrong_type", `${field.label} must be ticked or left alone.`);
      }
      if (!raw && field.required) {
        return refuse(field, "consent_required", `Tick "${field.label}" if we may contact you.`);
      }
      return { ok: true, value: raw };
    }

    case "email": {
      const text = String(raw).trim().toLowerCase();
      /**
       * Deliberately loose, and lower cased in full. Every mail provider a
       * homeowner uses treats the address case insensitively, and keeping the
       * case they typed produces two customer records for one person. A
       * stricter pattern is the more common mistake: real addresses with a
       * plus sign or an apostrophe get rejected, and the lead is lost to
       * protect a database column that would have been fine.
       */
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text)) {
        return refuse(field, "bad_email", `That does not look like an email address. Check for a missing @ or a typo in the part after it.`);
      }
      return { ok: true, value: text };
    }

    case "phone": {
      const digits = onlyDigits(String(raw));
      /**
       * Stored as ten digits, never as typed. "(512) 555-0134" and
       * "512.555.0134" are the same person, and keeping the punctuation means
       * they are two customers, two histories, and a technician ringing the
       * wrong one of them back.
       */
      if (digits.length !== 10) {
        return refuse(field, "bad_phone", `That needs to be a ten digit phone number so we can call you back.`);
      }
      return { ok: true, value: digits };
    }

    case "number": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) {
        return refuse(field, "wrong_type", `${field.label} needs to be a number.`);
      }
      const refusals = applyNumberRules(field, value);
      return refusals.length > 0 ? { ok: false, refusals } : { ok: true, value };
    }

    case "date": {
      const text = String(raw).trim();
      /**
       * A plain calendar date, and nothing is parsed out of a free text
       * string. `new Date("03/04/2026")` is two different days depending on
       * where the person typing it lives, and a heating system booked for the
       * wrong day is a real cost. ISO or a refusal.
       */
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !isRealDate(text)) {
        return refuse(field, "bad_date", `Use a date in the form 2026-03-04. A date written 03/04/2026 means two different days in two different countries.`);
      }
      return { ok: true, value: text };
    }

    case "choice": {
      const text = String(raw).trim();
      const options = field.options ?? [];
      if (!options.some((o) => o.value === text)) {
        return refuse(field, "not_an_option", `Choose one of: ${options.map((o) => o.label).join(", ")}.`);
      }
      return { ok: true, value: text };
    }

    case "multi_choice": {
      if (!Array.isArray(raw)) {
        return refuse(field, "wrong_type", `${field.label} needs one or more choices.`);
      }
      const options = field.options ?? [];
      const chosen = raw.map((v) => String(v).trim());
      const bad = chosen.filter((v) => !options.some((o) => o.value === v));
      if (bad.length > 0) {
        return refuse(field, "not_an_option", `Not on this form: ${bad.join(", ")}. Choose from: ${options.map((o) => o.label).join(", ")}.`);
      }
      return { ok: true, value: chosen };
    }

    case "service_address": {
      return checkAddress(field, raw);
    }

    case "text":
    case "long_text": {
      const text = String(raw).trim();
      const refusals = applyTextRules(field, text);
      return refusals.length > 0 ? { ok: false, refusals } : { ok: true, value: text };
    }

    case "honeypot":
      // Handled before the loop, where a filled one ends the whole submission.
      return { ok: true, value: undefined };
  }
}

function applyTextRules(field: FormField, text: string): FieldRefusal[] {
  const refusals: FieldRefusal[] = [];
  for (const rule of field.rules ?? []) {
    switch (rule.rule) {
      case "min_length":
        if (text.length < rule.value) {
          refusals.push({
            field: field.key, reason: "too_short",
            /**
             * The message names what a useful answer looks like rather than
             * the number of characters. "At least 20 characters" makes
             * somebody type twenty characters of nothing; asking what is
             * actually wrong gets a sentence a dispatcher can act on.
             */
            message: `Tell us a bit more in ${field.label.toLowerCase()}, enough that whoever we send knows what to bring.`,
          });
        }
        break;
      case "max_length":
        if (text.length > rule.value) {
          refusals.push({
            field: field.key, reason: "too_long",
            message: `${field.label} is longer than we can store. Keep it under ${rule.value} characters and tell the technician the rest.`,
          });
        }
        break;
      case "pattern": {
        const pattern = PATTERNS[rule.value];
        if (!pattern.test.test(text)) {
          refusals.push({
            field: field.key, reason: "pattern",
            message: `${field.label} should be ${pattern.expected}.`,
          });
        }
        break;
      }
      case "min":
      case "max":
        // A numeric bound on text is a definition mistake, caught by
        // `checkForm` before the form is ever shown. Ignored here rather than
        // refused, because a live form must not start rejecting real people
        // over a setting somebody saved.
        break;
    }
  }
  return refusals;
}

function applyNumberRules(field: FormField, value: number): FieldRefusal[] {
  const refusals: FieldRefusal[] = [];
  for (const rule of field.rules ?? []) {
    if (rule.rule === "min" && value < rule.value) {
      refusals.push({ field: field.key, reason: "too_small", message: `${field.label} needs to be at least ${rule.value}.` });
    }
    if (rule.rule === "max" && value > rule.value) {
      refusals.push({ field: field.key, reason: "too_large", message: `${field.label} cannot be more than ${rule.value}.` });
    }
  }
  return refusals;
}

/**
 * An address, checked part by part.
 *
 * A service address is not a string. It is where a van has to go, it decides
 * which territory the lead belongs to and which technician is nearest, and a
 * lead with "Austin" and nothing else cannot be dispatched, priced or
 * assigned. So a partial address is refused with the missing parts named: a
 * message that says "address is invalid" makes somebody retype the whole
 * thing and guess which bit we did not like.
 */
function checkAddress(field: FormField, raw: unknown): FieldOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse(field, "wrong_type", `${field.label} needs a street, a city, a state and a ZIP.`);
  }
  const source = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    return value === undefined || value === null ? "" : String(value).trim();
  };

  const line1 = text("line1");
  const line2 = text("line2");
  const city = text("city");
  const state = text("state").toUpperCase();
  const postalCode = text("postalCode");

  const missing: string[] = [];
  if (line1 === "") missing.push("a street address");
  if (city === "") missing.push("a city");
  if (state === "") missing.push("a state");
  if (postalCode === "") missing.push("a ZIP");
  if (missing.length > 0) {
    return refuse(field, "incomplete_address", `We need ${missing.join(", ")} so we know where to send somebody.`);
  }
  if (!PATTERNS.us_state.test.test(state)) {
    return refuse(field, "incomplete_address", `Use the two letter state code, like TX.`);
  }
  if (!PATTERNS.us_zip.test.test(postalCode)) {
    return refuse(field, "incomplete_address", `That ZIP does not look right. It should be five digits, or ZIP+4.`);
  }

  return {
    ok: true,
    value: {
      line1, city, state, postalCode,
      ...(line2 !== "" ? { line2 } : {}),
    },
  };
}

/**
 * Whether those three numbers are a day that exists.
 *
 * Counted out rather than handed to a Date, because `new Date("2026-02-31")`
 * quietly becomes the third of March and a booking made for a day that does
 * not exist ends up on a real one nobody agreed to.
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map((part) => Number(part));
  if (y === undefined || m === undefined || d === undefined) return false;
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = m === 2 && (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
  const days = (DAYS_IN_MONTH[m - 1] ?? 0) + (leap ? 1 : 0);
  return d <= days;
}

export type FormVerdict =
  | { ok: true; form: FormDefinition }
  | { ok: false; problems: string[] };

/**
 * Whether a definition is coherent, checked once when it is saved.
 *
 * The alternative is discovering it on the live form, which means a homeowner
 * with a burst pipe meets a choice field with no choices. Every problem here
 * is one somebody creates in a builder in about four seconds, and every one
 * of them is silent until a customer hits it.
 */
export function checkForm(form: FormDefinition): FormVerdict {
  const problems: string[] = [];

  if (form.fields.length === 0) {
    problems.push("A form with no fields collects nothing.");
  }

  const seen = new Set<string>();
  for (const field of form.fields) {
    if (seen.has(field.key)) {
      // Two fields with one key means one silently overwrites the other in
      // the submission, and which one wins depends on the browser.
      problems.push(`Two fields both use the key "${field.key}".`);
    }
    seen.add(field.key);

    if (!/^[a-z][a-z0-9_]*$/.test(field.key)) {
      problems.push(`"${field.key}" is not a usable field key: lower case letters, digits and underscores, starting with a letter.`);
    }
    if (field.label.trim() === "" && field.type !== "hidden" && field.type !== "honeypot") {
      problems.push(`The field "${field.key}" has no label, so nobody knows what to type in it.`);
    }
    if ((field.type === "choice" || field.type === "multi_choice") && (field.options ?? []).length === 0) {
      problems.push(`"${field.key}" asks somebody to choose and offers nothing to choose from.`);
    }
    if ((field.type === "hidden" || field.type === "honeypot") && field.required) {
      // Nobody can fill in a field they cannot see, so this form can never be
      // submitted by a human being.
      problems.push(`"${field.key}" is hidden and required, which no person can satisfy.`);
    }
    for (const rule of field.rules ?? []) {
      const numeric = rule.rule === "min" || rule.rule === "max";
      if (numeric && field.type !== "number") {
        problems.push(`"${field.key}" is not a number field, so a ${rule.rule} rule on it does nothing.`);
      }
      if ((rule.rule === "min_length" || rule.rule === "max_length") && field.type === "number") {
        problems.push(`"${field.key}" is a number field, so a ${rule.rule} rule on it does nothing.`);
      }
    }
  }

  /**
   * Some way to reach them back. A lead with a description of a broken
   * furnace and no phone number and no email is not a lead: it is a note
   * about somebody the company cannot contact.
   */
  const reachable = form.fields.some((f) => (f.type === "phone" || f.type === "email") && f.required);
  if (form.fields.length > 0 && !reachable) {
    problems.push("No required phone number and no required email: a lead nobody can ring back is not a lead.");
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, form };
}

/* -------------------------------------------------------------------------
 * 5. SPEND AND RETURN
 * ---------------------------------------------------------------------- */

export interface SpendRow {
  source: LeadSourceKey;
  spend: Money;
}

export interface ResultRow {
  source: LeadSourceKey;
  leads: number;
  bookedJobs: number;
  bookedValue: Money;
}

/**
 * What a source did, and whether the number is worth reading.
 *
 * Every ratio here is `null` when its denominator is zero, and that is a
 * deliberate refusal rather than a convenience. The two tempting alternatives
 * are both actively harmful:
 *
 *   ZERO. A source that spent nine hundred dollars and produced no leads gets
 *   a cost per lead of zero, sorts to the top of "cheapest channels", and the
 *   worst line in the account is presented as the best.
 *
 *   INFINITY. It poisons every sort it takes part in, does not survive JSON,
 *   and renders on a screen as "Infinity", which nobody reads as "we have no
 *   leads from this".
 *
 * `null` forces the caller to render something honest, and `verdict` says in
 * words which of the awkward cases this row is.
 */
export interface SourcePerformance {
  source: LeadSourceKey;
  spend: Money;
  leads: number;
  bookedJobs: number;
  bookedValue: Money;
  /** Null when there were no leads. */
  costPerLead: Money | null;
  /** Null when nothing was booked. */
  costPerBookedJob: Money | null;
  /** Booked value over spend, to four places. Null when nothing was spent. */
  roas: string | null;
  /** Booked jobs over leads, as a percentage to two places. Null with no leads. */
  bookingRate: string | null;
  verdict: PerformanceVerdict;
}

export type PerformanceVerdict =
  /** Money went out and nothing came back. The number that matters most. */
  | { kind: "spend_no_leads"; message: string }
  /** Leads arrived and none of them booked. A sales problem, not a media one. */
  | { kind: "leads_no_jobs"; message: string }
  /** Work came in and no spend is recorded against it. */
  | { kind: "return_no_spend"; message: string }
  /** Nothing happened at all. */
  | { kind: "dormant"; message: string }
  /** Both sides present. The only case where the ratios mean anything. */
  | { kind: "measured"; message: string };

export interface SpendSummary {
  currency: CurrencyCode;
  rows: SourcePerformance[];
  totalSpend: Money;
  totalLeads: number;
  totalBookedJobs: number;
  totalBookedValue: Money;
  blendedCostPerLead: Money | null;
  blendedCostPerBookedJob: Money | null;
  blendedRoas: string | null;
  /** Spend against sources that booked nothing. The first number to look at. */
  wastedSpend: Money;
  /** Those sources, so the sentence has names in it. */
  wastedSources: LeadSourceKey[];
  /** Sources that booked work with no spend recorded. Usually a missing feed. */
  unpricedSources: LeadSourceKey[];
}

export type SpendDecision =
  | { ok: true; summary: SpendSummary }
  | { ok: false; reason: "currency_mismatch" | "negative_input" | "nothing_to_report"; detail: string };

/**
 * Pull spend and results together into one table.
 *
 * Rows are MERGED by source rather than assumed unique. Two Google Ads
 * accounts, or a manual entry beside an imported one, is the ordinary state of
 * a contractor's marketing: taking the last row wins would silently halve the
 * spend and double the measured return, which is the direction of error
 * nobody questions.
 *
 * A currency mismatch is a refusal, not a throw. A Canadian branch's ad
 * account reporting in CAD is a real situation, and a thrown error takes down
 * the whole marketing screen instead of telling somebody which row to fix.
 */
export function summariseSpend(
  spend: SpendRow[],
  results: ResultRow[],
  currency: CurrencyCode = "USD",
): SpendDecision {
  if (spend.length === 0 && results.length === 0) {
    return {
      ok: false, reason: "nothing_to_report",
      detail: "No spend and no results for this period. Connect an ad account or record spend by hand: an empty report is not the same as a zero.",
    };
  }

  for (const row of spend) {
    if (row.spend.currency !== currency) {
      return {
        ok: false, reason: "currency_mismatch",
        detail: `Spend for ${leadSourceLabel(row.source)} is in ${row.spend.currency} and this report is in ${currency}. Convert it before comparing: a ratio across two currencies is a number with no meaning.`,
      };
    }
    if (isNegative(row.spend)) {
      return {
        ok: false, reason: "negative_input",
        detail: `Spend for ${leadSourceLabel(row.source)} is negative. A refund belongs in the period it was refunded, not as negative spend that makes a return on ad spend look infinite.`,
      };
    }
  }
  for (const row of results) {
    if (row.bookedValue.currency !== currency) {
      return {
        ok: false, reason: "currency_mismatch",
        detail: `Booked value for ${leadSourceLabel(row.source)} is in ${row.bookedValue.currency} and this report is in ${currency}.`,
      };
    }
    if (row.leads < 0 || row.bookedJobs < 0 || isNegative(row.bookedValue)) {
      return {
        ok: false, reason: "negative_input",
        detail: `${leadSourceLabel(row.source)} has a negative count or value. Counts cannot be negative and a cancelled job is a job that did not book, not a job that booked minus one.`,
      };
    }
    if (row.bookedJobs > row.leads) {
      /**
       * More booked jobs than leads is arithmetically impossible and is
       * always the same bug: the two sides were counted over different date
       * ranges, or bookings were counted per visit rather than per lead. A
       * booking rate over one hundred per cent on a screen destroys trust in
       * every other number on it, so it is refused here instead.
       */
      return {
        ok: false, reason: "negative_input",
        detail: `${leadSourceLabel(row.source)} shows ${row.bookedJobs} booked jobs from ${row.leads} leads. A job cannot book without a lead: the two sides were probably counted over different periods.`,
      };
    }
  }

  const spendBySource = new Map<LeadSourceKey, Money>();
  for (const row of spend) {
    spendBySource.set(row.source, add(spendBySource.get(row.source) ?? zero(currency), row.spend));
  }

  const resultBySource = new Map<LeadSourceKey, ResultRow>();
  for (const row of results) {
    const existing = resultBySource.get(row.source);
    resultBySource.set(row.source, existing
      ? {
          source: row.source,
          leads: existing.leads + row.leads,
          bookedJobs: existing.bookedJobs + row.bookedJobs,
          bookedValue: add(existing.bookedValue, row.bookedValue),
        }
      : row);
  }

  const keys = [...new Set([...spendBySource.keys(), ...resultBySource.keys()])];
  const rows = keys.map((source) => {
    const rowSpend = spendBySource.get(source) ?? zero(currency);
    const result = resultBySource.get(source);
    const leads = result?.leads ?? 0;
    const bookedJobs = result?.bookedJobs ?? 0;
    const bookedValue = result?.bookedValue ?? zero(currency);
    return rowPerformance(source, rowSpend, leads, bookedJobs, bookedValue);
  }).sort((a, b) => {
    // Biggest spend first: the report is read to decide where money goes, and
    // the rows worth arguing about are the expensive ones.
    const diff = b.spend.amount - a.spend.amount;
    return diff > 0n ? 1 : diff < 0n ? -1 : a.source.localeCompare(b.source);
  });

  const totalSpend = rows.reduce((sum, r) => add(sum, r.spend), zero(currency));
  const totalBookedValue = rows.reduce((sum, r) => add(sum, r.bookedValue), zero(currency));
  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0);
  const totalBookedJobs = rows.reduce((sum, r) => sum + r.bookedJobs, 0);

  const wasted = rows.filter((r) => !isZero(r.spend) && r.bookedJobs === 0);

  return {
    ok: true,
    summary: {
      currency,
      rows,
      totalSpend,
      totalLeads,
      totalBookedJobs,
      totalBookedValue,
      blendedCostPerLead: totalLeads > 0 ? divideByCount(totalSpend, totalLeads) : null,
      blendedCostPerBookedJob: totalBookedJobs > 0 ? divideByCount(totalSpend, totalBookedJobs) : null,
      blendedRoas: isZero(totalSpend) ? null : ratio(totalBookedValue, totalSpend),
      wastedSpend: wasted.reduce((sum, r) => add(sum, r.spend), zero(currency)),
      wastedSources: wasted.map((r) => r.source),
      unpricedSources: rows.filter((r) => isZero(r.spend) && r.bookedJobs > 0).map((r) => r.source),
    },
  };
}

function rowPerformance(
  source: LeadSourceKey,
  spend: Money,
  leads: number,
  bookedJobs: number,
  bookedValue: Money,
): SourcePerformance {
  const label = leadSourceLabel(source);
  const spent = !isZero(spend);

  let verdict: PerformanceVerdict;
  if (!spent && leads === 0 && bookedJobs === 0) {
    verdict = { kind: "dormant", message: `Nothing spent and nothing recorded for ${label} in this period.` };
  } else if (spent && leads === 0) {
    verdict = {
      kind: "spend_no_leads",
      message: `${label} took money and produced no leads at all. Check that the tracking is recording before cutting the budget: an untagged landing page looks exactly like this.`,
    };
  } else if (spent && bookedJobs === 0) {
    verdict = {
      kind: "leads_no_jobs",
      message: `${label} produced ${leads} leads and booked none of them. That is usually how fast the phone gets answered rather than the channel being bad.`,
    };
  } else if (!spent && bookedJobs > 0) {
    verdict = {
      kind: "return_no_spend",
      message: `${label} booked work with no spend recorded. Either it genuinely costs nothing, or the spend is sitting in a feed nobody connected, and the second one makes every other channel look worse than it is.`,
    };
  } else {
    verdict = { kind: "measured", message: `${label} has both spend and booked work, so the ratios below mean something.` };
  }

  return {
    source, spend, leads, bookedJobs, bookedValue,
    costPerLead: leads > 0 ? divideByCount(spend, leads) : null,
    costPerBookedJob: bookedJobs > 0 ? divideByCount(spend, bookedJobs) : null,
    roas: isZero(spend) ? null : ratio(bookedValue, spend),
    bookingRate: leads > 0 ? percentOf(bookedJobs, leads) : null,
    verdict,
  };
}

/**
 * Money divided by a count of things.
 *
 * On the underlying integer, half up, at the full stored scale. Going through
 * a float here would be the one place in the whole module where a cent could
 * appear out of nowhere, and a cost per lead is compared against a target to
 * two decimal places by somebody who will notice.
 */
function divideByCount(amount: Money, count: number): Money {
  const divisor = BigInt(Math.round(count));
  if (divisor === 0n) throw new RangeError("divideByCount called with zero, which the caller must handle as a refusal");
  const negative = amount.amount < 0n;
  const abs = negative ? -amount.amount : amount.amount;
  let value = abs / divisor;
  if ((abs % divisor) * 2n >= divisor) value += 1n;
  return { amount: negative ? -value : value, currency: amount.currency };
}

/**
 * One money over another, as a plain decimal string to four places.
 *
 * A ratio is not money and must not pretend to be: four dollars back for one
 * spent is `"4.0000"`, with no currency attached, because multiplying it by
 * anything is the caller's problem and tagging it USD invites somebody to add
 * it to a total.
 */
export function ratio(numerator: Money, denominator: Money): string | null {
  if (denominator.currency !== numerator.currency) return null;
  if (denominator.amount === 0n) return null;
  const scaled = numerator.amount * 10_000n;
  const divisor = denominator.amount;
  const negative = (scaled < 0n) !== (divisor < 0n);
  const absScaled = scaled < 0n ? -scaled : scaled;
  const absDivisor = divisor < 0n ? -divisor : divisor;
  let whole = absScaled / absDivisor;
  if ((absScaled % absDivisor) * 2n >= absDivisor) whole += 1n;
  return `${negative ? "-" : ""}${whole / 10_000n}.${(whole % 10_000n).toString().padStart(4, "0")}`;
}
