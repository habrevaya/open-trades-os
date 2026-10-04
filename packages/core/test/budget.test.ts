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
