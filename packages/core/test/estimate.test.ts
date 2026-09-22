import { describe, it, expect } from "vitest";
import { money, toString, zero } from "../src/money/index.js";
import {
  computeOption, computeDeposit, applicableDeposit, presentationOrder,
  DepositError, type EstimateLineInput,
} from "../src/estimate/index.js";
import {
  postDeposit, postDepositApplication, postDepositRefund, postDepositForfeiture,
  ACCOUNTS,
} from "../src/ledger/index.js";

const line = (over: Partial<EstimateLineInput> = {}): EstimateLineInput => ({
  quantity: "1",
  unitPrice: money("100.00"),
  taxable: true,
  taxRate: "0",
  ...over,
});

describe("option totals", () => {
  it("excludes an optional line the customer has not taken", () => {
    const { totals } = computeOption([
      line({ unitPrice: money("1200.00") }),
      line({ unitPrice: money("249.00"), isOptional: true }),
    ]);
    expect(toString(totals.total)).toBe("1200.0000");
    expect(toString(totals.optionalTotal)).toBe("249.0000");
  });

  it("includes an optional line once it is taken, and it leaves the offer list", () => {
    const { totals } = computeOption([
      line({ unitPrice: money("1200.00") }),
      line({ unitPrice: money("249.00"), isOptional: true, isSelected: true }),
    ]);
    expect(toString(totals.total)).toBe("1449.0000");
    expect(toString(totals.optionalTotal)).toBe("0.0000");
  });

  it("prices every line, including ones outside the total", () => {
    // The customer has to see what the option they did not take would cost,
    // or there is nothing to say yes to later.
    const { lines } = computeOption([
      line({ unitPrice: money("1200.00") }),
      line({ unitPrice: money("249.00"), isOptional: true }),
    ]);
    expect(lines).toHaveLength(2);
    expect(toString(lines[1]!.lineTotal)).toBe("249.0000");
  });

  it("keeps the base total steady as optional lines are taken", () => {
    const taken = computeOption([
      line({ unitPrice: money("1200.00") }),
      line({ unitPrice: money("249.00"), isOptional: true, isSelected: true }),
    ]);
    expect(toString(taken.totals.baseTotal)).toBe("1200.0000");
    expect(toString(taken.totals.total)).toBe("1449.0000");
  });

  it("taxes only the included lines", () => {
    const { totals } = computeOption([
      line({ unitPrice: money("1000.00"), taxRate: "0.0825" }),
      line({ unitPrice: money("500.00"), taxRate: "0.0825", isOptional: true }),
    ]);
    expect(toString(totals.taxTotal)).toBe("82.5000");
    expect(toString(totals.total)).toBe("1082.5000");
  });

  it("reports margin when every included line carries a cost", () => {
    const { totals } = computeOption([
      line({ unitPrice: money("1000.00"), unitCost: money("600.00") }),
    ]);
    expect(toString(totals.cost!)).toBe("600.0000");
    expect(totals.margin).toBe("0.400000");
  });

  it("reports no margin at all when one included line is missing a cost", () => {
    // A margin computed from a partial cost picture is not a low margin, it is
    // a wrong one, and it will be read as the former.
    const { totals } = computeOption([
      line({ unitPrice: money("1000.00"), unitCost: money("600.00") }),
      line({ unitPrice: money("400.00") }),
    ]);
    expect(totals.cost).toBeNull();
    expect(totals.margin).toBeNull();
  });

  it("ignores the cost of an optional line nobody took", () => {
    const { totals } = computeOption([
      line({ unitPrice: money("1000.00"), unitCost: money("600.00") }),
      line({ unitPrice: money("400.00"), isOptional: true }),
    ]);
    expect(totals.margin).toBe("0.400000");
  });

  it("handles an option with no lines", () => {
    const { totals } = computeOption([]);
    expect(toString(totals.total)).toBe("0.0000");
    expect(totals.margin).toBeNull();
  });
});

describe("presentation order", () => {
  it("presents most expensive first, because cheapest-first anchors low", () => {
    const ordered = presentationOrder([
      { total: money("1200.00"), name: "good" },
      { total: money("8400.00"), name: "best" },
      { total: money("4100.00"), name: "better" },
    ]);
    expect(ordered.map((o) => o.name)).toEqual(["best", "better", "good"]);
  });

  it("pulls the recommended option to the front", () => {
    const ordered = presentationOrder([
      { total: money("1200.00"), name: "good" },
      { total: money("8400.00"), name: "best" },
      { total: money("4100.00"), name: "better", isRecommended: true },
    ]);
    expect(ordered.map((o) => o.name)).toEqual(["better", "best", "good"]);
  });
});

describe("deposit policy", () => {
  it("takes a percentage of the total", () => {
    expect(toString(computeDeposit(money("4000.00"), { percent: "0.5" }))).toBe("2000.0000");
  });

  it("takes a flat amount", () => {
    expect(toString(computeDeposit(money("4000.00"), { amount: money("500.00") }))).toBe("500.0000");
  });

  it("asks for nothing when no policy is set", () => {
    expect(toString(computeDeposit(money("4000.00"), {}))).toBe("0.0000");
  });

  it("caps at the maximum", () => {
    const d = computeDeposit(money("40000.00"), { percent: "0.5", maximum: money("5000.00") });
    expect(toString(d)).toBe("5000.0000");
  });

  it("asks for nothing rather than a trivial amount", () => {
    // Collecting eighteen dollars up front costs more in handling than it holds.
    const d = computeDeposit(money("180.00"), { percent: "0.1", minimum: money("100.00") });
    expect(toString(d)).toBe("0.0000");
  });

  it("never asks for more than the job is worth", () => {
    const d = computeDeposit(money("300.00"), { amount: money("500.00") });
    expect(toString(d)).toBe("300.0000");
  });

  it("rejects a policy that sets both an amount and a percent", () => {
    expect(() => computeDeposit(money("100.00"), { amount: money("50.00"), percent: "0.5" }))
      .toThrow(DepositError);
  });

  it("rejects a percentage over one hundred", () => {
    expect(() => computeDeposit(money("100.00"), { percent: "1.5" })).toThrow(DepositError);
  });
});

describe("applying a deposit", () => {
  it("applies the whole deposit when the invoice is larger", () => {
    const applied = applicableDeposit({
      heldAmount: money("2000.00"),
      alreadyApplied: zero("USD"),
      invoiceBalance: money("4000.00"),
    });
    expect(toString(applied)).toBe("2000.0000");
  });

  it("never applies more than the invoice is asking for", () => {
    // The remainder stays held against the next invoice on the job rather than
    // becoming a credit the customer has to ring up about.
    const applied = applicableDeposit({
      heldAmount: money("2000.00"),
      alreadyApplied: zero("USD"),
      invoiceBalance: money("1400.00"),
    });
    expect(toString(applied)).toBe("1400.0000");
  });

  it("accounts for what has already been consumed", () => {
    const applied = applicableDeposit({
      heldAmount: money("2000.00"),
      alreadyApplied: money("1400.00"),
      invoiceBalance: money("2600.00"),
    });
    expect(toString(applied)).toBe("600.0000");
  });

  it("applies nothing once the deposit is spent", () => {
    const applied = applicableDeposit({
      heldAmount: money("2000.00"),
      alreadyApplied: money("2000.00"),
      invoiceBalance: money("600.00"),
    });
    expect(toString(applied)).toBe("0.0000");
  });
});

describe("deposits in the ledger", () => {
  const at = new Date("2026-03-01T12:00:00Z");
  const codes = (p: ReturnType<typeof postDeposit>) =>
    Object.fromEntries(p.entries.map((e) => [`${e.direction}:${e.accountCode}`, toString(e.amount)]));

  it("books a deposit as a liability, never as revenue", () => {
    const p = postDeposit({ depositId: "d1", occurredAt: at, amount: money("2000.00") });
    expect(codes(p)).toEqual({
      "debit:1000": "2000.0000",
      "credit:2300": "2000.0000",
    });
    expect(p.entries.some((e) => e.accountCode === ACCOUNTS.REVENUE)).toBe(false);
  });

  it("recognises no sales tax on a deposit", () => {
    // Tax is owed when the sale is recognised, not when the cash arrives.
    const p = postDeposit({ depositId: "d1", occurredAt: at, amount: money("2000.00") });
    expect(p.entries.some((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE)).toBe(false);
  });

  it("nets the processing fee out of cash and still balances", () => {
    const p = postDeposit({
      depositId: "d1", occurredAt: at,
      amount: money("2000.00"), processingFee: money("58.00"),
    });
    expect(codes(p)).toEqual({
      "debit:1000": "1942.0000",
      "debit:6100": "58.0000",
      "credit:2300": "2000.0000",
    });
  });

  it("discharges the liability against the receivable on application", () => {
    const p = postDepositApplication({ depositId: "d1", occurredAt: at, amount: money("2000.00") });
    expect(codes(p)).toEqual({
      "debit:2300": "2000.0000",
      "credit:1200": "2000.0000",
    });
    // No cash moves: it arrived when the deposit was taken.
    expect(p.entries.some((e) => e.accountCode === ACCOUNTS.CASH)).toBe(false);
  });

  it("returns cash and clears the liability on a refund, touching no revenue", () => {
    const p = postDepositRefund({ depositId: "d1", occurredAt: at, amount: money("2000.00") });
    expect(codes(p)).toEqual({
      "debit:2300": "2000.0000",
      "credit:1000": "2000.0000",
    });
    expect(p.entries.some((e) => e.accountCode === ACCOUNTS.REVENUE)).toBe(false);
  });

  it("earns a forfeited deposit without moving cash", () => {
    const p = postDepositForfeiture({ depositId: "d1", occurredAt: at, amount: money("500.00") });
    expect(codes(p)).toEqual({
      "debit:2300": "500.0000",
      "credit:4000": "500.0000",
    });
  });

  it("leaves the deposit liability at zero across take, apply and refund", () => {
    const taken = postDeposit({ depositId: "d1", occurredAt: at, amount: money("2000.00") });
    const applied = postDepositApplication({ depositId: "d1", occurredAt: at, amount: money("1400.00") });
    const refunded = postDepositRefund({ depositId: "d1", occurredAt: at, amount: money("600.00") });

    const net = [taken, applied, refunded]
      .flatMap((p) => p.entries)
      .filter((e) => e.accountCode === ACCOUNTS.CUSTOMER_DEPOSITS)
      .reduce((acc, e) => acc + (e.direction === "debit" ? 1 : -1) * Number(toString(e.amount)), 0);

    expect(net).toBe(0);
  });
});
