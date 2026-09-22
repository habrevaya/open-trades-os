import { describe, it, expect } from "vitest";
import {
  money, zero, toString, add, subtract, multiply, divide, round, allocate, split,
  sum, compare, equals, negate, abs, isNegative, format, CurrencyMismatchError,
} from "../src/money/index.js";

const usd = (v: string) => money(v, "USD");

describe("parsing and representation", () => {
  it("round trips a decimal string exactly", () => {
    expect(toString(usd("12.34"))).toBe("12.3400");
    expect(toString(usd("0.0001"))).toBe("0.0001");
    expect(toString(usd("-5"))).toBe("-5.0000");
    expect(toString(usd("999999.9999"))).toBe("999999.9999");
  });

  it("refuses a JS number, which is how floats get in", () => {
    // @ts-expect-error deliberately passing a number
    expect(() => money(12.34)).toThrow();
  });

  it("refuses precision it cannot hold rather than silently truncating", () => {
    expect(() => usd("1.00001")).toThrow(/precision/);
  });

  it("refuses garbage", () => {
    expect(() => usd("12.34.56")).toThrow();
    expect(() => usd("1e5")).toThrow();
    expect(() => usd("")).toThrow();
  });
});

describe("the float problem this exists to avoid", () => {
  it("0.1 + 0.2 is exactly 0.3", () => {
    expect(toString(add(usd("0.1"), usd("0.2")))).toBe("0.3000");
    expect(equals(add(usd("0.1"), usd("0.2")), usd("0.3"))).toBe(true);
  });

  it("a hundred dimes is exactly ten dollars", () => {
    let total = zero("USD");
    for (let i = 0; i < 100; i++) total = add(total, usd("0.10"));
    expect(toString(total)).toBe("10.0000");
  });

  it("sub-cent unit costs survive a real quantity", () => {
    // 2,400 ft of wire at $0.1875/ft. Rounding the unit cost to cents first
    // gives 2400 * 0.19 = $456.00, which is $6 wrong on one line.
    expect(toString(multiply(usd("0.1875"), "2400"))).toBe("450.0000");
  });
});

describe("currency safety", () => {
  it("refuses to add different currencies", () => {
    expect(() => add(usd("1"), money("1", "CAD"))).toThrow(CurrencyMismatchError);
  });
});

describe("rounding", () => {
  it("rounds half away from zero, the way an invoice does", () => {
    expect(toString(round(usd("1.005"), 2))).toBe("1.0100");
    expect(toString(round(usd("2.675"), 2))).toBe("2.6800");
    expect(toString(round(usd("-1.005"), 2))).toBe("-1.0100");
  });

  it("supports bankers rounding when asked", () => {
    expect(toString(round(usd("1.005"), 2, "half-even"))).toBe("1.0000");
    expect(toString(round(usd("1.015"), 2, "half-even"))).toBe("1.0200");
  });

  it("does not round when asked for full precision", () => {
    expect(toString(round(usd("1.2345"), 4))).toBe("1.2345");
  });
});

describe("tax, the everyday case", () => {
  it("applies a rate held as a decimal string", () => {
    const line = usd("1250.00");
    const tax = round(multiply(line, "0.0825"), 2);
    expect(toString(tax)).toBe("103.1300");
    expect(toString(round(add(line, tax), 2))).toBe("1353.1300");
  });

  it("rounds once at the total, not on every line", () => {
    const lines = [usd("19.99"), usd("19.99"), usd("19.99")];
    const rate = "0.0825";
    const perLineRounded = sum(lines.map((l) => round(multiply(l, rate), 2)));
    const roundedAtTotal = round(multiply(sum(lines), rate), 2);
    // They differ by a cent. The second is what an accountant expects.
    expect(toString(perLineRounded)).toBe("4.9500");
    expect(toString(roundedAtTotal)).toBe("4.9500");
    // And with a rate that exposes it:
    const odd = [usd("0.07"), usd("0.07"), usd("0.07")];
    expect(toString(sum(odd.map((l) => round(multiply(l, "0.5"), 2))))).toBe("0.1200");
    expect(toString(round(multiply(sum(odd), "0.5"), 2))).toBe("0.1100");
  });
});

describe("allocation, where cents get lost", () => {
  it("splits at full precision and still reconciles", () => {
    const parts = split(usd("10.00"), 3);
    expect(parts.map(toString)).toEqual(["3.3334", "3.3333", "3.3333"]);
    expect(toString(sum(parts))).toBe("10.0000");
  });

  it("splits in whole cents when the parts will be paid or stored as cents", () => {
    // The trap: at full precision the remainder is a ten-thousandth, so
    // rounding each part to cents afterwards silently loses a cent.
    const naive = split(usd("10.00"), 3).map((p) => round(p, 2));
    expect(toString(sum(naive))).toBe("9.9900");

    // Allocating AT cent precision gives parts that are already whole cents
    // and still sum exactly to the original.
    const parts = split(usd("10.00"), 3, 2);
    expect(parts.map(toString)).toEqual(["3.3400", "3.3300", "3.3300"]);
    expect(toString(sum(parts))).toBe("10.0000");
  });

  it("keeps sub-cent residue rather than dropping it", () => {
    const parts = split(usd("10.0007"), 3, 2);
    expect(toString(sum(parts))).toBe("10.0007");
  });

  it("allocates by ratio and still reconciles exactly", () => {
    const parts = allocate(usd("100.00"), ["1", "1", "1"]);
    expect(toString(sum(parts))).toBe("100.0000");
  });

  it("applies a payment across invoices proportionally, to the cent", () => {
    // $1,000 received against invoices of $333.33, $333.33 and $333.34
    const parts = allocate(usd("1000.00"), ["333.33", "333.33", "333.34"], 2);
    expect(toString(sum(parts))).toBe("1000.0000");
    expect(parts.every((p) => p.amount % 100n === 0n)).toBe(true);
  });

  it("handles a negative amount, which is a refund being apportioned", () => {
    const parts = allocate(usd("-10.00"), ["1", "1", "1"]);
    expect(toString(sum(parts))).toBe("-10.0000");
    expect(parts.every(isNegative)).toBe(true);
  });

  it("is deterministic, so the same split twice is the same split", () => {
    const a = allocate(usd("10.00"), ["1", "1", "1"]).map((m) => toString(m));
    const b = allocate(usd("10.00"), ["1", "1", "1"]).map((m) => toString(m));
    expect(a).toEqual(b);
  });

  it("refuses ratios that sum to zero rather than dividing by zero", () => {
    expect(() => allocate(usd("10.00"), ["0", "0"])).toThrow();
  });

  it("splits a crew commission three ways with an uneven remainder", () => {
    const commission = usd("487.63");
    const parts = allocate(commission, ["0.5", "0.3", "0.2"], 2);
    expect(toString(sum(parts))).toBe("487.6300");
    expect(parts.map(toString)).toEqual(["243.8200", "146.2900", "97.5200"]);
  });
});

describe("arithmetic basics", () => {
  it("subtracts, negates and takes absolute value", () => {
    expect(toString(subtract(usd("10"), usd("3.50")))).toBe("6.5000");
    expect(toString(negate(usd("5")))).toBe("-5.0000");
    expect(toString(abs(usd("-5")))).toBe("5.0000");
  });

  it("divides", () => {
    expect(toString(divide(usd("10"), "4"))).toBe("2.5000");
  });

  it("compares", () => {
    expect(compare(usd("1"), usd("2"))).toBe(-1);
    expect(compare(usd("2"), usd("2"))).toBe(0);
  });

  it("sums an empty list to zero", () => {
    expect(toString(sum([]))).toBe("0.0000");
  });
});

describe("formatting is display only", () => {
  it("formats for a human", () => {
    expect(format(usd("1234.56"))).toBe("$1,234.56");
  });
});
