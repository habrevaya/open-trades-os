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

  it("asks only for settings the provider reads, and only for secret names", () => {
    /**
     * Resend's webhook signing secret had a password box here and went into
     * the database. A field is now a declared setting or it is not offered,
     * and a declared secret is a `secret_name` field: the name it is kept
     * under in the store. There is no kind of field for a secret's value.
     */
    const wrong: string[] = [];
    for (const [provider, form] of Object.entries(FORMS)) {
      const declared = connectors.CONNECTOR_SETTINGS[provider] ?? {};
      for (const field of form.fields) {
        const spec = declared[field.key];
        if (!spec) wrong.push(`${provider}.${field.key} is not a setting ${provider} reads`);
        else if ((spec.kind === "secret_name") !== (field.kind === "secret_name")) {
          wrong.push(`${provider}.${field.key} is ${spec.kind} and the form treats it as ${field.kind}`);
        }
        if (/secret|password/i.test(field.key) && field.kind !== "secret_name") {
          wrong.push(`${provider}.${field.key} takes a secret's value`);
        }
      }
    }
    expect(wrong).toEqual([]);
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
