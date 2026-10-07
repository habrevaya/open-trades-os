import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as adsService from "../src/services/ads";
import * as reviewSync from "../src/services/review-sync";
import * as reviews from "../src/services/reviews";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { ENV, fakeGoogleOAuth, fakePlatform, readSecret, stateOf } from "./ads-fakes";

/**
 * GOOGLE BUSINESS PROFILE REVIEWS AND LOCAL SERVICES LEADS, AGAINST FAKES
 *
 * Reviews arrive through the reviews module's own record, a reply already on
 * Google comes in as the reply, a reply written here goes back to Google,
 * and who wrote a review is suggested and only a person confirms it. Local
 * Services leads land in the lead inbox credited to Local Services, once
 * each however often they are read. And the worker visits each platform on
 * its own clock, not on every tick.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-reviews:org");
const USER = fixtureId("ads-reviews:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (roles: ("owner" | "dispatcher")[] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

const fake = fakePlatform();
fakeGoogleOAuth(fake);
const deps = { transport: fake.transport, readSecret, env: ENV };
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

const REVIEW_BASE = "accounts/111/locations/222/reviews";
let listing: Record<string, unknown>[] = [];
const replies: { name: string; comment: string }[] = [];
let refuseReplies = false;

fake.on("GET", /^https:\/\/gbp\.fake\/v4\/accounts\/111\/locations\/222\/reviews\?/, () => ({
  status: 200, body: { reviews: listing, totalReviewCount: listing.length },
}));
fake.on("PUT", /^https:\/\/gbp\.fake\/v4\/accounts\/111\/locations\/222\/reviews\/[^/]+\/reply$/, (call) => {
  if (refuseReplies) return { status: 400, body: { error: { message: "Reply contains content that violates policy." } } };
  const name = call.url.replace("https://gbp.fake/v4/", "").replace(/\/reply$/, "");
  const { comment } = JSON.parse(call.body) as { comment: string };
  replies.push({ name, comment });
  return { status: 200, body: { comment, updateTime: new Date().toISOString() } };
});

let lsaLeads: Record<string, unknown>[] = [];
fake.on("POST", /^https:\/\/ads\.fake\/v21\/customers\/5556667777\/googleAds:search$/, (call) => {
  const query = (JSON.parse(call.body) as { query: string }).query;
  if (query.includes("FROM local_services_lead")) return { status: 200, body: { results: lsaLeads } };
  return { status: 200, body: { results: [] } };
});

/**
 * The platforms are local fakes, reached through the connections' own
 * `baseUrl`/`authUrl`. Only a test may point a provider somewhere else
 * (docs/self-hosting/secrets.md), and this file says so for itself.
 */
const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
afterAll(() => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
});

beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads Reviews Co", slug: "ads-reviews-co" });
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

async function signIn(provider: string) {
  const started = await adPlatforms.startSignIn({ ...ctx(), idempotencyKey: `sign-in-${provider}` }, { provider }, deps);
  return adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code: "good-code" }, deps);
}

run("Google Business Profile reviews", () => {
  let mariaId = "";
  let mariaJob = "";

  beforeAll(async () => {
    if (!url) return;
    await reviews.setPolicy(ctx(), {
      timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90, requirePaid: true,
      maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
    });
    await reviews.setPlatform(ctx(), {
      platform: "google", displayName: "Google Business Profile",
      prohibits: ["incentives", "bulk_requests", "templated_replies"], note: "Read their policy in October 2026.",
    });
    const maria = await customers.create(ctx(), {
      type: "residential", name: "Maria Lopez", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "9 Cedar Ct", city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
    });
    mariaId = maria.id as string;
    const [property] = await raw<{ id: string }[]>`select property_id as id from public.customer_property where customer_id = ${mariaId}`;
    const job = await jobs.create(ctx(), { customerId: mariaId, propertyId: property!.id, summary: "Water heater", tags: [], customFields: {} });
    mariaJob = job.id as string;
    await raw`update public.job set completed_at = now() - interval '3 days', status = 'completed' where id = ${mariaJob}`;

    await leadIntake.connect(ctx(), {
      provider: "google_business_profile",
      settings: {
        accountId: "accounts/111", locationId: "locations/222", oauthClientRef: "GOOGLE_OAUTH_CLIENT",
        authUrl: "https://oauth.fake/auth", tokenUrl: "https://oauth.fake/token", baseUrl: "https://gbp.fake",
      },
    });
    await signIn("google_business_profile");
  });

  it("reads the listing into the review work list, with a reply already on Google counted as answered", async () => {
    listing = [
      { name: `${REVIEW_BASE}/r1`, reviewId: "r1", reviewer: { displayName: "Maria Lopez" }, starRating: "TWO",
        comment: "Took three visits.", createTime: hoursAgo(5), updateTime: hoursAgo(5) },
      { name: `${REVIEW_BASE}/r2`, reviewId: "r2", reviewer: { displayName: "A Google user", isAnonymous: true }, starRating: "FIVE",
        comment: "Great.", createTime: hoursAgo(50), updateTime: hoursAgo(50),
        reviewReply: { comment: "Thank you for having us out.", updateTime: hoursAgo(40) } },
    ];
    const outcome = await reviewSync.syncNow({ ...ctx(), idempotencyKey: "reviews-sync-1" }, deps);
    expect(outcome.listings[0]).toMatchObject({ provider: "google_business_profile", read: 2, error: null });

    const work = await reviews.workList(ctx());
    expect(work.map((w) => w.rating)).toEqual([2]);
    expect(work[0]!.recoveryDueAt).not.toBeNull();
    const [answered] = await raw<{ reply_state: string; response_body: string }[]>`
      select reply_state, response_body from public.review where organization_id = ${ORG} and external_id = ${`${REVIEW_BASE}/r2`}`;
    expect(answered).toEqual({ reply_state: "posted", response_body: "Thank you for having us out." });
  });

  it("is the same review when read again, not a second one", async () => {
    await reviewSync.syncNow({ ...ctx(), idempotencyKey: "reviews-sync-2" }, deps);
    const rows = await raw`select 1 from public.review where organization_id = ${ORG}`;
    expect(rows).toHaveLength(2);
  });

  it("suggests the customer whose name and finished job fit, and never writes them on by itself", async () => {
    const [row] = await raw<{ id: string; customer_id: string | null; suggested_customer_id: string; suggestion_reason: string }[]>`
      select id, customer_id, suggested_customer_id, suggestion_reason from public.review
      where organization_id = ${ORG} and external_id = ${`${REVIEW_BASE}/r1`}`;
    expect(row!.customer_id).toBeNull();
    expect(row!.suggested_customer_id).toBe(mariaId);
    expect(row!.suggestion_reason).toMatch(/Maria Lopez had a job finished 3 days before the review/);

    const confirmed = await reviewSync.confirmMatch({ ...ctx(), idempotencyKey: "match-r1" }, { id: row!.id, accept: true });
    expect(confirmed).toEqual({ id: row!.id, customerId: mariaId, jobId: mariaJob });
    await expect(reviewSync.confirmMatch(ctx(), { id: row!.id, accept: true })).rejects.toThrow(/no suggestion/);
  });

  it("posts a reply written here back to Google", async () => {
    const [row] = await raw<{ id: string }[]>`select id from public.review where external_id = ${`${REVIEW_BASE}/r1`}`;
    await reviews.respond(ctx(), { id: row!.id, body: "Maria, I am sorry it took three trips. I will ring you today." });
    const [pending] = await raw<{ reply_state: string }[]>`select reply_state from public.review where id = ${row!.id}`;
    expect(pending!.reply_state).toBe("pending");

    const posted = await reviewSync.postPendingReplies(db(), await adPlatforms.connectedRow(db(), ORG, "google_business_profile"), deps);
    expect(posted).toBe(1);
    expect(replies).toEqual([{ name: `${REVIEW_BASE}/r1`, comment: "Maria, I am sorry it took three trips. I will ring you today." }]);
    const [after] = await raw<{ reply_state: string; reply_posted_at: Date | null }[]>`
      select reply_state, reply_posted_at from public.review where id = ${row!.id}`;
    expect(after!.reply_state).toBe("posted");
    expect(after!.reply_posted_at).not.toBeNull();
  });

  it("writes Google's refusal of a reply on the review in Google's words", async () => {
    listing = [...listing, { name: `${REVIEW_BASE}/r3`, reviewer: { displayName: "Sam K." }, starRating: "ONE",
      comment: "No show.", createTime: hoursAgo(1), updateTime: hoursAgo(1) }];
    await reviewSync.syncNow({ ...ctx(), idempotencyKey: "reviews-sync-3" }, deps);
    const [row] = await raw<{ id: string }[]>`select id from public.review where external_id = ${`${REVIEW_BASE}/r3`}`;
    await reviews.respond(ctx(), { id: row!.id, body: "Sam, that should not have happened. Please call me directly." });
    refuseReplies = true;
    await reviewSync.postPendingReplies(db(), await adPlatforms.connectedRow(db(), ORG, "google_business_profile"), deps);
    refuseReplies = false;
    const [after] = await raw<{ reply_state: string; reply_error: string }[]>`
      select reply_state, reply_error from public.review where id = ${row!.id}`;
    expect(after!.reply_state).toBe("failed");
    expect(after!.reply_error).toMatch(/violates policy/);
  });

  it("is refused to somebody without the reviews permission", async () => {
    await expect(reviewSync.syncNow(ctx(["dispatcher"]), deps)).rejects.toThrow();
  });
});

run("Google Local Services leads", () => {
  beforeAll(async () => {
    if (!url) return;
    await leadIntake.connect(ctx(), {
      provider: "google_lsa",
      settings: {
        customerId: "555-666-7777", developerTokenRef: "GOOGLE_ADS_DEVELOPER_TOKEN", oauthClientRef: "GOOGLE_OAUTH_CLIENT",
        authUrl: "https://oauth.fake/auth", tokenUrl: "https://oauth.fake/token", baseUrl: "https://ads.fake",
      },
    });
    await signIn("google_lsa");
  });

  it("puts calls and messages in the lead inbox, credited to Local Services", async () => {
    lsaLeads = [
      { localServicesLead: { id: "9001", leadType: "PHONE_CALL", categoryId: "xcat:service_area_business_hvac",
        contactDetails: { phoneNumber: "+15125550123", consumerName: "Dana Wright" }, leadStatus: "NEW",
        creationDateTime: new Date(Date.now() - 600_000).toISOString().slice(0, 19).replace("T", " "), leadCharged: true } },
      { localServicesLead: { id: "9002", leadType: "MESSAGE", categoryId: "xcat:service_area_business_plumber",
        contactDetails: { email: "chris@example.com" }, leadStatus: "NEW",
        creationDateTime: new Date(Date.now() - 300_000).toISOString().slice(0, 19).replace("T", " "), leadCharged: false } },
    ];
    const outcome = await adsService.syncPlatform({ ...ctx(), idempotencyKey: "lsa-sync-1" }, { provider: "google_lsa" }, deps);
    expect(outcome.runs.find((r) => r.entity === "leads")).toMatchObject({ read: 2, written: 2, error: null });

    const offers = await leadIntake.openOffers(ctx());
    const dana = offers.find((o) => o.contactName === "Dana Wright")!;
    expect(dana).toMatchObject({ connector: "Google Local Services Ads", contactPhone: "+15125550123", serviceRequested: "hvac" });
    expect(dana.notes).toBe("A call through Google Local Services, charged.");
    expect(offers.find((o) => o.contactEmail === "chris@example.com")!.contactName).toBe("Local Services lead");

    const touches = await raw<{ source: string }[]>`
      select source from public.marketing_touch where organization_id = ${ORG} and visitor_id like 'lead_offer:%'`;
    expect(touches.map((t) => t.source)).toEqual(["google_lsa", "google_lsa"]);
  });

  it("reads the same lead twice as the same lead", async () => {
    await adsService.syncPlatform({ ...ctx(), idempotencyKey: "lsa-sync-2" }, { provider: "google_lsa" }, deps);
    const offers = await raw`select 1 from public.lead_offer where organization_id = ${ORG}`;
    expect(offers).toHaveLength(2);
  });

  it("asks for the leads since the last pull, less an hour of overlap", async () => {
    const query = (JSON.parse(fake.callsTo(/5556667777\/googleAds:search/).filter((c) => c.body.includes("local_services_lead")).at(-1)!.body) as { query: string }).query;
    const since = /creation_date_time >= '([^']+)'/.exec(query)![1]!;
    const gap = Date.now() - new Date(`${since.replace(" ", "T")}Z`).getTime();
    expect(gap).toBeGreaterThan(3_600_000);
    expect(gap).toBeLessThan(3_600_000 + 15 * 60_000);
  });
});

run("the worker's clock", () => {
  it("visits each connected platform when its cadence is due, and not on every tick", async () => {
    await raw`update public.sync_run set started_at = now() - interval '2 hours' where organization_id = ${ORG}`;
    const listed = await raw<{ organization_id: string }[]>`select organization_id from app.ad_work_organizations(10000)`;
    expect(listed.map((r) => r.organization_id)).toContain(ORG);

    /** One company's turn, which the pass gives every company it lists; other test files' companies are left alone. */
    const first = await adsService.adsForOrganization(db(), ORG, { deps });
    expect(first.map((o) => `${o.provider}:${o.entity}`).sort()).toEqual([
      "google_business_profile:reviews", "google_lsa:leads",
    ]);
    expect(await adsService.adsForOrganization(db(), ORG, { deps })).toEqual([]);
  });
});
