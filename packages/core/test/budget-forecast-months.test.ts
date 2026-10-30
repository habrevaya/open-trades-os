import { describe, it, expect } from "vitest";
import { budget as b, money as m } from "../src/index";

/** The forecast month by month, a blend of the three ways, and a shape averaged over several years. */
const $ = (value: string) => m.money(value);
const str = (values: readonly m.Money[]) => values.map((v) => m.toString(v));

/** A year with a budget of 1,000 a month, and 1,200 a month actually done in the four months over. */
const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1, budget: $("1000"), actual: i < 4 ? $("1200") : $("0"),
}));

describe("the forecast month by month", () => {
  it("is the actual for a month over and the budget for a month to come, adding up to the year", () => {
    const f = b.forecastLine({ key: "category:revenue", months, closed: 4, method: "budget" });
    expect(str(f.months)).toEqual([...Array(4).fill("1200.0000"), ...Array(8).fill("1000.0000")]);
    expect(m.toString(f.forecast)).toBe("12800.0000");
  });

  it("shares the run rate evenly, to the cent, and the shape like last year's months", () => {
    const run = b.forecastLine({ key: "category:revenue", months, closed: 4, method: "run_rate" });
    expect(str(run.months.slice(4))).toEqual(Array(8).fill("1200.0000"));
    const lastYear = [1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1].map((n) => $(String(n * 100)));
    const shaped = b.forecastLine({ key: "category:revenue", months, closed: 4, method: "seasonal", lastYear });
    expect(m.toString(shaped.toCome)).toBe("14400.0000");
    expect(str(shaped.months.slice(4))).toEqual([
      "2400.0000", "2400.0000", "2400.0000", "2400.0000", "1200.0000", "1200.0000", "1200.0000", "1200.0000",
    ]);
    const odd = b.forecastLine({ key: "category:revenue", months: months.map((x, i) => ({ ...x, actual: i < 3 ? $("100") : $("0") })), closed: 3, method: "run_rate" });
    expect(odd.months.slice(3).reduce((a, x) => m.add(a, x), m.zero())).toEqual(odd.toCome);
  });
});

describe("a blend of the three", () => {
  it("is the weighted months to come, and says what each part would make them", () => {
    const f = b.forecastLine({
      key: "category:revenue", months, closed: 4, method: "blend", weights: { budget: 50, runRate: 50, seasonal: 0 },
    });
    expect(f.method).toBe("blend");
    expect(m.toString(f.toCome)).toBe("8800.0000");
    expect(str(f.months.slice(4))).toEqual(Array(8).fill("1100.0000"));
    expect(f.parts && str([f.parts.budget, f.parts.runRate])).toEqual(["8000.0000", "9600.0000"]);
    expect(f.fellBack).toBe(false);
  });

  it("falls back to the budget for a part that has nothing to go on, and says it fell back", () => {
    const f = b.forecastLine({
      key: "category:revenue", months, closed: 0, method: "blend", weights: { budget: 20, runRate: 80, seasonal: 0 },
    });
    expect(m.toString(f.toCome)).toBe("12000.0000");
    expect(f.fellBack).toBe(true);
  });

  it("takes weights that are whole percentages adding up to 100, and refuses any other", () => {
    expect(b.checkWeights({ budget: "50", runRate: "30", seasonal: "20" })).toEqual({ ok: true, weights: { budget: 50, runRate: 30, seasonal: 20 } });
    expect(b.checkWeights({ budget: "100" })).toEqual({ ok: true, weights: { budget: 100, runRate: 0, seasonal: 0 } });
    expect(b.checkWeights({ budget: "50", runRate: "40" })).toMatchObject({ ok: false, reason: expect.stringMatching(/add up to 90/) });
    expect(b.checkWeights({ budget: "50.5", runRate: "49.5" })).toMatchObject({ ok: false, field: "budget" });
    expect(b.checkWeights({ budget: "-10", runRate: "110" })).toMatchObject({ ok: false });
  });
});
