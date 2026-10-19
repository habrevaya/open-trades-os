import { describe, it, expect } from "vitest";
import { ads, reviews } from "../src/index";

/**
 * A RECOMMENDATION IS NOT A RATING
 *
 * Facebook asks "do you recommend" and not for stars. These pin how one is
 * read from the Graph API, what a yes and a no are OWED (a reply, and for a no
 * a call) and how they are counted: as a share, never added to a star average.
 */
describe("a Facebook review, as what it is", () => {
  it("keeps stars as stars and a recommendation as a recommendation", () => {
    expect(ads.facebookReview({ rating: 4, has_rating: true })).toEqual({ kind: "stars", rating: 4 });
    expect(ads.facebookReview({ recommendation_type: "positive" })).toEqual({ kind: "recommendation", recommends: true });
    expect(ads.facebookReview({ recommendation_type: "negative" })).toEqual({ kind: "recommendation", recommends: false });
  });

  it("reads a recommendation that Facebook also gave a stale rating for as a recommendation", () => {
    expect(ads.facebookReview({ rating: 5, has_rating: false, recommendation_type: "negative" }))
      .toEqual({ kind: "recommendation", recommends: false });
  });

  it("is nothing when it is neither, rather than a guess", () => {
    expect(ads.facebookReview({})).toBeNull();
    expect(ads.facebookReview({ rating: 9, recommendation_type: "unsure" })).toBeNull();
  });

  it("leaves the older stars-only reading as it was", () => {
    expect(ads.facebookRating({ recommendation_type: "positive" })).toBe(5);
    expect(ads.facebookRating({ recommendation_type: "negative" })).toBe(1);
  });
});

describe("what a yes and a no are owed", () => {
  it("is a reply as a five and a one are, and a call for a no as a one star is", () => {
    expect(reviews.owedRating(true)).toBe(5);
    expect(reviews.owedRating(false)).toBe(1);
    const policy = { recoverAtOrBelow: 3, sameDayAtOrBelow: 2 };
    const at = new Date("2026-10-06T15:00:00Z");
    const no = reviews.routeReply({ jobId: "", customerId: "", rating: reviews.owedRating(false), receivedAt: at }, policy);
    const yes = reviews.routeReply({ jobId: "", customerId: "", rating: reviews.owedRating(true), receivedAt: at }, policy);
    expect(no).toMatchObject({ recover: true, urgency: "same_day" });
    expect(yes.recover).toBe(false);
  });
});

describe("the share who recommend", () => {
  it("is null, never zero, when nobody has been asked", () => {
    expect(reviews.recommendationShare([])).toMatchObject({ count: 0, recommend: 0, doNot: 0, share: null });
  });

  it("counts yes against all, and is not a star average", () => {
    const view = reviews.recommendationShare([{ recommends: true }, { recommends: true }, { recommends: false }, { recommends: true }]);
    expect(view).toMatchObject({ count: 4, recommend: 3, doNot: 1, share: 0.75 });
    expect(view.caveat).toContain("never added to the star average");
  });

  it("leaves the star views to the star reviews alone", () => {
    const at = new Date("2026-10-06T15:00:00Z");
    const stars = [
      { id: "1", platform: "google", rating: 5, postedAt: at },
      { id: "2", platform: "google", rating: 4, postedAt: at },
    ];
    const view = reviews.summarise(stars, { halfLifeDays: 365 }, at);
    expect(view.mean).toBe(4.5);
  });
});
