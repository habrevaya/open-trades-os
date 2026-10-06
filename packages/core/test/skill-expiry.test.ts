import { describe, it, expect } from "vitest";
import * as people from "../src/people/index.js";
import * as q from "../src/qualification/index.js";

/**
 * M24. A SKILL RECORD'S OWN EXPIRY.
 *
 * Read the way a certification's is: the day it expires is still good, it is
 * expired from the next, and it is "expiring" inside its notice period.
 */
describe("a skill's own expiry", () => {
  const stand = (expiresOn: string | null, today = "2026-10-06", leadDays = 30) =>
    people.skillExpiryStanding({ skill: "brazing", expiresOn, today, leadDays });

  it("has no state at all without an expiry", () => {
    expect(stand(null)).toEqual({ state: "none", daysRemaining: null, sentence: "brazing does not expire." });
  });

  it("is current outside the notice period and expiring inside it, counting both ends", () => {
    /** Oct 6 to Nov 5 is 30 days: the last day inside the window. */
    expect(stand("2026-11-05")).toMatchObject({ state: "expiring", daysRemaining: 30 });
    expect(stand("2026-11-06")).toMatchObject({ state: "current", daysRemaining: 31, sentence: "brazing is good until 2026-11-06." });
    expect(stand("2026-10-20").sentence).toBe("brazing runs out on 2026-10-20, in 14 days.");
    expect(stand("2026-10-07").sentence).toBe("brazing runs out on 2026-10-07, in 1 day.");
  });

  it("is still good on the day it expires and expired from the next", () => {
    expect(stand("2026-10-06")).toEqual({ state: "expiring", daysRemaining: 0, sentence: "brazing runs out today." });
    expect(stand("2026-10-05")).toEqual({ state: "expired", daysRemaining: -1, sentence: "brazing ran out on 2026-10-05, 1 day ago." });
    expect(stand("2026-09-01").sentence).toBe("brazing ran out on 2026-09-01, 35 days ago.");
  });

  it("does not clear the check once the record has lapsed, and says when", () => {
    const base = { skill: "brazing", certified: "uncertified" as const, certifiedExplanation: "", typed: true, typedAnywhere: true };
    expect(q.judgeSkill("Sam", base)).toMatchObject({ outcome: "qualified" });
    expect(q.judgeSkill("Sam", { ...base, expiredOn: null })).toMatchObject({ outcome: "qualified" });
    expect(q.judgeSkill("Sam", { ...base, expiredOn: "2026-09-30" })).toEqual({
      skill: "brazing", outcome: "refused", basis: "profile",
      explanation: "Sam's record of brazing ran out on 2026-09-30. Renew it on their page to send them.",
    });
    /** A live certification still clears it: the register decides where it speaks. */
    expect(q.judgeSkill("Sam", { ...base, certified: "covered", certifiedExplanation: "Held.", expiredOn: "2026-09-30" }))
      .toMatchObject({ outcome: "qualified", basis: "certification" });
  });
});
