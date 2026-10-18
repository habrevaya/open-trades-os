import { describe, it, expect } from "vitest";
import {
  heldBackFor, checkHoldBack, holdBackInWords, restChoice, variantFor, linkTag, mergeScope, reachRate,
  MIN_HOLD_BACK, MAX_HOLD_BACK, REST_CONTENT,
} from "../src/campaign/index.js";

/**
 * HOLDING PART OF THE LIST BACK FOR THE WINNER
 *
 * A test can keep a share of its audience back, and a person sends that part
 * the winner afterwards. Who is held back is a hash of its own, so it says
 * nothing about which version somebody would have got, and the version split
 * among the people tested keeps the shares the office chose.
 */

function ids(count: number, seed = 1): string[] {
  let x = seed;
  const hex = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x.toString(16).padStart(8, "0");
  };
  return Array.from({ length: count }, () => `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`);
}

const campaign = "1d2e3f40-0b0e-4a1e-9c57-0d3a5a3b7c11";

describe("who is held back", () => {
  const people = ids(20_000, 7);

  it("holds back nobody with no share, and about the share chosen with one", () => {
    expect(people.some((c) => heldBackFor(campaign, c, null))).toBe(false);
    expect(people.some((c) => heldBackFor(campaign, c, 0))).toBe(false);
    const held = people.filter((c) => heldBackFor(campaign, c, 80)).length / people.length;
    expect(held).toBeGreaterThan(0.78);
    expect(held).toBeLessThan(0.82);
  });

  it("holds back the same people every time it is asked", () => {
    for (const c of people.slice(0, 300)) {
      expect(heldBackFor(campaign, c, 50)).toBe(heldBackFor(campaign, c, 50));
    }
  });

  it("says nothing about the version: the people tested still split in the chosen shares", () => {
    const tested = people.filter((c) => !heldBackFor(campaign, c, 70));
    const b = tested.filter((c) => variantFor(campaign, c, { versions: 2, shares: [90, 10] }) === "b").length / tested.length;
    expect(b).toBeGreaterThan(0.08);
    expect(b).toBeLessThan(0.12);
    const even = tested.filter((c) => variantFor(campaign, c) === "a").length / tested.length;
    expect(even).toBeGreaterThan(0.47);
    expect(even).toBeLessThan(0.53);
  });

  it("holds back different people in a different campaign", () => {
    const other = "9a8b7c6d-0b0e-4a1e-9c57-0d3a5a3b7c11";
    const same = people.slice(0, 2000).filter((c) => heldBackFor(campaign, c, 50) === heldBackFor(other, c, 50)).length;
    expect(same).toBeGreaterThan(900);
    expect(same).toBeLessThan(1100);
  });
});

describe("checking a held back share", () => {
  it("takes nothing as no hold back, which is the default", () => {
    expect(checkHoldBack(undefined, 2)).toEqual({ ok: true, share: null });
    expect(checkHoldBack(null, 1)).toEqual({ ok: true, share: null });
    expect(checkHoldBack(0, 1)).toEqual({ ok: true, share: null });
  });

  it("refuses one with no test, out of bounds, or not whole", () => {
    expect(checkHoldBack(50, 1)).toMatchObject({ ok: false, message: expect.stringContaining("Write a second version first") });
    expect(checkHoldBack(MIN_HOLD_BACK - 1, 2)).toMatchObject({ ok: false, message: expect.stringContaining("between 5% and 95%") });
    expect(checkHoldBack(MAX_HOLD_BACK + 1, 2)).toMatchObject({ ok: false });
    expect(checkHoldBack(12.5, 2)).toMatchObject({ ok: false, message: expect.stringContaining("whole percent") });
    expect(checkHoldBack(80, 3)).toEqual({ ok: true, share: 80 });
  });

  it("says it in words, including that nothing goes by itself", () => {
    expect(holdBackInWords(null)).toBeNull();
    expect(holdBackInWords(80)).toBe(
      "80% of the list is held back. The test goes to the other 20%, and once it is judged you send the winner to the 80%. Nothing goes to them by itself.",
    );
  });
});

describe("what the held back part may be sent", () => {
  it("is the winner when there is one", () => {
    expect(restChoice("b")).toMatchObject({ version: "b", won: true, sentence: "Version B won, by more than luck would explain." });
    expect(restChoice("a")).toMatchObject({ version: "a", won: true });
  });

  it("is version A when nothing won, and says so", () => {
    const choice = restChoice(null);
    expect(choice).toMatchObject({ version: "a", won: false });
    expect(choice.sentence).toContain("No version won");
  });
});

describe("the link tag on the winner sent to the rest", () => {
  it("carries a content of its own, so its clicks are never counted in the test", () => {
    expect(linkTag("spring", "b", true)).toBe(`utm_campaign=spring&utm_content=${REST_CONTENT}`);
    expect(linkTag("spring", "b")).toBe("utm_campaign=spring&utm_content=b");
    const scope = mergeScope({ customerName: "Maria Lopez", companyName: "Comfort Co", campaign: { utmCampaign: "spring", variant: "b", rest: true } });
    expect(scope).toMatchObject({ campaign: { utm: "utm_campaign=spring&utm_content=rest" } });
  });
});

describe("the reach rate with people held back", () => {
  it("is out of the people a send was tried on", () => {
    expect(reachRate({ selected: 10, queued: 1, skipped: 1, held: 8, skippedBy: {} })).toBe("50.0");
    expect(reachRate({ selected: 8, queued: 0, skipped: 0, held: 8, skippedBy: {} })).toBeNull();
  });
});
