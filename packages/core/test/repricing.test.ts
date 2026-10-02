import { describe, it, expect } from "vitest";
import { money } from "../src/money/index.js";
import {
  reprice, roundToEnding, checkRule, describeRule, marginOf, reversalOf,
} from "../src/repricing/index.js";

const ending = (price: string, cents: string) => {
  const rounded = roundToEnding(money(price), cents);
  return (Number(rounded.amount) / 10_000).toFixed(2);
};

describe("rounding to a price ending", () => {
  it("rounds up to the next price with those cents, never down", () => {
    expect(ending("218.40", "95")).toBe("218.95");
    expect(ending("218.96", "95")).toBe("219.95");
    expect(ending("218.00", "00")).toBe("218.00");
    expect(ending("218.01", "00")).toBe("219.00");
  });

  it("leaves a price already on the ending where it is", () => {
    expect(ending("49.99", "99")).toBe("49.99");
  });

  it("rounds a sub cent price up to the cent before it looks at the ending", () => {
    // 218.9501 is a cent over 218.95, so .95 is the next one up.
    expect(ending("218.9501", "95")).toBe("219.95");
  });
});

describe("one item under a rule", () => {
  it("raises by a percentage to the cent, half up", () => {
    expect(reprice({ price: "218.40", cost: null }, { adjust: { kind: "percent", percent: "5" } }))
      .toEqual({ changed: true, price: "229.3200" });
    expect(reprice({ price: "10.00", cost: null }, { adjust: { kind: "percent", percent: "-12.5" } }))
      .toEqual({ changed: true, price: "8.7500" });
  });

  it("adds a fixed amount, up or down", () => {
    expect(reprice({ price: "99.00", cost: null }, { adjust: { kind: "amount", amount: "+5" } }))
      .toEqual({ changed: true, price: "104.0000" });
    expect(reprice({ price: "99.00", cost: null }, { adjust: { kind: "amount", amount: "-9.01" } }))
      .toEqual({ changed: true, price: "89.9900" });
  });

  it("prices to a margin over cost, rounding up so the margin is at least what was asked", () => {
    // 55 / (1 - 0.45) = 100.00 exactly.
    expect(reprice({ price: "80.00", cost: "55.00" }, { adjust: { kind: "margin", margin: "0.45" } }))
      .toEqual({ changed: true, price: "100.0000" });
    // 10 / 0.7 = 14.2857..., up to 14.29.
    const out = reprice({ price: "12.00", cost: "10.00" }, { adjust: { kind: "margin", margin: "0.30" } });
    expect(out).toEqual({ changed: true, price: "14.2900" });
    expect(Number(marginOf("14.29", "10.00"))).toBeGreaterThanOrEqual(0.3);
  });

  it("skips an item with no cost when the rule is a margin, and says so", () => {
    const out = reprice({ price: "80.00", cost: null }, { adjust: { kind: "margin", margin: "0.45" } });
    expect(out).toMatchObject({ changed: false, reason: "no_cost" });
  });

  it("will not price anything at nothing", () => {
    const out = reprice({ price: "5.00", cost: null }, { adjust: { kind: "amount", amount: "-5" } });
    expect(out).toMatchObject({ changed: false, reason: "not_positive" });
  });

  it("applies the ending after the change", () => {
    expect(reprice({ price: "218.40", cost: null }, { adjust: { kind: "percent", percent: "5" }, ending: "95" }))
      .toEqual({ changed: true, price: "229.9500" });
  });

  it("can only round", () => {
    expect(reprice({ price: "218.40", cost: null }, { adjust: { kind: "none" }, ending: "00" }))
      .toEqual({ changed: true, price: "219.0000" });
    expect(reprice({ price: "219.00", cost: null }, { adjust: { kind: "none" }, ending: "00" }))
      .toMatchObject({ changed: false, reason: "unchanged" });
  });
});

describe("a rule worth previewing", () => {
  it("refuses the typos that would wreck a book", () => {
    expect(checkRule({ adjust: { kind: "percent", percent: "0" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "percent", percent: "-100" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "percent", percent: "5000" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "percent", percent: "five" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "margin", margin: "45" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "margin", margin: "0" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "none" } }).ok).toBe(false);
    expect(checkRule({ adjust: { kind: "none" }, ending: "9" }).ok).toBe(false);
  });

  it("accepts the ordinary ones", () => {
    expect(checkRule({ adjust: { kind: "percent", percent: "+7.5" } }).ok).toBe(true);
    expect(checkRule({ adjust: { kind: "amount", amount: "-2" }, ending: "99" }).ok).toBe(true);
    expect(checkRule({ adjust: { kind: "margin", margin: "0.45" } }).ok).toBe(true);
    expect(checkRule({ adjust: { kind: "none" }, ending: "95" }).ok).toBe(true);
  });
});

describe("the rule in words", () => {
  it("reads back what was asked for", () => {
    expect(describeRule({ adjust: { kind: "percent", percent: "5" }, ending: "95" }))
      .toBe("Up 5%, rounded up to the next .95");
    expect(describeRule({ adjust: { kind: "amount", amount: "-2.50" } })).toBe("Down $2.50");
    expect(describeRule({ adjust: { kind: "margin", margin: "0.45" } })).toBe("Priced to a 45% margin over cost");
    expect(describeRule({ adjust: { kind: "none" }, ending: "00" })).toBe("Rounded up to the next .00");
  });
});

describe("margin", () => {
  it("is price less cost over price, to four places", () => {
    expect(marginOf("100.00", "55.00")).toBe("0.4500");
    expect(marginOf("100.00", null)).toBeNull();
    expect(marginOf("0", "1")).toBeNull();
  });
});

describe("undoing a change", () => {
  it("puts the old price back rather than applying the opposite percentage", () => {
    // Five per cent up and five per cent down is 99.75, not 100.
    expect(reversalOf({ priceBefore: "100.0000", priceAfter: "105.0000", priceNow: "105.0000" }))
      .toEqual({ ok: true, price: "100.0000" });
  });

  it("will not undo an item somebody has changed again since", () => {
    expect(reversalOf({ priceBefore: "100.0000", priceAfter: "105.0000", priceNow: "110.0000" }).ok)
      .toBe(false);
  });
});
