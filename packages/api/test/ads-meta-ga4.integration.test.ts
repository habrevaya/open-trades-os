import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as adConversions from "../src/services/ad-conversions";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as websiteTracking from "../src/services/website-tracking";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { ENV, fakePlatform, readSecret, stateOf } from "./ads-fakes";

/**
 * META AND GOOGLE ANALYTICS, AGAINST FAKES OF EACH
 *
 * Meta: a sign in that becomes a sixty day token, spend per campaign per day
 * exactly as Meta writes it, and a Lead and a Purchase through the
 * Conversions API, matched on the click and the browser and, only where
 * allowed, on hashed details spelt Meta's way. A refused event is recorded in
 * Meta's words; a token past its date stops everything.
 *
 * Google Analytics: a lead and a purchase tied to the visit's analytics id,
 * with no personal detail in them at all, and a job whose visitor was never
 * seen withheld with the reason.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-meta:org");
const USER = fixtureId("ads-meta:user");
const SLUG = "ads-meta-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db() });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const fake = fakePlatform();
let clock = new Date();
const deps = { transport: fake.transport, readSecret, env: ENV, now: () => clock };

const events: Record<string, unknown>[] = [];
const refuseEvents = new Set<string>();
const collected: Record<string, unknown>[] = [];

fake.on("GET", /^https:\/\/graph\.fake\/token\?/, (call) => {
  const q = new URL(call.url).searchParams;
  if (q.get("grant_type") === "fb_exchange_token") {
    return q.get("fb_exchange_token") === "short-token"
      ? { status: 200, body: { access_token: "meta-long-token", token_type: "bearer", expires_in: 5_184_000 } }
      : { status: 400, body: { error: { message: "Invalid token", type: "OAuthException", code: 190 } } };
  }
  return q.get("code") === "meta-code"
    ? { status: 200, body: { access_token: "short-token", token_type: "bearer", expires_in: 3600 } }
    : { status: 400, body: { error: { message: "Invalid code", type: "OAuthException", code: 100 } } };
});
fake.on("GET", /^https:\/\/graph\.fake\/v21\.0\/act_998877\/insights\?/, (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer meta-long-token");
  expect(call.url).not.toContain("meta-long-token");
  if (call.url.includes("page=2")) {
    return { status: 200, body: { data: [{ campaign_id: "702", campaign_name: "Retargeting", spend: "3.5", impressions: "50", clicks: "1", account_currency: "USD", date_start: day(0), date_stop: day(0) }] } };
  }
  return {
    status: 200,
    body: {
      data: [{ campaign_id: "701", campaign_name: "Furnace season", spend: "42.17", impressions: "900", clicks: "12", account_currency: "USD", date_start: day(0), date_stop: day(0) }],
      paging: { next: "https://graph.fake/v21.0/act_998877/insights?page=2" },
    },
  };
});
fake.on("POST", /^https:\/\/graph\.fake\/v21\.0\/556677\/events$/, (call) => {
  const body = JSON.parse(call.body) as { data: Record<string, unknown>[] };
  const event = body.data[0]!;
  if (refuseEvents.has(event["event_id"] as string)) {
    return { status: 400, body: { error: { message: "Invalid parameter", error_user_msg: "event_time is too far in the past.", code: 100 } } };
  }
  events.push(event);
  return { status: 200, body: { events_received: 1, messages: [], fbtrace_id: "trace" } };
});
fake.on("POST", /^https:\/\/ga\.fake\/mp\/collect\?/, (call) => {
  const q = new URL(call.url).searchParams;
  expect(q.get("measurement_id")).toBe("G-TEST123");
  expect(q.get("api_secret")).toBe("ga4-api-secret-not-real");
  collected.push(JSON.parse(call.body) as Record<string, unknown>);
  return { status: 204 };
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads Meta Co", slug: SLUG });
});
afterAll(async () => { if (raw) await raw.end(); });

/** A visitor who clicked a Facebook ad, became a customer and booked a job. */
async function aJobFromAMetaClick(input: { visitor: string; fbclid: string; ga?: string; name: string; email: string; phone: string }) {
  await websiteTracking.recordVisit(db(), {
    companyKey: SLUG, visitorId: input.visitor,
    query: `fbclid=${input.fbclid}&utm_source=facebook&utm_medium=paid_social`,
    fbp: "fb.1.1712345678901.1234567890",
    ...(input.ga ? { ga: input.ga } : {}),
  });
  const customer = await customers.create(ctx(), {
    type: "residential", name: input.name, email: input.email, phone: input.phone,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: `${input.visitor.length} Oak Ave`, city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
  });
  const customerId = customer.id as string;
  await inTenant(ctx(), (tx) => marketing.identify(tx, ORG, { visitorId: input.visitor, customerId }));
  const [property] = await raw<{ id: string }[]>`select property_id as id from public.customer_property where customer_id = ${customerId}`;
  const job = await jobs.create(ctx(), { customerId, propertyId: property!.id, summary: "Furnace tune up", tags: [], customFields: {} });
  return { customerId, jobId: job.id as string };
}

async function pay(customerId: string, jobId: string, amount: string) {
  const invoice = await billing.create(ctx(), {
    customerId, jobId, lines: [{ name: "Tune up", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...ctx(), idempotencyKey: `ads-meta-pay-${jobId}` }, {
    customerId, method: "card", amount, tipAmount: "0", allocations: [{ invoiceId: invoice.id as string, amount }],
  });
}

run("Meta", () => {
  it("signs in, trades the short token for a long one, and counts down to its date", async () => {
    await leadIntake.connect(ctx(), {
      provider: "meta_ads",
      settings: {
        adAccountId: "act_998877", pixelId: "556677", oauthClientRef: "META_OAUTH_CLIENT",
        personalData: "unless_refused",
        authUrl: "https://facebook.fake/dialog", tokenUrl: "https://graph.fake/token", baseUrl: "https://graph.fake",
      },
    });
    const started = await adPlatforms.startSignIn(ctx(), { provider: "meta_ads" }, deps);
    expect(new URL(started.url).searchParams.get("scope")).toBe("ads_read,ads_management");
    const done = await adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code: "meta-code" }, deps);
    expect(done.status).toBe("connected");
    const [grant] = await raw<{ expires_at: Date }[]>`select expires_at from public.sealed_credential where organization_id = ${ORG}`;
    expect(Math.round((grant!.expires_at.getTime() - clock.getTime()) / 86_400_000)).toBe(60);
  });

  it("refuses a personal data setting that is not one of the three", async () => {
    await expect(leadIntake.connect(ctx(), { provider: "meta_ads", settings: { personalData: "everything" }, keepExisting: true }))
      .rejects.toThrow(/personalData/);
  });

  it("pulls spend from every page, exactly as Meta writes it", async () => {
    const row = await adPlatforms.connectedRow(db(), ORG, "meta_ads");
    const outcome = await adPlatforms.pullSpend(db(), row, deps);
    expect(outcome.error).toBeNull();
    const rows = await raw<{ amount: string; source: string; origin: string; campaign: string }[]>`
      select amount, source, origin, campaign from public.ad_spend where organization_id = ${ORG} and deleted_at is null order by campaign`;
    expect(rows).toEqual([
      { amount: "42.1700", source: "meta_ads", origin: "meta_ads", campaign: "Furnace season" },
      { amount: "3.5000", source: "meta_ads", origin: "meta_ads", campaign: "Retargeting" },
    ]);
  });

  let job = { customerId: "", jobId: "" };
  it("sends a Lead when the job is booked, matched on the click, the browser and the hashed details", async () => {
    job = await aJobFromAMetaClick({
      visitor: "visitor-ads-meta-1", fbclid: "IwAR-one", ga: "GA1.1.333.444",
      name: "Jo Banks", email: " Jo.Banks@Gmail.com ", phone: "(512) 555-0188",
    });
    const row = await adPlatforms.connectedRow(db(), ORG, "meta_ads");
    await adConversions.sendConversions(db(), row, deps);
    expect(events).toHaveLength(1);
    const [lead] = events;
    expect(lead).toMatchObject({ event_name: "Lead", event_id: `ots_lead_${job.jobId}`, action_source: "system_generated" });
    const user = lead!["user_data"] as Record<string, unknown>;
    expect(user["em"]).toEqual([sha("jo.banks@gmail.com")]);
    expect(user["ph"]).toEqual([sha("15125550188")]);
    expect(user["fbp"]).toBe("fb.1.1712345678901.1234567890");
    expect(String(user["fbc"])).toMatch(/^fb\.1\.\d{13}\.IwAR-one$/);
    expect(lead!["custom_data"]).toBeUndefined();
  });

  it("sends a Purchase with Meta's share of the revenue once the job is paid, and the Lead is not sent again", async () => {
    await pay(job.customerId, job.jobId, "300.00");
    events.length = 0;
    clock = new Date(clock.getTime() + 20 * 60_000);
    await adConversions.sendConversions(db(), await adPlatforms.connectedRow(db(), ORG, "meta_ads"), deps);
    expect(events.map((e) => `${String(e["event_name"])} ${String(e["event_id"])}`)).toEqual([`Purchase ots_purchase_${job.jobId}`]);
    expect(events[0]!["custom_data"]).toEqual({ value: 300, currency: "USD" });
  });

  it("records Meta's refusal of one event in Meta's words", async () => {
    const other = await aJobFromAMetaClick({
      visitor: "visitor-ads-meta-2", fbclid: "IwAR-two", name: "Kim Lowe", email: "kim@example.com", phone: "512-555-0199",
    });
    refuseEvents.add(`ots_lead_${other.jobId}`);
    clock = new Date(clock.getTime() + 20 * 60_000);
    await adConversions.sendConversions(db(), await adPlatforms.connectedRow(db(), ORG, "meta_ads"), deps);
    const [send] = await adConversions.listSends(ctx(), { jobId: other.jobId, provider: "meta_ads" });
    expect(send).toMatchObject({ state: "refused", kind: "lead" });
    expect(send!.detail).toMatch(/event_time is too far in the past/);
  });

  it("stops and asks for a person when the sixty days are up", async () => {
    clock = new Date(Date.now() + 61 * 86_400_000);
    const outcome = await adPlatforms.pullSpend(db(), await adPlatforms.connectedRow(db(), ORG, "meta_ads"), deps);
    expect(outcome.needsSignIn).toBe(true);
    expect(outcome.error).toMatch(/Meta's sign in ran out/);
    clock = new Date();
  });
});

run("Google Analytics", () => {
  it("waits for the API secret's name before it will send anything", async () => {
    const saved = await leadIntake.connect(ctx(), {
      provider: "ga4", settings: { measurementId: "G-TEST123", baseUrl: "https://ga.fake" },
    });
    expect(saved.status).toBe("pending");
    const connected = await leadIntake.connect(ctx(), { provider: "ga4", credentialRef: "GA4_API_SECRET", settings: {}, keepExisting: true });
    expect(connected.status).toBe("connected");
  });

  it("sends a lead and then a purchase tied to the visit, with nothing that identifies a person", async () => {
    const job = await aJobFromAMetaClick({
      visitor: "visitor-ads-ga-1", fbclid: "IwAR-ga", ga: "GA1.2.987654.321",
      name: "Pat Reyes", email: "pat@example.com", phone: "512-555-0111",
    });
    const row = await adPlatforms.connectedRow(db(), ORG, "ga4");
    clock = new Date();
    collected.length = 0;
    await adConversions.sendConversions(db(), row, deps);
    const lead = collected.find((c) => (c["events"] as { params: Record<string, unknown> }[])[0]!.params["lead_id"] === `ots_lead_${job.jobId}`);
    expect(lead).toBeDefined();
    expect(lead!["client_id"]).toBe("987654.321");
    expect((lead!["events"] as { name: string }[])[0]!.name).toBe("generate_lead");
    expect(JSON.stringify(collected)).not.toMatch(/pat@example|5550111/);

    await pay(job.customerId, job.jobId, "150.00");
    collected.length = 0;
    clock = new Date(Date.now() + 20 * 60_000);
    await adConversions.sendConversions(db(), row, deps);
    const purchase = collected.find((c) => (c["events"] as { name: string }[])[0]!.name === "purchase")!;
    expect((purchase["events"] as { params: Record<string, unknown> }[])[0]!.params).toEqual({
      value: 150, currency: "USD", transaction_id: `ots_purchase_${job.jobId}`,
    });
  });

  it("withholds a job whose visitor was never seen on the website, and says why", async () => {
    const [customer] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, name) values (${ORG}, 'Rang from a van') returning id`;
    const [property] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property cp join public.customer c on c.id = cp.customer_id
      where c.organization_id = ${ORG} limit 1`;
    const job = await jobs.create(ctx(), {
      customerId: customer!.id, propertyId: property!.id, summary: "Called the number on the van",
      leadSource: "vehicle_wrap", tags: [], customFields: {},
    });
    clock = new Date(Date.now() + 40 * 60_000);
    await adConversions.sendConversions(db(), await adPlatforms.connectedRow(db(), ORG, "ga4"), deps);
    const [send] = await adConversions.listSends(ctx(), { jobId: job.id as string, provider: "ga4" });
    expect(send).toMatchObject({ state: "withheld", withheldReason: "no_client_id" });
    /** Meta was not told about it at all: none of its touches came from Meta. */
    expect(await adConversions.listSends(ctx(), { jobId: job.id as string, provider: "meta_ads" })).toEqual([]);
  });
});
