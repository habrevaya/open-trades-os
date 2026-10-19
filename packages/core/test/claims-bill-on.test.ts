import { describe, it, expect } from "vitest";
import * as claims from "../src/claims/index.js";
import { money, toString as m } from "../src/money/index.js";

/**
 * M32. BILLING THE CUSTOMER FOR WHAT THE PAYER DID NOT PAY
 *
 * Only on a claim the payer is done with, only once their invoice owes
 * nothing, only once, and only for something more than nothing.
 */
const usd = (v: string) => money(v, "USD");
const claim = (status: claims.ClaimStatus, paid: string, approved: string | null = null): claims.ClaimState => ({
  status, claimed: usd("420.00"), approved: approved ? usd(approved) : null, paid: usd(paid),
});
const nothingOwed = { payerOwes: usd("0"), alreadyBilled: null };

describe("billing the rest of a claim to the customer", () => {
  it("bills what was claimed less what they paid on a claim approved for less and paid", () => {
    const verdict = claims.billOn(claim("paid", "380.00", "380.00"), nothingOwed);
    expect(verdict.ok && m(verdict.amount)).toBe("40.0000");
  });

  it("bills the whole claim on a denial, and the unpaid part of a short payment", () => {
    const denied = claims.billOn(claim("denied", "0"), nothingOwed);
    expect(denied.ok && m(denied.amount)).toBe("420.0000");
    const short = claims.billOn(claim("short_paid", "300.00", "380.00"), nothingOwed);
    expect(short.ok && m(short.amount)).toBe("120.0000");
  });

  it("refuses a claim the payer has not finished with", () => {
    for (const status of ["submitted", "approved"] as const) {
      const verdict = claims.billOn(claim(status, "0", status === "approved" ? "380.00" : null), nothingOwed);
      expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("has not finished with this claim") });
    }
  });

  it("refuses when they paid all of it", () => {
    expect(claims.billOn(claim("paid", "420.00", "420.00"), nothingOwed))
      .toEqual({ ok: false, reason: "They paid everything that was claimed, so there is nothing to bill the customer." });
  });

  it("refuses while their invoice still owes it, so the money is never owed twice", () => {
    expect(claims.billOn(claim("paid", "380.00", "380.00"), { payerOwes: usd("40.00"), alreadyBilled: null })).toEqual({
      ok: false,
      reason: "Their invoice still shows $40.00 owing. Credit it or write it off on their invoice first, so the same money is not owed by two people.",
    });
  });

  it("refuses a second time", () => {
    expect(claims.billOn(claim("paid", "380.00", "380.00"), { payerOwes: usd("0"), alreadyBilled: "1043" }))
      .toEqual({ ok: false, reason: "This claim has already been billed to the customer, on invoice 1043." });
  });
});
