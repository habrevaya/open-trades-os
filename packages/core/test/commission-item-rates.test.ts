import { describe, it, expect } from "vitest";
import * as labor from "../src/labor/index.js";
import { money, toString as m, add, sum } from "../src/money/index.js";

/**
 * AN ITEM'S OWN COMMISSION RATE, AND THE COMPANY'S CHOICE OF HOW IT COMBINES
 * WITH THE PLAN
 *
 * Every figure here was worked by hand first, on one invoice:
 *
 *   Water heater, 50 gallon   1,000.00   the item's own rate 10%
 *   Smart thermostat            300.00   the item's own rate 5%
 *   Haul away the old tank      200.00   no rate of its own
 *                              -------
 *                              1,500.00
 *
 * Under eight per cent of revenue the plan pays 120.00, which is 80.00,
 * 24.00 and 16.00 on the three lines. The items' own rates are 100.00 and
 * 15.00.
 *
 *   The plan only                 120.00
 *   The item's rate wins          100.00 + 15.00 + 16.00 = 131.00
 *   Whichever pays more           100.00 + 24.00 + 16.00 = 140.00
 *   The item's rate on top        120.00 + 100.00 + 15.00 = 235.00
 */
const usd = (v: string) => money(v, "USD");

const LINES: labor.CommissionLine[] = [
  { lineId: "l1", label: "Water heater, 50 gallon", net: usd("1000.00"), itemRate: "0.100000" },
  { lineId: "l2", label: "Smart thermostat", net: usd("300.00"), itemRate: "0.050000" },
  { lineId: "l3", label: "Haul away the old tank", net: usd("200.00"), itemRate: null },
];

const event = (over: Partial<labor.CommissionEvent> = {}): labor.CommissionEvent => ({
  id: "inv-1", jobId: "job-1", invoiceId: "inv-1", occurredAt: new Date("2026-03-04T15:00:00Z"),
  revenue: usd("1500.00"), shares: [{ personId: "ray", weight: "1" }], lines: LINES, ...over,
});

const revenuePlan = (itemRule?: labor.ItemRateRule): labor.CommissionPlan => ({
  basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
  ...(itemRule ? { itemRule } : {}),
});

function total(plan: labor.CommissionPlan, e: labor.CommissionEvent = event()): string {
  const verdict = labor.computeCommission(plan, e);
  if (!verdict.ok) throw new Error(verdict.reason);
  return m(verdict.total);
}

function verdictOf(plan: labor.CommissionPlan, e: labor.CommissionEvent = event()) {
  const verdict = labor.computeCommission(plan, e);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict;
}

describe("the company's choice, on a plan of eight per cent of revenue", () => {
  it("pays the plan only when nobody has chosen, exactly as before there was a choice", () => {
    expect(total(revenuePlan())).toBe("120.0000");
    const verdict = verdictOf(revenuePlan("plan_only"));
    expect(m(verdict.total)).toBe("120.0000");
    // The words are the plan's words, unchanged: no line breakdown, no sentence about items.
    expect(verdict.explanation).toBe(verdictOf(revenuePlan()).explanation);
    expect(verdict.lines).toBeUndefined();
    expect(verdict.rule).toBe("plan_only");
  });

  it("pays the item's rate instead of the plan on a line whose item has one", () => {
    const verdict = verdictOf(revenuePlan("item_wins"));
    expect(m(verdict.total)).toBe("131.0000");
    expect(verdict.rule).toBe("item_wins");
    expect(verdict.lines!.map((l) => [l.lineId, m(l.planPart), l.itemPart ? m(l.itemPart) : null, m(l.paid), l.source])).toEqual([
      ["l1", "80.0000", "100.0000", "100.0000", "item"],
      ["l2", "24.0000", "15.0000", "15.0000", "item"],
      ["l3", "16.0000", null, "16.0000", "plan"],
    ]);
    expect(verdict.explanation).toContain("The company pays an item's own rate on its line instead of the plan.");
    expect(verdict.explanation).toContain("The plan pays 8% of what each line charged, $120.00 on the whole invoice.");
    expect(verdict.explanation).toContain("Water heater, 50 gallon: 10% of $1,000.00 is $100.00, paid instead of the plan's $80.00.");
    expect(verdict.explanation).toContain("Smart thermostat: 5% of $300.00 is $15.00, paid instead of the plan's $24.00.");
    expect(verdict.explanation).toContain("Commission: $131.00.");
  });

  it("pays whichever is more, line by line", () => {
    const verdict = verdictOf(revenuePlan("higher"));
    expect(m(verdict.total)).toBe("140.0000");
    expect(verdict.lines!.map((l) => [m(l.paid), l.source])).toEqual([
      ["100.0000", "item"], ["24.0000", "plan"], ["16.0000", "plan"],
    ]);
    expect(verdict.explanation).toContain("Water heater, 50 gallon: 10% of $1,000.00 is $100.00, more than the plan's $80.00, so the item's rate is paid.");
    expect(verdict.explanation).toContain("Smart thermostat: 5% of $300.00 is $15.00, less than the plan's $24.00, so the plan is paid.");
  });

  it("says so when the two come to the same", () => {
    const verdict = verdictOf(revenuePlan("higher"), event({
      revenue: usd("1000.00"),
      lines: [{ lineId: "l1", label: "Water heater, 50 gallon", net: usd("1000.00"), itemRate: "0.08" }],
    }));
    expect(m(verdict.total)).toBe("80.0000");
    expect(verdict.lines![0]!.source).toBe("plan");
    expect(verdict.explanation).toContain("8% of $1,000.00 is $80.00, the same as the plan's $80.00.");
  });

  it("pays the item's rate on top of the plan", () => {
    const verdict = verdictOf(revenuePlan("item_adds"));
    expect(m(verdict.total)).toBe("235.0000");
    expect(verdict.lines!.map((l) => [m(l.paid), l.source])).toEqual([
      ["180.0000", "plan_and_item"], ["39.0000", "plan_and_item"], ["16.0000", "plan"],
    ]);
    expect(verdict.explanation).toContain("Water heater, 50 gallon: 10% of $1,000.00 is $100.00, paid on top of the plan.");
  });

  it("changes nothing, and says why, when no line is for an item with a rate of its own", () => {
    const plain = event({ lines: LINES.map((l) => ({ ...l, itemRate: null })) });
    for (const rule of ["item_wins", "higher", "item_adds"] as const) {
      const verdict = verdictOf(revenuePlan(rule), plain);
      expect(m(verdict.total)).toBe("120.0000");
      expect(verdict.lines).toBeUndefined();
      expect(verdict.explanation).toContain("No line on this invoice is for an item with its own rate, so the plan decides it.");
      expect(verdict.parts[0]!.explanation).toContain("so the plan decides it.");
    }
  });
});

describe("the choice, on a plan that is not a rate on each line", () => {
  /**
   * Thirty per cent of a 600.00 margin (1,500.00 less 900.00 of cost) is
   * 180.00. Shared over the lines by what each charged it is 120.00, 36.00
   * and 24.00.
   *
   *   The item's rate wins    180.00 - (120.00 - 100.00) - (36.00 - 15.00) = 139.00
   *   Whichever pays more     both items are below the plan's part:          180.00
   *   On top                  180.00 + 100.00 + 15.00                       = 295.00
   */
  const margin = (itemRule: labor.ItemRateRule): labor.CommissionPlan => ({
    basis: "percent_of_gross_margin", rate: "0.30", note: "Thirty per cent of the margin.", itemRule,
  });
  const costed = event({ cost: usd("900.00") });

  it("shares a margin plan over the lines by what each charged", () => {
    expect(total(margin("plan_only"), costed)).toBe("180.0000");
    const wins = verdictOf(margin("item_wins"), costed);
    expect(m(wins.total)).toBe("139.0000");
    expect(wins.lines!.map((l) => m(l.planPart))).toEqual(["120.0000", "36.0000", "24.0000"]);
    expect(wins.explanation).toContain("The plan pays $180.00 on the whole invoice, shared over its lines by what each one charged.");
    expect(total(margin("higher"), costed)).toBe("180.0000");
    expect(total(margin("item_adds"), costed)).toBe("295.0000");
  });

  it("still pays an item's own rate on a job that lost money, and the plan nothing", () => {
    const lost = event({ cost: usd("1600.00") });
    expect(total(margin("plan_only"), lost)).toBe("0.0000");
    const wins = verdictOf(margin("item_wins"), lost);
    expect(m(wins.total)).toBe("115.0000");
    expect(wins.explanation).toContain("The job lost money, so the plan pays nothing on it.");
    expect(total(margin("item_adds"), lost)).toBe("115.0000");
    expect(total(margin("higher"), lost)).toBe("115.0000");
  });

  it("still refuses a margin plan with no cost, whatever the choice", () => {
    const verdict = labor.computeCommission(margin("item_wins"), event());
    expect(verdict.ok).toBe(false);
  });

  /**
   * Fifty dollars a job, shared by what each line charged, is 33.3333,
   * 10.00 and 6.6667. Instead of the plan: 50 + 66.6667 + 5 = 121.6667,
   * which is 121.67 to the cent. On top: 50 + 115 = 165.00.
   */
  it("shares a flat plan the same way, and makes the result payable once", () => {
    const flat = (itemRule: labor.ItemRateRule): labor.CommissionPlan => ({
      basis: "flat_per_job", flatAmount: usd("50.00"), note: "Fifty dollars a job.", itemRule,
    });
    expect(total(flat("plan_only"))).toBe("50.0000");
    const wins = verdictOf(flat("item_wins"));
    expect(wins.lines!.map((l) => m(l.planPart))).toEqual(["33.3333", "10.0000", "6.6667"]);
    expect(m(wins.total)).toBe("121.6700");
    expect(total(flat("higher"))).toBe("121.6700");
    expect(total(flat("item_adds"))).toBe("165.0000");
  });

  it("shares a plan on what was collected by what each line charged", () => {
    const collected: labor.CommissionPlan = {
      basis: "percent_of_collected", rate: "0.10", note: "Ten per cent of what was collected.", itemRule: "item_wins",
    };
    // 150.00 on the whole; 100.00, 30.00 and 20.00 on the lines; items 100.00 and 15.00.
    expect(total(collected, event({ collected: usd("1500.00") }))).toBe("135.0000");
  });
});

describe("what the choice is paid out as", () => {
  it("is split between the people on it like any commission, the parts adding back exactly", () => {
    const verdict = verdictOf(revenuePlan("item_wins"), event({
      shares: [{ personId: "ray", weight: "2" }, { personId: "dana", weight: "1" }],
    }));
    expect(m(verdict.total)).toBe("131.0000");
    expect(verdict.parts.map((p) => m(p.amount))).toEqual(["87.3400", "43.6600"]);
    expect(m(sum(verdict.parts.map((p) => p.amount)))).toBe("131.0000");
    expect(verdict.parts[0]!.explanation).toContain("paid instead of the plan's $80.00.");
    expect(verdict.parts[0]!.explanation).toContain("the odd cent goes to the largest share");
  });

  it("is never below nothing: a line that charged less than nothing does not take pay off the rest", () => {
    // 8% of 100.00 is 8.00. The credit line's own rate of 100% on -400.00 replaces the plan's -32.00.
    const verdict = verdictOf(revenuePlan("item_wins"), event({
      revenue: usd("100.00"),
      lines: [
        { lineId: "l1", label: "Credit for the callback", net: usd("-400.00"), itemRate: "1" },
        { lineId: "l2", label: "Service call", net: usd("500.00"), itemRate: null },
      ],
    }));
    expect(m(verdict.total)).toBe("0.0000");
    expect(verdict.explanation).toContain("The lines come to less than nothing, so the commission is zero.");
  });

  it("leaves the plan alone on an invoice that charged nothing overall", () => {
    const verdict = verdictOf(revenuePlan("item_adds"), event({
      revenue: usd("0.00"),
      lines: [{ lineId: "l1", label: "Warranty part", net: usd("0.00"), itemRate: "0.10" }],
    }));
    expect(m(verdict.total)).toBe("0.0000");
    expect(verdict.explanation).toContain("charged nothing overall");
  });
});

describe("taking it back when the money comes back", () => {
  /**
   * A credit of 300.00 off the 1,500.00 is a fifth off every line: 800.00,
   * 240.00 and 160.00. The plan then pays 96.00, the water heater's own rate
   * 80.00 in place of the plan's 64.00 and the thermostat's 12.00 in place of
   * 19.20, so 104.80. From 131.00, 26.20 comes back, which is a fifth.
   */
  it("takes the credit off every line in proportion, and recomputes under the same choice", () => {
    const plan = revenuePlan("item_wins");
    const clawback = labor.clawbackFor(plan, event(), {
      id: "credit-1", commissionEventId: "inv-1", occurredAt: new Date("2026-04-01T15:00:00Z"),
      reason: "credit_note", creditedRevenue: usd("300.00"),
    });
    if (!clawback.ok) throw new Error(clawback.reason);
    expect(m(clawback.total)).toBe("-26.2000");
  });

  it("gives every cent back when the whole invoice is credited", () => {
    const plan = revenuePlan("item_adds");
    const clawback = labor.clawbackFor(plan, event({ shares: [{ personId: "ray", weight: "1" }, { personId: "dana", weight: "1" }] }), {
      id: "credit-2", commissionEventId: "inv-1", occurredAt: new Date("2026-04-01T15:00:00Z"),
      reason: "write_off", creditedRevenue: usd("1500.00"),
    });
    if (!clawback.ok) throw new Error(clawback.reason);
    expect(m(clawback.total)).toBe("-235.0000");
    expect(clawback.lines.map((l) => m(l.amount))).toEqual(["-117.5000", "-117.5000"]);
    expect(m(add(clawback.lines[0]!.amount, clawback.lines[1]!.amount))).toBe("-235.0000");
  });
});

describe("reading the company's choice", () => {
  it("reads the four choices and anything else as the plan only", () => {
    for (const rule of labor.ITEM_RATE_RULES) expect(labor.readItemRateRule({ itemRule: rule })).toBe(rule);
    for (const junk of [undefined, null, "item_wins", {}, { itemRule: "item_always" }, { itemRule: 3 }]) {
      expect(labor.readItemRateRule(junk)).toBe("plan_only");
    }
  });

  it("says each choice in a sentence, and the plan only is first", () => {
    expect(labor.ITEM_RATE_RULES[0]).toBe("plan_only");
    for (const rule of labor.ITEM_RATE_RULES) {
      expect(labor.ITEM_RATE_RULE[rule].label.length).toBeGreaterThan(0);
      expect(labor.ITEM_RATE_RULE[rule].meaning).toMatch(/\.$/);
    }
  });

  it("writes a rate as a percent without a float", () => {
    expect(labor.percentWords("0.085000")).toBe("8.5%");
    expect(labor.percentWords("0.1")).toBe("10%");
    expect(labor.percentWords("1")).toBe("100%");
    expect(labor.percentWords("0.123456")).toBe("12.3456%");
    expect(labor.percentWords("0")).toBe("0%");
  });
});
