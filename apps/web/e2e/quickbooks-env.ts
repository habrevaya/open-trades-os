/**
 * The QuickBooks credential the browser suite starts the server with, under
 * the name the accounting spec connects QuickBooks with.
 *
 * Not a credential at all. The adapter sends the client id and secret to
 * whatever its `tokenUrl` points at and the refresh token in the body, and in
 * the suite that is the fake in ./quickbooks.ts. Shared between
 * playwright.config.ts (through ./stripe-env.ts) and the spec so the two
 * cannot drift.
 */
export const E2E_QUICKBOOKS_ENV = {
  E2E_QUICKBOOKS_CREDENTIAL: JSON.stringify({
    refreshToken: "e2e-fake-quickbooks-refresh-not-a-secret",
    clientId: "e2e-fake-quickbooks-client",
    clientSecret: "e2e-fake-quickbooks-client-value-not-a-secret",
  }),
} as const;
