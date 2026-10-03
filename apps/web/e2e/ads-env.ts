/**
 * What the browser suite starts the server with for the ad platforms.
 *
 * None of it is a key. The sealing key seals the fake Google's fake refresh
 * token and nothing else; the OAuth client and the developer token are names
 * the spec types on the settings screen, holding values only the local fake
 * in ./ads.ts ever sees. Shared between playwright.config.ts and the spec so
 * the two cannot drift.
 */
export const E2E_ADS_ENV = {
  CREDENTIAL_SEALING_KEY: Buffer.alloc(32, 9).toString("base64"),
  E2E_GOOGLE_OAUTH_CLIENT: JSON.stringify({ clientId: "e2e-client.apps.example", clientSecret: "e2e-not-a-secret" }),
  E2E_GOOGLE_ADS_DEVELOPER_TOKEN: "e2e-developer-token-not-a-secret",
} as const;
