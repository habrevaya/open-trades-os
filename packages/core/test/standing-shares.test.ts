import { describe, it, expect } from "vitest";
import { proposeSplit, checkStandingShare, splitCommission, sameSplit, evenShares, type StandingShare } from "../src/labor/index.js";
import { money, toString } from "../src/money/index.js";

/**
 * A STANDING SHARE OF SHARED COMMISSION
 *
 * Somebody who always takes the same part: the person who sold it gets 30%,
 * the rest is split evenly between the others. Only a proposal: whatever the
 * office settles is checked by the same rules as before.
 */

const ray: StandingShare = { personId: "ray", percent: 30, applies: "always", reason: "He sells the systems.", name: "Ray" };
const lead: StandingShare = { personId: "ana", percent: 40, applies: "as_lead", reason: "Leads the install", name: "Ana" };
const people = (...ids: [string, boolean][]) => ids.map(([personId, isLead]) => ({ personId, isLead }));

describe("proposing a split with standing shares", () => {
  it("is the even split when nobody on the job has one", () => {
    const proposed = proposeSplit(people(["a", false], ["b", false]), [ray]);
    expect(proposed).toEqual({ shares: evenShares(["a", "b"]), applied: [], sentence: null, conflict: null });
  });

  it("gives the standing share and splits the rest evenly, exactly", () => {
    const proposed = proposeSplit(people(["ray", false], ["b", false], ["c", false], ["d", false]), [ray]);
    expect(proposed.shares).toEqual([
      { personId: "ray", weight: "90" }, { personId: "b", weight: "70" }, { personId: "c", weight: "70" }, { personId: "d", weight: "70" },
    ]);
    expect(proposed.sentence).toBe("Standing shares: Ray takes 30% (He sells the systems). The remaining 70% is split evenly between the other 3 people.");
    const parts = splitCommission(money("100.00", "USD"), proposed.shares).map((p) => toString(p.amount));
    /** The odd cent goes to the biggest share, as in any split. */
    expect(parts).toEqual(["30.0100", "23.3300", "23.3300", "23.3300"]);
  });

  it("applies a lead's share only when they led a visit", () => {
    expect(proposeSplit(people(["ana", false], ["b", false]), [lead]).applied).toEqual([]);
    const led = proposeSplit(people(["ana", true], ["b", false]), [lead]);
    expect(led.shares).toEqual([{ personId: "ana", weight: "40" }, { personId: "b", weight: "60" }]);
    expect(led.sentence).toContain("The other person gets the remaining 60%.");
  });

  it("takes several standing shares together", () => {
    const both = proposeSplit(people(["ray", false], ["ana", true], ["c", false]), [ray, lead]);
    expect(both.shares).toEqual([{ personId: "ray", weight: "30" }, { personId: "ana", weight: "40" }, { personId: "c", weight: "30" }]);
    const exact = proposeSplit(people(["ray", false], ["x", false]), [ray, { ...ray, personId: "x", percent: 70, name: "Xi" }]);
    expect(exact.shares).toEqual([{ personId: "ray", weight: "30" }, { personId: "x", weight: "70" }]);
    expect(exact.conflict).toBeNull();
  });

  it("proposes the even split, and says why, when the standing shares cannot all be honoured", () => {
    const over = proposeSplit(people(["ray", false], ["x", false], ["c", false]), [ray, { ...ray, personId: "x", percent: 80, name: "Xi" }]);
    expect(over.shares).toEqual(evenShares(["ray", "x", "c"]));
    expect(over.conflict).toContain("add up to 110%, which would leave the others nothing");
    const under = proposeSplit(people(["ray", false], ["x", false]), [ray, { ...ray, personId: "x", percent: 30, name: "Xi" }]);
    expect(under.shares).toEqual(evenShares(["ray", "x"]));
    expect(under.conflict).toContain("add up to 60%, not 100%");
  });

  it("is a single person's whole commission when they are alone on the job", () => {
    expect(proposeSplit(people(["ray", false]), [ray]).shares).toEqual(evenShares(["ray"]));
  });

  it("compares with a split the office typed as percents", () => {
    const proposed = proposeSplit(people(["ray", false], ["b", false], ["c", false]), [ray]);
    expect(sameSplit(proposed.shares, [{ personId: "ray", weight: "30" }, { personId: "b", weight: "35" }, { personId: "c", weight: "35" }])).toBe(true);
    expect(sameSplit(proposed.shares, evenShares(["ray", "b", "c"]))).toBe(false);
  });
});

describe("checking a standing share", () => {
  it("is a whole percent from 1 to 99, with a reason", () => {
    expect(checkStandingShare({ percent: 30, reason: "Sells it" })).toEqual({ ok: true });
    expect(checkStandingShare({ percent: 0, reason: "x" })).toMatchObject({ ok: false });
    expect(checkStandingShare({ percent: 100, reason: "x" })).toMatchObject({ ok: false });
    expect(checkStandingShare({ percent: 12.5, reason: "x" })).toMatchObject({ ok: false });
    expect(checkStandingShare({ percent: 30, reason: "  " })).toMatchObject({ ok: false, reason: expect.stringContaining("Say why") });
  });
});
