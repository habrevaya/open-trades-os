import { createHash } from "node:crypto";
import { E2E_CALLRAIL_ENV } from "./callrail-env";
import { E2E_TWILIO_ENV } from "./twilio-env";
import { E2E_ADS_ENV } from "./ads-env";
import { E2E_AI_ENV } from "./ai-env";
import { E2E_WISETACK_ENV } from "./wisetack-env";
import { E2E_VOICE_RELAY_ENV } from "./voice-relay-env";
import { E2E_MARKETING_ENV } from "./marketing-env";

/**
 * The two Stripe secrets the browser suite starts the server with, and the
 * names the suite connects Stripe under.
 *
 * Neither is a key. The adapter only forwards the first to whatever its
 * `baseUrl` points at, which in the suite is the fake in ./stripe.ts, and
 * the second is what the suite signs its webhook with. Shared between
 * playwright.config.ts and the specs so the two cannot drift.
 */
export const E2E_STRIPE_ENV = {
  STRIPE_SECRET_KEY: "e2e-fake-stripe-api-key-not-a-secret",
  STRIPE_WEBHOOK_SECRET: "e2e-fake-stripe-signing-value-not-a-secret",
} as const;

/**
 * The seeded company's id, derived exactly as packages/api/src/seed derives
 * it. Copied rather than imported because importing the seed runs it.
 */
function seedId(name: string, namespace: "seed" | "demo" = "seed"): string {
  const h = createHash("sha256").update(`opentradesos:${namespace}:${name}`).digest("hex");
  return [
    h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

export const E2E_ORGANIZATION_ID = seedId("org");

/**
 * The public demo's company, which global setup creates with `demo:seed`
 * beside the seeded one, and which the server is told about the way a
 * deployment offering the demo is (docs/self-hosting/demo.md).
 */
export const E2E_DEMO_ORGANIZATION_ID = seedId("org", "demo");

/**
 * `connectors.environmentVariableFor` in core, spelled out because this file
 * is loaded by playwright.config.ts before anything else is built. If the
 * two disagree the Stripe spec fails on its first card payment, which is the
 * check.
 */
const variableFor = (organizationId: string, name: string) =>
  `OTS_SECRET__${organizationId.replace(/-/g, "").toUpperCase()}__${name}`;

/**
 * What the server is started with, configured the way docs/self-hosting
 * says a single company's install is.
 *
 * The secrets go under the seeded company's own prefix, because the server
 * reads nothing else: the suite connects Stripe under the names
 * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, and the store looks for
 * `OTS_SECRET__<company>__STRIPE_SECRET_KEY`. The CallRail and Twilio names
 * (./callrail-env.ts, ./twilio-env.ts) go under the same prefix.
 *
 * ALLOW_PROVIDER_BASE_URL is the one setting no real deployment has. It lets
 * the suite point the connection at the local fake Stripe. A deployment with
 * it set lets any integration admin send the server's credentials to a host
 * of their choosing.
 */
/** The ad platforms' secrets without the sealing key, which is the deployment's. */
function secretsOnly(env: Record<string, string>): Record<string, string> {
  const { CREDENTIAL_SEALING_KEY: _sealing, ...secrets } = env;
  return secrets;
}

export const E2E_SERVER_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries({
    ...E2E_STRIPE_ENV, ...E2E_CALLRAIL_ENV, ...E2E_TWILIO_ENV, ...secretsOnly(E2E_ADS_ENV), ...E2E_AI_ENV,
    ...E2E_WISETACK_ENV, ...E2E_MARKETING_ENV,
  }).map(([name, value]) => [
    variableFor(E2E_ORGANIZATION_ID, name), value,
  ])),
  // The deployment's own settings, not a company's secrets.
  CREDENTIAL_SEALING_KEY: E2E_ADS_ENV.CREDENTIAL_SEALING_KEY,
  ...E2E_VOICE_RELAY_ENV,
  ALLOW_PROVIDER_BASE_URL: "1",
  DEMO_ORGANIZATION_ID: E2E_DEMO_ORGANIZATION_ID,
};
