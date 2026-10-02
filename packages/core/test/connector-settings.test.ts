import { describe, it, expect } from "vitest";
import { connectors } from "../src/index";

/**
 * NO SECRET LIVES IN A CONNECTION'S SETTINGS
 *
 * `integration_connection.settings` is a plain jsonb column. Resend's webhook
 * signing secret was stored in it, from a box on the settings screen, while
 * every other secret in the product was a name in the deployment's store.
 * The rule was written down and nothing checked it.
 *
 * This walks every provider's declared settings and fails on a key whose
 * name says it carries a secret unless it is a `secret_name` (it holds the
 * NAME of a secret and ends in `Ref`) or is listed below with the reason it
 * is not a secret in the sense that matters.
 */
const SECRET_LOOKING = /secret|token|key|password|signing/i;

const NOT_SECRETS: Record<string, string> = {
  /**
   * The webhook path token. It is in the URL a carrier or mail provider
   * calls, and it is what identifies the tenant, so it has to be found by a
   * lookup before any tenant is known: a hash in the store would need the
   * store to be searchable. It is not what authenticates the request; every
   * provider must still verify a signature made with a secret that IS in the
   * store, so a leaked token buys an attacker a URL that refuses them.
   * docs/self-hosting/messaging.md, "The token in the path is what
   * identifies the tenant", and the same reasoning on
   * `lead_source_connector.webhook_token` in the schema.
   */
  webhookToken: "routing token in the webhook URL; requests are still verified by a stored-secret signature",
  /**
   * Stripe's publishable key is public by design: Stripe.js sends it to the
   * customer's browser on every invoice page that takes a card.
   */
  publishableKey: "public by design, sent to every customer's browser",
  /** The address of Intuit's or Xero's OAuth token endpoint, overridden only by tests. A URL, not a token. */
  tokenUrl: "the OAuth token endpoint's address, not a token",
};

describe("connection settings", () => {
  it("declares no key that carries a secret's value", () => {
    const offenders: string[] = [];
    for (const [provider, settings] of Object.entries(connectors.CONNECTOR_SETTINGS)) {
      for (const [key, spec] of Object.entries(settings)) {
        if (!SECRET_LOOKING.test(key)) continue;
        if (spec.kind === "secret_name") continue;
        if (NOT_SECRETS[key]) continue;
        offenders.push(`${provider}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names every secret-name key with the Ref suffix, so its meaning is in its name", () => {
    const misnamed = Object.entries(connectors.CONNECTOR_SETTINGS).flatMap(([provider, settings]) =>
      Object.entries(settings)
        .filter(([key, spec]) => spec.kind === "secret_name" && !key.endsWith("Ref"))
        .map(([key]) => `${provider}.${key}`));
    expect(misnamed).toEqual([]);
  });

  it("covers every built connector outside marketing, so a new one cannot skip the check", () => {
    const marketing = new Set(["ads", "lead_source", "analytics", "reviews"]);
    const missing = connectors.builtConnectors()
      .filter((c) => !marketing.has(c.capability) && c.key !== "ics_feed")
      .filter((c) => !connectors.CONNECTOR_SETTINGS[c.key])
      .map((c) => c.key);
    expect(missing).toEqual([]);
  });

  it("refuses a legacy secret key with the key that replaced it", () => {
    const check = connectors.checkConnectorSettings("resend", { webhookSecret: "whsec_abc" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/webhookSecretRef/);
  });

  it("refuses a key nothing reads, a value of the wrong kind and a secret in a name's place", () => {
    expect(connectors.checkConnectorSettings("stripe", { secretKey: "x" }).ok).toBe(false);
    expect(connectors.checkConnectorSettings("smtp", { port: "587" }).ok).toBe(false);
    expect(connectors.checkConnectorSettings("stripe", { webhookSecretRef: "whsec_live" }).ok).toBe(false);
    expect(connectors.checkConnectorSettings("stripe", {
      webhookSecretRef: "STRIPE_WEBHOOK_SECRET", publishableKey: "pk_live_x",
    })).toEqual({ ok: true });
  });

  it("tells a secret's name from the secret", () => {
    for (const name of ["STRIPE_WEBHOOK_SECRET", "vault:kv/acme/resend", "acme.twilio.auth"]) {
      expect(connectors.looksLikeSecretValue(name), name).toBe(false);
    }
    for (const value of ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "sk_live_abc", "re_123_abc",
      "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z", "two words"]) {
      expect(connectors.looksLikeSecretValue(value), value).toBe(true);
    }
  });
});
