import { describe, it, expect } from "vitest";
import { connectors } from "@opentradesos/core";
import { FORMS, settingsFrom } from "../src/app/(app)/settings/integrations/fields";

/**
 * EVERY BUILT INTEGRATION CAN BE CONNECTED FROM A SCREEN
 *
 * Each one's setup note used to end "through the API". The test is that
 * every connector the catalogue calls built, outside marketing (which has
 * its own screen), has a form on Settings → Integrations or a stated reason
 * it needs none, so the next adapter added cannot quietly go back to being
 * API-only.
 */
const MARKETING = new Set(["ads", "lead_source", "analytics", "reviews"]);

describe("the integrations screen", () => {
  it("has a form, or a reason for none, for every built connector", () => {
    const built = connectors.CONNECTORS
      .filter((c) => c.state === "built" && !MARKETING.has(c.capability));
    expect(built.length).toBeGreaterThan(5);
    const missing = built.filter((c) => !FORMS[c.key]).map((c) => c.key);
    expect(missing).toEqual([]);
  });

  it("offers no form for anything the catalogue does not know", () => {
    const known = new Set(connectors.CONNECTORS.map((c) => c.key));
    expect(Object.keys(FORMS).filter((key) => !known.has(key))).toEqual([]);
  });

  it("sends only what was typed, so a blank box keeps what is stored", () => {
    const data = new FormData();
    data.set("setting:host", " smtp.example.com ");
    data.set("setting:port", "587");
    data.set("setting:username", "");
    data.set("setting:verifiedDomains", "example.com, mail.example.com,");
    expect(settingsFrom(FORMS.smtp!, data)).toEqual({
      host: "smtp.example.com", port: 587, verifiedDomains: ["example.com", "mail.example.com"],
    });
  });
});
