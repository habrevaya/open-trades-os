import { describe, it, expect } from "vitest";
import {
  variantFor, compareRates, judgeTest, luckInWords, linkTag, checkVersionB, mergeScope, checkBody, ALPHA,
  type VersionCounts,
} from "../src/campaign/index.js";

/** A repeatable stream of ids shaped like the real ones, so the split is tried on more than a handful. */
function ids(count: number, seed = 1): string[] {
  let x = seed;
  const hex = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x.toString(16).padStart(8, "0");
  };
  return Array.from({ length: count }, () => `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`);
}

describe("which half of an audience a customer is in", () => {
  const campaign = "6f1d0c52-0b0e-4a1e-9c57-0d3a5a3b7c11";

  it("is the same answer every time for the same customer and campaign", () => {
    for (const customer of ids(50)) {
      expect(variantFor(campaign, customer)).toBe(variantFor(campaign, customer));
    }
  });

  it("splits a big audience close to half and half", () => {
    const people = ids(20_000, 7);
    const inA = people.filter((customer) => variantFor(campaign, customer) === "a").length;
    expect(inA / people.length).toBeGreaterThan(0.48);
    expect(inA / people.length).toBeLessThan(0.52);
  });

  it("does not put the same people in the same half of every campaign", () => {
    const people = ids(2_000, 3);
    const other = "0a9c5de4-77aa-4d54-8f2b-1d0e6b9c42aa";
    const same = people.filter((c) => variantFor(campaign, c) === variantFor(other, c)).length;
    /** Independent halves agree about half the time; the same split would agree always. */
    expect(same / people.length).toBeGreaterThan(0.45);
    expect(same / people.length).toBeLessThan(0.55);
  });

  it("does not depend on the order or the company of the others in the list", () => {
    const people = ids(100, 9);
    const forward = people.map((c) => variantFor(campaign, c));
    const backward = [...people].reverse().map((c) => variantFor(campaign, c)).reverse();
    expect(backward).toEqual(forward);
  });
});

describe("the two proportion test", () => {
  it("finds a real gap and says it in plain words, with the counts", () => {
    const result = compareRates({ n: 200, hits: 40 }, { n: 200, hits: 62 });
    expect(result.verdict).toBe("b_higher");
    expect(result.pValue).toBeCloseTo(0.0116, 3);
    expect(result.rateA).toBe("20.0");
    expect(result.rateB).toBe("31.0");
    expect(result.sentence).toContain("40 of 200 (20.0%) for version A against 62 of 200 (31.0%) for version B");
    expect(result.sentence).toContain("Version B did better");
    expect(result.sentence).toContain("by chance about 1 time in 86");
  });

  it("names version A when it is the better one", () => {
    expect(compareRates({ n: 300, hits: 90 }, { n: 300, hits: 55 }).verdict).toBe("a_higher");
  });

  it("calls a gap that luck explains no clear difference, and does not name a leader", () => {
    const result = compareRates({ n: 200, hits: 40 }, { n: 200, hits: 46 });
    expect(result.verdict).toBe("no_clear_difference");
    expect(result.pValue!).toBeGreaterThan(0.3);
    expect(result.sentence).toContain("neither is shown to be better");
    expect(result.sentence).not.toMatch(/did better/);
  });

  it("is 1 for equal rates", () => {
    expect(compareRates({ n: 100, hits: 20 }, { n: 100, hits: 20 }).pValue).toBeCloseTo(1, 5);
  });

  it("gives the same answer whichever version is called A", () => {
    const one = compareRates({ n: 150, hits: 30 }, { n: 180, hits: 60 });
    const other = compareRates({ n: 180, hits: 60 }, { n: 150, hits: 30 });
    expect(one.pValue).toBeCloseTo(other.pValue!, 10);
  });

  it("says too few to tell, rather than no difference, when the counts are small", () => {
    const result = compareRates({ n: 50, hits: 1 }, { n: 50, hits: 4 });
    expect(result.verdict).toBe("too_few");
    expect(result.pValue).toBeNull();
    expect(result.sentence).toContain("too few");
  });

  it("says nothing with nobody in a half, and does not divide by zero", () => {
    const result = compareRates({ n: 0, hits: 0 }, { n: 40, hits: 3 });
    expect(result.verdict).toBe("no_data");
    expect(result.rateA).toBeNull();
  });

  it("holds to a stricter bar when asked to", () => {
    const a = { n: 200, hits: 40 };
    const b = { n: 200, hits: 62 };
    expect(compareRates(a, b, ALPHA).verdict).toBe("b_higher");
    expect(compareRates(a, b, ALPHA / 10).verdict).toBe("no_clear_difference");
  });

  it("reads a chance as a sentence", () => {
    expect(luckInWords(0.05)).toBe("about 1 time in 20");
    expect(luckInWords(0.5)).toBe("about 50 times in 100");
    expect(luckInWords(0.00001)).toBe("fewer than 1 time in 10,000");
  });
});

describe("judging a whole test", () => {
  const counts = (over: Partial<VersionCounts>): VersionCounts => ({ sent: 400, clicks: 40, replies: 20, booked: 10, ...over });

  it("names no winner when nothing is clearly different", () => {
    const verdict = judgeTest(counts({}), counts({ clicks: 44, replies: 22, booked: 12 }));
    expect(verdict.winner).toBeNull();
    expect(verdict.headline).toContain("No clear winner");
  });

  it("names the winner and what it won on", () => {
    const verdict = judgeTest(counts({ clicks: 30 }), counts({ clicks: 80 }));
    expect(verdict.winner).toBe("b");
    expect(verdict.headline).toBe("Version B did better on people who clicked the link, by more than luck would explain.");
  });

  it("divides the bar across what it compares, so one lucky measure of three is not a win", () => {
    /** 40 against 58 of 200 clears 5 per cent alone (about 4 in 100), and not 5 per cent shared over three. */
    const verdict = judgeTest(
      { sent: 200, clicks: 40, replies: 5, booked: 3 },
      { sent: 200, clicks: 58, replies: 6, booked: 4 },
    );
    expect(verdict.measures.find((m) => m.measure === "clicks")!.comparison.verdict).toBe("no_clear_difference");
    expect(verdict.winner).toBeNull();
  });

  it("leaves replies out, and says the bar over two, when replies are not read back", () => {
    const verdict = judgeTest(counts({ replies: null }), counts({ replies: null }));
    expect(verdict.measures.map((m) => m.measure)).toEqual(["clicks", "booked"]);
    expect(verdict.measures[0]!.comparison.alpha).toBeCloseTo(ALPHA / 2, 10);
  });

  it("names no winner when each version won at something different", () => {
    const verdict = judgeTest(
      counts({ clicks: 30, booked: 60 }),
      counts({ clicks: 90, booked: 10 }),
    );
    expect(verdict.winner).toBeNull();
    expect(verdict.headline).toContain("each did better at something");
  });

  it("says too few to tell only when nothing could be tested, and no clear winner when something could", () => {
    const thin = judgeTest(counts({ clicks: 1, replies: 0, booked: 0 }), counts({ clicks: 3, replies: 0, booked: 0 }));
    expect(thin.headline).toBe("Too few people have acted to tell the versions apart yet. No winner.");
    const mixed = judgeTest(counts({ clicks: 40, booked: 0 }), counts({ clicks: 43, booked: 0 }));
    expect(mixed.headline).toContain("No clear winner");
  });

  it("says so before anybody has been sent anything", () => {
    const verdict = judgeTest(counts({ sent: 0, clicks: 0, replies: 0, booked: 0 }), counts({ sent: 0, clicks: 0, replies: 0, booked: 0 }));
    expect(verdict.winner).toBeNull();
    expect(verdict.headline).toBe("Nobody has been sent a version yet.");
  });
});

describe("the link tag and the second version", () => {
  it("puts the campaign and the version on the end of a link", () => {
    expect(linkTag("spring-tune-up", "b")).toBe("utm_campaign=spring-tune-up&utm_content=b");
    const scope = mergeScope({ customerName: "Maria Lopez", companyName: "Hartley", campaign: { utmCampaign: "spring", variant: "a" } });
    expect(scope["campaign"]).toEqual({ utm: "utm_campaign=spring&utm_content=a" });
  });

  it("lets a body use the tag", () => {
    expect(checkBody({ channel: "sms", body: "Book: https://hartley.example/tune-up?{{ campaign.utm }}" })).toEqual({ ok: true });
  });

  it("checks version B as it checks A", () => {
    expect(checkVersionB({ channel: "sms", body: "A words", versionB: { body: "B words" } })).toEqual({ ok: true });
    const noSubject = checkVersionB({ channel: "email", subject: "Hi", body: "A", versionB: { body: "B" } });
    expect(noSubject.ok).toBe(false);
    const withSubject = checkVersionB({ channel: "sms", body: "A", versionB: { body: "B", subject: "no" } });
    expect(withSubject.ok).toBe(false);
  });

  it("refuses a version B that says the same as version A", () => {
    const same = checkVersionB({ channel: "sms", body: "Same words ", versionB: { body: "Same words" } });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.refusals[0]!.message).toContain("nothing to test");
    expect(checkVersionB({ channel: "email", subject: "One", body: "Same", versionB: { body: "Same", subject: "Two" } })).toEqual({ ok: true });
  });
});
