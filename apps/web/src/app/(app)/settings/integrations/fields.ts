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
export type FieldKind = "text" | "secret_name" | "number" | "select" | "list";

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
}

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
    if (field.kind === "number") {
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
