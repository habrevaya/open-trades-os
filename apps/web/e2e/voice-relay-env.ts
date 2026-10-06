/**
 * Where the browser suite's voice relay listens, and the address the web app
 * is told to hand the carrier for it.
 *
 * The relay is started inside the spec (voice-agent.spec.ts) rather than as a
 * second web server, because the spec is what plays the carrier's part on the
 * other end of its WebSocket. One port above the app's own by a thousand, so
 * parallel suites on different E2E_PORTs do not collide. Shared between
 * playwright.config.ts and the spec so the two cannot drift.
 */
export const E2E_RELAY_PORT = Number(process.env["E2E_PORT"] ?? 3100) + 1000;

export const E2E_VOICE_RELAY_ENV = {
  VOICE_RELAY_URL: `ws://127.0.0.1:${E2E_RELAY_PORT}`,
} as const;
