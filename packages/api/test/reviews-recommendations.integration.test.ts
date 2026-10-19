import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as reviews from "../src/services/reviews";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A FACEBOOK RECOMMENDATION IS A RECOMMENDATION, NOT STARS (M20)
 *
 * Facebook asks "do you recommend" and not for stars. Counted as five and one,
 * a yes made the average say every recommendation was a perfect score. What is
 * pinned: it is its own kind of review, stored without a rating, left out of
 * every star average and counted as the share who recommend; a no still starts
 * the clock for a reply and a call, as a one star does; a recommendation read
 * again is the same review; and the database refuses a review that is both.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("reco-reviews:org");
const USER = fixtureId("reco-reviews:user");

let raw: postgres.Sql;
let technicianId = "";
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Recommend Co", slug: "reco-reviews-co" });
  await reviews.setPolicy(owner(), {
    timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90, requirePaid: true,
    maxJobAgeDays: 14, earliestHour: 9, latestHour: 19,
  });
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${USER}, 'owner') on conflict do nothing returning id`;
  const membership = m?.id ?? (await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`)[0]!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership}, 'Sam Rivera') returning id`;
  technicianId = t!.id;
});

const yes = (externalId: string, over: Partial<Parameters<typeof reviews.record>[1]> = {}) =>
  reviews.record(owner(), { platform: "facebook", externalId, recommends: true, postedAt: hoursAgo(30), body: "Great crew.", ...over });
const no = (externalId: string, over: Partial<Parameters<typeof reviews.record>[1]> = {}) =>
  reviews.record(owner(), { platform: "facebook", externalId, recommends: false, postedAt: hoursAgo(3), body: "Never showed up.", ...over });
const stars = (externalId: string, rating: number, over: Partial<Parameters<typeof reviews.record>[1]> = {}) =>
  reviews.record(owner(), { platform: "google", externalId, rating, postedAt: hoursAgo(50), body: "Fine.", ...over });

run("recording a recommendation", () => {
  it("is stored as its own kind, with no rating, and says what is owed", async () => {
    const saved = await yes("fb-1");
    expect(saved).toMatchObject({ kind: "recommendation", rating: null, recommends: true, recoveryOwed: false });
    const [row] = await raw<{ kind: string; rating: number | null; recommends: boolean | null }[]>`
      select kind, rating, recommends from public.review where id = ${saved.id}`;
    expect(row).toEqual({ kind: "recommendation", rating: null, recommends: true });

    // A no starts the clock for a call exactly as a one star does.
    const refused = await no("fb-2");
    expect(refused).toMatchObject({ kind: "recommendation", rating: null, recommends: false, recoveryOwed: true });
    expect(refused.recoveryUrgency).toBe("same_day");
    expect(refused.recoveryDueAt).not.toBeNull();
    const oneStar = await stars("g-1", 1);
    expect(oneStar.recoveryUrgency).toBe(refused.recoveryUrgency);
  });

  it("is a yes or a no or a rating, never both and never neither", async () => {
    await expect(reviews.record(owner(), { platform: "facebook", rating: 5, recommends: true, postedAt: hoursAgo(1) }))
      .rejects.toThrow("has no rating");
    await expect(reviews.record(owner(), { platform: "facebook", postedAt: hoursAgo(1) }))
      .rejects.toThrow(ConflictError);
    await expect(stars("g-bad", 6)).rejects.toThrow("whole number from one to five");
    await expect(stars("g-bad2", 4.5)).rejects.toThrow(ConflictError);
  });

  it("is the same review when read again, and turns a star review into a recommendation when the source says so", async () => {
    // Stored before recommendations were their own kind: five stars with the person's own words.
    await raw`insert into public.review (organization_id, platform, external_id, kind, rating, body, posted_at)
      values (${ORG}, 'facebook', 'fb-old', 'stars', 5, 'Great crew, on time.', ${hoursAgo(100)})`;
    await yes("fb-old", { body: "Great crew, on time.", postedAt: hoursAgo(100) });
    await yes("fb-old", { body: "Great crew, on time.", postedAt: hoursAgo(100) });
    const rows = await raw<{ kind: string; rating: number | null; recommends: boolean | null }[]>`
      select kind, rating, recommends from public.review where organization_id = ${ORG} and external_id = 'fb-old'`;
    expect(rows).toEqual([{ kind: "recommendation", rating: null, recommends: true }]);
  });
});

run("what the averages count", () => {
  it("leaves recommendations out of every star average, and counts them as a share", async () => {
    await stars("g-1", 5);
    await stars("g-2", 4);
    await yes("fb-1");
    await yes("fb-2");
    await no("fb-3");

    const view = await reviews.rating(owner());
    // Only the two star reviews: the mean is 4.5, not the 3.8 that five and one would have made it.
    expect(view).toMatchObject({ count: 2, mean: 4.5 });
    expect(view.recommendations).toMatchObject({ count: 3, recommend: 2, doNot: 1 });
    expect(view.recommendations.share).toBeCloseTo(2 / 3, 10);

    // Narrowed to a platform, each answers for its own.
    expect(await reviews.rating(owner(), { platform: "facebook" })).toMatchObject({
      count: 0, mean: null, recommendations: { count: 3, recommend: 2 },
    });
    const google = await reviews.rating(owner(), { platform: "google" });
    expect(google).toMatchObject({ count: 2, mean: 4.5 });
    expect(google.recommendations).toMatchObject({ count: 0, share: null });
  });

  it("says nothing of a share when there are no recommendations, and not zero", async () => {
    await stars("g-1", 3);
    const view = await reviews.rating(owner());
    expect(view.recommendations.share).toBeNull();
    expect(view.recommendations.count).toBe(0);
  });

  it("ranks a technician by their star reviews only", async () => {
    await stars("g-1", 5, { technicianId });
    await stars("g-2", 4, { technicianId });
    await yes("fb-1", { technicianId });
    await no("fb-2", { technicianId });
    const ranked = await reviews.byTechnician(owner());
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ technicianId, count: 2, mean: 4.5 });
  });
});

run("the reply queue", () => {
  it("still owes a reply to a recommendation, and a no is the most urgent, as a one star is", async () => {
    await yes("fb-1", { postedAt: hoursAgo(2) });
    await no("fb-2", { postedAt: hoursAgo(2) });
    await stars("g-1", 5, { postedAt: hoursAgo(2) });
    const work = await reviews.workList(owner());
    expect(work).toHaveLength(3);
    const refused = work.find((w) => w.recommends === false)!;
    const thanked = work.find((w) => w.recommends === true)!;
    expect(refused).toMatchObject({ kind: "recommendation", rating: null, platform: "facebook" });
    expect(thanked).toMatchObject({ kind: "recommendation", rating: null });
    expect(work.find((w) => w.kind === "stars")).toMatchObject({ rating: 5, recommends: null });
    // The no owes a call; the yes does not.
    expect(refused.recoveryDueAt).not.toBeNull();
    expect(thanked.recoveryDueAt).toBeNull();
    // Its reply is due sooner than a yes's, as a one star's is than a five's.
    expect(refused.dueAt.getTime()).toBeLessThan(thanked.dueAt.getTime());
  });
});

run("the database", () => {
  it("refuses a review that is both a rating and a recommendation, or neither", async () => {
    const insert = (kind: string, rating: number | null, recommends: boolean | null) => raw`
      insert into public.review (organization_id, platform, kind, rating, recommends, posted_at)
      values (${ORG}, 'facebook', ${kind}::review_kind, ${rating}, ${recommends}, now())`;
    await expect(insert("recommendation", 5, true)).rejects.toThrow(/review_kind_fields/);
    await expect(insert("recommendation", null, null)).rejects.toThrow(/review_kind_fields/);
    await expect(insert("stars", null, null)).rejects.toThrow(/review_kind_fields/);
    await expect(insert("stars", 4, true)).rejects.toThrow(/review_kind_fields/);
    await expect(insert("stars", 0, null)).rejects.toThrow(/review_kind_fields/);
    await insert("stars", 4, null);
    await insert("recommendation", null, false);
  });
});
