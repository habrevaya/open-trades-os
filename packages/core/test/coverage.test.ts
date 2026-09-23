import { describe, it, expect } from "vitest";
import { coverage, money as m } from "../src/index";

/**
 * WHO IS PAYING, AND WHY
 *
 * The distinction that matters most: a zero dollar visit under an agreement
 * and a zero dollar visit that is our own rework look identical on a revenue
 * report and mean opposite things about the business.
 *
 * The two things that make the arithmetic hard are both properties of the
 * VISIT rather than of a line: a coverage limit is a ceiling on the total,
 * and a deductible is charged once however many lines there are.
 */
const usd = (v: string) => m.money(v, "USD");
const charges = (labour: string, parts: string, trip = "0.00") => [
  { kind: "labour" as const, amount: usd(labour) },
  { kind: "parts" as const, amount: usd(parts) },
  { kind: "trip" as const, amount: usd(trip) },
];

const split = (source: coverage.CoverageSource, over = {}, c = charges("300.00", "200.00")) =>
  coverage.split(coverage.withDefaults(source, over), c);

describe("what each source covers by default", () => {
  it("bills the customer for everything when the customer is paying", () => {
    const result = split("customer");
    expect(m.toString(result.customer)).toBe("500.0000");
    expect(m.toString(result.covered)).toBe("0.0000");
  });

  it("gets the two warranties the right way round", () => {
    /**
     * The pair people get backwards, and getting them backwards bills a
     * customer for something a manufacturer owed.
     */
    expect(m.toString(split("parts_warranty").customer)).toBe("300.0000");
    expect(m.toString(split("parts_warranty").covered)).toBe("200.0000");
    expect(m.toString(split("labour_warranty").customer)).toBe("200.0000");
    expect(m.toString(split("labour_warranty").covered)).toBe("300.0000");
  });

  it("bills nothing for our own rework", () => {
    // We are back because of something we did. This must never be billed.
    expect(m.toString(split("no_charge_callback").customer)).toBe("0.0000");
  });

  it("covers labour and the trip under an agreement, but not the part", () => {
    // A plan includes the visit. It does not include a compressor.
    const result = split("agreement", {}, charges("300.00", "200.00", "50.00"));
    expect(m.toString(result.covered)).toBe("350.0000");
    expect(m.toString(result.customer)).toBe("200.0000");
  });

  it("leaves anything it cannot classify with the customer", () => {
    /**
     * Guessing the other way means a line billed to nobody, and a line
     * billed to nobody is revenue that silently disappears.
     */
    const result = coverage.split(coverage.withDefaults("our_warranty"), [
      { kind: "other", amount: usd("75.00") },
    ]);
    expect(m.toString(result.customer)).toBe("75.0000");
  });
});

describe("the arithmetic that is easy to get wrong", () => {
  it("charges a deductible once, not once per line", () => {
    /**
     * Splitting line by line and adding the deductible to each is how a
     * customer gets charged their excess four times.
     */
    const result = split("insurance", { customerResponsibility: usd("100.00") });
    expect(m.toString(result.customer)).toBe("100.0000");
    expect(m.toString(result.covered)).toBe("400.0000");
  });

  it("takes the deductible out of the covered amount, not on top of the bill", () => {
    // A five hundred dollar job with a hundred dollar deductible costs the
    // customer a hundred, not six hundred.
    const result = split("insurance", { customerResponsibility: usd("100.00") });
    expect(m.toString(m.add(result.customer, result.covered))).toBe("500.0000");
  });

  it("does not let a deductible bigger than the job overcharge", () => {
    const result = split("insurance", { customerResponsibility: usd("900.00") });
    expect(m.toString(result.customer)).toBe("500.0000");
    expect(m.toString(result.covered)).toBe("0.0000");
  });

  it("caps what the source pays and hands the rest back to the customer", () => {
    // Which is what a cap means. Anything else makes the ceiling decorative.
    const result = split("home_warranty", { coverageLimit: usd("350.00") });
    expect(m.toString(result.covered)).toBe("350.0000");
    expect(m.toString(result.customer)).toBe("150.0000");
  });

  it("applies a percentage to what is in scope, not to the whole bill", () => {
    /**
     * A parts warranty paying eighty percent pays eighty percent of the
     * PART. Applying it to the total would have a manufacturer paying most
     * of our labour.
     */
    const result = split("parts_warranty", { coveragePercent: "0.8000" });
    expect(m.toString(result.covered)).toBe("160.0000");
    expect(m.toString(result.customer)).toBe("340.0000");
  });

  it("always adds up to the total", () => {
    // The property that has to hold whatever the terms are, because the two
    // halves are a bill and somebody has to pay all of it.
    for (const source of coverage.SOURCES) {
      const terms: [string, Record<string, unknown>][] = [
        ["plain", {}],
        ["half", { coveragePercent: "0.5000" }],
        ["capped", { coverageLimit: usd("120.00") }],
        ["deductible", { customerResponsibility: usd("75.00") }],
        ["all three", {
          coveragePercent: "0.8000",
          customerResponsibility: usd("100.00"),
          coverageLimit: usd("250.00"),
        }],
      ];
      for (const [name, over] of terms) {
        const result = split(source, over, charges("300.00", "200.00", "50.00"));
        expect(
          m.toString(m.add(result.customer, result.covered)),
          `${source}, ${name}`,
        ).toBe("550.0000");
      }
    }
  });

  it("never goes negative on either side", () => {
    const result = split("our_warranty", { customerResponsibility: usd("1000.00") });
    expect(m.isNegative(result.customer)).toBe(false);
    expect(m.isNegative(result.covered)).toBe(false);
  });
});

describe("what it cost us", () => {
  it("separates work we absorbed from work somebody else is paying for", () => {
    /**
     * The number nobody has and everybody needs. An agreement visit and a
     * callback both bill the customer zero; one is why the company is worth
     * what it is and the other is work being done twice.
     */
    expect(coverage.isOurCost("no_charge_callback")).toBe(true);
    expect(coverage.isOurCost("our_warranty")).toBe(true);
    expect(coverage.isOurCost("goodwill")).toBe(true);
    expect(coverage.isOurCost("agreement")).toBe(false);
    expect(coverage.isOurCost("home_warranty")).toBe(false);
  });

  it("knows which sources produce a bill to somebody else", () => {
    // A manufacturer and a home warranty administrator get invoiced. Our own
    // callback and goodwill do not, and that difference is the whole of
    // "what does rework cost us".
    expect(coverage.COVERAGE.parts_warranty.billsAThirdParty).toBe(true);
    expect(coverage.COVERAGE.no_charge_callback.billsAThirdParty).toBe(false);
    expect(coverage.COVERAGE.goodwill.isAConcession).toBe(true);
    expect(coverage.COVERAGE.our_warranty.isAConcession).toBe(false);
  });

  it("describes every source, because the screen has to name them", () => {
    for (const source of coverage.SOURCES) {
      expect(coverage.COVERAGE[source].label.length, source).toBeGreaterThan(0);
      expect(coverage.COVERAGE[source].description.length, source).toBeGreaterThan(20);
    }
  });
});
