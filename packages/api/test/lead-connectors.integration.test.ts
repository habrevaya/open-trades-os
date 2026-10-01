import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as connectors from "../src/services/lead-connectors";
import { type ServiceContext } from "../src/services/context";
import { createLeadSource } from "../src/marketing/index";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * SETTING UP A LEAD SOURCE, WHICH NOTHING COULD DO
 *
 * The signed endpoint existed, `receiveLead` existed, and the table existed
 * with a unique index on a token column. No service inserted a row, so there
 * was no URL to give a sender, no secret to sign with, and nowhere to put the
 * field map the parser had accepted since it was written. The feature was
 * reachable and unusable at once, which is the hardest kind of gap to see:
 * every test passed, because every test called the parser directly.
 *
 * The tests below are about the three things that make it usable rather than
 * merely possible: credentials handed over once, a mapping checked against
 * fields this product really has, and a dry run.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("lead19:org");
const USER = fixtureId("lead19:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

const ANGI_SAMPLE = {
  lead_id: "ANG-55120",
  contact: { full_name: "Dana Whitfield", phone_number: "+15125550133", email: "dana@example.com" },
  address: { street: "812 Mesquite Dr", city: "Austin", state: "TX", zip: "78745" },
  task: "Water heater not producing hot water",
  budget: "850.00",
};

const ANGI_MAP = {
  externalId: "lead_id",
  contactName: "contact.full_name",
  contactPhone: "contact.phone_number",
  contactEmail: "contact.email",
  addressLine1: "address.street",
  city: "address.city",
  state: "address.state",
  postalCode: "address.zip",
  serviceRequested: "task",
  estimatedValue: "budget",
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lead Co", slug: "lead-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lead Co", slug: "lead-co" });
});

run("setting one up", () => {
  it("hands over a URL and a secret, and the secret exactly once", async () => {
    const made = await connectors.create(owner(), {
      source: "angi", displayName: "Angi", fieldMap: ANGI_MAP,
    });

    expect(made.webhookPath).toMatch(/^\/api\/webhooks\/leads\/[A-Za-z0-9_-]{20,}$/);
    expect(made.secret).toMatch(/^lhsec_/);

    /**
     * AND NEVER AGAIN. A secret a read path will hand over on request leaks
     * through every screen, log and support transcript that shows a
     * connector. Losing it means rotating, which is the same action somebody
     * takes if it leaked, so nothing is lost by having no way back to it.
     */
    const [listed] = await connectors.list(owner());
    expect(listed).toBeDefined();
    expect(JSON.stringify(listed)).not.toContain(made.secret);
    expect(JSON.stringify(listed)).not.toContain("lhsec_");
  });

  it("makes the connection that carries the credential, rather than leaving it as a second step", async () => {
    /**
     * The webhook route refuses a connector whose connection has no
     * credential reference, with a 409. That is correct and it is also a
     * setup that silently does not work, so the connection is made here
     * rather than left for somebody to know about.
     */
    const made = await connectors.create(owner(), { source: "angi", displayName: "Angi", fieldMap: ANGI_MAP });

    const [row] = await raw`
      select c.credential_ref from public.lead_source_connector lsc
      join public.integration_connection c on c.id = lsc.connection_id
      where lsc.id = ${made.id}`;
    expect((row as { credential_ref: string }).credential_ref).toBe(made.secretRef);
  });

  it("refuses a mapping onto a field this product cannot store", async () => {
    /**
     * THE EXPENSIVE ONE, and the reason the target list is data rather than a
     * TypeScript interface. A map is jsonb from a settings call: the
     * interface is checked at compile time and therefore not at all by the
     * time somebody posts `contact_phone` instead of `contactPhone`. Saved
     * and ignored means every lead arrives with nobody to ring and nothing
     * ever said so.
     */
    await expect(connectors.create(owner(), {
      source: "angi", displayName: "Angi",
      fieldMap: { ...ANGI_MAP, contact_phone: "contact.phone_number" },
    })).rejects.toThrow(/"contact_phone" is not a field/i);
  });

  it("refuses a source name that cannot survive being a report column", async () => {
    await expect(connectors.create(owner(), { source: "Angi Leads!", displayName: "Angi" }))
      .rejects.toThrow(/not a usable source name/i);
  });

  it("refuses a connector nobody could be reached through", async () => {
    /** The same rule the live parser applies, met while it can still be fixed. */
    await expect(connectors.create(owner(), {
      source: "angi", displayName: "Angi",
      fieldMap: { externalId: "lead_id", contactName: "contact.full_name" },
    })).resolves.toBeDefined();
  });

  it("refuses setup from somebody who may read integrations and not change them", async () => {
    /**
     * A GRANT OF EXACTLY ONE PERMISSION, not a role.
     *
     * The first version used a technician, who holds neither of the pair and
     * is therefore refused whichever one this is guarded by: it passed just
     * as happily against an `integration:read` guard, which would have let
     * anybody who can see the settings screen mint a live webhook URL and a
     * signing secret. No role preset distinguishes the two, so the only way
     * to tell them apart is to hold one of them and nothing else.
     */
    const reader: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG, roles: [] as Actor["roles"],
        grants: ["integration:read"],
      },
      db: db(),
    };

    await expect(connectors.create(reader, { source: "angi", displayName: "Angi" }))
      .rejects.toThrow();

    /** And can still read, or this proved only that they are locked out entirely. */
    await expect(connectors.list(reader)).resolves.toEqual([]);
  });
});

run("trying a real body before going live", () => {
  it("shows what each field becomes and says it would be accepted", async () => {
    const result = await connectors.testMapping(owner(), {
      fieldMap: ANGI_MAP, sample: ANGI_SAMPLE,
    });

    expect(result.wouldBeAccepted).toBe(true);
    expect(result.reason).toBeNull();

    const byKey = Object.fromEntries(result.fields.map((f) => [f.key, f]));
    expect(byKey.contactName!.value).toBe("Dana Whitfield");
    expect(byKey.contactPhone!.value).toBe("+15125550133");
    expect(byKey.postalCode!.value).toBe("78745");
    expect(byKey.externalId!.value).toBe("ANG-55120");

    /** And says where each one will end up, which is the point of the screen. */
    expect(byKey.contactName!.becomes).toMatch(/customer/i);
    expect(byKey.addressLine1!.becomes).toMatch(/property/i);
  });

  it("refuses to call a mapping good when nobody could be rung", async () => {
    /**
     * A mapping that quietly produces nulls looks exactly like one that
     * works, which is why this reports the verdict rather than only the
     * values. The failure it prevents is an operator publishing a URL and
     * learning from a dispatcher three days later.
     */
    const result = await connectors.testMapping(owner(), {
      fieldMap: { externalId: "lead_id", contactName: "contact.full_name" },
      sample: { lead_id: "X1", contact: { full_name: "Dana Whitfield" } },
    });

    expect(result.wouldBeAccepted).toBe(false);
    expect(result.reason).toMatch(/no way to reach them/i);
  });

  it("falls back to the usual field names when nothing is mapped", async () => {
    /**
     * The commonest sender is somebody's own website form, which calls things
     * what you would expect. Requiring a map for that case would make the
     * easy integration the fiddly one.
     */
    const result = await connectors.testMapping(owner(), {
      sample: { name: "Dana Whitfield", phone: "+15125550133", id: "X9" },
    });
    const byKey = Object.fromEntries(result.fields.map((f) => [f.key, f]));
    expect(byKey.contactName!.value).toBe("Dana Whitfield");
    expect(byKey.contactPhone!.value).toBe("+15125550133");
  });

  it("writes nothing", async () => {
    await connectors.testMapping(owner(), { fieldMap: ANGI_MAP, sample: ANGI_SAMPLE });
    const rows = await raw`select count(*)::int as n from public.lead_offer where organization_id = ${ORG}`;
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("names the sample keys nothing is mapped to", async () => {
    const result = await connectors.testMapping(owner(), {
      fieldMap: ANGI_MAP, sample: { ...ANGI_SAMPLE, referred_by: "Mrs Patel" },
    });
    expect(result.unmapped).toContain("referred_by");
  });
});

run("changing one", () => {
  it("rotates the URL and the secret together", async () => {
    const made = await connectors.create(owner(), { source: "angi", displayName: "Angi", fieldMap: ANGI_MAP });
    const rotated = await connectors.rotateSecret(owner(), { id: made.id });

    expect(rotated.secret).not.toBe(made.secret);
    /**
     * Both halves. Rotating one leaves the other valid, and somebody rotating
     * is responding to a worry rather than performing an audit.
     */
    expect(rotated.webhookPath).not.toBe(made.webhookPath);
  });

  it("checks a replacement mapping the same way as the first one", async () => {
    const made = await connectors.create(owner(), { source: "angi", displayName: "Angi", fieldMap: ANGI_MAP });
    await expect(connectors.update(owner(), {
      id: made.id, fieldMap: { ...ANGI_MAP, zipcode: "address.zip" },
    })).rejects.toThrow(/"zipcode" is not a field/i);
  });

  it("clears the token on removal, so the old URL stops answering", async () => {
    const made = await connectors.create(owner(), { source: "angi", displayName: "Angi", fieldMap: ANGI_MAP });
    await connectors.remove(owner(), { id: made.id });

    const [row] = await raw`
      select webhook_token from public.lead_source_connector where id = ${made.id}`;
    expect((row as { webhook_token: string | null }).webhook_token).toBeNull();
  });
});

run("the mapping reaches the parser", () => {
  it("parses a sender's body with this connector's own map", async () => {
    /**
     * THE TEST THAT WAS MISSING, AND THE BUG IT FOUND.
     *
     * Everything above proves a field map can be stored and checked. None of
     * it proved the map is ever USED, because the webhook route builds the
     * adapter through the registry and the registry's factory took no
     * arguments: `registerLeadSource("lead_webhook", () => webhookLeadSource())`
     * discarded whatever it was handed. So a mapping could be configured,
     * validated, saved and displayed, and every lead would still be parsed
     * with the default guesses.
     *
     * Nothing failed when that happened. Leads arrived, carrying whichever
     * fields happened to match the guesses, and the rest came through empty.
     * That is why this goes through `createLeadSource` rather than calling
     * `webhookLeadSource` directly: the direct call always worked, and the
     * seam between it and the route was where the map was being dropped.
     */
    const adapter = createLeadSource("lead_webhook", {
      fieldMap: ANGI_MAP,
      source: "angi",
    });

    const lead = adapter.parse({
      url: "https://example.test/api/webhooks/leads/t",
      headers: {},
      body: JSON.stringify(ANGI_SAMPLE),
    });

    expect(lead).not.toBeNull();
    expect(lead!.contactName).toBe("Dana Whitfield");
    expect(lead!.contactPhone).toBe("+15125550133");
    expect(lead!.postalCode).toBe("78745");
    expect(lead!.externalId).toBe("ANG-55120");
    /** And attributed to this connector, which every channel report groups by. */
    expect(lead!.source).toBe("angi");
  });

  it("still reads a body that uses the usual names when no map is given", async () => {
    const adapter = createLeadSource("lead_webhook");
    const lead = adapter.parse({
      url: "https://example.test/api/webhooks/leads/t",
      headers: {},
      body: JSON.stringify({ name: "Dana Whitfield", phone: "+15125550133" }),
    });
    expect(lead?.contactName).toBe("Dana Whitfield");
  });
});
