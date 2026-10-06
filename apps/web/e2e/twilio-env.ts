/**
 * The secret NAME the browser suite points its Twilio connection at, and the
 * value the server is started with under it.
 *
 * Not a key: nothing here reaches Twilio. The voice adapter is pointed at a
 * local fake through its `baseUrl` setting, and the suite signs the carrier's
 * webhooks with this value the way Twilio signs them with an auth token.
 * Shared between playwright.config.ts and the spec so the two cannot drift.
 */
export const E2E_TWILIO_ENV = {
  E2E_TWILIO_TOKEN: "e2e-fake-twilio-auth-token-not-a-secret",
} as const;
