import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectors } from "@opentradesos/core";

/**
 * EVERY SETTING AN ADAPTER READS IS DECLARED
 *
 * `connectors.CONNECTOR_SETTINGS` in core is what a connect call is checked
 * against, and core's own test fails on any declared key that looks like it
 * carries a secret. Both are worthless if an adapter reads a key that is not
 * declared, because then the declaration describes a different adapter. So
 * this reads each adapter's source for the settings it touches and fails on
 * any it does not declare: an adapter that went back to reading
 * `settings.webhookSecret` fails here before it ships.
 */
const SRC = join(import.meta.dirname, "../src");

const ADAPTERS: Record<string, string[]> = {
  stripe: ["payments/stripe.ts"],
  quickbooks: ["accounting/quickbooks.ts"],
  xero: ["accounting/xero.ts"],
  twilio: ["comms/twilio.ts", "voice/twilio.ts"],
  justcall: ["comms/justcall.ts"],
  resend: ["email/resend.ts"],
  smtp: ["email/smtp.ts"],
  anthropic: ["ai/anthropic.ts"],
  openai: ["ai/openai.ts"],
  google: ["ai/google.ts"],
  callrail: ["call-tracking/callrail.ts"],
  nominatim: ["maps/nominatim.ts"],
  mapbox: ["maps/mapbox.ts"],
  whisper: ["voice/whisper.ts"],
  osrm: ["routing/osrm.ts"],
  mapbox_directions: ["routing/mapbox.ts"],
  openrouteservice: ["routing/openrouteservice.ts"],
  wisetack: ["financing/wisetack.ts"],
  lob: ["direct-mail/lob.ts"],
  angi: ["marketplaces/angi.ts"],
  thumbtack: ["marketplaces/thumbtack.ts"],
  yelp: ["marketplaces/yelp.ts"],
  ga4: ["ads/ga4.ts"],
  ga4_data: ["ads/ga4-data.ts"],
  meta_ads: ["ads/meta-ads.ts"],
  meta_lead_ads: ["ads/meta-lead-ads.ts"],
  google_ads: ["ads/google-ads.ts"],
  search_console: ["ads/search-console.ts"],
  bing_ads: ["ads/microsoft-ads.ts"],
  google_business_profile: ["ads/google-business-profile.ts"],
  facebook_page: ["ads/facebook-page.ts"],
};

function keysRead(file: string): Set<string> {
  const source = readFileSync(join(SRC, file), "utf8");
  const keys = new Set<string>();
  for (const m of source.matchAll(/\b(?:settings|config)\??\.(\w+)/g)) keys.add(m[1]!);
  for (const m of source.matchAll(/\b(?:settings|config)\[\s*"(\w+)"\s*\]/g)) keys.add(m[1]!);
  // The ad platforms and marketplaces read through a helper.
  for (const m of source.matchAll(/\btextSetting\(\s*[\w.]+,\s*"(\w+)"\s*\)/g)) keys.add(m[1]!);
  return keys;
}

describe("adapter settings", () => {
  it("reads nothing from settings that the provider does not declare", () => {
    const undeclared: string[] = [];
    for (const [provider, files] of Object.entries(ADAPTERS)) {
      const declared = connectors.CONNECTOR_SETTINGS[provider] ?? {};
      for (const file of files) {
        for (const key of keysRead(file)) {
          if (!declared[key]) undeclared.push(`${provider}: ${file} reads settings.${key}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("finds the reads it is looking for, so it cannot pass by matching nothing", () => {
    expect(keysRead("email/smtp.ts").has("host")).toBe(true);
    expect(keysRead("payments/stripe.ts").has("publishableKey")).toBe(true);
  });
});
