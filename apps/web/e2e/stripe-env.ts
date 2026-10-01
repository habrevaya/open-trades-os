/**
 * The two Stripe variables .env.example names, as the browser suite starts
 * the server with them.
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
