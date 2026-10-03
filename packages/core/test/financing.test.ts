import { describe, it, expect } from "vitest";
import { financing as f, money as m } from "../src/index";

/**
 * The monthly figure a customer is shown, and what an application's status
 * may become when a lender reports one. Both are numbers somebody quotes
 * back, so each is held to a figure worked out independently.
 */
const usd = (v: string) => m.money(v, "USD");

describe("the monthly payment", () => {
  it("matches the amortisation formula, rounded up to the cent", () => {
    // 222.4444768... by the formula at fifty digits; never shown lower than a real payment.
    expect(m.toString(f.monthlyPayment(usd("10000"), { months: 60, aprPercent: "12" }))).toBe("222.4500");
    expect(m.toString(f.monthlyPayment(usd("5000"), { months: 36, aprPercent: "9.99" }))).toBe("161.3200");
    expect(m.toString(f.monthlyPayment(usd("12500"), { months: 60, aprPercent: "17.9" }))).toBe("316.7400");
  });

  it("divides evenly at no interest, still rounding up", () => {
    expect(m.toString(f.monthlyPayment(usd("1000"), { months: 12, aprPercent: "0" }))).toBe("83.3400");
    expect(m.toString(f.monthlyPayment(usd("1200"), { months: 12, aprPercent: "0" }))).toBe("100.0000");
  });

  it("does not lose a tiny rate to rounding", () => {
    // 200.000108...: a hundredth of a basis point still costs the customer a cent.
    expect(m.toString(f.monthlyPayment(usd("2400"), { months: 12, aprPercent: "0.0001" }))).toBe("200.0100");
  });

  it("refuses a term or an APR it cannot work with", () => {
    expect(() => f.monthlyPayment(usd("100"), { months: 0, aprPercent: "5" })).toThrow();
    expect(() => f.monthlyPayment(usd("100"), { months: 12, aprPercent: "abc" })).toThrow();
    expect(() => f.monthlyPayment(usd("100"), { months: 1000, aprPercent: "5" })).toThrow();
  });
});

describe("as low as", () => {
  const terms: f.FinancingTerms = {
    lender: "Wisetack", minAmount: "500", maxAmount: "25000",
    plans: [{ months: 12, aprPercent: "0" }, { months: 60, aprPercent: "17.9" }],
  };

  it("takes the plan with the lowest payment", () => {
    const offer = f.asLowAs(usd("12500"), terms);
    expect(offer?.plan.months).toBe(60);
    expect(m.toString(offer!.monthly)).toBe("316.7400");
  });

  it("offers nothing outside what the lender finances, or with no plans", () => {
    expect(f.asLowAs(usd("499.99"), terms)).toBeNull();
    expect(f.asLowAs(usd("25000.01"), terms)).toBeNull();
    expect(f.asLowAs(usd("0"), terms)).toBeNull();
    expect(f.asLowAs(usd("1000"), { ...terms, plans: [] })).toBeNull();
  });

  it("never states the figure without saying it is subject to approval", () => {
    const offer = f.asLowAs(usd("12500"), terms)!;
    const sentence = f.offerSentence(offer);
    expect(sentence).toContain("$316.74");
    expect(sentence).toContain("60 months at 17.9% APR");
    expect(sentence).toContain("Subject to approval");
    expect(sentence).toContain("Wisetack");
    expect(f.offerShort(offer)).toContain("subject to approval");
  });

  it("reads a plan as typed on the connection, and nothing else", () => {
    expect(f.parsePlan("60@17.9")).toEqual({ months: 60, aprPercent: "17.9" });
    expect(f.parsePlan(" 12 @ 0% ")).toEqual({ months: 12, aprPercent: "0" });
    expect(f.parsePlan("sixty@17")).toBeNull();
    expect(f.parsePlan("60")).toBeNull();
    expect(f.parsePlan("0@5")).toBeNull();
  });
});

describe("what an application may become", () => {
  it("moves forward and ignores an older update arriving late", () => {
    expect(f.advance("sent", "applied")).toEqual({ changed: true, status: "applied" });
    expect(f.advance("applied", "approved")).toEqual({ changed: true, status: "approved" });
    const late = f.advance("approved", "applied");
    expect(late.changed).toBe(false);
    expect(late.status).toBe("approved");
  });

  it("ends on a decline, an expiry or a cancellation, and stays ended", () => {
    expect(f.advance("applied", "declined")).toEqual({ changed: true, status: "declined" });
    expect(f.advance("declined", "applied").changed).toBe(false);
    expect(f.advance("expired", "approved").changed).toBe(false);
  });

  it("is funded whenever the lender says it paid, and funded is final", () => {
    expect(f.advance("expired", "funded")).toEqual({ changed: true, status: "funded" });
    const after = f.advance("funded", "cancelled");
    expect(after.changed).toBe(false);
    expect(after.status).toBe("funded");
    expect(after.changed ? "" : after.reason).toContain("record the refund");
  });

  it("changes nothing on a repeat", () => {
    expect(f.advance("approved", "approved")).toEqual({ changed: false, status: "approved", reason: null });
  });
});
