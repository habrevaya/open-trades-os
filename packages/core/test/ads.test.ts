import { describe, it, expect } from "vitest";
import {
  PROVIDERS, ADS_PROVIDERS, answersFor, authorizeUrl, isDue, spendWindow, microsToAmount,
  sourceOfPlatformCampaign, matchCampaign, spendKey, normaliseEmail, normalisePhone, sha256Hex,
  gaClientIdFromCookie, isMetaBrowserId, metaClickParam, decideShare, eventId, retryAt,
  MAX_SEND_ATTEMPTS, googleDateTime, starRating, suggestReviewMatch, WITHHELD,
  sessionSource, decideAdjustment, adjustmentEventId, facebookRating, facebookVerdict,
  type Identifier, type ShareInput,
} from "../src/ads/index.js";

/**
 * TALKING TO THE AD PLATFORMS DIRECTLY
 *
 * Four things here cost real money or real trust when they are wrong. A hash
 * of the wrong spelling matches nobody and fails in silence. A send that can
 * be made twice makes the account bid as though the work were worth double. A
 * customer who said no whose click id goes anyway. And a review tied to the
 * wrong customer by a guess.
 */

const none: Record<Identifier, boolean> = {
  click_id: false, email: false, phone: false, client_id: false, browser_id: false,
};
const share = (input: Partial<Omit<ShareInput, "have">> & { have?: Partial<Record<Identifier, boolean>> }) =>
  decideShare({
    provider: input.provider ?? "google_ads",
    mode: input.mode ?? "consented",
    choice: input.choice ?? null,
    have: { ...none, ...input.have },
  });

describe("the providers", () => {
  it("asks each consent screen for exactly the scope it uses", () => {
    expect(PROVIDERS.google_ads.scopes).toEqual(["https://www.googleapis.com/auth/adwords"]);
    expect(PROVIDERS.google_lsa.scopes).toEqual(PROVIDERS.google_ads.scopes);
    expect(PROVIDERS.google_business_profile.scopes).toEqual(["https://www.googleapis.com/auth/business.manage"]);
    expect(PROVIDERS.ga4.oauth).toBeNull();
  });

  it("tells a platform only about work its own clicks touched, and the analytics property about any", () => {
    expect(answersFor("google_ads", "google_ads")).toBe(true);
    expect(answersFor("google_ads", "meta_ads")).toBe(false);
    expect(answersFor("meta_ads", "google_ads")).toBe(false);
    expect(answersFor("ga4", "yard_sign")).toBe(true);
  });

  it("never lets personal data go to the analytics property or the review listing", () => {
    expect(PROVIDERS.ga4.personalData).toBe(false);
    expect(PROVIDERS.google_business_profile.personalData).toBe(false);
    expect(PROVIDERS.facebook_page.personalData).toBe(false);
    /** Every provider is named, and only the two that match a click to a person may ever be sent one. */
    expect(ADS_PROVIDERS).toHaveLength(10);
    expect(ADS_PROVIDERS.filter((p) => PROVIDERS[p].personalData)).toEqual(["google_ads", "meta_ads"]);
  });
});

describe("signing in", () => {
  it("asks Google for offline access with the consent screen forced, so a refresh token always comes back", () => {
    const url = new URL(authorizeUrl({
      family: "google", clientId: "abc.apps.googleusercontent.com", redirectUri: "https://ots.test/cb",
      scopes: PROVIDERS.google_ads.scopes, state: "s1",
    }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ots.test/cb");
  });

  it("joins Meta's scopes with commas, and takes a fake endpoint for a test", () => {
    const url = new URL(authorizeUrl({
      family: "meta", endpoint: "http://127.0.0.1:9/dialog", clientId: "123", redirectUri: "https://ots.test/cb",
      scopes: PROVIDERS.meta_ads.scopes, state: "s2",
    }));
    expect(url.host).toBe("127.0.0.1:9");
    expect(url.searchParams.get("scope")).toBe("ads_read,ads_management");
    expect(url.searchParams.get("access_type")).toBeNull();
  });
});

describe("when to pull, and which days", () => {
  it("is due when never run, or once the cadence has passed", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(isDue(null, now, 60)).toBe(true);
    expect(isDue(new Date("2026-10-03T11:30:00Z"), now, 60)).toBe(false);
    expect(isDue(new Date("2026-10-03T11:00:00Z"), now, 60)).toBe(true);
  });

  it("reaches thirty days back the first time, then revisits the last three days", () => {
    expect(spendWindow({ today: "2026-10-03", lastThrough: null })).toEqual({ from: "2026-09-04", to: "2026-10-03" });
    expect(spendWindow({ today: "2026-10-03", lastThrough: "2026-10-03" })).toEqual({ from: "2026-10-01", to: "2026-10-03" });
  });

  it("never asks for more than ninety days, however long a connection was off", () => {
    expect(spendWindow({ today: "2026-10-03", lastThrough: "2025-01-01" })).toEqual({ from: "2026-07-06", to: "2026-10-03" });
  });
});

describe("micros", () => {
  it("becomes an exact amount at four places, rounded half up in integers", () => {
    expect(microsToAmount("1234567890")).toBe("1234.5679");
    expect(microsToAmount("1234560000")).toBe("1234.5600");
    expect(microsToAmount("49")).toBe("0.0000");
    expect(microsToAmount("50")).toBe("0.0001");
    expect(microsToAmount(0)).toBe("0.0000");
    // The float route gives 0.30000000000000004 for these two added; this never sees a float.
    expect(microsToAmount("300000")).toBe("0.3000");
  });

  it("refuses something that is not a whole number of micros", () => {
    expect(() => microsToAmount("12.5")).toThrow(/whole number/);
  });
});

describe("a platform's campaign, and ours", () => {
  const ours = [
    { id: "a", name: "Spring AC tune up", utm: "spring_ac" },
    { id: "b", name: "Furnace", utm: "brand" },
    { id: "c", name: "Brand", utm: null },
  ];

  it("files a Local Services campaign under Local Services, not under Google Ads", () => {
    expect(sourceOfPlatformCampaign("google_ads", "SEARCH")).toBe("google_ads");
    expect(sourceOfPlatformCampaign("google_ads", "LOCAL_SERVICES")).toBe("google_lsa");
    expect(sourceOfPlatformCampaign("meta_ads", null)).toBe("meta_ads");
  });

  it("matches by name or tag, ignoring case and spacing", () => {
    expect(matchCampaign("  spring AC   tune up ", ours)).toBe("a");
    expect(matchCampaign("SPRING_AC", ours)).toBe("a");
  });

  it("matches nobody when two of ours could be meant, rather than guessing", () => {
    expect(matchCampaign("Brand", ours)).toBeNull();
    expect(matchCampaign("Something else", ours)).toBeNull();
    expect(matchCampaign("", ours)).toBeNull();
  });

  it("keys a pulled row by account, campaign and day, so a re-pull finds it again", () => {
    expect(spendKey("1234567890", "99", "2026-10-01")).toBe("1234567890:99:2026-10-01");
  });
});

describe("hashing, the way each platform spells things first", () => {
  it("lower cases and trims an email for both, and drops the dots in a Gmail address for Google only", () => {
    expect(normaliseEmail("  Test@Example.COM ", "google")).toBe("test@example.com");
    expect(normaliseEmail("John.Smith@gmail.com", "google")).toBe("johnsmith@gmail.com");
    expect(normaliseEmail("John.Smith@googlemail.com", "google")).toBe("johnsmith@googlemail.com");
    expect(normaliseEmail("John.Smith@gmail.com", "meta")).toBe("john.smith@gmail.com");
    expect(normaliseEmail("not an email", "google")).toBeNull();
    expect(normaliseEmail(null, "meta")).toBeNull();
  });

  it("writes a phone in E.164 for Google and as bare digits for Meta", () => {
    expect(normalisePhone("(512) 555-0100", "google")).toBe("+15125550100");
    expect(normalisePhone("(512) 555-0100", "meta")).toBe("15125550100");
    expect(normalisePhone("555-0100", "google")).toBeNull();
  });

  it("hashes with SHA-256 as lower case hex, matching the published vectors", async () => {
    expect(await sha256Hex("test@example.com"))
      .toBe("973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b");
    expect(await sha256Hex(normaliseEmail("John.Smith@gmail.com", "google")!))
      .toBe("3586de92bb3636d0885a12eff961429a32e4ebd764b96f50d85d016f9338d586");
    expect(await sha256Hex(normalisePhone("512 555 0100", "google")!))
      .toBe("12945b229096fbeea14e73ff7096d927765584b9663358877238f4075eba0d89");
    expect(await sha256Hex(normalisePhone("512 555 0100", "meta")!))
      .toBe("33c6438defc14519a2f9147cbf01d0ccb0471bbaf4b17bff231402de8fcceda7");
  });
});

describe("the browser's own ids", () => {
  it("reads the client id out of the _ga cookie and refuses anything else", () => {
    expect(gaClientIdFromCookie("GA1.1.1234567890.1712345678")).toBe("1234567890.1712345678");
    expect(gaClientIdFromCookie("GA1.2.55.66")).toBe("55.66");
    expect(gaClientIdFromCookie("1234567890.1712345678")).toBe("1234567890.1712345678");
    expect(gaClientIdFromCookie("GA1.1.someone@example.com")).toBeNull();
    expect(gaClientIdFromCookie(null)).toBeNull();
  });

  it("knows Meta's browser id and writes its click id with the moment it was seen", () => {
    expect(isMetaBrowserId("fb.1.1712345678901.1234567890")).toBe(true);
    expect(isMetaBrowserId("fb.1.x.1")).toBe(false);
    expect(metaClickParam("IwAR2abc", new Date(1_712_345_678_901))).toBe("fb.1.1712345678901.IwAR2abc");
  });
});

describe("what may go to a platform about one customer", () => {
  it("sends nothing at all, not even a click id, for a customer who said no", () => {
    const decided = share({ choice: "refused", mode: "unless_refused", have: { click_id: true, email: true } });
    expect(decided).toEqual({ send: false, reason: "customer_refused", because: WITHHELD.customer_refused });
  });

  it("sends the click id alone under the default, for a customer never asked", () => {
    expect(share({ have: { click_id: true, email: true, phone: true } }))
      .toEqual({ send: true, identifiers: ["click_id"], adUserData: "DENIED" });
  });

  it("adds the hashed email and phone for a customer who said yes", () => {
    expect(share({ choice: "granted", have: { click_id: true, email: true, phone: true } }))
      .toEqual({ send: true, identifiers: ["click_id", "email", "phone"], adUserData: "GRANTED" });
  });

  it("adds them for everybody who did not say no, when the company chose that", () => {
    expect(share({ mode: "unless_refused", have: { email: true } }))
      .toEqual({ send: true, identifiers: ["email"], adUserData: "GRANTED" });
  });

  it("never sends them when the company said never, whatever the customer said", () => {
    expect(share({ mode: "never", choice: "granted", have: { email: true, phone: true } }))
      .toMatchObject({ send: false, reason: "nothing_to_match" });
    expect(share({ mode: "never", choice: "granted", have: { click_id: true, email: true } }))
      .toEqual({ send: true, identifiers: ["click_id"], adUserData: "DENIED" });
  });

  it("gives Meta its browser id, which is its own identifier handed back", () => {
    expect(share({ provider: "meta_ads", have: { browser_id: true } }))
      .toEqual({ send: true, identifiers: ["browser_id"], adUserData: "DENIED" });
  });

  it("gives the analytics property the client id and never a person's details", () => {
    expect(share({ provider: "ga4", mode: "unless_refused", have: { client_id: true, email: true, phone: true } }))
      .toEqual({ send: true, identifiers: ["client_id"], adUserData: "GRANTED" });
    expect(share({ provider: "ga4", have: { email: true } })).toMatchObject({ send: false, reason: "no_client_id" });
  });
});

describe("never counted twice", () => {
  it("carries the same event id every time a send is made for the same job", () => {
    const job = "4d5e6f70-0000-4000-8000-000000000001";
    expect(eventId("purchase", job)).toBe(eventId("purchase", job));
    expect(eventId("purchase", job)).not.toBe(eventId("lead", job));
    expect(eventId("purchase", job).length).toBeLessThanOrEqual(64);
  });

  it("backs off a failed send and then leaves it for a person", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(retryAt(1, now)).toEqual(new Date("2026-10-03T12:05:00Z"));
    expect(retryAt(2, now)).toEqual(new Date("2026-10-03T12:30:00Z"));
    expect(retryAt(MAX_SEND_ATTEMPTS, now)).toBeNull();
  });

  it("writes a conversion time the way Google's API reads it", () => {
    expect(googleDateTime(new Date("2026-04-01T14:05:09.123Z"))).toBe("2026-04-01 14:05:09+00:00");
  });
});

describe("reviews", () => {
  it("reads Google's star words and numbers, and refuses anything else", () => {
    expect(starRating("FOUR")).toBe(4);
    expect(starRating(5)).toBe(5);
    expect(starRating("STAR_RATING_UNSPECIFIED")).toBeNull();
    expect(starRating(6)).toBeNull();
  });

  const posted = new Date("2026-10-03T12:00:00Z");
  const daysBefore = (n: number) => new Date(posted.getTime() - n * 86_400_000);

  it("suggests the customer whose name and recent job fit, and says why", () => {
    const suggestion = suggestReviewMatch({ authorName: "Maria Lopez", postedAt: posted }, [
      { customerId: "c1", customerName: "Maria Lopez", jobId: "j1", finishedAt: daysBefore(3) },
      { customerId: "c2", customerName: "Mario Lopez", jobId: "j2", finishedAt: daysBefore(2) },
    ]);
    expect(suggestion).toEqual({
      customerId: "c1", jobId: "j1",
      because: "Signed \"Maria Lopez\", and Maria Lopez had a job finished 3 days before the review.",
    });
  });

  it("matches a first name and a last initial", () => {
    expect(suggestReviewMatch({ authorName: "John D.", postedAt: posted }, [
      { customerId: "c1", customerName: "John Davis", jobId: "j1", finishedAt: daysBefore(1) },
    ])?.customerId).toBe("c1");
  });

  it("suggests nobody on a first name alone, an old job, or two people who fit equally", () => {
    const john = { customerId: "c1", customerName: "John Davis", jobId: "j1", finishedAt: daysBefore(1) };
    expect(suggestReviewMatch({ authorName: "John", postedAt: posted }, [john])).toBeNull();
    expect(suggestReviewMatch({ authorName: "John Davis", postedAt: posted }, [{ ...john, finishedAt: daysBefore(60) }])).toBeNull();
    expect(suggestReviewMatch({ authorName: "John D.", postedAt: posted }, [
      john, { customerId: "c2", customerName: "John Dunn", jobId: "j2", finishedAt: daysBefore(2) },
    ])).toBeNull();
    expect(suggestReviewMatch({ authorName: null, postedAt: posted }, [john])).toBeNull();
  });

  it("does not suggest a job finished after the review was written", () => {
    expect(suggestReviewMatch({ authorName: "John Davis", postedAt: posted }, [
      { customerId: "c1", customerName: "John Davis", jobId: "j1", finishedAt: new Date(posted.getTime() + 3_600_000) },
    ])).toBeNull();
  });
});

describe("Microsoft, read back, and restating", () => {
  it("asks Microsoft for offline access on its own consent screen", () => {
    const url = new URL(authorizeUrl({
      family: "microsoft", clientId: "c", redirectUri: "https://x/settings/integrations/oauth",
      scopes: PROVIDERS.bing_ads.scopes, state: "s".repeat(20),
    }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("https://ads.microsoft.com/msads.manage offline_access");
    expect(url.searchParams.get("access_type")).toBeNull();
  });

  it("files a session under the same source a landing page's tags would be", () => {
    expect(sessionSource("(direct)", "(none)")).toBe("direct");
    expect(sessionSource("google", "organic")).toBe("organic_search");
    expect(sessionSource("google", "cpc")).toBe("google_ads");
    expect(sessionSource("weird.example", "referral")).toBe("unknown");
  });

  it("restates Google to the new value, retracts at nothing, and only ever adds to Meta", () => {
    expect(decideAdjustment({ provider: "google_ads", told: "400.0000", now: "400.00" })).toEqual({ kind: "none" });
    expect(decideAdjustment({ provider: "google_ads", told: "400.00", now: "550.00" })).toEqual({ kind: "restatement", value: "550.00" });
    expect(decideAdjustment({ provider: "google_ads", told: "400.00", now: "0.00" })).toEqual({ kind: "retraction" });
    expect(decideAdjustment({ provider: "meta_ads", told: "300.00", now: "400.00" })).toEqual({ kind: "increase", value: "100.00", total: "400.00" });
    expect(decideAdjustment({ provider: "meta_ads", told: "400.00", now: "340.00" })).toMatchObject({ kind: "cannot_lower" });
    expect(adjustmentEventId("j1", 2)).toBe("ots_purchase_j1_adj2");
  });
});

describe("a Facebook Page rating", () => {
  it("reads stars where there are stars, and a recommendation as five or one", () => {
    expect(facebookRating({ rating: 4, has_rating: true })).toBe(4);
    expect(facebookRating({ recommendation_type: "positive" })).toBe(5);
    expect(facebookRating({ recommendation_type: "negative", rating: 1 })).toBe(1);
    expect(facebookRating({ recommendation_type: "negative", has_rating: false, rating: 5 })).toBe(1);
    expect(facebookRating({})).toBeNull();
    expect(facebookVerdict({ recommendation_type: "negative" })).toMatch(/Does not recommend/);
  });
});
