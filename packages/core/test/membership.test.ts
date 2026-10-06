import { describe, it, expect } from "vitest";
import { money, toString } from "../src/money/index.js";
import {
  memberPricingFor, memberDiscounts, eligibleForMemberPricing, usableRate, priorityFor,
  renewalDue, noticeDue, nextTerm, endingWithin, daysBetween, lastCoveredDay,
  type MemberCandidate, type RenewalState,
} from "../src/membership/index.js";
import { computeInvoice, postInvoice, ACCOUNTS } from "../src/ledger/index.js";

const member = (over: Partial<MemberCandidate> = {}): MemberCandidate => ({
  agreementId: "a1",
  planName: "Comfort Club",
  discountRate: "0.15",
  status: "active",
  startedOn: "2026-01-15",
  endsOn: "2027-01-15",
  propertyId: "home",
  ...over,
});

describe("who is a member on the day", () => {
  it("prices a customer on an active plan at their own address", () => {
    expect(memberPricingFor([member()], { on: "2026-06-01", propertyId: "home" }))
      .toEqual({
        agreementId: "a1", planName: "Comfort Club", rate: "0.15",
        waivesDiagnosticFee: false, waivesAfterHoursRate: false,
      });
  });

  it("does not price work at another address they own as member work", () => {
    expect(memberPricingFor([member()], { on: "2026-06-01", propertyId: "rental" })).toBeNull();
  });

  it("lets an agreement sold with no address cover the customer anywhere", () => {
    expect(memberPricingFor([member({ propertyId: null })], { on: "2026-06-01", propertyId: "rental" }))
      .not.toBeNull();
  });

  it("treats the end date as the first day without cover", () => {
    expect(memberPricingFor([member()], { on: "2027-01-14" })).not.toBeNull();
    expect(memberPricingFor([member()], { on: "2027-01-15" })).toBeNull();
    expect(memberPricingFor([member()], { on: "2026-01-14" })).toBeNull();
  });

  it("ignores a cancelled agreement, a plan with no discount and a rate typed as a percentage", () => {
    expect(memberPricingFor([member({ status: "cancelled" })], { on: "2026-06-01" })).toBeNull();
    expect(memberPricingFor([member({ discountRate: null })], { on: "2026-06-01" })).toBeNull();
    expect(memberPricingFor([member({ discountRate: "0" })], { on: "2026-06-01" })).toBeNull();
    expect(memberPricingFor([member({ discountRate: "15" })], { on: "2026-06-01" })).toBeNull();
    expect(usableRate("1")).toBe(false);
  });

  it("gives the better of two plans, never both, and names which one the same way every time", () => {
    const picked = memberPricingFor([
      member({ agreementId: "b", discountRate: "0.10" }),
      member({ agreementId: "c", discountRate: "0.20", startedOn: "2026-03-01" }),
      member({ agreementId: "a", discountRate: "0.20", startedOn: "2026-03-01" }),
    ], { on: "2026-06-01" });
    expect(picked?.agreementId).toBe("a");
    expect(picked?.rate).toBe("0.20");
  });
});

describe("the perks a plan carries besides its rate", () => {
  it("counts a plan whose only benefit is a waived fee as membership", () => {
    /**
     * "Members never pay a diagnostic fee" is a whole plan for some
     * companies. Requiring a rate as well was why the perk was recorded on
     * every plan and applied by nothing.
     */
    const found = memberPricingFor([member({ discountRate: null, waivesDiagnosticFee: true })], { on: "2026-06-01" });
    expect(found).toEqual({
      agreementId: "a1", planName: "Comfort Club", rate: "0",
      waivesDiagnosticFee: true, waivesAfterHoursRate: false,
    });
  });

  it("prefers the better rate, then more waivers, and never mixes two plans", () => {
    const picked = memberPricingFor([
      member({ agreementId: "rate", discountRate: "0.10" }),
      member({ agreementId: "waiver", discountRate: "0.10", waivesDiagnosticFee: true, waivesAfterHoursRate: true }),
    ], { on: "2026-06-01" });
    expect(picked?.agreementId).toBe("waiver");
    const higher = memberPricingFor([
      member({ agreementId: "rate", discountRate: "0.20" }),
      member({ agreementId: "waiver", discountRate: null, waivesDiagnosticFee: true }),
    ], { on: "2026-06-01" });
    expect(higher).toMatchObject({ agreementId: "rate", waivesDiagnosticFee: false });
  });

  it("waives the whole of a diagnostic or after hours line, and only when the plan says so", () => {
    const lines = [
      { quantity: "1", unitPrice: money("89.00"), eligible: true, feeRole: "diagnostic" as const },
      { quantity: "1", unitPrice: money("150.00"), eligible: true, feeRole: "after_hours" as const },
      { quantity: "1", unitPrice: money("200.00"), eligible: true },
    ];
    expect(memberDiscounts(lines, "0.10", { diagnostic: true }).map(toString))
      .toEqual(["89.0000", "15.0000", "20.0000"]);
    expect(memberDiscounts(lines, "0", { afterHours: true }).map(toString))
      .toEqual(["0.0000", "150.0000", "0.0000"]);
    expect(memberDiscounts(lines, "0.10").map(toString))
      .toEqual(["8.9000", "15.0000", "20.0000"]);
  });

  it("waives what is left after a hand discount, never more", () => {
    const [off] = memberDiscounts([
      { quantity: "1", unitPrice: money("89.00"), discountAmount: money("9.00"), eligible: true, feeRole: "diagnostic" },
    ], "0", { diagnostic: true });
    expect(toString(off!)).toBe("80.0000");
  });

  it("puts a member at the front of the queue under the same cover rules as the discount", () => {
    const priority = member({ priorityDispatch: true });
    expect(priorityFor([priority], { on: "2026-06-01", propertyId: "home" }))
      .toEqual({ agreementId: "a1", planName: "Comfort Club" });
    expect(priorityFor([priority], { on: "2026-06-01", propertyId: "rental" })).toBeNull();
    expect(priorityFor([priority], { on: "2027-01-15", propertyId: "home" })).toBeNull();
    expect(priorityFor([member()], { on: "2026-06-01", propertyId: "home" })).toBeNull();
    expect(priorityFor([member({ priorityDispatch: true, status: "cancelled" })], { on: "2026-06-01" })).toBeNull();
  });
});

describe("what the member rate takes off", () => {
  it("takes the rate off each eligible line, rounded to the cent on that line", () => {
    const off = memberDiscounts([
      { quantity: "1", unitPrice: money("189.00"), eligible: true },
      { quantity: "3", unitPrice: money("12.35"), eligible: true },
      { quantity: "1", unitPrice: money("49.00"), eligible: false },
    ], "0.15");
    expect(off.map(toString)).toEqual(["28.3500", "5.5600", "0.0000"]);
  });

  it("takes it off what is left after a hand discount, not off the gross", () => {
    const [off] = memberDiscounts([
      { quantity: "1", unitPrice: money("200.00"), discountAmount: money("50.00"), eligible: true },
    ], "0.10");
    expect(toString(off!)).toBe("15.0000");
  });

  it("never takes more than the line is worth", () => {
    const [off] = memberDiscounts([
      { quantity: "1", unitPrice: money("10.00"), discountAmount: money("10.00"), eligible: true },
    ], "0.5");
    expect(toString(off!)).toBe("0.0000");
  });

  it("leaves free lines, discount items, the membership's own price and adjustments alone", () => {
    expect(eligibleForMemberPricing({ unitPrice: money("0") })).toBe(false);
    expect(eligibleForMemberPricing({ unitPrice: money("10"), itemKind: "discount" })).toBe(false);
    expect(eligibleForMemberPricing({ unitPrice: money("10"), origin: "membership" })).toBe(false);
    expect(eligibleForMemberPricing({ unitPrice: money("10"), origin: "manual" })).toBe(false);
    expect(eligibleForMemberPricing({ unitPrice: money("10"), itemKind: "service", origin: "job" })).toBe(true);
  });

  it("posts the member discount to the discounts account, with revenue at the full price", () => {
    /**
     * The whole reason it is a per line discount rather than a negative line:
     * the ledger already debits contra revenue for a line's discount, so gross
     * revenue and what members saved are both visible.
     */
    const unitPrice = money("300.00");
    const [off] = memberDiscounts([{ quantity: "1", unitPrice, eligible: true }], "0.15");
    const { totals } = computeInvoice([{ quantity: "1", unitPrice, discountAmount: off, taxable: false, taxRate: "0" }]);
    const posting = postInvoice({ invoiceId: "i", occurredAt: new Date(), totals });
    const at = (code: string) => posting.entries.find((e) => e.accountCode === code);
    expect(toString(at(ACCOUNTS.DISCOUNTS)!.amount)).toBe("45.0000");
    expect(toString(at(ACCOUNTS.REVENUE)!.amount)).toBe("300.0000");
    expect(toString(at(ACCOUNTS.AR)!.amount)).toBe("255.0000");
  });
});

const state = (over: Partial<RenewalState> = {}): RenewalState => ({
  status: "active",
  endsOn: "2027-01-15",
  autoRenews: true,
  planAutoRenews: true,
  renewalNoticeDays: 30,
  renewalNoticeSentAt: null,
  ...over,
});

describe("renewing", () => {
  it("renews on the end date, and late rather than never", () => {
    expect(renewalDue(state(), "2027-01-14")).toEqual({ renew: false, reason: "not_yet" });
    expect(renewalDue(state(), "2027-01-15")).toEqual({ renew: true });
    expect(renewalDue(state(), "2027-02-01")).toEqual({ renew: true });
  });

  it("needs both the plan and the agreement to say so", () => {
    expect(renewalDue(state({ autoRenews: false }), "2027-01-15").renew).toBe(false);
    expect(renewalDue(state({ planAutoRenews: false }), "2027-01-15").renew).toBe(false);
  });

  it("never renews a cancelled agreement or one with no end", () => {
    expect(renewalDue(state({ status: "cancelled" }), "2027-02-01")).toEqual({ renew: false, reason: "not_active" });
    expect(renewalDue(state({ endsOn: null }), "2027-02-01")).toEqual({ renew: false, reason: "no_end" });
  });

  it("starts the next term the day this one ends, clamped at a month's end", () => {
    expect(nextTerm("2027-01-15", 12)).toEqual({ startsOn: "2027-01-15", endsOn: "2028-01-15" });
    expect(nextTerm("2027-01-31", 1)).toEqual({ startsOn: "2027-01-31", endsOn: "2027-02-28" });
  });
});

describe("the notice before a renewal", () => {
  it("is due inside the window and before the end, once", () => {
    expect(noticeDue(state(), "2026-12-15")).toBe(false);
    expect(noticeDue(state(), "2026-12-16")).toBe(true);
    expect(noticeDue(state(), "2027-01-14")).toBe(true);
    expect(noticeDue(state(), "2027-01-15")).toBe(false);
    expect(noticeDue(state({ renewalNoticeSentAt: new Date() }), "2026-12-20")).toBe(false);
  });

  it("is owed by a plan that does not renew on its own too, and never by one that owes none", () => {
    expect(noticeDue(state({ autoRenews: false }), "2026-12-20")).toBe(true);
    expect(noticeDue(state({ renewalNoticeDays: 0 }), "2027-01-10")).toBe(false);
    expect(noticeDue(state({ status: "cancelled" }), "2026-12-20")).toBe(false);
  });

  it("says the last covered day rather than the exclusive end", () => {
    expect(lastCoveredDay("2027-01-15")).toBe("2027-01-14");
  });
});

describe("ending soon", () => {
  it("counts whole days and includes today", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(endingWithin("2026-10-31", "2026-10-01", 30)).toBe(true);
    expect(endingWithin("2026-11-01", "2026-10-01", 30)).toBe(false);
    expect(endingWithin("2026-09-30", "2026-10-01", 30)).toBe(false);
    expect(endingWithin(null, "2026-10-01", 30)).toBe(false);
  });
});
