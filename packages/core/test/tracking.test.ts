import { describe, it, expect } from "vitest";
import {
  attributionQuery, pathOf, checkPublicTouch, isVisitorId, checkTrackingSettings, leaseAt, choosePoolNumber,
  fallbackNumber, formatLike, nationalDigits, SNIPPET_HELPERS, snippetSource, lapsesAt,
} from "../src/tracking/index.js";

/**
 * THE COMPANY'S OWN WEBSITE
 *
 * Two failures matter here. A touch endpoint on the open internet that keeps
 * whatever was in somebody's address bar keeps their search, their email and
 * their reset token. And a number swap that writes the new number in a
 * different shape from the old one is a page that looks broken.
 */

describe("what a touch from a website keeps", () => {
  it("keeps the attribution parameters and drops everything else", () => {
    const kept = attributionQuery("?utm_source=google&email=a%40b.com&gclid=ABC&token=secret&ref=KQ7M2P&q=leaking+tap");
    expect(kept).toBe("utm_source=google&gclid=ABC&ref=KQ7M2P");
  });

  it("keeps every click id an ads platform matches on, including the iPhone ones", () => {
    expect(attributionQuery("gbraid=1&wbraid=2&fbclid=3&msclkid=4")).toBe("gbraid=1&wbraid=2&fbclid=3&msclkid=4");
  });

  it("does not throw on a query that will not decode, and clips long values", () => {
    expect(attributionQuery("utm_source=%E0%A4%A")).toBe("utm_source=%25E0%25A4%25A");
    expect(attributionQuery(`utm_content=${"x".repeat(1000)}`).length).toBeLessThan(320);
  });

  it("keeps a page's path and never its query", () => {
    expect(pathOf("https://acme.com/ac-repair?email=a@b.com#top")).toBe("/ac-repair");
    expect(pathOf("/contact?x=1")).toBe("/contact");
    expect(pathOf("javascript:alert(1)")).toBeNull();
  });

  it("refuses a visitor id the snippet would never make", () => {
    expect(isVisitorId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isVisitorId("someone@example.com")).toBe(false);
    expect(isVisitorId("short")).toBe(false);
    expect(checkPublicTouch({ visitorId: "x".repeat(100) }).ok).toBe(false);
  });

  it("reads the attribution from the page when no query is sent", () => {
    const touch = checkPublicTouch({ visitorId: "abcdefghijklmnop", page: "/offer?utm_source=mailer&name=Bob" });
    expect(touch.ok && touch.query).toBe("utm_source=mailer");
    expect(touch.ok && touch.landingPath).toBe("/offer");
  });

  it("refuses a referrer that is not a web address", () => {
    const touch = checkPublicTouch({ visitorId: "abcdefghijklmnop", referrer: "android-app://x" });
    expect(touch.ok && touch.referrer).toBeNull();
  });
});

describe("how long a quiet visitor keeps a number", () => {
  it("defaults to half an hour and refuses the extremes", () => {
    expect(checkTrackingSettings({})).toEqual({ ok: true, settings: { idleMinutes: 30 } });
    expect(checkTrackingSettings({ idleMinutes: 1 }).ok).toBe(false);
    expect(checkTrackingSettings({ idleMinutes: 1000 }).ok).toBe(false);
  });
});

describe("which visit a call on a pool number belongs to", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 3, 1, 12, minute));
  const lease = (id: string, assigned: number, seen: number, released: number | null = null) => ({
    id, phoneNumberId: "n1", assignedAt: at(assigned), lastSeenAt: at(seen), releasedAt: released === null ? null : at(released),
  });

  it("is the lease holding the number when the call started", () => {
    const leases = [lease("old", 0, 10, 40), lease("new", 45, 50)];
    expect(leaseAt(leases, at(20), 30)?.id).toBe("old");
    expect(leaseAt(leases, at(55), 30)?.id).toBe("new");
  });

  it("still covers a call a few minutes after the visitor left, up to the idle time", () => {
    expect(leaseAt([lease("a", 0, 10)], at(35), 30)?.id).toBe("a");
    expect(leaseAt([lease("a", 0, 10)], at(41), 30)).toBeNull();
  });

  it("is nobody for a call before the lease began", () => {
    expect(leaseAt([lease("a", 30, 40)], at(10), 30)).toBeNull();
  });

  it("lapses at the last sighting plus the idle time", () => {
    expect(lapsesAt(at(10), 30)).toEqual(at(40));
  });
});

describe("handing out pool numbers", () => {
  it("offers the number free the longest and nothing that is held", () => {
    const pool = [
      { id: "a", lastLeasedAt: new Date("2026-04-01T12:00:00Z") },
      { id: "b", lastLeasedAt: new Date("2026-04-01T09:00:00Z") },
      { id: "c", lastLeasedAt: null },
    ];
    expect(choosePoolNumber(pool, new Set())?.id).toBe("c");
    expect(choosePoolNumber(pool, new Set(["c"]))?.id).toBe("b");
    expect(choosePoolNumber(pool, new Set(["a", "b", "c"]))).toBeNull();
  });

  it("falls back to the visitor's own source number, then the main number", () => {
    const statics = [{ e164: "+15125550111", source: "google_ads" }];
    expect(fallbackNumber({ source: "google_ads", statics, main: "+15125550100" })).toBe("+15125550111");
    expect(fallbackNumber({ source: "meta_ads", statics, main: "+15125550100" })).toBe("+15125550100");
  });
});

describe("writing a swapped number the way the page wrote the old one", () => {
  const cases: [string, string][] = [
    ["(512) 555-0100", "(512) 555-0199"],
    ["512.555.0100", "512.555.0199"],
    ["512-555-0100", "512-555-0199"],
    ["+1 512 555 0100", "+1 512 555 0199"],
    ["1-512-555-0100", "1-512-555-0199"],
    ["5125550100", "5125550199"],
  ];

  it.each(cases)("%s becomes %s", (sample, expected) => {
    expect(formatLike(sample, "+15125550199")).toBe(expected);
  });

  it("writes a plain national form when the shape cannot hold the number", () => {
    expect(formatLike("555-0100", "+15125550199")).toBe("(512) 555-0199");
  });

  it("compares numbers by their national digits", () => {
    expect(nationalDigits("+1 (512) 555-0100")).toBe("5125550100");
  });

  /**
   * The snippet carries the same logic as source for the browser. Running
   * that source here against the same cases is what keeps the page and the
   * server from drifting apart.
   */
  it("runs the same in the browser's copy as here", () => {
    const helpers = new Function(`${SNIPPET_HELPERS}; return { otFormatLike, otAttribution };`)() as {
      otFormatLike: (sample: string, e164: string) => string;
      otAttribution: (raw: string) => string;
    };
    for (const [sample] of [...cases, ["555-0100", ""]] as [string, string][]) {
      expect(helpers.otFormatLike(sample, "+15125550199")).toBe(formatLike(sample, "+15125550199"));
    }
    const query = "?utm_source=google&email=a%40b.com&gclid=ABC&ref=KQ7M2P&utm_source=twice";
    expect(helpers.otAttribution(query)).toBe(attributionQuery(query));
  });

  it("builds one script per company with nothing per visitor in it", () => {
    const source = snippetSource({ apiBase: "https://ots.example/api", appBase: "https://ots.example", companyKey: "acme" });
    expect(source).toContain('"key":"acme"');
    expect(source).toContain("/v1/public/dni");
    expect(source).toContain("/v1/public/touches");
    expect(() => new Function(source)).not.toThrow();
  });
});
