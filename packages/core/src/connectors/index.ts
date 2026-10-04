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
  | "telephony"
  /**
   * Taking money, which is the first capability here that is not about
   * marketing.
   *
   * This file began as the map of what a marketing operation needs, and the
   * comment above still reads that way. It is now the map of every outside
   * system the product speaks to, because there is no second place for an
   * owner to look and a catalogue that covers most of the integrations is one
   * whose silences mean nothing.
   */
  | "payments"
  /** The books of record, which this product posts to and never owns. */
  | "accounting"
  /**
   * The technician's own calendar, which is the one piece of this product
   * most of its users already have open on their phone all day.
   *
   * In the database's capability enum since the first migration with nothing
   * behind it, which is the state this catalogue exists to make visible: a
   * seam named in the schema and implemented by nobody reads, to anybody
   * looking at the schema, as a feature.
   */
  | "calendar"
  /** A language model, running on the company's own key and the company's own bill. */
  | "ai_model"
  /**
   * Where an address is. In the database's capability enum since the first
   * migration with nothing behind it, exactly as `calendar` was, and the
   * reason `property.latitude` was a column nothing filled.
   */
  | "maps"
  /**
   * How long the drive is by road. In the capability enum since the first
   * migration with nothing behind it, so every drive time was a straight line
   * stretched by a factor. The optimiser, the rebalance and a customer's ETA
   * all ask it, and all fall back to the straight line without it.
   */
  | "routing"
  /** Speech to text, for the call recordings and voicemails this product keeps. */
  | "transcription"
  /**
   * Consumer financing: a lender the customer borrows from to pay the
   * company. In the database's capability enum since the first migration with
   * nothing behind it, as `calendar` and `maps` were.
   */
  | "financing"
  /** Postcards and letters printed and posted by a mail house, to an audience of the company's own customers. */
  | "direct_mail";

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
  /**
   * A secret THIS product mints and hands over, rather than one the operator
   * fetches from a vendor.
   *
   * A subscribable calendar URL is the case: there is nobody to get a
   * credential from, the token in the path is the whole of the
   * authentication, and whoever holds the URL has the access until it is
   * revoked. Calling that `none` would be false, and calling it `api_key`
   * would send an operator looking for a vendor screen that does not exist.
   */
  | "feed_token"
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
  /**
   * Replies to a lead written here and sent through the marketplace that sold
   * it, and the customer's messages back. Its own flow because most
   * marketplaces deliver a lead and take nothing back, and an owner choosing
   * between them should see which ones answer.
   */
  | "lead_messages"
  /** Printed mail out: a postcard or a letter, to a person at an address. */
  | "mail_out"
  /** Reputation: reviews read, and replies written. */
  | "reviews_in"
  | "reviews_out"
  /** Marketing sends, as opposed to the transactional ones M18 already does. */
  | "campaigns_out"
  /**
   * Transactional sends: the arrival notice, the invoice, the receipt.
   *
   * Added because the two email adapters send these and cannot send a
   * campaign, there being no campaign engine. Declaring `campaigns_out` for
   * them would have been exactly the claim this file exists to prevent, and
   * declaring nothing would have made the honest half of the feature
   * invisible in the only place an owner looks.
   */
  | "messages_out"
  /**
   * Replies back in, which is a different flow and not the same connector
   * capability read backwards.
   *
   * An adapter can send and not receive: an outbound-only gateway is a real
   * product people buy. Folding the two into one flow would make a carrier
   * that drops replies on the floor indistinguishable from one that threads
   * them into the inbox, and the first of those is a customer saying STOP
   * into a void.
   */
  | "messages_in"
  /** Money in: a card charged, and the processor's word that it cleared. */
  | "payments_in"
  /** Money back out: a refund issued from here rather than from their dashboard. */
  | "refunds_out"
  /** Invoices, payments and credits pushed into the books of record. */
  | "books_out"
  /** What changed over there read back, so the two do not silently diverge. */
  | "books_in"
  /** Questions out and answers back, priced per token against the operator's own account. */
  | "model_calls"
  /** Words out of a call's audio. */
  | "transcripts_in"
  /**
   * The schedule out: visits leaving this product for a calendar somebody
   * has already got open.
   *
   * None of the flows above fits and the nearest, `messages_out`, would be a
   * claim that something is being sent to a customer. This is a read a
   * client comes and collects, and the direction matters because it is the
   * first thing in this catalogue that puts customer addresses somewhere
   * this company does not control.
   */
  | "calendar_out"
  /**
   * Addresses out, and where they are back. A customer's address leaves this
   * product for the geocoder, which is worth an owner knowing before they
   * connect one, and a coordinate with its precision comes back to be kept.
   */
  | "locations_in"
  /**
   * A loan application out to a lender, its decision back, and the lender's
   * payment in. One flow rather than three, because none of the three is
   * worth anything without the others: an application whose decision never
   * comes back is a customer left waiting, and a decision with no payment is
   * an invoice nobody closes.
   */
  | "financing_in"
  /**
   * Drive times back for pairs of points sent out. The points are customers'
   * houses and where technicians are, which is worth an owner knowing before
   * they point this at somebody else's server.
   */
  | "drive_times_in";

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
    state: "built",
    purpose:
      "Pull every campaign's cost per day into your spend, mapped onto your tracking campaigns, and report each paid job back against the click that won it, with its revenue, so the account bids on work rather than on form fills. Replaces the conversion file once it is on.",
    setup:
      "Three things from Google, then a sign in. A developer token, which is an application to Google from a manager account and is not instant: until it is approved for basic access it only works against test accounts. An OAuth client of the web application type in Google Cloud, with this deployment's sign in return address added to it, kept in your secret store as one JSON value with clientId and clientSecret. And a conversion action in the Ads account, of the import type, for booked jobs. Enter the customer id and the names of the two secrets, then press Sign in with Google with an account that can manage the Ads account.",
    limitation:
      "It knows what it was paid and what it was clicked. A conversion can only be sent for a job whose customer arrived through a tagged click, or whose email or phone the company and the customer allow to be matched, and Google refuses a click more than ninety days old. Google's own conversion counts will differ from this product's, because Google models what it cannot see. A job's revenue that changes after it was sent is not restated.",
  },
  {
    key: "google_lsa",
    label: "Google Local Services Ads",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "leads_in"],
    state: "built",
    purpose:
      "The pay per lead product most trades companies actually spend on. Its calls, messages and bookings arrive in the lead inbox credited to Local Services, and what it charged arrives as spend under Local Services rather than blended into Google Ads.",
    setup:
      "The same developer token and OAuth client as Google Ads, because Local Services leads are read through the Google Ads API. Enter the customer id of the Local Services account, which is its own account even when one person owns both, and sign in with Google.",
    limitation:
      "Disputing a bad lead is a manual process on Google's side and no API changes that, so a charge will be in the numbers before anybody decides whether it should be. Google withholds the caller's details on some leads and in some regions, and the message text of a message lead is not read, only that it arrived. The lead's time is read in the account's own timezone.",
  },
  {
    key: "meta_ads",
    label: "Meta Ads",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in", "conversions_out"],
    state: "built",
    purpose:
      "Pull every Facebook and Instagram campaign's cost per day into your spend, and send a Lead when a job is booked and a Purchase when it is paid through the Conversions API, matched on the click and, where allowed, hashed email and phone.",
    setup:
      "A Meta app of the business type with Marketing API access, its app id and secret in your secret store as one JSON value with clientId and clientSecret, and this deployment's sign in return address added to it. Reading another business's ad account needs ads_read and ads_management at advanced access, which is Meta's app review. Enter the ad account id and the pixel id, then press Sign in with Meta.",
    limitation:
      "Meta's sign in lasts about sixty days and cannot be extended without signing in again; a system user token kept in your own secret store does not expire. Attribution inside Meta's own reporting will not agree with what this product measures, and the gap is not a bug in either. Meta refuses an event more than seven days old, so a job paid later than that is never reported. Leads from Meta's instant forms are not read; use the lead webhook for those.",
  },
  {
    key: "bing_ads",
    label: "Microsoft Advertising",
    capability: "ads",
    auth: "oauth",
    flows: ["spend_in"],
    state: "built",
    purpose:
      "Pull every Microsoft Advertising (Bing) campaign's cost per day into your spend every six hours, mapped onto your tracking campaigns, for the account most contractors forget they are running.",
    setup:
      "A Microsoft Advertising developer token, which Microsoft issues from the Developer Portal to a user of a Microsoft Advertising account, and an app registered in Microsoft Entra with this deployment's sign in return address added to it, kept in your secret store as one JSON value with clientId and clientSecret. Enter the customer id and the account id from the top of the Microsoft Advertising screen, the names of the two secrets, then press Sign in with Microsoft.",
    limitation:
      "Spend only: booked jobs are not sent back to Microsoft, so its own reports count form fills and not work; the conversion file is for Google and Meta. Its reporting is a report job that is submitted, waited on and downloaded, and a report Microsoft is still preparing after a minute is asked for again at the next pull. Lower volume than Google, so per campaign numbers go noisy fast at a contractor's budget.",
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
    auth: "webhook_secret",
    flows: ["leads_in"],
    state: "built",
    purpose:
      "Each lead Angi (and HomeAdvisor) sells you arrives in the lead inbox the moment it is posted, credited to the channel and tracking campaign you choose, with what Angi charged for it recorded as spend.",
    setup:
      "Angi posts leads to a CRM only for partners in its CRM integration program, which Angi has to approve. Once approved, give Angi the address shown when you set it up here, and the password you keep in your secret store under the name you entered. Until then, forward Angi's lead emails to your lead inbox address instead.",
    limitation:
      "Tested against a fake of Angi's lead post, not a live account. Angi has no API for writing back to a customer, so replies are a call or a text from here. A lead Angi credits back after a dispute is not taken out of the spend by itself.",
  },
  {
    key: "thumbtack",
    label: "Thumbtack",
    capability: "lead_source",
    auth: "webhook_secret",
    flows: ["leads_in", "lead_messages"],
    state: "built",
    purpose:
      "Each Thumbtack lead in the lead inbox as it is sent, credited to the channel and tracking campaign you choose, with its price recorded as spend; the customer's messages on the lead, and replies written here sent back through Thumbtack.",
    setup:
      "Thumbtack's partner API is open only to partners Thumbtack approves. An approved partner gets an access token (kept in your secret store, its name entered here) and registers the address shown here for new leads and messages, with the password you keep under the name you entered. Until then, forward Thumbtack's lead emails to your lead inbox address.",
    limitation:
      "Tested against a fake of Thumbtack's documented API, not a live account. The access token is read from your secret store as it is; when Thumbtack expires it, put the new one there. Offers expire in minutes, so a lead read from an email has usually already been answered by somebody faster.",
  },
  {
    key: "yelp",
    label: "Yelp Request a Quote",
    capability: "lead_source",
    auth: "api_key",
    flows: ["leads_in", "lead_messages"],
    state: "built",
    purpose:
      "Each Request a Quote lead from Yelp in the lead inbox, credited to the channel and tracking campaign you choose, with the customer's messages on it and replies written here sent back through Yelp.",
    setup:
      "Yelp's Leads API is open only to partners Yelp approves, and the business owner then grants the partner access to the business. Enter the Yelp business id and the name of the secret holding the access token, and give Yelp the address shown here for lead notices. Until then, forward Yelp's emails to your lead inbox address.",
    limitation:
      "Tested against a fake of Yelp's documented API, not a live account. Yelp posts only that something happened and nothing is believed from the notice: the lead is read from Yelp with the token. Yelp usually withholds the customer's phone number, so the lead's email is Yelp's relay to them.",
  },
  {
    key: "nextdoor",
    label: "Nextdoor",
    capability: "lead_source",
    auth: "none",
    flows: ["leads_in"],
    state: "built",
    purpose: "Enquiries from your Nextdoor business page in the lead inbox, read from the notification emails Nextdoor sends you.",
    setup: "Nothing to apply for, because there is nothing to apply for: Nextdoor has no API for a business's enquiries. Forward Nextdoor's notification emails to your lead inbox address.",
    limitation:
      "Only as good as the email. Nextdoor's notifications often carry a name and a message and no phone number, and such an email is kept for somebody to read rather than made into a lead with nobody to call. Answering is done on Nextdoor.",
  },
  {
    key: "lead_email",
    label: "Lead notification emails",
    capability: "lead_source",
    auth: "none",
    flows: ["leads_in"],
    state: "built",
    purpose:
      "One address per company that the lead emails from Angi, HomeAdvisor, Thumbtack, Yelp and Nextdoor are forwarded to, each read into a lead offer credited to the platform that sent it. For the platforms that will not give you API access.",
    setup:
      "An email provider that receives mail (Resend, with a receiving domain entered as its reply domain on Settings, Integrations). The address is shown on Marketing, Lead offers, Lead sources; set a rule in your mailbox forwarding the platforms' lead emails to it.",
    limitation:
      "It reads labels (Name, Phone, Zip code) rather than a platform's layout, so it survives a redesign, and it is still reading an email: a platform that drops the phone number from its email gives a lead with nobody to call, which is kept for a person to read rather than made into a lead. The first email a mailbox sends to confirm a forwarding rule is kept the same way, so the code in it can be read here.",
  },

  /* ----------------------------------------------------------- analytics */
  {
    key: "ga4",
    label: "Google Analytics 4",
    capability: "analytics",
    auth: "api_key",
    flows: ["conversions_out"],
    state: "built",
    purpose:
      "Send a lead when a job is booked and a purchase when it is paid, tied to the visit the website snippet saw, so booked work shows up in your own analytics against the page and the source that brought it.",
    setup:
      "Google Analytics on your website, and the website snippet from Settings, Website on the same pages, which is what reads the visitor's analytics id. Then the measurement id of the web data stream, and a Measurement Protocol API secret created in that stream's settings, kept in your secret store with its name entered here.",
    limitation:
      "Google accepts a malformed event as readily as a good one and drops it without a word, so sent here means received there and nothing more. Nothing that identifies a person is sent, which Google's terms forbid. A visitor whose analytics id was never captured, because they rang from a van rather than visiting the site, cannot be tied to a visit at all. Sessions are read back by Google Analytics 4 reports, a separate connection.",
  },
  {
    key: "ga4_data",
    label: "Google Analytics 4 reports",
    capability: "analytics",
    auth: "oauth",
    flows: ["analytics_in"],
    state: "built",
    purpose:
      "Sessions by source and medium, per day, read from your Google Analytics property twice a day onto the marketing overview, beside the leads and the jobs each source brought.",
    setup:
      "The Google Analytics Data API switched on in a Google Cloud project, an OAuth client of the web application type there with this deployment's sign in return address, kept in your secret store as one JSON value with clientId and clientSecret. Enter the property id (the number in Analytics' admin, not the G- measurement id), then sign in with Google as somebody who can read the property.",
    limitation:
      "Sessions are Google's count, with Google's sampling and consent mode gaps, and will not match the visits this product's own snippet records. A session is a visit, not a person, so sessions and leads are compared as rates, never matched one to one.",
  },
  {
    key: "search_console",
    label: "Google Search Console",
    capability: "analytics",
    auth: "oauth",
    flows: ["analytics_in"],
    state: "built",
    purpose: "What people searched before they arrived, with the clicks and impressions of each search, read twice a day onto the marketing overview: the only honest read on organic demand.",
    setup:
      "The domain verified in Search Console, the Search Console API switched on in a Google Cloud project with an OAuth client of the web application type there (this deployment's sign in return address added, kept in your secret store as one JSON value with clientId and clientSecret). Enter the property exactly as Search Console names it (sc-domain:yourcompany.com, or the https address of a URL property), then sign in with Google as somebody who can read it.",
    limitation: "Queries are withheld below a volume threshold, so the long tail a trades site lives on is mostly invisible. Search Console publishes a day two or three days late, so the last few days are always short.",
  },

  /* ------------------------------------------------------- meta instant forms */
  {
    key: "meta_lead_ads",
    label: "Meta instant forms",
    capability: "ads",
    auth: "oauth",
    flows: ["leads_in"],
    state: "built",
    purpose:
      "Leads filled in on a Facebook or Instagram instant form, in the lead inbox within seconds of Meta posting them and read again every ten minutes in case a post was missed, each credited to Meta and to the tracking campaign its ad campaign is mapped to.",
    setup:
      "A Meta app of the business type with app review passed for leads_retrieval, pages_show_list, pages_read_engagement, pages_manage_metadata and ads_read; its id and secret in your secret store as one JSON value with clientId and clientSecret. In the app's webhooks, subscribe the Page object's leadgen field to this deployment's public address followed by /api/webhooks/meta/leads, with the verify token set as META_LEADS_VERIFY_TOKEN in the deployment's environment. Enter the Page id, then sign in with Meta as an admin of the Page.",
    limitation:
      "Tested against a fake of Meta's documented Graph API and webhooks, not a live Page. Meta's sign in lasts about sixty days. A form's custom questions are kept with the lead and not mapped onto fields; the name, phone, email and address questions are. A lead older than ninety days cannot be read from Meta at all.",
  },

  /* ----------------------------------------------------------- direct mail */
  {
    key: "lob",
    label: "Lob",
    capability: "direct_mail",
    auth: "api_key",
    flows: ["mail_out"],
    state: "built",
    purpose:
      "Print and post a postcard or a letter to an audience of your own customers, each piece with the mailing's tracking number and its own web address and QR code, so a call or a visit from it is credited to the mailing and its cost recorded as spend.",
    setup:
      "A Lob account and its secret API key, kept in your secret store with its name entered here. A test key (it starts test_) prints nothing and charges nothing, which is the way to look at a mailing before sending it for real. Your company's address on Settings is the return address.",
    limitation:
      "Tested against a fake of Lob's documented API, not a live account. Lob's API does not say what a piece cost, so the price per piece is yours to type from Lob's price list. Where a piece is in the post is not read back from Lob; what it says when the piece is sent (its id and expected delivery) is kept.",
  },

  /* ------------------------------------------------------------- reviews */
  {
    key: "google_business_profile",
    label: "Google Business Profile",
    capability: "reviews",
    auth: "oauth",
    flows: ["reviews_in", "reviews_out"],
    state: "built",
    purpose:
      "Read reviews into the review work list every hour and post the reply written here back to the listing. For a local trades company this listing is worth more than the website.",
    setup:
      "Access to the Business Profile API, which is its own application to Google, granted to a Google Cloud project, and an OAuth client in that project kept in your secret store as one JSON value with clientId and clientSecret. Enter the listing's account id and location id, then sign in with Google as somebody who manages the listing.",
    limitation:
      "Google rate limits both reading and replying, and a reply posted through an API is still subject to their moderation, so a reply that appears here can be absent there. Who wrote a review is a suggestion here, never a fact, until somebody confirms it.",
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

  /* ----------------------------------------------------------- messages out */
  /* ------------------------------------------------------------- messaging */
  /**
   * TWILIO WAS MISSING FROM THIS CATALOGUE UNTIL JUSTCALL WAS ADDED BESIDE IT.
   *
   * It is the first adapter this product ever had, it is named on the
   * website, and the file above says this is the map of every outside system
   * the product speaks to. An owner looking here for the thing their texts
   * go through found nothing and could only conclude the product had never
   * heard of it, which is the understating failure this catalogue is as
   * exposed to as the overclaiming one.
   */
  {
    key: "twilio",
    label: "Twilio",
    capability: "messaging",
    auth: "api_key",
    flows: ["messages_out", "messages_in"],
    state: "built",
    purpose:
      "Texts out and replies back in, on your own Twilio account. Reminders, arrival notices and the shared inbox all run through it, and a reply threads onto the job it belongs to rather than onto a phone number.",
    setup:
      "An account SID and auth token from your own Twilio console, and a number or messaging service to send from. Put the auth token in your secret store: this product holds the name of it and never the value. In the United States, A2P 10DLC registration is between you and Twilio, and unregistered traffic is filtered rather than refused, so it fails by disappearing.",
    limitation:
      "Twilio's own opt out handling is a courtesy and not your compliance position: it knows nothing about a form somebody signed in 2024, which is why consent is decided here before a carrier is chosen at all. A delivery receipt says the handset acknowledged it, never that anybody read it.",
  },
  {
    key: "justcall",
    label: "JustCall",
    capability: "messaging",
    auth: "api_key",
    flows: ["messages_out", "messages_in"],
    state: "built",
    purpose:
      "The same seam with a JustCall account instead, for a company already running their phones through it. Nothing in the send path, the outbox or the consent rules knows which of the two is configured.",
    setup:
      "An API key and secret from the APIs and Webhooks screen of your own JustCall account, stored as one `key:secret` value in your secret store, because a credential split across two names is two things to rotate and one of them forgotten. Then a webhook in JustCall pointed at this product, subscribed to SMS received and SMS delivery status updated. API access starts at their Team plan.",
    limitation:
      "Their webhook signature does not cover the event data: it is computed over the secret, the configured URL, the event type and a timestamp, and none of the message. A valid signature proves somebody holding the secret sent an event of that type, not that this is the body they sent. The replay window is therefore five minutes rather than the day the call tracking adapter allows, and a resent body lands on the row their message id already wrote. Nothing of ours is carried through a send either, so a delivery receipt is matched on their id alone.",
  },

  {
    key: "resend",
    label: "Resend",
    capability: "email",
    auth: "api_key",
    flows: ["messages_out"],
    state: "built",
    purpose:
      "Send from your own Resend account and learn what happened to each message: delivered, bounced, or reported as spam.",
    setup:
      "An API key from your own Resend account, a sending domain verified there with SPF, DKIM and DMARC, and a webhook endpoint pointed at the URL on this screen plus the signing secret it gives you. Both go in your secret store; this product holds the names, never the values.",
    limitation:
      "Delivery reporting depends entirely on the webhook, so a connection whose signing secret is missing or wrong sends perfectly well and never learns that anything arrived or bounced. Opens and clicks are not recorded at all, because a tracking pixel that Apple Mail fetches on its own is not evidence a person read anything.",
  },
  {
    key: "smtp",
    label: "Any SMTP server",
    capability: "email",
    auth: "api_key",
    flows: ["messages_out"],
    state: "built",
    purpose:
      "Send through the mail server you already pay for: a Google Workspace or Microsoft 365 mailbox, your web host's relay, or your own Postfix. No vendor account to open, which is the point of it.",
    setup:
      "The host, port, username and password your mail client already uses, plus whether it wants TLS or STARTTLS. Nothing else, and no signup anywhere.",
    limitation:
      "SMTP cannot tell you what happened. It ends at the receiving server's 250 OK; a bounce comes back hours later as a separate email to the envelope sender and a spam complaint goes to a feedback loop, neither of which this product reads. Delivery, bounce and complaint stay empty for everything sent this way, and the do not email list only ever grows from what somebody puts on it by hand.",
  },

  /* --------------------------------------------------------------- books */
  {
    key: "quickbooks",
    label: "QuickBooks Online",
    capability: "accounting",
    auth: "oauth",
    flows: ["books_out", "books_in"],
    state: "built",
    purpose:
      "Put every invoice, payment and write-off into the books your accountant already works in, and read back what changed over there, so nobody keys the same figure twice.",
    setup:
      "Connect the QuickBooks company you already use, then map your account codes to your own chart of accounts on the screen that follows. Nothing is mapped for you: a posting whose code has no mapping stops and names the code, because a default that quietly picks a plausible income account is a year of misfiled revenue found by an accountant in March.",
    limitation:
      "Intuit meters READS and refuses the overage with a 429 rather than billing it, so a pass that runs out of read budget stops reading, says so on the run, and keeps pushing: the invoices still land, the change feed waits for the next window. Connecting it does not import history either; it starts from the day you connect, because their change feed will not answer for anything older than thirty days.",
  },

  /* -------------------------------------------------------------- models */
  {
    key: "xero",
    label: "Xero",
    capability: "accounting",
    auth: "oauth",
    flows: ["books_out", "books_in"],
    state: "built",
    purpose:
      "The same accounting bridge against Xero instead of QuickBooks. Invoices, payments, credit notes and the customers behind them go into the books your accountant already works in, and what changes over there comes back.",
    setup:
      "A free Xero developer account and an app you register yourself, which is a form rather than an approval queue, then the usual consent screen against the organisation you want connected. The client id, client secret and refresh token go into your secret store as one value, because Xero rotates the refresh token on every single exchange and all three have to be replaced together.",
    limitation:
      "Xero has no change feed. It has a modified-since window, so inbound is a timestamp boundary rather than a cursor, and a few records either side of it are read twice on purpose because the alternative is losing one written mid-request. Their refresh token has no grace period at all: the moment one is exchanged the previous one is dead, so a deployment that loses the rotated value needs a human back at the consent screen. Payments arrive as batch payments, including a payment against a single invoice, so they appear as one line on the bank reconciliation and the deposit account has to be a bank account with payments enabled. Sixty calls a minute and five thousand a day per organisation, shared between reading and writing.",
  },
  {
    key: "anthropic",
    label: "Claude",
    capability: "ai_model",
    auth: "api_key",
    flows: ["model_calls"],
    state: "built",
    purpose:
      "Point Claude at your own data with your own key, and give it the same tools a person with your permissions would have. Nothing it can reach is anything you could not do by hand.",
    setup:
      "An API key from your own Anthropic account, put in your secret store. This product holds the name of it and never the value. Set a monthly ceiling at the same time: the key is yours and so is the bill.",
    limitation:
      "The ceiling is checked before each call against the worst case cost of that call, so a month can overrun by at most one call's input, which nothing can know in advance. No word of any prompt or answer is stored here, which also means there is no transcript to go back to.",
  },
  {
    key: "openai",
    label: "ChatGPT",
    capability: "ai_model",
    auth: "api_key",
    flows: ["model_calls"],
    state: "built",
    purpose:
      "The same seam with an OpenAI key instead, for a company that already pays for one.",
    setup:
      "An API key from your own OpenAI account. Prices and the default model are not held for this vendor, so set them in the connection settings if you want a spend ceiling, because a ceiling built on an unknown price is a setting that does nothing.",
    limitation:
      "A call this product cannot price is refused while a ceiling is set, rather than running and recording nothing, and runs recording a null cost when no ceiling is set. Never a zero: zero is a claim the call was free.",
  },
  {
    key: "google",
    label: "Gemini",
    capability: "ai_model",
    auth: "api_key",
    flows: ["model_calls"],
    state: "built",
    purpose:
      "The same seam with a Google key. The adapter sends it as a header rather than in the URL, because a URL is logged by every proxy between your box and the vendor.",
    setup:
      "An API key from your own Google AI account, plus prices and a default model in the connection settings if you want a ceiling, for the same reason as OpenAI.",
    limitation:
      "Gemini issues no id for a tool call, so when a model asks for the same tool twice in one turn the two are told apart by order rather than by identity. Everything else lines up with the other two.",
  },

  /* ------------------------------------------------------------- calendar */
  {
    key: "ics_feed",
    label: "Calendar feed",
    capability: "calendar",
    auth: "feed_token",
    flows: ["calendar_out"],
    state: "built",
    purpose:
      "Put a technician's visits in the calendar they already have. A URL they subscribe to once in Google Calendar, Apple Calendar, Outlook or the phone's own app, and their day is there with the address ready to navigate to.",
    setup:
      "Mint a feed on the calendar settings screen and copy the URL it shows you once. Paste it into the calendar app as a subscription, not an import: an import is a one-off copy that never changes again. There is no account to open and nothing to approve, because there is no vendor involved at all.",
    limitation:
      "The URL is the whole credential: anybody who gets it sees those visits until it is revoked, so it is handed over once and cannot be read back, and rotating is one call. It is also read only in both directions. Nothing a technician changes in their own calendar comes back here, and how often a client collects it is the client's decision rather than ours: Google in particular can take hours to notice a change, so a visit moved this morning is not a reliable way to tell somebody. The customer's phone number is deliberately not in it, because a calendar syncs to accounts and devices this company does not control.",
  },

  /* ----------------------------------------------------------------- maps */
  {
    key: "nominatim",
    label: "OpenStreetMap (Nominatim)",
    capability: "maps",
    auth: "none",
    flows: ["locations_in"],
    state: "built",
    purpose:
      "Put every customer's address on the dispatch map, and give the route optimiser something to measure, with no account and no key. Addresses are looked up by the background worker, never while somebody is saving a customer.",
    setup:
      "Nothing to sign up for. Give a contact email so the OpenStreetMap volunteers who run the public server can reach you, as their usage policy asks. With more than a few thousand addresses, run your own Nominatim server and have whoever runs this installation set NOMINATIM_URL to it: the public one asks not to be used for bulk work, and this product will only ask it one address a second. The address is the deployment's to set, not a company's, because the server sends every customer's address to it.",
    limitation:
      "The public server answers one request a second at most, so a backfill of a large customer list takes hours, and its coverage of house numbers is patchy outside cities: many answers land on the street rather than the house, and the map says so. Your customers' addresses are sent to whichever server you point it at. A pin placed by hand on the property page always wins over it.",
  },
  {
    key: "mapbox",
    label: "Mapbox",
    capability: "maps",
    auth: "api_key",
    flows: ["locations_in"],
    state: "built",
    purpose:
      "The same job as OpenStreetMap with a commercial geocoder behind it, for a company with a large customer list or addresses where house level answers matter.",
    setup:
      "A Mapbox account with permanent geocoding enabled, which is a paid tier, and an access token scoped to geocoding only. Put the token in your secret store and enter its name here; this product holds the name and never the value.",
    limitation:
      "Only the permanent tier may be stored, and this product stores every answer, so it always asks for that tier and a token without it is refused. The token travels in the request's URL because that is the only place Mapbox accepts it, which is why it should be scoped to geocoding and nothing else. Google is deliberately not offered: its terms cap keeping coordinates at thirty days and bar drawing them on a map that is not Google's.",
  },

  /* -------------------------------------------------------------- routing */
  {
    key: "osrm",
    label: "OSRM (your own routing server)",
    capability: "routing",
    auth: "none",
    flows: ["drive_times_in"],
    state: "built",
    purpose:
      "Drive times by road for the route optimiser, the day rebalance and the arrival time a customer sees on their tracking link, from a routing engine you run yourself on OpenStreetMap roads. Nothing leaves your own servers.",
    setup:
      "Run OSRM with your state's OpenStreetMap extract (the project publishes a container that does it in three commands) and enter its address here. There is no account and no key. The project's public demo server is not offered: it asks not to be used for real traffic.",
    limitation:
      "No live traffic: a time is what the roads allow, not what the motorway is doing at five. Answers are kept thirty days, so a road that opens or closes takes that long to show unless you refresh your extract and reconnect. Without a routing service connected, or when it does not answer, every drive is a straight line estimate and the screens say so.",
  },
  {
    key: "mapbox_directions",
    label: "Mapbox (drive times)",
    capability: "routing",
    auth: "api_key",
    flows: ["drive_times_in"],
    state: "built",
    purpose:
      "The same drive times by road from Mapbox's Matrix API, for a company that would rather pay per request than run a routing server.",
    setup:
      "A Mapbox access token scoped to the Matrix API, in your secret store with its name entered here. This is a separate connection from the Mapbox geocoder, so a company can geocode with one service and route with another.",
    limitation:
      "Each request costs money on Mapbox's pricing, and a customer watching their tracking link asks for the drive from the van's newest position. Answers are kept for a day at most, the cautious reading of terms that restrict storing what Mapbox returns. Twenty five points a request, so a big day is several requests. The token travels in the URL, which is why it should be scoped to this API alone.",
  },
  {
    key: "openrouteservice",
    label: "OpenRouteService",
    capability: "routing",
    auth: "api_key",
    flows: ["drive_times_in"],
    state: "built",
    purpose:
      "Drive times by road over OpenStreetMap from Heidelberg's hosted routing service, which has a free tier, or from the same software run on your own server.",
    setup:
      "For the hosted service, a free key from openrouteservice.org in your secret store with its name entered here. For your own server, enter its address and leave the key empty.",
    limitation:
      "The hosted free tier has a daily request quota and fifty points a request; a company that outgrows it runs its own. No live traffic. Answers are kept a week. Your customers' locations are sent to whichever server you point it at.",
  },

  /* ------------------------------------------------------- call transcripts */
  {
    key: "whisper",
    label: "Speech to text (Whisper)",
    capability: "transcription",
    auth: "api_key",
    flows: ["transcripts_in"],
    state: "built",
    purpose:
      "Write out every call recording and voicemail this product keeps, so the call log can be searched for what was said and a voicemail can be read in the van rather than played. Card numbers and security codes read aloud are removed before the words are stored.",
    setup:
      "Either an API key from your own OpenAI account, put in your secret store with its name entered here, or the address of a Whisper server you run yourself (faster-whisper-server, LocalAI or the whisper.cpp server all speak the same API) and no key at all. Then every recording and voicemail kept from that moment is written out by the background worker within a minute or two.",
    limitation:
      "The audio is sent to whichever server you point it at, so a company that does not want customers' calls to leave the building runs its own. It does not tell voices apart: a recorded call reads as one stream of words, not as caller and answerer. Only audio this product kept is transcribed, which means only calls the recording check allowed and voicemails; a recording deleted here takes its transcript with it.",
  },

  /* -------------------------------------------------------- call tracking */
  {
    key: "callrail",
    label: "CallRail",
    capability: "telephony",
    auth: "api_key",
    flows: ["leads_in", "analytics_in"],
    state: "built",
    purpose:
      "Attribute phone calls to what paid for them. For most trades companies this is the only measurement their marketing ever gets: a yard sign, a van, a mailer and a radio spot carry no query string, so the number on them is the tag, and a tracked call becomes a call record and a marketing touch here.",
    setup:
      "An API key from the integrations screen of your own CallRail account, which is self-serve on any paid plan. Then a Webhooks integration in CallRail pointed at the URL on this screen, and the signing key from that same page. Both values go in your secret store; this product holds the names of them and never the values. Record each tracking number here with the source it stands for, because that declaration is what turns a call into a channel rather than into an unrecognised number on the worklist.",
    limitation:
      "One long-lived API key, with no OAuth and no refresh token, so nothing expires and nothing will ever prompt a rotation: changing the key is somebody deciding to, minting a new one and replacing it in the secret store by hand. CallRail does not resend a webhook that failed either, so an outage is calls that never arrive on their own and the backfill is the only way to get them back. The webhook signature is HMAC-SHA1 rather than SHA-256, which is what they offer. The recording and the transcript CallRail sends are deliberately not stored: a recording needs a permission decision under your own declared policy and a webhook carries no evidence of one, and a transcript would land unredacted, card numbers and all.",
  },

  /* ------------------------------------------------------------ payments in */
  {
    key: "stripe",
    label: "Stripe",
    capability: "payments",
    auth: "api_key",
    flows: ["payments_in", "refunds_out"],
    state: "built",
    purpose:
      "Take a card on the customer portal or in the field, and have the invoice close itself when the money actually clears. Refunds go out from here rather than from a second dashboard nobody in the office has a login for.",
    setup:
      "A restricted API key from your own Stripe account, scoped to payment intents, charges and refunds, plus a webhook endpoint pointed at the URL on this screen and the signing secret it gives you. Both go in your secret store; this product holds the names of them, never the values. The money goes to your account, on your rate, and nothing here takes a cut.",
    limitation:
      "The webhook is what closes an invoice, so a connection whose signing secret is missing or wrong takes cards perfectly well and never learns that any of them succeeded. It also means a payment taken while this product is down is reconciled when it comes back, not at the moment the customer pays.",
  },

  /* ---------------------------------------------------------- financing in */
  {
    key: "wisetack",
    label: "Wisetack",
    capability: "financing",
    auth: "api_key",
    flows: ["financing_in"],
    state: "built",
    purpose:
      "Let customers pay over time. Estimates and invoices show an \"as low as\" monthly figure from your Wisetack plans, always with \"subject to approval\" beside it; the customer applies from their link or from a text or email the office sends; the application's status shows on the estimate or invoice; and when Wisetack funds the loan the payment lands on the invoice with Wisetack's fee booked as an expense.",
    setup:
      "A Wisetack merchant account with API access, which Wisetack grants to merchants it has signed: an API token, your merchant id, and a webhook endpoint pointed at the URL on this screen with its signing secret. The token and the signing secret go in your secret store; this product holds their names. Enter the plans on your Wisetack agreement (months and APR, such as 60@17.9) and the smallest and largest amount Wisetack finances for you, which is what the monthly figure is worked out from.",
    limitation:
      "Tested against a fake of Wisetack's API, not a live account: run one application through Wisetack's sandbox before turning it on for customers. The monthly figure is worked out from the plans you enter, not asked of Wisetack per customer, so it is only as right as those plans. Nothing about a customer's credit is kept beyond the status Wisetack returns. A loan Wisetack refunds after funding is shown and not reversed: record the refund on the payment.",
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
export * from "./settings.js";
