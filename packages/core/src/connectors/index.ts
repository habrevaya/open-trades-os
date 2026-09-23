/**
 * THE CONNECTOR CATALOGUE
 *
 * Every outside system a home services company needs for marketing to work,
 * named, with what it does, what it needs from the operator, and above all
 * WHETHER IT IS BUILT.
 *
 * That last field is the whole reason this file is data rather than prose in
 * a README. A catalogue that lists Google Ads beside a connected checkbox is
 * a product telling an owner their spend is being imported. If nothing is
 * importing it, the report shows a channel with leads and no cost, the owner
 * reads it as a free channel, and they move budget onto it. The failure is
 * silent, it points the wrong way, and it is exactly the defect class this
 * codebase spends most of its time removing.
 *
 * So `state` is required on every entry and there are only two values.
 * `built` means an adapter is registered and a connection will actually move
 * data. `declared` means this is a thing the product intends to speak to and
 * today does not. A test in the API package asserts that every `built` entry
 * has a registered adapter behind it, so this file cannot drift into
 * optimism.
 *
 * WHAT COUNTS AS BUILT IS DELIBERATELY NARROW. A parser with no transport is
 * not a connector. A connector is built when a company can set it up from
 * the settings screen and data arrives.
 *
 * WHY CSV AND WEBHOOKS COME FIRST, AND ARE NOT A COMPROMISE
 *
 * The first connectors here take a file or an HTTP POST, and that ordering
 * is on purpose rather than a staging post on the way to "real" API
 * integrations.
 *
 *   A spend CSV works on the day somebody installs this. No OAuth consent
 *   screen, no developer token, no application review that takes six weeks
 *   and can be refused. Every ads platform exports one and every contractor
 *   already knows how to download it.
 *
 *   A webhook is how the lead marketplaces genuinely deliver. Angi,
 *   Thumbtack and Facebook Lead Ads all POST; polling their APIs is the
 *   slower path even where one exists, and speed to lead is the entire game
 *   in that market.
 *
 * An OAuth adapter that pulls the same numbers is better for the operator
 * who can get through the approval process. It is not better for the one who
 * cannot, and a self hosted product whose marketing features require a
 * vendor's permission is one that stops working when the vendor changes
 * their mind.
 */

export type ConnectorCapability =
  | "ads"
  | "analytics"
  | "lead_source"
  | "reviews"
  | "email"
  | "messaging"
  | "telephony";

/**
 * How the operator proves who they are.
 *
 * `file_upload` is here as a first class member rather than as an absence.
 * A monthly CSV is a real integration with real semantics: it has a grain, a
 * cadence, an idempotency story and a failure mode. Calling it "manual" and
 * leaving it off the list is how a product ends up with no honest way to
 * describe the thing most of its users will actually do.
 */
export type ConnectorAuth =
  | "oauth"
  | "api_key"
  | "webhook_secret"
  | "file_upload"
  | "none";

/** What actually moves, and which way. */
export type ConnectorFlow =
  /** Money out: what a channel cost. */
  | "spend_in"
  /** People in: a lead, an offer, an enquiry. */
  | "leads_in"
  /** The loop closed: a booked job reported back to the account that bought it. */
  | "conversions_out"
  /** Behaviour: sessions, search terms, page performance. */
  | "analytics_in"
  /** Reputation: reviews read, and replies written. */
  | "reviews_in"
  | "reviews_out"
  /** Marketing sends, as opposed to the transactional ones M18 already does. */
  | "campaigns_out";

/**
 * Built, or named but not built. Two values, no middle.
 *
 * There is no `partial` and no `beta`, because both are ways of saying
 * `declared` while leaving a reader free to assume `built`. A connector that
 * moves some of its data is `built` with a shorter `flows` list; one that
 * moves none is `declared`.
 */
export type ConnectorState = "built" | "declared";

export interface ConnectorSpec {
  /** The provider key stored on `integration_connection.provider`. */
  key: string;
  label: string;
  capability: ConnectorCapability;
  auth: ConnectorAuth;
  flows: ConnectorFlow[];
  state: ConnectorState;
  /** What this is for, in one sentence an owner can act on. */
  purpose: string;
  /**
   * What the operator has to go and get. Required on every entry, because
   * "connect Google Ads" with no note is a button that opens a support
   * ticket: the answer is a developer token, which takes an application.
   */
  setup: string;
  /**
   * What this connector CANNOT tell you. Required, and the field that stops
   * the catalogue reading like a sales page.
   */
  limitation: string;
}

export const CONNECTORS: readonly ConnectorSpec[] = [
  /* ------------------------------------------------------------- spend in */
  {
    key: "spend_csv",
    label: "Ad spend CSV",
    capability: "ads",
    auth: "file_upload",
    flows: ["spend_in"],
    state: "built",
    purpose:
      "Load what every channel cost from the daily export any ad platform will give you, plus the offline spend that no platform knows about.",
    setup:
      "Download the daily export from the platform: one row per campaign per day, with a date and an amount. Offline spend is typed in the same shape.",
    limitation:
      "It is as current as the last file somebody uploaded. If the answer has to be right this morning, it will not be.",
  },
  {
    key: "google_ads",
    label: "Google Ads",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "conversions_out"],
    state: "declared",
    purpose:
      "Pull spend, clicks and impressions per campaign per day, and report booked jobs back against the gclid so the account can bid on work rather than on form fills.",
    setup:
      "A Google Ads developer token, which is an application to Google and is not instant, plus OAuth consent from somebody with account access.",
    limitation:
      "It knows what it was paid and what it was clicked. It does not know which of those clicks became a job, which is the whole reason conversions have to be sent back.",
  },
  {
    key: "google_lsa",
    label: "Google Local Services Ads",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "leads_in"],
    state: "declared",
    purpose:
      "The pay per lead product most trades companies actually spend on. Leads arrive as calls and messages with a charge attached, which is spend and a lead at once.",
    setup: "OAuth against the Local Services account, which is separate from the Google Ads account even when one person owns both.",
    limitation:
      "Disputing a bad lead is a manual process on Google's side and no API changes that, so a charge will be in the numbers before anybody decides whether it should be.",
  },
  {
    key: "meta_ads",
    label: "Meta Ads",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "leads_in", "conversions_out"],
    state: "declared",
    purpose:
      "Spend per campaign, leads from instant forms, and booked jobs reported back against the fbclid.",
    setup: "A Meta app with ads_read and leads_retrieval, reviewed by Meta, plus a page admin to authorise it.",
    limitation:
      "Attribution inside Meta's own reporting will not agree with what this product measures, and the gap is not a bug in either. Meta counts a view that led to a search a week later; this counts what was tagged.",
  },
  {
    key: "bing_ads",
    label: "Microsoft Advertising",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "conversions_out"],
    state: "declared",
    purpose: "The same as Google Ads, for the account most contractors forget they are running.",
    setup: "A Microsoft Advertising developer token and OAuth consent.",
    limitation: "Lower volume than Google, so per campaign numbers go noisy fast at a contractor's budget.",
  },

  /* ------------------------------------------------------------ leads in */
  {
    key: "lead_webhook",
    label: "Lead webhook",
    capability: "lead_source",
    auth: "webhook_secret",
    flows: ["leads_in"],
    state: "built",
    purpose:
      "One signed endpoint any marketplace, form builder or website can POST a lead to. It becomes a customer, a property and a job, and it records the touch that brought it.",
    setup:
      "Copy the endpoint and the signing secret into whatever is sending. A field mapping says which of their keys is the name, the phone and the address.",
    limitation:
      "It takes what it is sent. If the sender omits a phone number, no amount of parsing will produce one, and the lead is stored with its refusals rather than silently dropped.",
  },
  {
    key: "angi",
    label: "Angi Leads",
    capability: "lead_source",
    auth: "api_key",
    flows: ["leads_in", "conversions_out"],
    state: "declared",
    purpose:
      "Accept or decline offers against real capacity, materialise the work, and reconcile what was actually paid out against what was promised.",
    setup: "A partner API key, which Angi issues to contractors on qualifying plans.",
    limitation:
      "Payout reconciliation is the part marketplaces are worst at, and their figures arrive late and change. Anything this reports before the month closes is provisional.",
  },
  {
    key: "thumbtack",
    label: "Thumbtack",
    capability: "lead_source",
    auth: "api_key",
    flows: ["leads_in"],
    state: "declared",
    purpose: "The same offer and accept loop, against Thumbtack's own lead flow.",
    setup: "A Thumbtack pro account with API access enabled.",
    limitation: "Offers expire in minutes, so an integration that polls rather than receives has already lost most of them.",
  },

  /* ----------------------------------------------------------- analytics */
  {
    key: "ga4",
    label: "Google Analytics 4",
    capability: "analytics",
    auth: "oauth",
    flows: ["analytics_in"],
    state: "declared",
    purpose: "Sessions, landing pages and search terms, to sit beside what the CRM says was booked.",
    setup: "OAuth against a property, plus the measurement id on the website.",
    limitation:
      "GA4 samples, models and thresholds its own data. Its session count and this product's lead count will not reconcile and should not be presented as if they might.",
  },
  {
    key: "search_console",
    label: "Google Search Console",
    capability: "analytics",
    auth: "oauth",
    flows: ["analytics_in"],
    state: "declared",
    purpose: "What people searched before they arrived, which is the only honest read on organic demand.",
    setup: "Verify the domain in Search Console and authorise the property.",
    limitation: "Queries are withheld below a volume threshold, so the long tail a trades site lives on is mostly invisible.",
  },

  /* ------------------------------------------------------------- reviews */
  {
    key: "google_business_profile",
    label: "Google Business Profile",
    capability: "reviews",
    auth: "oauth",
    flows: ["reviews_in", "reviews_out"],
    state: "declared",
    purpose:
      "Read reviews as they land and reply from here. For a local trades company this listing is worth more than the website.",
    setup: "OAuth from an account with manager access to the listing.",
    limitation:
      "Google rate limits both reading and replying, and a reply posted through an API is still subject to their moderation, so a reply that appears here can be absent there.",
  },

  /* --------------------------------------------------------- campaigns out */
  {
    key: "campaign_email",
    label: "Marketing email",
    capability: "email",
    auth: "api_key",
    flows: ["campaigns_out"],
    state: "declared",
    purpose:
      "Seasonal sends to a segment, as opposed to the transactional messages the communications module already sends.",
    setup: "An API key from the sending provider, and a verified sending domain with SPF, DKIM and DMARC.",
    limitation:
      "Marketing consent is a different question from transactional consent, and a customer who asked for an arrival notice has not asked for a spring promotion. This connector sends; it never decides whether it may.",
  },
];

const BY_KEY = new Map(CONNECTORS.map((c) => [c.key, c]));

export const connector = (key: string): ConnectorSpec | undefined => BY_KEY.get(key);

export const CONNECTOR_KEYS: readonly string[] = CONNECTORS.map((c) => c.key);

/** The ones that actually move data today. */
export const builtConnectors = (): ConnectorSpec[] =>
  CONNECTORS.filter((c) => c.state === "built");

/** Named, and not built. Shown as such, never as "coming soon" beside a switch. */
export const declaredConnectors = (): ConnectorSpec[] =>
  CONNECTORS.filter((c) => c.state === "declared");

export const connectorsFor = (capability: ConnectorCapability): ConnectorSpec[] =>
  CONNECTORS.filter((c) => c.capability === capability);

export type CatalogueVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether the catalogue itself is usable.
 *
 * Checked in a test rather than at runtime, because a duplicate key or a
 * missing sentence is a mistake in this file that a build should catch, not
 * a condition a running system should handle.
 */
export function checkCatalogue(entries: readonly ConnectorSpec[] = CONNECTORS): CatalogueVerdict {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      return { ok: false, reason: `There are two connectors keyed "${entry.key}".` };
    }
    seen.add(entry.key);

    if (entry.flows.length === 0) {
      return { ok: false, reason: `"${entry.key}" declares no flows, so nothing would move if it were connected.` };
    }
    if (entry.setup.trim().length < 20) {
      return {
        ok: false,
        reason: `"${entry.key}" has no real setup note. A connector an owner cannot find out how to set up is a support ticket with a button on it.`,
      };
    }
    if (entry.limitation.trim().length < 20) {
      return {
        ok: false,
        reason: `"${entry.key}" names no limitation. Every one of these is wrong about something, and the catalogue is not a sales page.`,
      };
    }
  }
  return { ok: true };
}
