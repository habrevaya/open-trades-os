import { describe, it, expect } from "vitest";
import { budget as b, money as m } from "../src/index";

/**
 * A RUN RATE THAT WEIGHS RECENT MONTHS MORE
 *
 * With recency on, the run rate is a weighted average of the months already
 * over: the first counts once, the second twice, and the latest as many times
 * as there are months over. Off, which is the default, every month counts the
 * same, as it always did.
 */
const key = "category:revenue" as const;
/** Three months over at 100, 200 and 300; nine to come with a budget of 1,000 each. */
const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  budget: m.money("1000"),
  actual: i < 3 ? m.money(String((i + 1) * 100)) : m.zero(),
}));

describe("a run rate weighing recent months more", () => {
  it("is off by default: every month over counts the same", () => {
    const even = b.forecastLine({ key, months, closed: 3, method: "run_rate" });
    /** The average month is 200, so nine to come are 1,800. */
    expect(m.toString(even.toCome)).toBe("1800.0000");
    expect(even.recentWeighted).toBe(false);
  });

  it("weighs the latest month most when it is on", () => {
    const recent = b.forecastLine({ key, months, closed: 3, method: "run_rate", recentWeighted: true });
    /** (100 + 2 x 200 + 3 x 300) / 6 = 233.33..., times nine is 2,100. */
    expect(m.toString(recent.toCome)).toBe("2100.0000");
    expect(recent.recentWeighted).toBe(true);
    expect(recent.months.slice(3).map((x) => m.toString(x))).toEqual(Array(9).fill("233.3300").map((v, i) => (i < 3 ? "233.3400" : v)));
    expect(m.toString(recent.months.reduce((a, x) => m.add(a, x), m.zero()))).toBe(m.toString(recent.forecast));
  });

  it("weighs the run rate part of a blend too, and says nothing of it when the run rate has no weight", () => {
    const blend = b.forecastLine({
      key, months, closed: 3, method: "blend", weights: { budget: 50, runRate: 50, seasonal: 0 }, recentWeighted: true,
    });
    /** Half of 9,000 at the budget and half of 2,100 at the weighted run rate. */
    expect(m.toString(blend.toCome)).toBe("5550.0000");
    expect(blend.recentWeighted).toBe(true);
    const budgetOnly = b.forecastLine({ key, months, closed: 3, method: "budget", recentWeighted: true });
    expect(budgetOnly.recentWeighted).toBe(false);
  });

  it("falls back to the budget with no month over, as the even run rate does", () => {
    const january = b.forecastLine({ key, months, closed: 0, method: "run_rate", recentWeighted: true });
    expect(january.method).toBe("budget");
    expect(january.recentWeighted).toBe(false);
  });

  it("says how many times each month over counts", () => {
    expect(b.recencyWeights(3)).toEqual([1, 2, 3]);
    expect(b.recencyWeights(0)).toEqual([]);
  });
});
