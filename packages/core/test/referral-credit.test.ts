import { describe, it, expect } from "vitest";
import { referrals as rf } from "../src/index";

/**
 * A REFERRAL REWARD'S CREDIT, ON THE NEXT INVOICE
 *
 * Off unless the company turns it on, and only for a credit on their account.
 * Next means after the reward was given, never a bill already sent, and it
 * takes the smaller of what the credit has left and what the invoice owes.
 */
describe("the setting that puts a reward on the next invoice", () => {
  it("is off unless it is sent, and leaves the stored settings as they were", () => {
    expect(rf.checkReferralSettings({ reward: "credit_note", amount: "25" }))
      .toEqual({ ok: true, settings: { reward: "credit_note", amount: "25" } });
    expect(rf.checkReferralSettings({ reward: "credit_note", amount: "25", applyToNextInvoice: false }))
      .toEqual({ ok: true, settings: { reward: "credit_note", amount: "25" } });
    expect(rf.checkReferralSettings({ reward: "credit_note", amount: "25", applyToNextInvoice: true }))
      .toEqual({ ok: true, settings: { reward: "credit_note", amount: "25", applyToNextInvoice: true } });
  });

  it("is refused for a reward that is not a credit on their account", () => {
    for (const reward of ["owed", "none"]) {
      const verdict = rf.checkReferralSettings({ reward, amount: "25", applyToNextInvoice: true });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("Only a credit on their account");
    }
  });
});

describe("the invoice a credit goes on", () => {
  const granted = { on: "2026-06-03", at: "2026-06-03T15:00:00.000Z" };
  const invoice = (id: string, issuedOn: string | null, balance: string, createdAt: string) => ({ id, issuedOn, balance, createdAt });
  const invoices = [
    invoice("old", "2026-05-30", "120.00", "2026-05-30T12:00:00.000Z"),
    invoice("before", "2026-06-03", "70.00", "2026-06-03T09:00:00.000Z"),
    invoice("later-b", "2026-06-04", "80.00", "2026-06-04T10:00:00.000Z"),
    invoice("later-a", "2026-06-04", "40.00", "2026-06-04T09:00:00.000Z"),
    invoice("paid", "2026-06-05", "0.00", "2026-06-05T09:00:00.000Z"),
    invoice("draft", null, "50.00", "2026-06-06T09:00:00.000Z"),
  ];

  it("is the oldest one still owed that came after the reward", () => {
    expect(rf.nextInvoiceFor(invoices, granted)).toBe("later-a");
  });

  it("counts a bill raised the day the reward was given only if it was raised after the reward", () => {
    const same = [...invoices, invoice("after", "2026-06-03", "30.00", "2026-06-03T16:00:00.000Z")];
    expect(rf.nextInvoiceFor(same, granted)).toBe("after");
  });

  it("is none when nothing is owed, nothing is issued, or everything came before", () => {
    expect(rf.nextInvoiceFor([], granted)).toBeNull();
    expect(rf.nextInvoiceFor([invoice("x", "2026-06-05", "0.00", "2026-06-05T09:00:00.000Z")], granted)).toBeNull();
    expect(rf.nextInvoiceFor(invoices, { on: "2026-06-10", at: "2026-06-10T09:00:00.000Z" })).toBeNull();
  });
});

describe("how much of a credit goes on an invoice", () => {
  it("is the smaller of what the credit has left and what the invoice owes, to the cent", () => {
    expect(rf.creditToApply("25.0000", "80.0000")).toBe("25.00");
    expect(rf.creditToApply("25.0000", "10.5000")).toBe("10.50");
    expect(rf.creditToApply("0.1000", "0.2000")).toBe("0.10");
  });

  it("is nothing when either is nothing", () => {
    expect(rf.creditToApply("0", "10")).toBe("0.00");
    expect(rf.creditToApply("25", "0.0000")).toBe("0.00");
  });
});
