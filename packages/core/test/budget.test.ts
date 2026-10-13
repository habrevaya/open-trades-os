import { describe, it, expect } from "vitest";
import { budget as b, money as m } from "../src/index";

const usd = (v: string) => m.money(v, "USD");
const sums = (entries: Record<string, [string, string]>) =>
  new Map(Object.entries(entries).map(([code, [debit, credit]]) => [code, { debit: usd(debit), credit: usd(credit) }]));

describe("which category an account counts towards", () => {
  it("reads the chart's numbering", () => {
    expect(b.categoryOf("4000")).toBe("revenue");
    expect(b.categoryOf("4900")).toBe("revenue");
    expect(b.categoryOf("5000")).toBe("materials");
    expect(b.categoryOf("5100")).toBe("labour");
    expect(b.categoryOf("5200")).toBe("labour");
    expect(b.categoryOf("6100")).toBe("overhead");
    expect(b.categoryOf("7000")).toBe("overhead");
    expect(b.categoryOf("1000")).toBeNull();
    expect(b.categoryOf("2200")).toBeNull();
  });
});

describe("the actual for a line", () => {
  const ledger = sums({
    "4000": ["0", "10000"],
    "4900": ["500", "0"],
    "6100": ["290", "0"],
    "6900": ["150", "0"],
    "5000": ["1200", "100"],
    "1000": ["9000", "0"],
  });

  it("nets a discount out of revenue", () => {
    expect(m.toString(b.actualFor("category:revenue", ledger))).toBe("9500.0000");
  });

  it("adds a category's accounts and nets a credit against a cost", () => {
    expect(m.toString(b.actualFor("category:overhead", ledger))).toBe("440.0000");
    expect(m.toString(b.actualFor("category:materials", ledger))).toBe("1100.0000");
    expect(m.toString(b.actualFor("account:6100", ledger))).toBe("290.0000");
  });
});

describe("variance", () => {
  it("is favourable when revenue beats the budget and when a cost comes in under it", () => {
    const revenue = b.variance("category:revenue", usd("9000"), usd("9500"));
    expect(m.toString(revenue.variance)).toBe("500.0000");
    expect(revenue.percent).toBe(5.6);
    expect(revenue.favourable).toBe(true);

    const cost = b.variance("category:overhead", usd("400"), usd("440"));
    expect(cost.favourable).toBe(false);
    expect(cost.percent).toBe(10);

    expect(b.variance("category:labour", usd("400"), usd("300")).favourable).toBe(true);
  });

  it("has no percentage with no budget, and no verdict on an exact hit", () => {
    expect(b.variance("category:revenue", usd("0"), usd("100")).percent).toBeNull();
    expect(b.variance("category:revenue", usd("100"), usd("100")).favourable).toBeNull();
  });
});

describe("a budget from a spreadsheet", () => {
  it("reads lines by name or account, months by name or number, and amounts as exported", () => {
    const parsed = b.parseBudgetCsv(
      "Line,Jan,Feb,3,Total\n"
      + "Revenue,\"80,000.00\",$85000,,165000\n"
      + "labor,30000,(250),31000\n"
      + "6100,1200,1250,1300\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.cells).toContainEqual({ line: "category:revenue", month: 1, amount: "80000.00" });
    expect(parsed.cells).toContainEqual({ line: "category:revenue", month: 2, amount: "85000" });
    expect(parsed.cells.filter((c) => c.line === "category:revenue")).toHaveLength(2);
    expect(parsed.cells).toContainEqual({ line: "category:labour", month: 2, amount: "-250" });
    expect(parsed.cells).toContainEqual({ line: "account:6100", month: 3, amount: "1300" });
  });

  it("lists every problem at once", () => {
    const parsed = b.parseBudgetCsv("Line,Jan,Smarch\nRevenue,abc,1\nPets,1,1\nRevenue,1,1\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.some((p) => p.includes("Smarch"))).toBe(true);
    expect(parsed.problems.some((p) => p.includes("\"abc\""))).toBe(true);
    expect(parsed.problems.some((p) => p.includes("Pets"))).toBe(true);
    expect(parsed.problems.some((p) => p.includes("appears twice"))).toBe(true);
  });
});

describe("the year end forecast", () => {
  /** Revenue budgeted at 10,000 a month, and the first three months at 9,000, 12,000 and 9,000. */
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    budget: i === 11 ? null : usd("10000"),
    actual: usd(i === 1 ? "12000" : i < 3 ? "9000" : i === 3 ? "4000" : "0"),
  }));

  it("counts only the months already over: the month in progress is a month to come", () => {
    expect(b.closedMonths(2026, "2026-04-10")).toBe(3);
    expect(b.closedMonths(2025, "2026-04-10")).toBe(12);
    expect(b.closedMonths(2027, "2026-04-10")).toBe(0);
    expect(b.closedMonths(2026, "2026-01-31")).toBe(0);
  });

  it("takes the months to come at their budget, and a month with none as nothing", () => {
    const f = b.forecastLine({ key: "category:revenue", months, closed: 3, method: "budget" });
    // 30,000 so far; April to November at 10,000 is 80,000; December has no budget.
    expect(m.toString(f.closedActual)).toBe("30000.0000");
    expect(m.toString(f.toCome)).toBe("80000.0000");
    expect(m.toString(f.forecast)).toBe("110000.0000");
    expect(f.unbudgetedMonths).toBe(1);
    expect(m.toString(f.yearBudget)).toBe("110000.0000");
    expect(f.variance.favourable).toBeNull();
    // April's 4,000 so far is not read: April is not over.
    expect(f.method).toBe("budget");
  });

  it("takes them at the run rate when the company chose it", () => {
    const f = b.forecastLine({ key: "category:revenue", months, closed: 3, method: "run_rate" });
    // An average of 10,000 over three months, for nine months: 90,000, so 120,000.
    expect(m.toString(f.toCome)).toBe("90000.0000");
    expect(m.toString(f.forecast)).toBe("120000.0000");
    expect(f.variance.favourable).toBe(true);
    expect(f.unbudgetedMonths).toBe(0);
  });

  it("rounds a run rate to the cent and judges a cost the other way", () => {
    const cost = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, budget: usd("100"), actual: usd(i < 3 ? "110.01" : "0") }));
    const f = b.forecastLine({ key: "category:labour", months: cost, closed: 3, method: "run_rate" });
    // 330.03 over three months, for nine: 990.09.
    expect(m.toString(f.forecast)).toBe("1320.1200");
    expect(f.variance.favourable).toBe(false);
  });

  it("falls back to the budget with no month over yet, and says so", () => {
    const f = b.forecastLine({ key: "category:revenue", months, closed: 0, method: "run_rate" });
    expect(f.method).toBe("budget");
    expect(f.fellBack).toBe(true);
    expect(m.toString(f.forecast)).toBe("110000.0000");
  });

  it("is the actual for a year that is over", () => {
    const f = b.forecastLine({ key: "category:revenue", months, closed: 12, method: "budget" });
    expect(m.toString(f.forecast)).toBe("34000.0000");
    expect(m.isZero(f.toCome)).toBe(true);
  });
});
