/**
 * WHAT A CONNECTION'S `settings` MAY HOLD, PER PROVIDER
 *
 * `integration_connection.settings` is an ordinary jsonb column. It is in
 * every backup, every replica, every `select *` a support engineer runs and
 * every row an export hands to a migration tool. A secret put there is a
 * secret the company no longer controls, which is why `credentialRef` exists
 * and holds a NAME in the deployment's secret store rather than a value.
 *
 * That rule was written down and not enforced: the column took any key, so a
 * Resend webhook signing secret went straight into it from a settings form.
 * This is the enforcement. Every key a provider's adapter or service reads is
 * declared here with what kind of value it is, a connect call carrying a key
 * that is not declared is refused, and a key whose value is a secret is
 * declared as `secret_name`: it holds the name of a second secret in the
 * store, resolved the same way `credentialRef` is, never the value.
 *
 * A test walks this table and fails on any key whose name looks like it
 * carries a secret and is not a `secret_name`, so the next adapter cannot put
 * one back without somebody writing down why in that test's allowlist.
 */

export type SettingKind =
  | "text"
  | "number"
  | "boolean"
  /** An array of strings. */
  | "list"
  /** A nested object, such as a model's price table. */
  | "record"
  /**
   * The NAME of a secret in the deployment's secret store. Resolved through
   * the same reader as `credentialRef`. By convention the key ends in `Ref`.
   */
  | "secret_name";

export interface SettingSpec {
  kind: SettingKind;
  /**
   * Written by the product rather than typed by an operator, such as the
   * webhook token minted on first connect. Still accepted on the API for an
   * install that set one by hand before the product minted them.
   */
  system?: true;
  /** Exists so a test can point the adapter at a fake server. */
  testOnly?: true;
}

const BASE_URL: SettingSpec = { kind: "text", testOnly: true };
const WEBHOOK_TOKEN: SettingSpec = { kind: "text", system: true };

/**
 * Every key each built provider reads, and nothing else.
 *
 * The lead webhook and the spend file are absent because they never pass
 * operator settings through `integration_connection`: lead webhooks keep
 * their own table and a spend file is parsed on upload. A provider absent
 * from here takes no settings at all.
 */
export const CONNECTOR_SETTINGS: Readonly<Record<string, Readonly<Record<string, SettingSpec>>>> = {
  stripe: {
    /** Public by design: Stripe sends it to the customer's browser. */
    publishableKey: { kind: "text" },
    webhookSecretRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
  },
  quickbooks: {
    realmId: { kind: "text" },
    minorVersion: { kind: "text" },
    baseUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  xero: {
    tenantId: { kind: "text" },
    baseUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  twilio: {
    accountSid: { kind: "text" },
    messagingServiceSid: { kind: "text" },
    webhookToken: WEBHOOK_TOKEN,
    baseUrl: BASE_URL,
  },
  justcall: {
    webhookUrl: { kind: "text" },
    webhookToken: WEBHOOK_TOKEN,
    baseUrl: BASE_URL,
  },
  resend: {
    fromAddress: { kind: "text" },
    /**
     * The domain Resend receives for, which reply addresses are built on:
     * `reply+TOKEN@` this. Absent, emails go out with no reply address of
     * this product's own and a reply lands wherever the From address does.
     */
    replyDomain: { kind: "text" },
    fromName: { kind: "text" },
    verifiedDomains: { kind: "list" },
    webhookSecretRef: { kind: "secret_name" },
    toleranceSeconds: { kind: "number" },
    webhookToken: WEBHOOK_TOKEN,
    baseUrl: BASE_URL,
  },
  smtp: {
    host: { kind: "text" },
    port: { kind: "number" },
    security: { kind: "text" },
    username: { kind: "text" },
    fromAddress: { kind: "text" },
    fromName: { kind: "text" },
    verifiedDomains: { kind: "list" },
    envelopeFrom: { kind: "text" },
    allowUntrustedCertificate: { kind: "boolean" },
    allowPlaintextAuth: { kind: "boolean" },
    connectionTimeoutMs: { kind: "number" },
    webhookToken: WEBHOOK_TOKEN,
  },
  anthropic: { defaultModel: { kind: "text" }, rates: { kind: "record" }, baseUrl: BASE_URL },
  openai: {
    defaultModel: { kind: "text" }, organization: { kind: "text" },
    rates: { kind: "record" }, baseUrl: BASE_URL,
  },
  google: { defaultModel: { kind: "text" }, rates: { kind: "record" }, baseUrl: BASE_URL },
  nominatim: {
    /** A self hosted server, or the public one when absent. */
    endpoint: { kind: "text" },
    /** Who the public server's operators can write to, as their usage policy asks. */
    contactEmail: { kind: "text" },
    /** Slower than the floor is allowed; faster than one a second against the public server is not. */
    minIntervalMs: { kind: "number" },
    countryCodes: { kind: "list" },
  },
  mapbox: {
    countryCodes: { kind: "list" },
    minIntervalMs: { kind: "number" },
    baseUrl: BASE_URL,
  },
  /**
   * Consumer financing. The plans are the merchant agreement's, typed in as
   * "months@APR", because they are what "as low as" is worked out from and
   * Wisetack is not asked for them per customer.
   */
  wisetack: {
    merchantId: { kind: "text" },
    webhookSecretRef: { kind: "secret_name" },
    plans: { kind: "list" },
    minAmount: { kind: "text" },
    maxAmount: { kind: "text" },
    /** Off hides the monthly figure everywhere and keeps the apply link. On by default once connected. */
    showMonthly: { kind: "boolean" },
  },
  osrm: {
    /** The address of the company's own OSRM server. Required: there is no public default. */
    endpoint: { kind: "text" },
    /** The OSRM profile, `driving` unless the server was built with another. */
    profile: { kind: "text" },
  },
  mapbox_directions: {
    /** `driving`, or `driving-traffic` for live traffic at ten points a request. */
    profile: { kind: "text" },
    baseUrl: BASE_URL,
  },
  openrouteservice: {
    /** A self hosted server; the hosted service when absent. */
    endpoint: { kind: "text" },
    /** `driving-car` unless a truck profile suits the vans better. */
    profile: { kind: "text" },
    baseUrl: BASE_URL,
  },
  whisper: {
    /** Where the API lives: OpenAI's, or a Whisper server the company runs itself. */
    endpoint: { kind: "text" },
    model: { kind: "text" },
    language: { kind: "text" },
    baseUrl: BASE_URL,
  },
  /**
   * The ad platforms. Each names its OAuth client by secret name; the grant a
   * sign in hands back is sealed in `sealed_credential` and never appears
   * here. `authUrl` and `tokenUrl` exist so a test can send the sign in to a
   * fake.
   */
  google_ads: {
    customerId: { kind: "text" },
    loginCustomerId: { kind: "text" },
    conversionActionId: { kind: "text" },
    developerTokenRef: { kind: "secret_name" },
    oauthClientRef: { kind: "secret_name" },
    personalData: { kind: "text" },
    sendConversions: { kind: "boolean" },
    apiVersion: { kind: "text" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  google_lsa: {
    customerId: { kind: "text" },
    loginCustomerId: { kind: "text" },
    developerTokenRef: { kind: "secret_name" },
    oauthClientRef: { kind: "secret_name" },
    apiVersion: { kind: "text" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  meta_ads: {
    adAccountId: { kind: "text" },
    pixelId: { kind: "text" },
    oauthClientRef: { kind: "secret_name" },
    personalData: { kind: "text" },
    sendConversions: { kind: "boolean" },
    /** Meta's Events Manager test code, so a company can watch events arrive before trusting them. */
    testEventCode: { kind: "text" },
    apiVersion: { kind: "text" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  ga4: {
    measurementId: { kind: "text" },
    personalData: { kind: "text" },
    sendConversions: { kind: "boolean" },
    baseUrl: BASE_URL,
  },
  google_business_profile: {
    accountId: { kind: "text" },
    locationId: { kind: "text" },
    /** The review platform key reviews are recorded under, which the review policy names. */
    platform: { kind: "text" },
    oauthClientRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  /**
   * Microsoft Advertising. Two ids because Microsoft's API wants both the
   * customer (the manager) and the account the campaigns live in on every
   * request, in headers.
   */
  bing_ads: {
    customerId: { kind: "text" },
    accountId: { kind: "text" },
    developerTokenRef: { kind: "secret_name" },
    oauthClientRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  /** Meta's instant forms, read from one Page. */
  meta_lead_ads: {
    pageId: { kind: "text" },
    oauthClientRef: { kind: "secret_name" },
    apiVersion: { kind: "text" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  search_console: {
    /** The property as Search Console names it: `sc-domain:example.com` or `https://www.example.com/`. */
    siteUrl: { kind: "text" },
    oauthClientRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  ga4_data: {
    /** The property's number, not the G- measurement id, which is the data stream's. */
    propertyId: { kind: "text" },
    oauthClientRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
    authUrl: BASE_URL,
    tokenUrl: BASE_URL,
  },
  /**
   * The marketplaces' API connections. Each is made by the lead source setup
   * rather than by the generic connect form, and holds the business the
   * account is and the name of the token its API is spoken to with. The
   * password the platform posts with is the connection's credential.
   */
  angi: { baseUrl: BASE_URL },
  thumbtack: {
    businessId: { kind: "text" },
    apiTokenRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
  },
  yelp: {
    businessId: { kind: "text" },
    apiTokenRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
  },
  /** The mail house. The API key is the connection's credential. */
  lob: {
    baseUrl: BASE_URL,
  },
  callrail: {
    accountId: { kind: "text" },
    companyId: { kind: "text" },
    webhookToken: WEBHOOK_TOKEN,
    webhookSecretRef: { kind: "secret_name" },
    baseUrl: BASE_URL,
  },
};

/**
 * Settings keys that once held a secret's VALUE, and the key that now holds
 * its name. Refused on every write with the replacement named; read once on
 * an install that already has one, with a warning, so its webhooks do not go
 * quiet on upgrade.
 */
export const LEGACY_SECRET_SETTINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  resend: { webhookSecret: "webhookSecretRef" },
};

/**
 * Prefixes real secrets carry. A secret name that starts with one is almost
 * certainly the secret pasted into the name box, and storing it would put
 * exactly the value this file exists to keep out of the database into it.
 */
const SECRET_VALUE_PREFIXES = [
  "whsec_", "sk_live_", "sk_test_", "rk_live_", "rk_test_", "re_", "sk-ant-", "sk-proj-", "AIza",
];

export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim();
  if (SECRET_VALUE_PREFIXES.some((p) => v.startsWith(p))) return true;
  // A secret store name is an identifier or a path. Whitespace, or a long
  // run of mixed-case letters and digits with no separator in it, is a value.
  if (/\s/.test(v)) return true;
  return v.length >= 32 && /^[A-Za-z0-9+/=]+$/.test(v)
    && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v);
}

export type SettingsCheck = { ok: true } | { ok: false; reason: string };

function kindMatches(kind: SettingKind, value: unknown): boolean {
  switch (kind) {
    case "text":
    case "secret_name": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "list": return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "record": return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * Whether these settings may be stored for this provider.
 *
 * Refuses an undeclared key (a key nothing reads is a field somebody fills in
 * and believes did something, and an open column is how a secret got in), a
 * legacy secret key with its replacement named, a value of the wrong kind,
 * and a secret name that is plainly a secret.
 */
export function checkConnectorSettings(provider: string, settings: Record<string, unknown>): SettingsCheck {
  const declared = CONNECTOR_SETTINGS[provider] ?? {};
  const legacy = LEGACY_SECRET_SETTINGS[provider] ?? {};
  for (const [key, value] of Object.entries(settings)) {
    const replacement = legacy[key];
    if (replacement) {
      return {
        ok: false,
        reason:
          `"${key}" would put a secret in the database, which this product does not do. `
          + `Put the secret in your deployment's secret store and send its name as "${replacement}".`,
      };
    }
    const spec = declared[key];
    if (!spec) {
      const known = Object.keys(declared).filter((k) => !declared[k]!.testOnly && !declared[k]!.system);
      return {
        ok: false,
        reason:
          `"${key}" is not a setting ${provider} reads, so storing it would change nothing. `
          + (known.length ? `It reads: ${known.join(", ")}.` : `It takes no settings.`),
      };
    }
    if (!kindMatches(spec.kind, value)) {
      return { ok: false, reason: `"${key}" should be ${spec.kind === "list" ? "a list of text" : `a ${spec.kind}`}.` };
    }
    if (spec.kind === "secret_name" && looksLikeSecretValue(value as string)) {
      return {
        ok: false,
        reason:
          `"${key}" takes the NAME a secret is kept under in your secret store, and that looks like the secret `
          + `itself. Nothing was saved. Put the value in the store and send the name.`,
      };
    }
  }
  return { ok: true };
}
