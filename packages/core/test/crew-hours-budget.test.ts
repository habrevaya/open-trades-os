import { describe, it, expect } from "vitest";
import { estimate as est } from "../src/index";

const line = (quantity: string, over: Record<string, unknown> = {}) =>
  ({ quantity, quantityIsCrewHours: true, ...over }) as Parameters<typeof est.crewHoursBudget>[0][number];

describe("the crew hours an approved option budgets a job", () => {
  it("adds up the lines that count their quantity in crew hours, to the ten thousandth", () => {
    expect(est.crewHoursBudget([line("0.1"), line("0.2"), line("16")])).toBe("16.3000");
  });

  it("leaves out lines that are not hours", () => {
    expect(est.crewHoursBudget([line("8"), line("40", { quantityIsCrewHours: false })])).toBe("8.0000");
  });

  it("counts an optional line only when the customer ticked it", () => {
    expect(est.crewHoursBudget([
      line("8"), line("4", { isOptional: true, isSelected: true }), line("5", { isOptional: true, isSelected: false }),
    ])).toBe("12.0000");
  });

  it("is null when nothing counts hours or they add up to nothing", () => {
    expect(est.crewHoursBudget([])).toBeNull();
    expect(est.crewHoursBudget([line("40", { quantityIsCrewHours: false })])).toBeNull();
    expect(est.crewHoursBudget([line("0"), line("-3")])).toBeNull();
  });
});
