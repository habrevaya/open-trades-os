/**
 * What the browser suite starts the server with for the lead marketplaces and
 * the mail house.
 *
 * None of it is a key. The names are the ones the specs type on the screens;
 * the values are seen only by the local fakes in ./marketing-fakes.ts and by
 * the spec signing its own posts. Shared between playwright.config.ts and the
 * specs so the two cannot drift.
 */
export const E2E_MARKETING_ENV = {
  E2E_THUMBTACK_PASSWORD: "e2e-thumbtack-password-not-a-secret",
  E2E_THUMBTACK_TOKEN: "e2e-thumbtack-token-not-a-secret",
  E2E_LOB_KEY: "test_e2e_lob_key_not_a_secret",
} as const;
