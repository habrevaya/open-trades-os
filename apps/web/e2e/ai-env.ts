/**
 * The name the suite's model connection points its key at, and a value that
 * is not a key.
 *
 * The Anthropic adapter forwards it only to whatever its `baseUrl` points at,
 * which in the suite is the fake model in agents.spec.ts. Shared between
 * playwright.config.ts and the spec so the two cannot drift, the same
 * arrangement as the Stripe, CallRail and Twilio pairs.
 */
export const E2E_AI_ENV = {
  E2E_AI_KEY: "e2e-fake-model-api-key-not-a-secret",
} as const;
