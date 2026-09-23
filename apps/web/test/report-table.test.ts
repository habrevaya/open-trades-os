import { describe, it, expect } from "vitest";
import { barWidth } from "../src/components/ReportTable";

/**
 * The bar is the only thing on a report screen that is not a number somebody
 * can check, so it has to agree with the number beside it.
 */
describe("the bar beside a measure", () => {
  it("is full for the largest value", () => {
    expect(barWidth(100, 100)).toBe(100);
  });

  it("is proportional", () => {
    expect(barWidth(25, 100)).toBe(25);
  });

  it("is nothing at all for zero", () => {
    /**
     * The floor below used to apply here too, so a paid invoice group with
     * nothing outstanding drew a sliver next to $0.00: a bar saying "a
     * little" beside a number saying "none".
     */
    expect(barWidth(0, 100)).toBe(0);
  });

  it("stays visible for a small value", () => {
    // Without a floor, one invoice against a hundred thousand is a bar
    // nobody can see, which reads as a rendering fault rather than as small.
    expect(barWidth(1, 100_000)).toBe(2);
  });

  it("measures a negative value by its size", () => {
    // A credit is a real amount. Drawing it as nothing hides it.
    expect(barWidth(-50, 100)).toBe(50);
  });

  it("draws nothing when every value is zero", () => {
    // peak is 0, and dividing by it would be Infinity or NaN across the
    // whole column.
    expect(barWidth(0, 0)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
  });

  it("does not overflow its track", () => {
    expect(barWidth(200, 100)).toBe(100);
  });
});
