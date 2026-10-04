import { defineConfig, devices, chromium } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { E2E_STRIPE_ENV } from "./e2e/stripe-env";
import { E2E_WISETACK_ENV } from "./e2e/wisetack-env";
import { E2E_CALLRAIL_ENV } from "./e2e/callrail-env";
import { E2E_TWILIO_ENV } from "./e2e/twilio-env";
import { E2E_ADS_ENV } from "./e2e/ads-env";
import { E2E_AI_ENV } from "./e2e/ai-env";
import { E2E_VOICE_RELAY_ENV } from "./e2e/voice-relay-env";

/**
 * THE BROWSER SUITE
 *
 * Render tests prove a screen draws and the HTTP smoke check proves the server
 * boots. Neither proves that a person can fill in a form, press the button and
 * have the thing they asked for happen, which is the only claim a contractor
 * cares about. This drives a real browser through real submits against a
 * production build and the seeded company.
 *
 *   pnpm build
 *   pnpm e2e
 *
 * `pnpm e2e` migrates and seeds the database in DATABASE_URL before it runs,
 * so point it at a database you do not mind being reseeded.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;

/**
 * Which chromium to launch.
 *
 * CI installs exactly the build this version of Playwright expects, and that
 * is used. A machine with a different build already on disk (a sandbox with
 * browsers baked in, a laptop that installed for another project) launches
 * the newest chromium it finds instead of failing on a revision mismatch,
 * because the suite tests the application, not the browser's build number.
 * CHROMIUM_PATH overrides both, the same variable scripts/screenshots.mjs
 * reads.
 */
function chromiumPath(): string | undefined {
  if (process.env["CHROMIUM_PATH"]) return process.env["CHROMIUM_PATH"];
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // Not installed for this revision; look for another below.
  }
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root || !existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    for (const binary of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const candidate = join(root, build, binary);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const executablePath = chromiumPath();

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  /**
   * One worker. Every spec writes to the same seeded company, and two specs
   * racing to close the same pay period or book the same technician would
   * fail for reasons that are about the suite rather than the product.
   */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  // No retries: a test that passes on its second go is a bug report.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    // The production server over the production build, not `next dev`: the
    // suite is meant to see what a deployment serves.
    command: `pnpm exec next start -p ${PORT}`,
    url: `${BASE}/login`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    /**
     * Configured the way .env.example says to, and no further. The links a
     * customer is sent are built from PUBLIC_URL, and setting anything more
     * here than a deployment would is how a suite passes against a setup
     * nobody runs. The two Stripe variables are the ones .env.example names,
     * holding values that are not keys: the suite points the company's
     * Stripe connection at a local fake and signs its own webhook with the
     * second (e2e/stripe.ts). The CallRail pair is the same arrangement for
     * call tracking (e2e/callrail-env.ts): names the spec points the
     * connection at, holding values that are not keys. The Twilio token is
     * the same again for the voice webhooks (e2e/twilio-env.ts). The ad
     * platforms' sealing key and secret names are the same arrangement again
     * (e2e/ads-env.ts), for a local fake of Google, and so is the model key
     * for the AI agents (e2e/ai-env.ts), and for the lender behind customer
     * financing (e2e/wisetack-env.ts). The voice relay's address is the one
     * .env.example names for the phone assistant, pointed at a relay the
     * assistant's spec starts itself (e2e/voice-relay-env.ts).
     */
    env: {
      PUBLIC_URL: BASE, ...E2E_STRIPE_ENV, ...E2E_CALLRAIL_ENV, ...E2E_TWILIO_ENV, ...E2E_ADS_ENV, ...E2E_AI_ENV,
      ...E2E_WISETACK_ENV, ...E2E_VOICE_RELAY_ENV,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
});
