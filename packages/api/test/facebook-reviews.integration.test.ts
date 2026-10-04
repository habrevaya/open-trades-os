import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as reviewSync from "../src/services/review-sync";
import * as reviews from "../src/services/reviews";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { ENV, fakePlatform, formOf, readSecret, stateOf } from "./ads-fakes";

/**
 * A FACEBOOK PAGE'S RATINGS AND RECOMMENDATIONS, AGAINST A FAKE GRAPH API
 *
 * The connector reads through the reviews module's own record, like Google's:
 * a recommendation becomes a rating the recovery clock understands, a reply
 * the Page already made comes in as the reply, a reply written here goes back
 * as a comment from the Page, and a rating Facebook gives nothing to reply to
 * is refused in words rather than posted nowhere. Meta's refusal while the
 * app has not passed review is shown in Meta's own words, because that is the
 * state every deployment starts in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("fb-reviews:org");
const USER = fixtureId("fb-reviews:user");
const PAGE = "5566778899";
const GRAPH = "https://graph.fb.fake/v21.0";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string, roles: ("owner" | "dispatcher")[] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});

const fake = fakePlatform();
const deps = { transport: fake.transport, readSecret, env: ENV };
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

/** What the Page's ratings edge answers, in two pages, and what the Page has commented. */
let firstPage: Record<string, unknown>[] = [];
let secondPage: Record<string, unknown>[] = [];
const comments: { story: string; message: string }[] = [];
let notReviewed = false;

fake.on("GET", /^https:\/\/graph\.fb\.fake\/token\?/, (call) => {
  const q = new URL(call.url).searchParams;
  if (q.get("grant_type") === "fb_exchange_token") return { status: 200, body: { access_token: "fb-user-long", expires_in: 5_184_000 } };
  return { status: 200, body: { access_token: "fb-user-short", expires_in: 3600 } };
});
fake.on("GET", new RegExp(`^${GRAPH.replace(/\./g, "\\.")}/${PAGE}\\?fields=access_token$`), (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer fb-user-long");
  return { status: 200, body: { access_token: "fb-page-token", id: PAGE } };
});
fake.on("GET", new RegExp(`^${GRAPH.replace(/\./g, "\\.")}/${PAGE}/ratings\\?`), (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer fb-page-token");
  if (notReviewed) {
    return { status: 403, body: { error: { message: "(#10) This endpoint requires the 'pages_read_user_content' permission.", code: 10 } } };
  }
  const after = new URL(call.url).searchParams.get("after");
  return after === "cursor-2"
    ? { status: 200, body: { data: secondPage, paging: { cursors: { after: "cursor-3" } } } }
    : { status: 200, body: { data: firstPage, paging: { cursors: { after: "cursor-2" }, next: `${GRAPH}/${PAGE}/ratings?after=cursor-2` } } };
});
fake.on("POST", new RegExp(`^${GRAPH.replace(/\./g, "\\.")}/[0-9_]+/comments$`), (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer fb-page-token");
  const story = call.url.replace(`${GRAPH}/`, "").replace(/\/comments$/, "");
  comments.push({ story, message: formOf(call.body)["message"]! });
  return { status: 200, body: { id: `${story}_c${comments.length}` } };
});

/**
 * Meta is a local fake, reached through the connection's own `baseUrl` and
 * `authUrl`. Only a test may point a provider somewhere else
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Facebook Reviews Co", slug: "fb-reviews-co" });
  await reviews.setPolicy(ctx(), {
    timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90, requirePaid: true,
    maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
  });
  await reviews.setPlatform(ctx(), {
    platform: "facebook", displayName: "Facebook", prohibits: ["incentives"], note: "Recommendations, not stars, since 2018.",
  });
});
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

const reviewOf = async (externalId: string) => (await raw<{
  id: string; platform: string; rating: number; body: string | null; author_name: string | null;
  reply_state: string | null; response_body: string | null; recovery_due_at: Date | null; reply_error: string | null;
}[]>`select id, platform, rating, body, author_name, reply_state, response_body, recovery_due_at, reply_error
  from public.review where organization_id = ${ORG} and external_id = ${externalId}`)[0];

run("a Facebook Page's reviews", () => {
  it("is connected with a Meta sign in that asks for the Page review scopes and nothing broader", async () => {
    await leadIntake.connect(ctx(), {
      provider: "facebook_page",
      settings: {
        pageId: PAGE, oauthClientRef: "META_OAUTH_CLIENT",
        authUrl: "https://facebook.fake/dialog", tokenUrl: "https://graph.fb.fake/token", baseUrl: "https://graph.fb.fake",
      },
    });
    const started = await adPlatforms.startSignIn(ctx("fb-sign-in"), { provider: "facebook_page" }, deps);
    const scopes = (new URL(started.url).searchParams.get("scope") ?? "").split(/[ ,]/);
    expect(scopes.sort()).toEqual(["pages_manage_engagement", "pages_read_engagement", "pages_read_user_content", "pages_show_list"]);
    const done = await adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code: "fb-code" }, deps);
    expect(done.status).toBe("connected");
  });

  it("reads ratings and recommendations, every page of them, into the review work list as facebook", async () => {
    firstPage = [
      { created_time: hoursAgo(3), recommendation_type: "negative", review_text: "Never showed up.",
        reviewer: { id: "r1", name: "Dana Fox" }, open_graph_story: { id: "111_901" } },
      { created_time: hoursAgo(30), recommendation_type: "positive", review_text: "",
        reviewer: { id: "r2", name: "Eli Park" },
        open_graph_story: { id: "111_902", comments: { data: [
          { message: "Thanks Eli!", created_time: hoursAgo(20), from: { id: PAGE } },
          { message: "Agreed, great crew", created_time: hoursAgo(25), from: { id: "someone-else" } },
        ] } } },
    ];
    secondPage = [
      { created_time: hoursAgo(900), has_rating: true, rating: 4, review_text: "Good, a bit pricey.",
        reviewer: { id: "r3", name: "Old Timer" }, open_graph_story: { id: "111_903" } },
      { created_time: hoursAgo(1000), recommendation_type: "positive", reviewer: { id: "r4", name: "No Story" } },
      { created_time: hoursAgo(1100), reviewer: { id: "r5", name: "Nothing Said" } },
    ];
    const outcome = await reviewSync.syncNow(ctx("fb-sync-1"), deps);
    expect(outcome.listings).toEqual([{ provider: "facebook_page", read: 4, written: 4, error: null }]);

    const no = (await reviewOf("111_901"))!;
    expect(no).toMatchObject({ platform: "facebook", rating: 1, body: "Never showed up.", author_name: "Dana Fox", reply_state: null });
    expect(no.recovery_due_at).not.toBeNull();
    const yes = (await reviewOf("111_902"))!;
    expect(yes).toMatchObject({ rating: 5, body: "Recommends you on Facebook.", reply_state: "posted", response_body: "Thanks Eli!" });
    expect((await reviewOf("111_903"))!.rating).toBe(4);
    const loose = await raw<{ external_id: string }[]>`
      select external_id from public.review where organization_id = ${ORG} and author_name = 'No Story'`;
    expect(loose[0]!.external_id).toMatch(/^facebook-rating:r4:/);
    // Neither stars nor a recommendation is not a rating, and is left out rather than guessed.
    const [nothing] = await raw`select count(*)::int as n from public.review where organization_id = ${ORG} and author_name = 'Nothing Said'`;
    expect(nothing!["n"]).toBe(0);

    // Everything unanswered is on the work list; the recommendation the Page already thanked is not.
    const work = await reviews.workList(ctx());
    expect(work.map((w) => w.rating).sort()).toEqual([1, 4, 5]);
  });

  it("is the same review when read again, not a second one", async () => {
    await reviewSync.syncNow(ctx("fb-sync-2"), deps);
    const [count] = await raw`select count(*)::int as n from public.review where organization_id = ${ORG}`;
    expect(count!["n"]).toBe(4);
  });

  it("posts a reply written here back as a comment from the Page", async () => {
    const no = (await reviewOf("111_901"))!;
    await reviews.respond(ctx(), { id: no.id, body: "Dana, I am sorry. I will call you this morning." });
    const posted = await reviewSync.postPendingReplies(db(), await adPlatforms.connectedRow(db(), ORG, "facebook_page"), deps);
    expect(posted).toBe(1);
    expect(comments).toEqual([{ story: "111_901", message: "Dana, I am sorry. I will call you this morning." }]);
    expect((await reviewOf("111_901"))!.reply_state).toBe("posted");
  });

  it("refuses, in words, a reply to a rating Facebook gives nothing to reply to", async () => {
    const [row] = await raw<{ id: string; external_id: string }[]>`
      select id, external_id from public.review where organization_id = ${ORG} and author_name = 'No Story'`;
    await reviews.respond(ctx(), { id: row!.id, body: "Thank you!" });
    await reviewSync.postPendingReplies(db(), await adPlatforms.connectedRow(db(), ORG, "facebook_page"), deps);
    const after = (await reviewOf(row!.external_id))!;
    expect(after.reply_state).toBe("failed");
    expect(after.reply_error).toMatch(/has to be made on Facebook/);
    expect(comments).toHaveLength(1);
  });

  it("names the listing on the review screen as Facebook's", async () => {
    const listed = await reviewSync.listings(ctx());
    expect(listed).toEqual([expect.objectContaining({ provider: "facebook_page", label: "Facebook Page reviews", site: "Facebook", status: "connected" })]);
  });

  it("says, in Meta's words, that the app has not passed review, and writes nothing", async () => {
    notReviewed = true;
    const outcome = await reviewSync.syncNow(ctx("fb-sync-3"), deps);
    notReviewed = false;
    expect(outcome.listings[0]!.error).toMatch(/pages_read_user_content/);
    const [count] = await raw`select count(*)::int as n from public.review where organization_id = ${ORG}`;
    expect(count!["n"]).toBe(4);
  });

  it("is refused to somebody without the reviews permission", async () => {
    await expect(reviewSync.syncNow(ctx(undefined, ["dispatcher"]), deps)).rejects.toThrow();
  });
});
