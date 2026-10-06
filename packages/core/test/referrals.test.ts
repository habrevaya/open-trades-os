import { describe, it, expect } from "vitest";
import {
  newReferralCode, normaliseCode, referralLink, checkReferralSettings, rewardDue, CODE_ALPHABET,
} from "../src/referrals/index.js";

/**
 * REFERRALS
 *
 * A code is read aloud and typed into a phone, so it must survive both, and
 * a reward is money, so it must be given once, for the right thing, and never
 * for a typing slip.
 */

describe("a referral code", () => {
  it("uses no letter that reads as another", () => {
    for (const ambiguous of ["0", "O", "1", "I", "L", "U", "V"]) expect(CODE_ALPHABET).not.toContain(ambiguous);
    let n = 0;
    const code = newReferralCode(() => ((n += 7) % 29) / 29);
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("is matched however it was typed", () => {
    expect(normaliseCode(" kq7-m2p ")).toBe("KQ7M2P");
    expect(normaliseCode("KQ0M2P")).toBeNull();
    expect(normaliseCode("")).toBeNull();
    expect(normaliseCode("AB")).toBeNull();
  });

  it("is a link to the company's booking page", () => {
    expect(referralLink("https://ots.example/", "acme", "KQ7M2P")).toBe("https://ots.example/book/acme?ref=KQ7M2P");
  });
});

describe("what a referral earns", () => {
  it("can be nothing at all", () => {
    expect(checkReferralSettings({})).toEqual({ ok: true, settings: { reward: "none", amount: "0" } });
  });

  it("refuses a reward of nothing and a reward that is a slipped digit", () => {
    expect(checkReferralSettings({ reward: "credit_note", amount: "0" }).ok).toBe(false);
    expect(checkReferralSettings({ reward: "owed", amount: "25000" }).ok).toBe(false);
    expect(checkReferralSettings({ reward: "owed", amount: "25.00" })).toEqual({ ok: true, settings: { reward: "owed", amount: "25.00" } });
    expect(checkReferralSettings({ reward: "cash", amount: "25" }).ok).toBe(false);
  });
});

describe("whether a reward is due", () => {
  const settings = { reward: "credit_note" as const, amount: "25" };
  const base = { settings, referrerId: "a", referredId: "b", alreadyRewarded: false, firstJobPaid: true };

  it("is due once the first job is paid in full", () => {
    expect(rewardDue(base)).toEqual({ grant: true, kind: "credit_note", amount: "25" });
  });

  it("is not due before, after it was given, for referring yourself, or when the company gives nothing", () => {
    expect(rewardDue({ ...base, firstJobPaid: false }).grant).toBe(false);
    expect(rewardDue({ ...base, alreadyRewarded: true }).grant).toBe(false);
    expect(rewardDue({ ...base, referredId: "a" }).grant).toBe(false);
    expect(rewardDue({ ...base, settings: { reward: "none", amount: "0" } }).grant).toBe(false);
  });
});
