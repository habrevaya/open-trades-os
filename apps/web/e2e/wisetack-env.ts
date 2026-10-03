/**
 * The two names the financing spec points the Wisetack connection at, as the
 * browser suite starts the server with them.
 *
 * Neither is a key. The adapter forwards the first to whatever its `baseUrl`
 * points at, which in the suite is the fake in ./wisetack.ts, and the second
 * is what the suite signs its webhook with. Shared between
 * playwright.config.ts and the spec so the two cannot drift.
 */
export const E2E_WISETACK_ENV = {
  E2E_WISETACK_TOKEN: "e2e-fake-wisetack-api-token-not-a-secret",
  E2E_WISETACK_SIGNING: "e2e-fake-wisetack-signing-value-not-a-secret",
} as const;
