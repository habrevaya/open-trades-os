import { describe, it, expect } from "vitest";
import { money, toString, sum, zero, add } from "../src/money/index.js";
import {
  computeInvoice, postInvoice, postPayment, postRefund, postWriteOff,
  postAgreementBilling, postAgreementRecognition, postDeferredRelease,
  recognitionSchedule, imbalanceOf, assertBalanced, UnbalancedPostingError,
  ACCOUNTS, type LedgerEntry,
} from "../src/ledger/index.js";

const usd = (v: string) => money(v, "USD");
const at = new Date("2026-09-24T12:00:00.000Z");

/** Net movement on one account across a posting. Debits positive. */
const net = (entries: LedgerEntry[], account: string) =>
  entries
    .filter((e) => e.accountCode === account)
    .reduce((acc, e) => (e.direction === "debit" ? add(acc, e.amount) : add(acc, { ...e.amount, amount: -e.amount.amount })), zero("USD"));

describe("invoice arithmetic", () => {
  it("computes a simple taxable line", () => {
    const { totals } = computeInvoice([
      { quantity: "1", unitPrice: usd("1250.00"), taxable: true, taxRate: "0.0825" },
    ]);
    expect(toString(totals.subtotal)).toBe("1250.0000");
    expect(toString(totals.taxTotal)).toBe("103.1300");
    expect(toString(totals.total)).toBe("1353.1300");
  });

  it("handles quantity and a per line discount", () => {
    const { totals } = computeInvoice([
      { quantity: "3", unitPrice: usd("120.00"), discountAmount: usd("60.00"), taxable: true, taxRate: "0.10" },
    ]);
    expect(toString(totals.subtotal)).toBe("360.0000");
    expect(toString(totals.discountTotal)).toBe("60.0000");
    // Tax is on the discounted base, not the gross.
    expect(toString(totals.taxTotal)).toBe("30.0000");
    expect(toString(totals.total)).toBe("330.0000");
  });

  it("exempts a non taxable line", () => {
    const { totals } = computeInvoice([
      { quantity: "1", unitPrice: usd("100.00"), taxable: true, taxRate: "0.10" },
      { quantity: "1", unitPrice: usd("100.00"), taxable: false, taxRate: "0.10" },
    ]);
    expect(toString(totals.taxTotal)).toBe("10.0000");
  });

  /**
   * The case that produces phone calls. Rounding tax per line and summing
   * drifts from rounding once at the document, and the customer's own
   * arithmetic produces the second one.
   */
  it("rounds tax once at the document, not per line", () => {
    const lines = Array.from({ length: 3 }, () => ({
      quantity: "1", unitPrice: usd("0.07"), taxable: true, taxRate: "0.5",
    }));
    const { totals } = computeInvoice(lines);
    // 0.21 * 0.5 = 0.105, rounded once, is 0.11. Per line it would be 0.12.
    expect(toString(totals.taxTotal)).toBe("0.1100");
  });

  it("handles sub cent unit prices at real quantities", () => {
    const { totals } = computeInvoice([
      { quantity: "2400", unitPrice: usd("0.1875"), taxable: false, taxRate: "0" },
    ]);
    expect(toString(totals.subtotal)).toBe("450.0000");
  });

  it("produces zero totals for an empty invoice", () => {
    const { totals } = computeInvoice([]);
    expect(toString(totals.total)).toBe("0.0000");
  });
});

describe("every posting balances", () => {
  const cases: [string, () => { entries: LedgerEntry[] }][] = [
    ["invoice", () => postInvoice({
      invoiceId: "i1", occurredAt: at,
      totals: computeInvoice([{ quantity: "1", unitPrice: usd("1250.00"), taxable: true, taxRate: "0.0825" }]).totals,
    })],
    ["invoice with a discount", () => postInvoice({
      invoiceId: "i2", occurredAt: at,
      totals: computeInvoice([{ quantity: "2", unitPrice: usd("99.99"), discountAmount: usd("19.99"), taxable: true, taxRate: "0.0675" }]).totals,
    })],
    ["payment", () => postPayment({ paymentId: "p1", occurredAt: at, appliedAmount: usd("1353.13") })],
    ["payment with tip, surcharge and fee", () => postPayment({
      paymentId: "p2", occurredAt: at, appliedAmount: usd("500.00"),
      tipAmount: usd("40.00"), surchargeAmount: usd("15.00"), processingFee: usd("16.35"),
    })],
    ["refund", () => postRefund({ refundId: "r1", occurredAt: at, amount: usd("120.00") })],
    ["write off", () => postWriteOff({ invoiceId: "i3", occurredAt: at, amount: usd("88.40") })],
    ["agreement billing", () => postAgreementBilling({ invoiceId: "i4", occurredAt: at, amount: usd("228.00"), taxAmount: usd("18.81") })],
    ["agreement recognition", () => postAgreementRecognition({ agreementVisitId: "v1", occurredAt: at, amount: usd("114.00") })],
    ["deferred release to revenue", () => postDeferredRelease({ agreementId: "a1", occurredAt: at, amount: usd("57.00"), toRevenue: true })],
    ["deferred release to the customer", () => postDeferredRelease({ agreementId: "a2", occurredAt: at, amount: usd("57.00"), toRevenue: false })],
  ];

  it.each(cases)("%s", (_name, build) => {
    const posting = build();
    expect(toString(imbalanceOf(posting.entries))).toBe("0.0000");
  });
});

describe("invoice posting", () => {
  const totals = computeInvoice([
    { quantity: "1", unitPrice: usd("1000.00"), discountAmount: usd("100.00"), taxable: true, taxRate: "0.10" },
  ]).totals;
  const posting = postInvoice({ invoiceId: "i1", occurredAt: at, totals, jobId: "j1" });

  it("debits receivable for the collectible total", () => {
    expect(toString(net(posting.entries, ACCOUNTS.AR))).toBe("990.0000");
  });

  it("credits gross revenue and shows the discount separately", () => {
    // Netting the discount into revenue hides how much discounting is
    // happening, which is usually the number an owner most needs.
    expect(toString(net(posting.entries, ACCOUNTS.REVENUE))).toBe("-1000.0000");
    expect(toString(net(posting.entries, ACCOUNTS.DISCOUNTS))).toBe("100.0000");
  });

  it("treats collected tax as a liability, not income", () => {
    expect(toString(net(posting.entries, ACCOUNTS.TAX_PAYABLE))).toBe("-90.0000");
  });

  it("tags entries with the job, so profitability is a query", () => {
    expect(posting.entries.every((e) => e.jobId === "j1")).toBe(true);
  });
});

describe("payment posting", () => {
  const posting = postPayment({
    paymentId: "p1", occurredAt: at,
    appliedAmount: usd("500.00"), tipAmount: usd("40.00"),
    surchargeAmount: usd("15.00"), processingFee: usd("16.35"),
  });

  it("banks the net of the fee", () => {
    // 500 + 40 + 15 = 555 received, less a 16.35 fee.
    expect(toString(net(posting.entries, ACCOUNTS.CASH))).toBe("538.6500");
  });

  it("only clears the receivable by what was applied", () => {
    expect(toString(net(posting.entries, ACCOUNTS.AR))).toBe("-500.0000");
  });

  it("holds a tip as a liability rather than booking it as revenue", () => {
    // A tip is the technician's money from the moment it is collected.
    // Treating it as revenue overstates the month and understates it again
    // when the tip is paid out.
    expect(toString(net(posting.entries, ACCOUNTS.TIPS_PAYABLE))).toBe("-40.0000");
    expect(toString(net(posting.entries, ACCOUNTS.REVENUE))).toBe("-15.0000");
  });

  it("recognises the processing fee when it was incurred", () => {
    expect(toString(net(posting.entries, ACCOUNTS.PROCESSING_FEES))).toBe("16.3500");
  });

  it("omits zero amount entries rather than writing noise", () => {
    const plain = postPayment({ paymentId: "p2", occurredAt: at, appliedAmount: usd("100.00") });
    expect(plain.entries).toHaveLength(2);
  });
});

describe("agreement revenue", () => {
  it("bills up front as a liability rather than revenue", () => {
    const posting = postAgreementBilling({ invoiceId: "i1", occurredAt: at, amount: usd("228.00") });
    expect(toString(net(posting.entries, ACCOUNTS.DEFERRED_REVENUE))).toBe("-228.0000");
    expect(toString(net(posting.entries, ACCOUNTS.REVENUE_AGREEMENT))).toBe("0.0000");
  });

  it("earns it only as the obligation is delivered", () => {
    const posting = postAgreementRecognition({ agreementVisitId: "v1", occurredAt: at, amount: usd("114.00") });
    expect(toString(net(posting.entries, ACCOUNTS.DEFERRED_REVENUE))).toBe("114.0000");
    expect(toString(net(posting.entries, ACCOUNTS.REVENUE_AGREEMENT))).toBe("-114.0000");
  });

  /**
   * The cent that would otherwise sit in deferred revenue forever with
   * nothing to release it.
   */
  it("splits a term price across visits without losing a cent", () => {
    const schedule = recognitionSchedule(usd("228.00"), 7);
    expect(toString(sum(schedule))).toBe("228.0000");
    expect(schedule.every((s) => s.amount % 100n === 0n), "every share is whole cents").toBe(true);
  });

  it("fully unwinds a term when every visit is delivered", () => {
    const schedule = recognitionSchedule(usd("499.00"), 4);
    const recognised = schedule.map((amount, i) =>
      postAgreementRecognition({ agreementVisitId: `v${i}`, occurredAt: at, amount }),
    );
    const totalReleased = sum(recognised.flatMap((p) => p.entries)
      .filter((e) => e.accountCode === ACCOUNTS.DEFERRED_REVENUE && e.direction === "debit")
      .map((e) => e.amount));
    expect(toString(totalReleased)).toBe("499.0000");
  });

  it("returns nothing for a plan with no visits", () => {
    expect(recognitionSchedule(usd("228.00"), 0)).toEqual([]);
  });
});

describe("the balance guard", () => {
  it("rejects a posting that does not balance", () => {
    expect(() => assertBalanced({
      sourceType: "test", sourceId: "x", occurredAt: at,
      entries: [
        { direction: "debit", accountCode: "1200", amount: usd("100.00") },
        { direction: "credit", accountCode: "4000", amount: usd("99.99") },
      ],
    })).toThrow(UnbalancedPostingError);
  });

  it("reports the exact imbalance, so the bug is findable", () => {
    try {
      assertBalanced({
        sourceType: "test", sourceId: "x", occurredAt: at,
        entries: [
          { direction: "debit", accountCode: "1200", amount: usd("100.00") },
          { direction: "credit", accountCode: "4000", amount: usd("99.99") },
        ],
      });
      expect.unreachable();
    } catch (e) {
      expect(toString((e as UnbalancedPostingError).imbalance)).toBe("0.0100");
    }
  });
});

describe("an invoice and its payment agree", () => {
  /**
   * The property that matters end to end: bill something, collect it in full,
   * and the receivable is exactly flat. A cent of drift here is a cent that
   * never reconciles, on every invoice, forever.
   */
  it.each([
    ["1250.00", "0.0825"],
    ["99.99", "0.0675"],
    ["0.07", "0.5"],
    ["8990.00", "0.0825"],
    ["19.99", "0.08375"],
  ])("bills %s at %s tax and collects it flat", (price, rate) => {
    const { totals } = computeInvoice([{ quantity: "1", unitPrice: usd(price), taxable: true, taxRate: rate }]);
    const invoice = postInvoice({ invoiceId: "i", occurredAt: at, totals });
    const payment = postPayment({ paymentId: "p", occurredAt: at, appliedAmount: totals.total });

    const arMovement = add(net(invoice.entries, ACCOUNTS.AR), net(payment.entries, ACCOUNTS.AR));
    expect(toString(arMovement)).toBe("0.0000");
  });
});
