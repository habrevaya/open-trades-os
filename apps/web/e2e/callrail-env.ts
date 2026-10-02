/**
 * The two secret NAMES the browser suite points its CallRail connection at,
 * and the values the server is started with under them.
 *
 * A real connection's names are derived from its id, which the suite cannot
 * know before it connects, so the spec points the connection at these two the
 * way `pointStripeAt` points Stripe at the fake (e2e/stripe.ts). Neither is a
 * key: nothing here reaches CallRail, and the second is what the suite signs
 * its own webhook with. Shared between playwright.config.ts and the spec so
 * the two cannot drift.
 */
export const E2E_CALLRAIL_ENV = {
  E2E_CALLRAIL_KEY: "e2e-fake-callrail-api-key-not-a-secret",
  E2E_CALLRAIL_SIGNING: "e2e-fake-callrail-signing-value-not-a-secret",
} as const;
