import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as adConversions from "../src/services/ad-conversions";
import * as overview from "../src/services/marketing-overview";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as websiteTracking from "../src/services/website-tracking";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";
import { ENV, fakeGoogleOAuth, fakePlatform, readSecret, stateOf } from "./ads-fakes";

/**
 * READING GOOGLE BACK, AND TELLING THE PLATFORMS AGAIN WHEN A JOB CHANGES
 *
 * Search Console's queries and Google Analytics' sessions by source are read
 * into their own tables, a day asked about again replacing what was read
 * before rather than adding to it, and shown on the marketing overview beside
 * the leads and jobs each source brought.
 *
 * A paid job sent to Google Ads and then worth more is restated to Google at
 * its new value, once. Sent to Meta, the increase goes as a second purchase
 * for the difference, once, and a decrease Meta cannot be told is written down
 * as withheld with the reason and not sent.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-readback:org");
const USER = fixtureId("ads-readback:user");
const SLUG = "ads-readback-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});

const fake = fakePlatform();
fakeGoogleOAuth(fake);
const deps = { transport: fake.transport, readSecret, env: ENV };
const today = () => companyToday();

let clicks = 30;
fake.on("POST", /^https:\/\/sc\.fake\/webmasters\/v3\/sites\/sc-domain%3Areadback\.example\/searchAnalytics\/query$/, (call) => {
  expect(JSON.parse(call.body)).toMatchObject({ dimensions: ["date", "query"] });
  return {
    status: 200,
    body: { rows: [
      { keys: [today(), "furnace repair austin"], clicks, impressions: 400, ctr: 0.075, position: 3.2 },
      { keys: [today(), "readback heating"], clicks: 12, impressions: 20, ctr: 0.6, position: 1 },
    ] },
  };
});
let organicSessions = "120";
fake.on("POST", /^https:\/\/ga4data\.fake\/v1beta\/properties\/321654:runReport$/, () => ({
  status: 200,
  body: {
    rowCount: 2,
    rows: [
      { dimensionValues: [{ value: today().replace(/-/g, "") }, { value: "google" }, { value: "organic" }], metricValues: [{ value: organicSessions }, { value: "80" }] },
      { dimensionValues: [{ value: today().replace(/-/g, "") }, { value: "(direct)" }, { value: "(none)" }], metricValues: [{ value: "40" }, { value: "10" }] },
    ],
  },
}));

const adjustments: Record<string, unknown>[] = [];
fake.on("POST", /^https:\/\/ads\.fake\/v21\/customers\/1234567890:uploadClickConversions$/, (call) => {
  const body = JSON.parse(call.body) as { conversions: unknown[] };
  return { status: 200, body: { results: body.conversions.map(() => ({})) } };
});
fake.on("POST", /^https:\/\/ads\.fake\/v21\/customers\/1234567890:uploadConversionAdjustments$/, (call) => {
  adjustments.push(...(JSON.parse(call.body) as { conversionAdjustments: Record<string, unknown>[] }).conversionAdjustments);
  return { status: 200, body: { results: [{}] } };
});
const metaEvents: Record<string, unknown>[] = [];
fake.on("GET", /^https:\/\/graph\.fake\/token\?/, (call) => {
  const q = new URL(call.url).searchParams;
  return q.get("grant_type") === "fb_exchange_token"
    ? { status: 200, body: { access_token: "meta-long", expires_in: 5_184_000 } }
    : { status: 200, body: { access_token: "meta-short", expires_in: 3600 } };
});
fake.on("POST", /^https:\/\/graph\.fake\/v21\.0\/556677\/events$/, (call) => {
  metaEvents.push((JSON.parse(call.body) as { data: Record<string, unknown>[] }).data[0]!);
  return { status: 200, body: { events_received: 1 } };
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads Readback Co", slug: SLUG });
});
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

const signIn = async (provider: string, code = "good-code") => {
  const started = await adPlatforms.startSignIn(ctx(`sign-in-${provider}`), { provider }, deps);
  return adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code }, deps);
};
const google = { oauthClientRef: "GOOGLE_OAUTH_CLIENT", authUrl: "https://oauth.fake/auth", tokenUrl: "https://oauth.fake/token" };

run("Search Console and Google Analytics, read back", () => {
  it("reads queries and sessions into their own rows, replacing a day read again rather than adding to it", async () => {
    await leadIntake.connect(ctx(), { provider: "search_console", settings: { siteUrl: "sc-domain:readback.example", baseUrl: "https://sc.fake", ...google } });
    await leadIntake.connect(ctx(), { provider: "ga4_data", settings: { propertyId: "321654", baseUrl: "https://ga4data.fake", ...google } });
    expect((await signIn("search_console")).status).toBe("connected");
    expect((await signIn("ga4_data")).status).toBe("connected");

    const sc = await adPlatforms.connectedRow(db(), ORG, "search_console");
    const ga = await adPlatforms.connectedRow(db(), ORG, "ga4_data");
    expect(await adPlatforms.pullAnalytics(db(), sc, deps)).toMatchObject({ entity: "analytics", read: 2, written: 2, error: null });
    expect(await adPlatforms.pullAnalytics(db(), ga, deps)).toMatchObject({ entity: "analytics", read: 2, written: 2, error: null });

    clicks = 31;
    organicSessions = "125";
    await adPlatforms.pullAnalytics(db(), sc, deps);
    await adPlatforms.pullAnalytics(db(), ga, deps);
    const queries = await raw<{ query: string; clicks: number }[]>`
      select query, clicks from public.search_query_day where organization_id = ${ORG} order by query`;
    expect(queries).toEqual([{ query: "furnace repair austin", clicks: 31 }, { query: "readback heating", clicks: 12 }]);
    const sessions = await raw<{ source: string; sessions: number }[]>`
      select source, sessions from public.analytics_session_day where organization_id = ${ORG} order by source`;
    expect(sessions).toEqual([{ source: "direct", sessions: 40 }, { source: "organic_search", sessions: 125 }]);
  });

  it("puts sessions beside the leads each source brought on the overview", async () => {
    const customer = await customers.create(ctx(), {
      type: "residential", name: "Ola Berg", phone: "+15125550144", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    await inTenant(ctx(), (tx) => marketing.recordDeclaredTouch(tx, ORG, { source: "organic_search", customerId: customer.id as string }));
    const view = await overview.overview(ctx(), { from: today(), to: today() });
    const organic = view.rows.find((r) => r.source === "organic_search")!;
    expect(organic).toMatchObject({ sessions: 125, engagedSessions: 80, leads: 1, leadsPer100Sessions: "0.8" });
    expect(view.totals).toMatchObject({ sessions: 165, searchClicks: 43, searchImpressions: 420 });
    expect(view.queries[0]).toEqual({ query: "furnace repair austin", clicks: 31, impressions: 400, position: "3.2" });
    expect(view.sources.map((s) => [s.provider, s.status])).toEqual([["ga4_data", "connected"], ["search_console", "connected"]]);
    await expect(overview.overview(ctx(), { from: today(), to: "2020-01-01" })).rejects.toThrow(/first not after the last/);
  });
});

/** A visitor who clicked, became a customer, booked and paid. */
async function aPaidJob(input: { visitor: string; query: string; name: string; amount: string }) {
  await websiteTracking.recordVisit(db(), { companyKey: SLUG, visitorId: input.visitor, query: input.query, fbp: "fb.1.1712345678901.1234567890" });
  const customer = await customers.create(ctx(), {
    type: "residential", name: input.name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: `${input.visitor.length} Ash St`, city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
  });
  const customerId = customer.id as string;
  await inTenant(ctx(), (tx) => marketing.identify(tx, ORG, { visitorId: input.visitor, customerId }));
  const [property] = await raw<{ id: string }[]>`select property_id as id from public.customer_property where customer_id = ${customerId}`;
  const job = await jobs.create(ctx(), { customerId, propertyId: property!.id, summary: "Furnace", tags: [], customFields: {} });
  const jobId = job.id as string;
  await invoiceAndPay(customerId, jobId, input.amount, "first");
  return { customerId, jobId };
}

async function invoiceAndPay(customerId: string, jobId: string, amount: string, tag: string) {
  const invoice = await billing.create(ctx(), {
    customerId, jobId, lines: [{ name: "Work", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
  await billing.pay(ctx(`readback-pay-${jobId}-${tag}`), {
    customerId, method: "card", amount, tipAmount: "0", allocations: [{ invoiceId: invoice.id as string, amount }],
  });
  return invoice.id as string;
}

run("restating a sent conversion", () => {
  it("tells Google Ads the new value of a paid job that is worth more, once", async () => {
    await leadIntake.connect(ctx(), {
      provider: "google_ads",
      settings: { customerId: "123-456-7890", conversionActionId: "555", developerTokenRef: "GOOGLE_ADS_DEVELOPER_TOKEN", baseUrl: "https://ads.fake", ...google },
    });
    await signIn("google_ads");
    const row = await adPlatforms.connectedRow(db(), ORG, "google_ads");
    const { customerId, jobId } = await aPaidJob({ visitor: "visitor-restate-google", query: "gclid=GCLID-R1&utm_source=google&utm_medium=cpc", name: "Ruth Hale", amount: "400.00" });
    expect(await adConversions.sendConversions(db(), row, deps)).toMatchObject({ written: 1 });

    /** Nothing has changed, so nothing is told. */
    expect(await adConversions.restateConversions(db(), row, deps)).toMatchObject({ written: 0 });
    expect(adjustments).toHaveLength(0);

    await invoiceAndPay(customerId, jobId, "150.00", "second");
    expect(await adConversions.restateConversions(db(), row, deps)).toMatchObject({ written: 1 });
    expect(adjustments).toEqual([expect.objectContaining({
      adjustmentType: "RESTATEMENT", orderId: `ots_purchase_${jobId}`,
      restatementValue: { adjustedValue: 550, currencyCode: "USD" },
      conversionAction: "customers/1234567890/conversionActions/555",
    })]);
    await adConversions.restateConversions(db(), row, deps);
    expect(adjustments).toHaveLength(1);
    const listed = await adConversions.listAdjustments(ctx(), { jobId });
    expect(listed).toEqual([expect.objectContaining({ kind: "restatement", previousValue: "400.0000", newValue: "550.0000", state: "sent", sequence: 1 })]);
  });

  it("sends Meta the increase as a second purchase, and writes a decrease down without sending it", async () => {
    await leadIntake.connect(ctx(), {
      provider: "meta_ads",
      settings: { adAccountId: "act_1", pixelId: "556677", oauthClientRef: "META_OAUTH_CLIENT", authUrl: "https://facebook.fake/dialog", tokenUrl: "https://graph.fake/token", baseUrl: "https://graph.fake" },
    });
    await signIn("meta_ads", "meta-code");
    const row = await adPlatforms.connectedRow(db(), ORG, "meta_ads");
    const { customerId, jobId } = await aPaidJob({ visitor: "visitor-restate-meta", query: "fbclid=FBCLID-R1&utm_source=facebook&utm_medium=paid_social", name: "Ivo Marsh", amount: "300.00" });
    await adConversions.sendConversions(db(), row, deps);
    expect(metaEvents.map((e) => e["event_name"])).toEqual(["Lead", "Purchase"]);

    const second = await invoiceAndPay(customerId, jobId, "100.00", "second");
    await adConversions.restateConversions(db(), row, deps);
    await adConversions.restateConversions(db(), row, deps);
    expect(metaEvents).toHaveLength(3);
    expect(metaEvents[2]).toMatchObject({
      event_name: "Purchase", event_id: `ots_purchase_${jobId}_adj1`, custom_data: { value: 100, currency: "USD" },
    });

    const [line] = await raw<{ id: string }[]>`select id from public.invoice_line where invoice_id = ${second}`;
    await creditNotes.create(ctx("readback-credit-1"), {
      invoiceId: second, reason: "price_adjustment", lines: [{ invoiceLineId: line!.id, quantity: "1", unitPrice: "60.00" }], draft: false, apply: true,
    });
    await adConversions.restateConversions(db(), row, deps);
    await adConversions.restateConversions(db(), row, deps);
    expect(metaEvents).toHaveLength(3);
    const listed = await adConversions.listAdjustments(ctx(), { jobId });
    expect(listed.map((a) => [a.sequence, a.kind, a.state, a.newValue])).toEqual([
      [2, "cannot_lower", "withheld", "340.0000"],
      [1, "increase", "sent", "400.0000"],
    ]);
    expect(listed[0]!.detail).toContain("Meta has no way to lower");
  });
});
