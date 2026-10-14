import { describe, it, expect } from "vitest";
import {
  variantFor, checkShares, splitInWords, judgeVersions, judgeTest, compareRates, ALPHA, MIN_SHARE,
  type VersionCounts, type Variant,
} from "../src/campaign/index.js";

/**
 * A TEST OF UP TO FOUR VERSIONS, IN THE SHARES THE OFFICE CHOSE
 *
 * The split stays a stable hash of the campaign and the customer, so it is
 * still reproducible and still blind to anything about the customer; the
 * shares only move where the buckets fall. Each new version is compared with
 * the first under a bar spread across every comparison made.
 */

function ids(count: number, seed = 1): string[] {
  let x = seed;
  const hex = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x.toString(16).padStart(8, "0");
  };
  return Array.from({ length: count }, () => `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`);
}

const campaign = "6f1d0c52-0b0e-4a1e-9c57-0d3a5a3b7c11";
const shareOf = (people: string[], split: Parameters<typeof variantFor>[2], v: Variant) =>
  people.filter((c) => variantFor(campaign, c, split) === v).length / people.length;

describe("splitting an audience in chosen shares", () => {
  const people = ids(20_000, 11);

  it("keeps the old even halves exactly when nothing is chosen", () => {
    for (const customer of people.slice(0, 500)) {
      expect(variantFor(campaign, customer, { versions: 2 })).toBe(variantFor(campaign, customer));
      expect(variantFor(campaign, customer, { versions: 2, shares: null })).toBe(variantFor(campaign, customer));
    }
  });

  it("gives ninety in a hundred to the first version and ten to the second", () => {
    const split = { versions: 2, shares: [90, 10] };
    expect(shareOf(people, split, "a")).toBeGreaterThan(0.885);
    expect(shareOf(people, split, "a")).toBeLessThan(0.915);
    expect(shareOf(people, split, "b")).toBeGreaterThan(0.085);
  });

  it("splits four ways in the shares given, and three ways evenly when none are", () => {
    const four = { versions: 4, shares: [70, 10, 10, 10] };
    expect(shareOf(people, four, "a")).toBeGreaterThan(0.68);
    for (const v of ["b", "c", "d"] as const) {
      expect(shareOf(people, four, v)).toBeGreaterThan(0.085);
      expect(shareOf(people, four, v)).toBeLessThan(0.115);
    }
    const three = { versions: 3 };
    for (const v of ["a", "b", "c"] as const) {
      expect(shareOf(people, three, v)).toBeGreaterThan(0.31);
      expect(shareOf(people, three, v)).toBeLessThan(0.36);
    }
    expect(shareOf(people, three, "d")).toBe(0);
  });

  it("is the same answer every time, whatever order the list is in", () => {
    const split = { versions: 3, shares: [80, 10, 10] };
    const forward = people.slice(0, 200).map((c) => variantFor(campaign, c, split));
    const backward = [...people.slice(0, 200)].reverse().map((c) => variantFor(campaign, c, split)).reverse();
    expect(backward).toEqual(forward);
  });
});

describe("checking the shares", () => {
  it("takes whole percents that add up to a hundred, one per version", () => {
    expect(checkShares([90, 10], 2)).toEqual({ ok: true, shares: [90, 10] });
    expect(checkShares([25, 25, 25, 25], 4)).toEqual({ ok: true, shares: null });
    expect(checkShares(null, 3)).toEqual({ ok: true, shares: null });
  });

  it("refuses shares that do not fit, in words", () => {
    expect(checkShares([90, 5], 2)).toEqual({ ok: false, message: "The shares add up to 95%. They need to add up to 100%." });
    expect(checkShares([90, 10], 3)).toEqual({ ok: false, message: "There are 3 versions, so give 3 shares, one for each." });
    expect(checkShares([97, 3], 2)).toMatchObject({ ok: false, message: expect.stringContaining(`at least ${MIN_SHARE}%`) });
    expect(checkShares([90.5, 9.5], 2)).toMatchObject({ ok: false, message: "Each share is a whole percent, like 90 or 10." });
    expect(checkShares([100], 1)).toMatchObject({ ok: false });
  });

  it("says the split in words", () => {
    expect(splitInWords(2, null)).toBe("Half get version A and half get version B.");
    expect(splitInWords(3, [80, 10, 10])).toBe("80% get version A, 10% get version B and 10% get version C.");
    expect(splitInWords(4, null)).toBe("The list is split evenly between versions A, B, C, D.");
  });
});

describe("judging more than two versions", () => {
  const counts = (over: Partial<VersionCounts>): VersionCounts => ({ sent: 400, clicks: 40, replies: 20, booked: 10, ...over });

  it("compares each version with the first, under a bar spread over every comparison", () => {
    const verdict = judgeVersions([counts({}), counts({}), counts({}), counts({})]);
    expect(verdict.measures.map((m) => `${m.against}:${m.measure}`)).toEqual([
      "b:clicks", "b:replies", "b:booked", "c:clicks", "c:replies", "c:booked", "d:clicks", "d:replies", "d:booked",
    ]);
    expect(verdict.measures[0]!.comparison.alpha).toBeCloseTo(ALPHA / 9, 10);
    expect(verdict.winner).toBeNull();
  });

  it("names a new version only when it alone beat the first, and says the others were compared only with A", () => {
    const verdict = judgeVersions([counts({ clicks: 30 }), counts({ clicks: 34 }), counts({ clicks: 90 })]);
    expect(verdict.winner).toBe("c");
    expect(verdict.headline).toBe(
      "Version C did better than version A on people who clicked the link, by more than luck would explain. The other versions were compared only with version A.",
    );
    const said = verdict.measures.find((m) => m.against === "c" && m.measure === "clicks")!.comparison.sentence;
    expect(said).toContain("for version A against 90 of 400 (22.5%) for version C");
    expect(said).toContain("Version C did better.");
  });

  it("names nobody when two new versions both beat the first, because they were not compared with each other", () => {
    const verdict = judgeVersions([counts({ clicks: 30 }), counts({ clicks: 90 }), counts({ clicks: 95 })]);
    expect(verdict.winner).toBeNull();
    expect(verdict.headline).toContain("More than one version did better than version A");
  });

  it("names the first version only when it beat every other one", () => {
    const all = judgeVersions([counts({ clicks: 100 }), counts({ clicks: 30 }), counts({ clicks: 35 })]);
    expect(all.winner).toBe("a");
    expect(all.headline).toBe("Version A did better than every other version, on people who clicked the link, by more than luck would explain.");
    const some = judgeVersions([counts({ clicks: 100 }), counts({ clicks: 30 }), counts({ clicks: 95 })]);
    expect(some.winner).toBeNull();
    expect(some.headline).toBe("Version A did better than version B, but not clearly better than every other version, so there is no single winner.");
  });

  it("asks more of each comparison as versions are added, so a gap that wins two ways may not win four", () => {
    const a = counts({ clicks: 40 });
    const b = counts({ clicks: 66 });
    expect(judgeVersions([a, b]).winner).toBe("b");
    expect(judgeVersions([a, b, counts({}), counts({})]).winner).toBeNull();
  });

  it("judges two versions exactly as before", () => {
    const a = counts({ clicks: 30 });
    const b = counts({ clicks: 80 });
    expect(judgeTest(a, b)).toEqual(judgeVersions([a, b]));
    expect(compareRates({ n: 200, hits: 40 }, { n: 200, hits: 62 }).sentence).toContain("for version B");
  });
});
