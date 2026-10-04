import { describe, it, expect } from "vitest";
import { claims, money as m } from "../src/index";

/**
 * A CLAIM ON A THIRD PARTY
 *
 * Yes, yes for less, no, or money that matches neither. The rules that cost
 * money when they are loose are the ones tested here.
 */
const usd = (v: string) => m.money(v, "USD");
const claim = (over: Partial<claims.ClaimState> = {}): claims.ClaimState => ({
  status: "submitted", claimed: usd("420.00"), approved: null, paid: usd("0"), ...over,
});

describe("deciding", () => {
  it("approves for what was claimed when no amount is given", () => {
    const decision = claims.decide(claim(), { outcome: "approved" });
    expect(decision.ok && m.toString(decision.approved!)).toBe("420.0000");
  });

  it("refuses an approval above the claim", () => {
    const decision = claims.decide(claim(), { outcome: "approved", amount: usd("500") });
    expect(decision.ok).toBe(false);
  });

  it("needs a reason to deny", () => {
    expect(claims.decide(claim(), { outcome: "denied" }).ok).toBe(false);
    expect(claims.decide(claim(), { outcome: "denied", note: "Pre-existing condition" }).ok).toBe(true);
  });

  it("treats a denial as final", () => {
    expect(claims.decide(claim({ status: "denied" }), { outcome: "approved" }).ok).toBe(false);
  });
});

describe("settling", () => {
  it("is paid when what they approved arrives, even below the claim", () => {
    const settled = claims.settle(claim({ status: "approved", approved: usd("380.00") }), usd("380.00"));
    expect(settled.ok && settled.status).toBe("paid");
  });

  it("is short paid when less arrives, with the shortfall", () => {
    const settled = claims.settle(claim(), usd("300.00"));
    expect(settled.ok && settled.status).toBe("short_paid");
    expect(settled.ok && m.toString(settled.shortfall)).toBe("120.0000");
  });

  it("refuses money over what they agreed", () => {
    expect(claims.settle(claim({ status: "approved", approved: usd("380") }), usd("400")).ok).toBe(false);
  });

  it("takes the rest of a short payment later", () => {
    const later = claims.settle(claim({ status: "short_paid", paid: usd("300") }), usd("120"));
    expect(later.ok && later.status).toBe("paid");
  });

  it("owes nothing once denied", () => {
    expect(m.toString(claims.outstanding(claim({ status: "denied" })))).toBe("0.0000");
    expect(m.toString(claims.outstanding(claim({ paid: usd("20") })))).toBe("400.0000");
  });
});
