/**
 * What each provider needs typed in, as fields rather than a JSON box.
 *
 * Read off the adapters, not invented: every key below is one an adapter or
 * service actually reads from `integration_connection.settings`, and a key
 * nobody reads is a field somebody fills in and believes did something.
 *
 * `credential` is the NAME of a secret in the deployment's secret store,
 * never its value, and so is every `...Ref` field: a provider with a second
 * secret (a webhook signing secret) takes a second name. No SETTING can hold
 * a secret's value, and the service refuses a settings key it does not
 * declare (`connectors.CONNECTOR_SETTINGS` in core) whatever posts it.
 *
 * With the database store (a shared deployment) the company pastes the value
 * instead, into a password box that is never filled back in. It goes to the
 * secrets service, encrypted, under `connectors.defaultSecretName`, and the
 * setting holds that name, exactly as it would hold a name typed here.
 */
export type FieldKind = "text" | "secret_name" | "number" | "select" | "list" | "yesno";

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  options?: readonly string[];
  hint?: string;
  /** For a `secret_name` field, what the box asks for when the value is pasted (database store). */
  secretLabel?: string;
}

export interface ProviderForm {
  /** Label for the secret-name field, or null when the provider takes none. */
  credential: string | null;
  /** The same, for pasting the value itself when the deployment stores secrets in its database. */
  credentialSecret?: string;
  fields: readonly Field[];
  /** Connected through a dedicated service rather than the generic one. */
  via?: "ai" | "call_tracking";
  /** No form at all, with the reason shown instead. */
  noForm?: string;
  /**
   * Whose consent screen a person signs in on after the settings are saved:
   * the ad platforms, whose access is granted by a person on the platform's
   * own screen rather than pasted from a vendor dashboard.
   */
  signIn?: "Google" | "Meta" | "Microsoft";
}

/** What the company lets go to an ad platform about its customers. Mirrors core's three modes. */
const PERSONAL_DATA: Field = {
  key: "personalData", label: "Customers' email and phone, hashed", kind: "select",
  options: ["consented", "unless_refused", "never"],
  hint: "consented: only for customers who said yes. unless_refused: for everybody who did not say no, which your privacy notice has to cover. never: click ids only. A customer who said no is never sent anything.",
};
const SEND_CONVERSIONS: Field = {
  key: "sendConversions", label: "Send booked and paid jobs back", kind: "yesno",
  hint: "Yes by default once connected. Each job is sent once, and only to the platform whose click it came from.",
};
const OAUTH_CLIENT: Field = {
  key: "oauthClientRef", label: "OAuth client, as the name of the secret holding clientId and clientSecret as one JSON value",
  kind: "secret_name", secretLabel: "OAuth client: clientId and clientSecret as one JSON value", placeholder: "GOOGLE_OAUTH_CLIENT",
};
const OWN_TOKEN = "A refresh token kept in your own secret store, as its name (leave empty and sign in below instead)";

export const FORMS: Record<string, ProviderForm> = {
  stripe: {
    credential: "Restricted secret key, as the name of the secret holding it",
    credentialSecret: "Restricted secret key",
    fields: [
      { key: "publishableKey", label: "Publishable key", kind: "text", placeholder: "pk_live_…",
        hint: "Sent to the customer's browser to show the card form. Without it the invoice page cannot take a card." },
      { key: "webhookSecretRef", label: "Webhook signing secret, as the name of the secret holding it", kind: "secret_name",
        secretLabel: "Webhook signing secret",
        hint: "Without it cards are taken and no payment is ever recorded." },
    ],
  },
  wisetack: {
    credential: "API token, as the name of the secret holding it",
    credentialSecret: "API token",
    fields: [
      { key: "merchantId", label: "Merchant id", kind: "text", hint: "From your Wisetack merchant account." },
      { key: "webhookSecretRef", label: "Webhook signing secret, as the name of the secret holding it", kind: "secret_name", secretLabel: "Webhook signing secret",
        hint: "Without it no application's status is ever heard, and a funded loan never reaches the invoice." },
      { key: "plans", label: "Plans on your Wisetack agreement, as months@APR, comma separated", kind: "list",
        placeholder: "12@0, 60@17.9",
        hint: "What \"as low as\" is worked out from. Leave empty and customers can still apply, with no monthly figure shown." },
      { key: "minAmount", label: "Smallest amount Wisetack finances for you", kind: "text", placeholder: "500" },
      { key: "maxAmount", label: "Largest amount Wisetack finances for you", kind: "text", placeholder: "25000" },
      { key: "showMonthly", label: "Show the monthly figure on estimates and invoices", kind: "yesno",
        hint: "Always shown with \"subject to approval\" beside it. No hides the figure and keeps the apply button." },
    ],
  },
  quickbooks: {
    credential: "Name of the secret holding refreshToken, clientId and clientSecret as one JSON value",
    credentialSecret: "refreshToken, clientId and clientSecret, as one JSON value",
    fields: [{ key: "realmId", label: "Company id (realm id)", kind: "text" }],
  },
  xero: {
    credential: "Name of the secret holding refreshToken, clientId and clientSecret as one JSON value",
    credentialSecret: "refreshToken, clientId and clientSecret, as one JSON value",
    fields: [{ key: "tenantId", label: "Organisation id (tenant id)", kind: "text" }],
  },
  twilio: {
    credential: "Auth token, as the name of the secret holding it",
    credentialSecret: "Auth token",
    fields: [
      { key: "accountSid", label: "Account SID", kind: "text", placeholder: "AC…" },
      { key: "messagingServiceSid", label: "Messaging service SID (optional)", kind: "text", placeholder: "MG…",
        hint: "Without it texts go from the number on each message." },
    ],
  },
  justcall: {
    credential: "Name of the secret holding key:secret",
    credentialSecret: "API key and secret, as key:secret",
    fields: [
      { key: "webhookUrl", label: "The webhook URL you entered in JustCall", kind: "text",
        hint: "Compared against what each signed webhook claims, so it must match exactly." },
    ],
  },
  resend: {
    credential: "API key, as the name of the secret holding it",
    credentialSecret: "API key",
    fields: [
      { key: "fromAddress", label: "Send from", kind: "text", placeholder: "office@yourcompany.com" },
      { key: "fromName", label: "Sender name", kind: "text" },
      { key: "verifiedDomains", label: "Domains verified with Resend, comma separated", kind: "list" },
      { key: "webhookSecretRef", label: "Webhook signing secret, as the name of the secret holding it",
        kind: "secret_name", placeholder: "RESEND_WEBHOOK_SECRET", secretLabel: "Webhook signing secret",
        hint: "Without it bounces, complaints and replies are never heard." },
      { key: "replyDomain", label: "Domain Resend receives replies on (optional)", kind: "text",
        placeholder: "replies.yourcompany.com",
        hint: "Set up as a receiving domain in Resend. Every email then carries a reply address on it, and a customer's reply lands in the right thread in the inbox." },
    ],
  },
  whisper: {
    credential: "API key, as the name of the secret holding it",
    credentialSecret: "API key",
    fields: [
      { key: "model", label: "Model (optional)", kind: "text", placeholder: "whisper-1" },
      { key: "language", label: "Language spoken, two letters (optional)", kind: "text", placeholder: "en" },
    ],
  },
  smtp: {
    credential: "Password, as the name of the secret holding it",
    credentialSecret: "Password",
    fields: [
      { key: "host", label: "Server", kind: "text", placeholder: "smtp.gmail.com" },
      { key: "port", label: "Port", kind: "number", placeholder: "587" },
      { key: "security", label: "Security", kind: "select", options: ["starttls", "tls", "none"] },
      { key: "username", label: "Username", kind: "text" },
      { key: "fromAddress", label: "Send from", kind: "text" },
      { key: "fromName", label: "Sender name", kind: "text" },
      { key: "verifiedDomains", label: "Domains you send from, comma separated", kind: "list" },
    ],
  },
  anthropic: {
    via: "ai",
    credential: "API key, as the name of the secret holding it",
    credentialSecret: "API key",
    fields: [{ key: "defaultModel", label: "Default model (optional)", kind: "text" }],
  },
  openai: {
    via: "ai",
    credential: "API key, as the name of the secret holding it",
    credentialSecret: "API key",
    fields: [{ key: "defaultModel", label: "Default model", kind: "text" }],
  },
  google: {
    via: "ai",
    credential: "API key, as the name of the secret holding it",
    credentialSecret: "API key",
    fields: [{ key: "defaultModel", label: "Default model", kind: "text" }],
  },
  callrail: {
    via: "call_tracking",
    credential: null,
    fields: [
      { key: "accountId", label: "Account id", kind: "text", hint: "The identifier in your CallRail dashboard's URL." },
      { key: "companyId", label: "Company id (optional)", kind: "text" },
    ],
  },
  nominatim: {
    credential: null,
    fields: [
      { key: "contactEmail", label: "Contact email for the OpenStreetMap volunteers", kind: "text",
        placeholder: "office@yourcompany.com",
        hint: "Sent with every lookup, as the public server's usage policy asks, so they can reach you rather than block you." },
      { key: "countryCodes", label: "Countries you work in, comma separated (optional)", kind: "list", placeholder: "us" },
    ],
  },
  mapbox: {
    credential: "Access token, as the name of the secret holding it",
    credentialSecret: "Access token",
    fields: [
      { key: "countryCodes", label: "Countries you work in, comma separated (optional)", kind: "list", placeholder: "us" },
    ],
  },
  osrm: {
    credential: null,
    fields: [
      { key: "profile", label: "Profile (optional)", kind: "text", placeholder: "driving" },
    ],
  },
  mapbox_directions: {
    credential: "Access token, as the name of the secret holding it",
    credentialSecret: "Access token",
    fields: [
      { key: "profile", label: "Profile", kind: "select", options: ["driving", "driving-traffic"],
        hint: "With traffic is ten points a request rather than twenty five, so a big day costs more requests." },
    ],
  },
  openrouteservice: {
    credential: "API key, as the name of the secret holding it (not needed for your own server)",
    credentialSecret: "API key",
    fields: [
      { key: "profile", label: "Profile (optional)", kind: "text", placeholder: "driving-car" },
    ],
  },
  spend_csv: {
    credential: null,
    fields: [],
    noForm: "Nothing to connect: upload the file on Marketing, Spend.",
  },
  google_ads: {
    credential: OWN_TOKEN,
    credentialSecret: "Refresh token",
    signIn: "Google",
    fields: [
      { key: "customerId", label: "Customer id", kind: "text", placeholder: "123-456-7890",
        hint: "The ten digits at the top of the Google Ads screen." },
      { key: "loginCustomerId", label: "Manager account id (optional)", kind: "text",
        hint: "Only when the account is reached through a manager account." },
      { key: "developerTokenRef", label: "Developer token, as the name of the secret holding it", kind: "secret_name", secretLabel: "Developer token",
        placeholder: "GOOGLE_ADS_DEVELOPER_TOKEN", hint: "An application to Google from a manager account. Until it is approved it works on test accounts only." },
      OAUTH_CLIENT,
      { key: "conversionActionId", label: "Conversion action id for booked jobs", kind: "text",
        hint: "An import conversion action in the Ads account. Without one, no jobs are sent." },
      PERSONAL_DATA,
      SEND_CONVERSIONS,
    ],
  },
  google_lsa: {
    credential: OWN_TOKEN,
    credentialSecret: "Refresh token",
    signIn: "Google",
    fields: [
      { key: "customerId", label: "Local Services customer id", kind: "text", placeholder: "123-456-7890" },
      { key: "loginCustomerId", label: "Manager account id (optional)", kind: "text" },
      { key: "developerTokenRef", label: "Developer token, as the name of the secret holding it", kind: "secret_name", secretLabel: "Developer token",
        placeholder: "GOOGLE_ADS_DEVELOPER_TOKEN" },
      OAUTH_CLIENT,
    ],
  },
  meta_ads: {
    credential: "A system user token kept in your own secret store, as its name (leave empty and sign in below instead)",
    credentialSecret: "System user token",
    signIn: "Meta",
    fields: [
      { key: "adAccountId", label: "Ad account id", kind: "text", placeholder: "act_1234567890" },
      { key: "pixelId", label: "Pixel id the Conversions API sends to", kind: "text" },
      { ...OAUTH_CLIENT, label: "Meta app, as the name of the secret holding its id and secret as clientId and clientSecret", placeholder: "META_OAUTH_CLIENT" },
      PERSONAL_DATA,
      SEND_CONVERSIONS,
      { key: "testEventCode", label: "Test event code (optional)", kind: "text",
        hint: "From Events Manager, to watch events arrive there before trusting them. Remove it when you have." },
    ],
  },
  ga4: {
    credential: "Measurement Protocol API secret, as the name of the secret holding it",
    credentialSecret: "Measurement Protocol API secret",
    fields: [
      { key: "measurementId", label: "Measurement id of the website's data stream", kind: "text", placeholder: "G-XXXXXXX" },
      { ...PERSONAL_DATA, hint: "Only decides what Google Analytics is told about consent. No email or phone is ever sent to it." },
      SEND_CONVERSIONS,
    ],
  },
  google_business_profile: {
    credential: null,
    signIn: "Google",
    fields: [
      { key: "accountId", label: "Account id", kind: "text", placeholder: "accounts/1234567890" },
      { key: "locationId", label: "Location id", kind: "text", placeholder: "locations/9876543210" },
      { key: "platform", label: "Review site name in your review policy (optional)", kind: "text", placeholder: "google",
        hint: "The platform key the reviews are recorded under. Leave empty for google." },
      OAUTH_CLIENT,
    ],
  },
  bing_ads: {
    credential: "A refresh token kept in your own secret store, as its name (leave empty and sign in below instead)",
    credentialSecret: "Refresh token",
    signIn: "Microsoft",
    fields: [
      { key: "customerId", label: "Customer id", kind: "text", hint: "From the top of the Microsoft Advertising screen, or the cid in its address." },
      { key: "accountId", label: "Account id", kind: "text", hint: "The account the campaigns are in: the aid in the address." },
      { key: "developerTokenRef", label: "Developer token, as the name of the secret holding it", kind: "secret_name", secretLabel: "Developer token",
        placeholder: "MICROSOFT_ADS_DEVELOPER_TOKEN", hint: "From the Microsoft Advertising Developer Portal." },
      { ...OAUTH_CLIENT, label: "App registered in Microsoft Entra, as the name of the secret holding clientId and clientSecret as one JSON value", placeholder: "MICROSOFT_OAUTH_CLIENT" },
    ],
  },
  meta_lead_ads: {
    credential: "A Page access token kept in your own secret store, as its name (leave empty and sign in below instead)",
    credentialSecret: "Page access token",
    signIn: "Meta",
    fields: [
      { key: "pageId", label: "Facebook Page id", kind: "text", hint: "The Page your instant forms run on, from its About section." },
      { ...OAUTH_CLIENT, label: "Meta app, as the name of the secret holding its id and secret as clientId and clientSecret", placeholder: "META_OAUTH_CLIENT",
        hint: "The same app's secret signs every lead Meta posts, which is how a post is known to be Meta's." },
    ],
  },
  search_console: {
    credential: OWN_TOKEN,
    credentialSecret: "Refresh token",
    signIn: "Google",
    fields: [
      { key: "siteUrl", label: "Search Console property", kind: "text", placeholder: "sc-domain:yourcompany.com",
        hint: "Exactly as Search Console names it: sc-domain: and the domain, or the https address of a URL property." },
      OAUTH_CLIENT,
    ],
  },
  ga4_data: {
    credential: OWN_TOKEN,
    credentialSecret: "Refresh token",
    signIn: "Google",
    fields: [
      { key: "propertyId", label: "Property id", kind: "text", placeholder: "123456789",
        hint: "In Analytics, Admin, Property details. Not the G- measurement id." },
      OAUTH_CLIENT,
    ],
  },
  lob: {
    credential: "Lob secret API key, as the name of the secret holding it",
    credentialSecret: "Lob secret API key",
    fields: [],
  },
  angi: { credential: null, fields: [], noForm: "Set up on Marketing, Lead offers, Lead sources, where its address and password are made." },
  thumbtack: { credential: null, fields: [], noForm: "Set up on Marketing, Lead offers, Lead sources, where its address and password are made." },
  yelp: { credential: null, fields: [], noForm: "Set up on Marketing, Lead offers, Lead sources, where its address is made." },
  nextdoor: { credential: null, fields: [], noForm: "Nothing to connect: forward Nextdoor's emails to the lead inbox address on Marketing, Lead offers, Lead sources." },
  lead_email: { credential: null, fields: [], noForm: "The address is on Marketing, Lead offers, Lead sources." },
  ics_feed: {
    credential: null,
    fields: [],
    noForm: "Nothing to connect: each technician's feed is minted on its own and the URL is shown once.",
  },
};

/**
 * Turn a submitted form into settings, sending only what was filled in.
 *
 * Blank means "leave it as it is", because the screen never shows a stored
 * value back and an empty box is not a decision to clear one.
 */
export function settingsFrom(form: ProviderForm, data: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of form.fields) {
    const raw = String(data.get(`setting:${field.key}`) ?? "").trim();
    if (raw === "") continue;
    if (field.kind === "yesno") {
      out[field.key] = raw === "yes";
    } else if (field.kind === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) out[field.key] = n;
    } else if (field.kind === "list") {
      out[field.key] = raw.split(",").map((part) => part.trim()).filter(Boolean);
    } else {
      out[field.key] = raw;
    }
  }
  return out;
}
