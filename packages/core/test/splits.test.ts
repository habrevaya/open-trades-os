import { describe, it, expect } from "vitest";
import { splits, coverage, money as m } from "../src/index";

/**
 * ONE JOB, TWO INVOICES, AND THEY MUST ADD UP
 *
 * The property every test here checks in one form or another: the parts of
 * every line add up to the line, and the parts of every payer add up to what
 * that payer was meant to pay. A split that loses or doubles a cent is a
 * split somebody has to explain to two different accounts departments.
 */
const usd = (v: string) => m.money(v, "USD");
const text = (x: m.Money) => m.toString(x);

const total = (parts: m.Money[]) => text(m.sum(parts, "USD"));

describe("cutting lines between payers", () => {
  it("adds up both ways, to the cent", () => {
    const lines = [usd("100.00"), usd("33.33"), usd("0.01"), usd("250.00")];
    const parts = splits.allocateAcross(lines, [usd("123.45"), usd("259.89")]);
    expect(total(parts[0]!)).toBe("123.4500");
    expect(total(parts[1]!)).toBe("259.8900");
    for (const [i, line] of lines.entries()) {
      expect(text(m.add(parts[0]![i]!, parts[1]![i]!))).toBe(text(line));
    }
  });

  it("only takes a payer's part from lines they may pay for", () => {
    const lines = [usd("400.00"), usd("90.00")];
    const parts = splits.allocateAcross(lines, [usd("300.00"), usd("190.00")], [[true, false], [true, true]]);
    expect(text(parts[0]![1]!)).toBe("0.0000");
    expect(text(parts[1]![1]!)).toBe("90.0000");
    expect(text(parts[0]![0]!)).toBe("300.0000");
  });

  it("refuses a target bigger than the work that payer may pay for", () => {
    expect(() => splits.allocateAcross([usd("100"), usd("50")], [usd("120"), usd("30")], [[true, false], [true, true]]))
      .toThrow(/only 100.00 /);
  });
});

describe("a home warranty job", () => {
  /**
   * The case in the brief: the warranty pays the repair less the deductible,
   * the homeowner pays the deductible and what is not covered.
   */
  const lines: splits.SplitLine[] = [
    { amount: usd("350.00"), kind: "labour" },
    { amount: usd("220.00"), kind: "parts" },
    { amount: usd("75.00"), kind: "other" },
  ];
  const terms = coverage.withDefaults("home_warranty", { customerResponsibility: usd("100.00") });

  it("puts the deductible and the uncovered line on the homeowner", () => {
    const targets = splits.coverageTargets(terms, lines);
    expect(text(targets.thirdParty)).toBe("470.0000");
    expect(text(targets.customer)).toBe("175.0000");
    expect(targets.eligible).toEqual([true, true, false]);

    const parts = splits.allocateAcross(lines.map((l) => l.amount), [targets.thirdParty, targets.customer], [targets.eligible, [true, true, true]]);
    expect(total(parts[0]!)).toBe("470.0000");
    expect(total(parts[1]!)).toBe("175.0000");
    /** The uncovered line is the homeowner's alone. */
    expect(text(parts[1]![2]!)).toBe("75.0000");
    expect(splits.reconciles(usd("645.00"), [m.sum(parts[0]!, "USD"), m.sum(parts[1]!, "USD")]).ok).toBe(true);
  });

  it("charges the homeowner the whole covered work when the deductible is larger", () => {
    const big = coverage.withDefaults("home_warranty", { customerResponsibility: usd("1000.00") });
    const targets = splits.coverageTargets(big, lines);
    expect(text(targets.thirdParty)).toBe("0.0000");
    expect(text(targets.customer)).toBe("645.0000");
  });
});

describe("shares", () => {
  it("takes fixed amounts first and gives the rest to the one payer without a share", () => {
    const result = splits.shareTargets(usd("1000.00"), [{ amount: usd("150.00") }, {}]);
    expect(result.ok && result.targets.map(text)).toEqual(["150.0000", "850.0000"]);
  });

  it("rounds percentages to the cent and puts the stray cent on the largest share", () => {
    const result = splits.shareTargets(usd("100.00"), [
      { percent: "0.333333" }, { percent: "0.333333" }, { percent: "0.333334" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(total(result.targets)).toBe("100.0000");
  });

  it("refuses shares that do not add up with nobody to take the rest", () => {
    const result = splits.shareTargets(usd("100.00"), [{ percent: "0.5" }, { percent: "0.3" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Make them add up/);
  });

  it("refuses a percentage written as a whole number", () => {
    const result = splits.shareTargets(usd("100.00"), [{ percent: "70" }, {}]);
    expect(result.ok).toBe(false);
  });

  it("refuses two payers who both want what is left", () => {
    expect(splits.shareTargets(usd("100.00"), [{}, {}]).ok).toBe(false);
  });
});
