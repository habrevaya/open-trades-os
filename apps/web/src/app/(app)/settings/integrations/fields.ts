/**
 * What each provider needs typed in, as fields rather than a JSON box.
 *
 * Read off the adapters, not invented: every key below is one an adapter or
 * service actually reads from `integration_connection.settings`, and a key
 * nobody reads is a field somebody fills in and believes did something.
 *
 * `credential` is the NAME of a secret in the deployment's secret store,
 * never its value. The one exception is Resend's webhook secret, which its
 * adapter reads from the settings themselves; it is a password field and is
 * never shown back.
 */
export type FieldKind = "text" | "secret" | "number" | "select" | "list";

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  options?: readonly string[];
  hint?: string;
}

export interface ProviderForm {
  /** Label for the secret-name field, or null when the provider takes none. */
  credential: string | null;
  fields: readonly Field[];
  /** Connected through a dedicated service rather than the generic one. */
  via?: "ai" | "call_tracking";
  /** No form at all, with the reason shown instead. */
  noForm?: string;
}

export const FORMS: Record<string, ProviderForm> = {
  stripe: {
    credential: "Restricted secret key, as the name of the secret holding it",
    fields: [
      { key: "publishableKey", label: "Publishable key", kind: "text", placeholder: "pk_live_…",
        hint: "Sent to the customer's browser to show the card form. Without it the invoice page cannot take a card." },
      { key: "webhookSecretRef", label: "Webhook signing secret, as a secret name", kind: "text",
        hint: "Without it cards are taken and no payment is ever recorded." },
    ],
  },
  quickbooks: {
    credential: "Name of the secret holding refreshToken, clientId and clientSecret as one JSON value",
    fields: [{ key: "realmId", label: "Company id (realm id)", kind: "text" }],
  },
  xero: {
    credential: "Name of the secret holding refreshToken, clientId and clientSecret as one JSON value",
    fields: [{ key: "tenantId", label: "Organisation id (tenant id)", kind: "text" }],
  },
  twilio: {
    credential: "Auth token, as the name of the secret holding it",
    fields: [
      { key: "accountSid", label: "Account SID", kind: "text", placeholder: "AC…" },
      { key: "messagingServiceSid", label: "Messaging service SID (optional)", kind: "text", placeholder: "MG…",
        hint: "Without it texts go from the number on each message." },
    ],
  },
  justcall: {
    credential: "Name of the secret holding key:secret",
    fields: [
      { key: "webhookUrl", label: "The webhook URL you entered in JustCall", kind: "text",
        hint: "Compared against what each signed webhook claims, so it must match exactly." },
    ],
  },
  resend: {
    credential: "API key, as the name of the secret holding it",
    fields: [
      { key: "fromAddress", label: "Send from", kind: "text", placeholder: "office@yourcompany.com" },
      { key: "fromName", label: "Sender name", kind: "text" },
      { key: "verifiedDomains", label: "Domains verified with Resend, comma separated", kind: "list" },
      { key: "webhookSecret", label: "Webhook signing secret", kind: "secret", placeholder: "whsec_…",
        hint: "Without it bounces and complaints are never heard." },
    ],
  },
  smtp: {
    credential: "Password, as the name of the secret holding it",
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
    fields: [{ key: "defaultModel", label: "Default model (optional)", kind: "text" }],
  },
  openai: {
    via: "ai",
    credential: "API key, as the name of the secret holding it",
    fields: [{ key: "defaultModel", label: "Default model", kind: "text" }],
  },
  google: {
    via: "ai",
    credential: "API key, as the name of the secret holding it",
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
