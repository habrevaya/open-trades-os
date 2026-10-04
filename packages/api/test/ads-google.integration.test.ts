import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as leadIntake from "../src/services/lead-intake";
import * as acquisition from "../src/services/acquisition";
import * as adPlatforms from "../src/services/ad-platforms";
import * as adConversions from "../src/services/ad-conversions";
import * as adsService from "../src/services/ads";
import * as report from "../src/services/marketing-report";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as websiteTracking from "../src/services/website-tracking";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { unseal } from "../src/ads/index";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";
import { ENV, SEALING_KEY, fakeGoogleOAuth, fakePlatform, readSecret, stateOf, type Call } from "./ads-fakes";

/**
 * GOOGLE ADS, END TO END AGAINST A FAKE OF GOOGLE
 *
 * The real adapter, the real token handling and the real services, with
 * Google replaced at the HTTP seam. A person signs in; the grant is sealed;
 * spend arrives in the spend rows, mapped onto the company's tracking
 * campaigns; a paid job goes back to Google once, with the click and the
 * revenue on it and nothing the customer did not allow; and a revoked grant
 * stops everything and says a person has to sign in again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-google:org");
const USER = fixtureId("ads-google:user");
const OTHER = fixtureId("ads-google:other-user");
const SLUG = "ads-google-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (roles: Actor["roles"] = ["owner"], userId = USER): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});

const fake = fakePlatform();
const oauth = fakeGoogleOAuth(fake);
const deps = { transport: fake.transport, readSecret, env: ENV };
const day = (offset = 0) => companyToday(offset);

/** What the fake Ads account reports, which a test changes between pulls. */
let spendRows: { id: string; name: string; type: string; date: string; micros: string; currency?: string }[] = [];
const uploads: Record<string, unknown>[] = [];
const refuseGclids = new Set<string>();

fake.on("POST", /^https:\/\/ads\.fake\/v21\/customers\/1234567890\/googleAds:search$/, (call) => {
  const query = (JSON.parse(call.body) as { query: string }).query;
  if (!query.includes("FROM campaign")) return { status: 400, body: { error: { message: "unexpected query" } } };
  return {
    status: 200,
    body: {
      results: spendRows.map((r) => ({
        customer: { currencyCode: r.currency ?? "USD" },
        campaign: { id: r.id, name: r.name, advertisingChannelType: r.type },
        segments: { date: r.date },
        metrics: { costMicros: r.micros, clicks: "4", impressions: "120" },
      })),
    },
  };
});
fake.on("POST", /^https:\/\/ads\.fake\/v21\/customers\/1234567890:uploadClickConversions$/, (call) => {
  const body = JSON.parse(call.body) as { conversions: Record<string, unknown>[] };
  uploads.push(...body.conversions);
  const errors = body.conversions
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => typeof c["gclid"] === "string" && refuseGclids.has(c["gclid"]))
    .map(({ index }) => ({
      errorCode: { conversionUploadError: "EXPIRED_EVENT" },
      message: "The click is older than the conversion window.",
      location: { fieldPathElements: [{ fieldName: "conversions", index }] },
    }));
  return {
    status: 200,
    body: {
      results: body.conversions.map(() => ({})),
      ...(errors.length > 0 ? { partialFailureError: { code: 3, message: "Partial failure", details: [{ errors }] } } : {}),
    },
  };
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads Google Co", slug: SLUG });
  await raw`delete from public."user" where id = ${OTHER}`;
  await raw`insert into public."user" (id, email) values (${OTHER}, 'ads-google-other@test.local')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${OTHER}, 'owner')`;
});

/**
 * Its connections are switched off at the end, so a worker pass in another
 * test file does not visit this company's fake hosts over the real network.
 */
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

const connectGoogleAds = (settings: Record<string, unknown> = {}) => leadIntake.connect(ctx(), {
  provider: "google_ads",
  settings: {
    customerId: "123-456-7890",
    conversionActionId: "555",
    developerTokenRef: "GOOGLE_ADS_DEVELOPER_TOKEN",
    oauthClientRef: "GOOGLE_OAUTH_CLIENT",
    authUrl: "https://oauth.fake/auth",
    tokenUrl: "https://oauth.fake/token",
    baseUrl: "https://ads.fake",
    ...settings,
  },
});

const connection = async () => adPlatforms.connectedRow(db(), ORG, "google_ads");

/** A visitor who clicked an ad, became a customer, and booked a job that was invoiced and paid. */
async function aPaidJobFromAClick(input: { visitor: string; gclid: string; name: string; email: string; phone: string; amount: string }) {
  await websiteTracking.recordVisit(db(), {
    companyKey: SLUG, visitorId: input.visitor,
    query: `gclid=${input.gclid}&utm_source=google&utm_medium=cpc`,
    ga: "GA1.1.111.222",
  });
  const customer = await customers.create(ctx(), {
    type: "residential", name: input.name, email: input.email, phone: input.phone,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: `${input.visitor.length} Elm St`, city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
  });
  const customerId = customer.id as string;
  await inTenant(ctx(), (tx) => marketing.identify(tx, ORG, { visitorId: input.visitor, customerId }));
  const [property] = await raw<{ id: string }[]>`
    select property_id as id from public.customer_property where customer_id = ${customerId}`;
  const job = await jobs.create(ctx(), { customerId, propertyId: property!.id, summary: "AC repair", tags: [], customFields: {} });
  const jobId = job.id as string;
  const invoice = await billing.create(ctx(), {
    customerId, jobId,
    lines: [{ name: "Repair", quantity: "1", unitPrice: input.amount, discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...ctx(), idempotencyKey: `ads-google-pay-${jobId}` }, {
    customerId, method: "card", amount: input.amount, tipAmount: "0",
    allocations: [{ invoiceId: invoice.id as string, amount: input.amount }],
  });
  return { customerId, jobId };
}

run("signing in with Google", () => {
  it("leaves a saved connection waiting until somebody signs in", async () => {
    const saved = await connectGoogleAds();
    expect(saved.status).toBe("pending");
    await expect(connection()).rejects.toThrow(/Nobody has signed in/);
  });

  it("refuses to start a sign in this deployment could not keep the result of", async () => {
    await expect(adPlatforms.startSignIn(ctx(), { provider: "google_ads" }, { ...deps, env: { PUBLIC_URL: "https://ots.test" } }))
      .rejects.toThrow(/CREDENTIAL_SEALING_KEY/);
  });

  it("refuses somebody who may not change integrations", async () => {
    await expect(adPlatforms.startSignIn(ctx(["dispatcher"]), { provider: "google_ads" }, deps)).rejects.toThrow();
  });

  let state = "";
  it("sends the person to Google for offline access, with a state of its own", async () => {
    const started = await adPlatforms.startSignIn(ctx(), { provider: "google_ads" }, deps);
    const address = new URL(started.url);
    expect(address.origin + address.pathname).toBe("https://oauth.fake/auth");
    expect(address.searchParams.get("client_id")).toBe("client-id.apps.example");
    expect(address.searchParams.get("redirect_uri")).toBe("https://ots.test/settings/integrations/oauth");
    expect(address.searchParams.get("access_type")).toBe("offline");
    state = stateOf(started.url);
    const [kept] = await raw<{ state_hash: string }[]>`select state_hash from public.oauth_authorization where organization_id = ${ORG}`;
    expect(kept!.state_hash).not.toContain(state);
  });

  it("refuses the return for somebody who did not start it", async () => {
    await expect(adPlatforms.finishSignIn(ctx(["owner"], OTHER), { state, code: "good-code" }, deps))
      .rejects.toThrow(/started by somebody else/);
  });

  it("refuses a state nobody here issued", async () => {
    await expect(adPlatforms.finishSignIn(ctx(), { state: "x".repeat(43), code: "good-code" }, deps))
      .rejects.toThrow(/not started here/);
  });

  it("trades the code for a grant, seals it, and connects", async () => {
    const done = await adPlatforms.finishSignIn(ctx(), { state, code: "good-code" }, deps);
    expect(done.status).toBe("connected");
    const token = fake.callsTo(/oauth\.fake\/token/).at(-1)!;
    expect(token.body).toContain("redirect_uri=https%3A%2F%2Fots.test%2Fsettings%2Fintegrations%2Foauth");

    const [grant] = await raw<{ sealed_token: string; connection_id: string; scopes: string[] }[]>`
      select sealed_token, connection_id, scopes from public.sealed_credential where organization_id = ${ORG}`;
    expect(grant!.sealed_token).not.toContain(oauth.refreshToken);
    expect(grant!.scopes).toEqual(["https://www.googleapis.com/auth/adwords"]);
    expect(unseal(grant!.sealed_token, grant!.connection_id, Buffer.from(SEALING_KEY, "base64"))).toBe(oauth.refreshToken);
  });

  it("answers the same return twice without trading the code again", async () => {
    const before = fake.callsTo(/oauth\.fake\/token/).length;
    const again = await adPlatforms.finishSignIn(ctx(), { state, code: "good-code" }, deps);
    expect(again.status).toBe("connected");
    expect(fake.callsTo(/oauth\.fake\/token/).length).toBe(before);
  });

  it("writes a cancelled sign in on the connection and changes nothing else", async () => {
    const started = await adPlatforms.startSignIn({ ...ctx(), idempotencyKey: "ads-google-cancel" }, { provider: "google_ads" }, deps);
    await expect(adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), error: "access_denied" }, deps))
      .rejects.toThrow(/did not grant access \(access_denied\)/);
    const row = await connection();
    expect(row.status).toBe("connected");
    expect(row.lastError).toMatch(/access_denied/);
  });
});

run("spend, pulled and mapped", () => {
  let springId = "";
  it("files each campaign's day under the company's own tracking campaign when the names agree", async () => {
    const google = (await acquisition.listChannels(ctx())).find((c) => c.sourceKey === "google_ads")!;
    springId = (await acquisition.createCampaign(ctx(), { channelId: google.id, name: "Spring AC tune up" })).id;

    spendRows = [
      { id: "11", name: "Spring AC tune up", type: "SEARCH", date: day(-1), micros: "12345678" },
      { id: "11", name: "Spring AC tune up", type: "SEARCH", date: day(0), micros: "5000000" },
      { id: "22", name: "Brand", type: "SEARCH", date: day(0), micros: "1990000" },
      { id: "33", name: "LSA plumbing", type: "LOCAL_SERVICES", date: day(0), micros: "45000000" },
    ];
    const outcome = await adPlatforms.pullSpend(db(), await connection(), deps);
    expect(outcome.error).toBeNull();
    expect(outcome.written).toBe(4);

    const rows = await raw<{ source: string; campaign: string; amount: string; acquisition_campaign_id: string | null; origin: string; external_id: string }[]>`
      select source, campaign, amount, acquisition_campaign_id, origin, external_id from public.ad_spend
      where organization_id = ${ORG} and deleted_at is null order by external_id`;
    expect(rows.map((r) => [r.source, r.amount, r.acquisition_campaign_id === springId])).toEqual([
      ["google_ads", "12.3457", true],
      ["google_ads", "5.0000", true],
      ["google_ads", "1.9900", false],
      ["google_lsa", "45.0000", false],
    ]);
    expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(["google_ads"]));
    expect(rows[0]!.external_id).toBe(`1234567890:11:${day(-1)}`);

    const sent = fake.callsTo(/googleAds:search/).at(-1)!;
    expect(sent.headers["developer-token"]).toBe("developer-token-not-real");
    expect(sent.headers["Authorization"]).toMatch(/^Bearer access-/);
  });

  it("rewrites a revised day rather than adding it, and takes out a day the platform no longer reports", async () => {
    spendRows = [
      { id: "11", name: "Spring AC (renamed)", type: "SEARCH", date: day(-1), micros: "13000000" },
      { id: "11", name: "Spring AC (renamed)", type: "SEARCH", date: day(0), micros: "5000000" },
      { id: "33", name: "LSA plumbing", type: "LOCAL_SERVICES", date: day(0), micros: "45000000" },
    ];
    await adPlatforms.pullSpend(db(), await connection(), deps);
    const rows = await raw<{ external_id: string; amount: string }[]>`
      select external_id, amount from public.ad_spend
      where organization_id = ${ORG} and deleted_at is null order by external_id`;
    expect(rows.map((r) => [r.external_id.split(":")[1], r.amount])).toEqual([
      ["11", "13.0000"], ["11", "5.0000"], ["33", "45.0000"],
    ]);
  });

  it("refuses a pull in another currency whole, rather than adding euros to dollars", async () => {
    const before = spendRows;
    spendRows = [{ id: "44", name: "Euro", type: "SEARCH", date: day(0), micros: "1000000", currency: "EUR" }];
    const outcome = await adPlatforms.pullSpend(db(), await connection(), deps);
    expect(outcome.error).toMatch(/bills in EUR/);
    spendRows = before;
    await adPlatforms.pullSpend(db(), await connection(), deps);
  });

  it("moves a platform campaign's days when a person maps it", async () => {
    const campaigns = await adPlatforms.listPlatformCampaigns(ctx());
    const brand = campaigns.find((c) => c.externalId === "22")!;
    expect(brand.campaignId).toBeNull();
    const spring = campaigns.find((c) => c.externalId === "11")!;
    expect(spring.mappedBy).toBe("matched");

    spendRows = [{ id: "22", name: "Brand", type: "SEARCH", date: day(0), micros: "1990000" }, ...spendRows];
    await adPlatforms.pullSpend(db(), await connection(), deps);
    const mapped = await adPlatforms.mapPlatformCampaign(ctx(), { id: brand.id, campaignId: springId });
    expect(mapped.moved).toBe(1);
    const [row] = await raw<{ acquisition_campaign_id: string }[]>`
      select acquisition_campaign_id from public.ad_spend where organization_id = ${ORG}
      and external_id = ${`1234567890:22:${day(0)}`} and deleted_at is null`;
    expect(row!.acquisition_campaign_id).toBe(springId);
    await expect(adPlatforms.mapPlatformCampaign(ctx(["csr"]), { id: brand.id, campaignId: null })).rejects.toThrow();
  });

  it("shows pulled spend on the funnel by ad platform, and every figure opens into its rows", async () => {
    const funnel = await report.funnel(ctx(), { from: day(-2), to: day(1), by: "platform" });
    const google = funnel.rows.find((r) => r.key === "google_ads")!;
    const lsa = funnel.rows.find((r) => r.key === "google_lsa")!;
    expect(google.label).toBe("Google Ads");
    expect(google.spend).toBe("19.9900");
    expect(lsa.spend).toBe("45.0000");
    const drilled = await report.drill(ctx(), { from: day(-2), to: day(1), by: "platform", key: "google_ads", measure: "spend" });
    expect(drilled.kind).toBe("spend");
    if (drilled.kind === "spend") {
      expect(drilled.spend.every((s) => s.note === "Pulled from Google Ads.")).toBe(true);
      expect(drilled.spend.reduce((sum, s) => sum + Math.round(Number(s.amount) * 10_000), 0)).toBe(199_900);
    }
  });
});

run("paid jobs told back to Google", () => {
  let first = { customerId: "", jobId: "" };

  it("sends a paid job once, against its click, with its revenue and nothing the customer did not allow", async () => {
    first = await aPaidJobFromAClick({
      visitor: "visitor-ads-google-1", gclid: "Cj0KCQ-first", name: "Rosa Delgado",
      email: "Rosa.Delgado@gmail.com", phone: "(512) 555-0133", amount: "480.00",
    });
    uploads.length = 0;
    const outcome = await adConversions.sendConversions(db(), await connection(), deps);
    expect(outcome.error).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      conversionAction: "customers/1234567890/conversionActions/555",
      gclid: "Cj0KCQ-first",
      orderId: `ots_purchase_${first.jobId}`,
      conversionValue: 480,
      currencyCode: "USD",
      consent: { adUserData: "DENIED" },
    });
    /** The default sends no email or phone for a customer who was never asked. */
    expect(uploads[0]!["userIdentifiers"]).toBeUndefined();

    const sends = await adConversions.listSends(ctx(), { jobId: first.jobId });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ state: "sent", kind: "purchase", identifiers: ["click_id"], value: "480.0000" });
  });

  it("does not send it again, however often the pass runs", async () => {
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads).toHaveLength(0);
    await expect(adConversions.retrySend(ctx(), { id: (await adConversions.listSends(ctx(), { jobId: first.jobId }))[0]!.id }))
      .rejects.toThrow(/count the job twice/);
  });

  it("sends a claim a dead worker left behind again with the same order id, which Google deduplicates", async () => {
    await raw`update public.ad_conversion_send set state = 'sending', updated_at = now() - interval '1 hour'
              where organization_id = ${ORG} and job_id = ${first.jobId}`;
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads.map((u) => u["orderId"])).toEqual([`ots_purchase_${first.jobId}`]);
    const [row] = await raw<{ state: string; n: number }[]>`
      select state, count(*) over ()::int as n from public.ad_conversion_send where job_id = ${first.jobId}`;
    expect(row).toEqual({ state: "sent", n: 1 });
  });

  it("adds the hashed email and phone, spelt Google's way, for a customer who said yes", async () => {
    const second = await aPaidJobFromAClick({
      visitor: "visitor-ads-google-2", gclid: "Cj0KCQ-second", name: "Sam Ortiz",
      email: "Sam.Ortiz@gmail.com", phone: "512-555-0144", amount: "250.00",
    });
    await adConversions.setAdChoice(ctx(), { customerId: second.customerId, choice: "granted", proofText: "Said yes on the phone." });
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads).toHaveLength(1);
    const { createHash } = await import("node:crypto");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(uploads[0]!["userIdentifiers"]).toEqual([
      { hashedEmail: sha("samortiz@gmail.com") },
      { hashedPhoneNumber: sha("+15125550144") },
    ]);
    expect(uploads[0]!["consent"]).toEqual({ adUserData: "GRANTED" });
    const body = fake.callsTo(/uploadClickConversions/).at(-1)!.body;
    expect(body).not.toMatch(/ortiz@gmail/i);
  });

  it("sends nothing at all for a customer who said no, and writes down why", async () => {
    const third = await aPaidJobFromAClick({
      visitor: "visitor-ads-google-3", gclid: "Cj0KCQ-third", name: "Lee Park",
      email: "lee@example.com", phone: "512-555-0155", amount: "99.00",
    });
    await adConversions.setAdChoice(ctx(), { customerId: third.customerId, choice: "refused" });
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads).toHaveLength(0);
    const [send] = await adConversions.listSends(ctx(), { jobId: third.jobId });
    expect(send).toMatchObject({ state: "withheld", withheldReason: "customer_refused", identifiers: [] });
  });

  it("records Google's refusal of one conversion in Google's words, and sends the rest", async () => {
    const fourth = await aPaidJobFromAClick({
      visitor: "visitor-ads-google-4", gclid: "Cj0KCQ-stale", name: "Ana Ruiz",
      email: "ana@example.com", phone: "512-555-0166", amount: "120.00",
    });
    refuseGclids.add("Cj0KCQ-stale");
    await adConversions.sendConversions(db(), await connection(), deps);
    const [send] = await adConversions.listSends(ctx(), { jobId: fourth.jobId });
    expect(send).toMatchObject({ state: "refused" });
    expect(send!.detail).toMatch(/EXPIRED_EVENT: The click is older/);

    const retried = await adConversions.retrySend({ ...ctx(), idempotencyKey: "ads-google-retry" }, { id: send!.id });
    expect(retried.state).toBe("failed");
    refuseGclids.clear();
    await adConversions.sendConversions(db(), await connection(), deps);
    expect((await adConversions.listSends(ctx(), { jobId: fourth.jobId }))[0]!.state).toBe("sent");
  });

  it("leaves a job Google has been told about out of the conversion file, so uploading both cannot count it twice", async () => {
    const file = await marketing.conversions(ctx(), { from: day(-1), to: day(1) });
    expect(file.some((row) => row.jobId === first.jobId)).toBe(false);
  });
});

run("the grant, refreshed and lost", () => {
  it("mints an access token once an hour rather than on every request", async () => {
    const before = oauth.refreshes;
    await adPlatforms.pullSpend(db(), await connection(), { ...deps });
    await adPlatforms.pullSpend(db(), await connection(), { ...deps });
    /** Each pull builds its own adapter, so each refreshes once; neither refreshes per request. */
    expect(oauth.refreshes - before).toBe(2);
    const refresh = fake.callsTo(/oauth\.fake\/token/).filter((c: Call) => c.body.includes("grant_type=refresh_token")).at(-1)!;
    expect(refresh.body).toContain("client_secret=client-secret-not-real");
  });

  it("marks the connection as needing a person when Google revokes the grant, and stops pulling it", async () => {
    oauth.revoked = true;
    const outcome = await adPlatforms.pullSpend(db(), await connection(), deps);
    expect(outcome.needsSignIn).toBe(true);
    expect(outcome.error).toMatch(/invalid_grant/);
    const [row] = await raw<{ status: string; last_error: string }[]>`
      select status, last_error from public.integration_connection where organization_id = ${ORG} and provider = 'google_ads'`;
    expect(row!.status).toBe("needs_reauth");
    expect(row!.last_error).not.toContain(oauth.refreshToken);
    await expect(adsService.syncPlatform({ ...ctx(), idempotencyKey: "ads-google-sync" }, { provider: "google_ads" }, deps))
      .rejects.toThrow(ConflictError);
    const platforms = await adPlatforms.platforms(ctx());
    expect(platforms.find((p) => p.provider === "google_ads")!.notices.join(" ")).toMatch(/Sign in again/);
  });

  it("is connected again by signing in again", async () => {
    oauth.revoked = false;
    const started = await adPlatforms.startSignIn({ ...ctx(), idempotencyKey: "ads-google-again" }, { provider: "google_ads" }, deps);
    const done = await adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code: "good-code" }, deps);
    expect(done.status).toBe("connected");
  });

  it("forgets the grant when Google Ads is disconnected", async () => {
    await leadIntake.disconnect(ctx(), "google_ads");
    const grants = await raw`select 1 from public.sealed_credential where organization_id = ${ORG}`;
    expect(grants).toHaveLength(0);
  });
});
