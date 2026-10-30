import { describe, it, expect } from "vitest";
import {
  agreementWording, autopayWording, backupWording, backupPaidNote, MAX_BACKUPS, sameWording, failureKind, retryAt, payLinkNote, RETRY_AFTER_MS,
} from "../src/customer-portal/index.js";

/**
 * A SAVED CARD THE COMPANY MAY CHARGE
 *
 * The words a customer agrees to, and what happens when a charge with nobody
 * on the page does not go through: who finishes it, and whether it is tried
 * once more.
 */

describe("the words a customer agrees to", () => {
  const card = { company: "Cool Air Co", method: "Visa ending 4242", kind: "card" as const };
  const bank = { company: "Cool Air Co", method: "Frost Bank account ending 6789", kind: "bank_account" as const };

  it("names the company and the card, says what may be taken, and how to stop it", () => {
    const words = agreementWording(card);
    expect(words).toContain("I let Cool Air Co charge my Visa ending 4242");
    expect(words).toContain("only take the amount a bill says I owe");
    expect(words).toContain("stop this at any time from my account");
    expect(agreementWording(bank)).toContain("take payments from my Frost Bank account ending 6789");
  });

  it("says when an automatic payment is taken and what happens when it fails", () => {
    const words = autopayWording(card);
    expect(words).toContain("including each payment on a plan");
    expect(words).toContain("charge each bill to my Visa ending 4242 that day");
    expect(words).toContain("send me a link to pay another way and may try once more the next day");
  });

  it("is the same agreement only when it says the same words", () => {
    const words = agreementWording(card);
    expect(sameWording(`${words.replace(/ /g, "\n")}  `, words)).toBe(true);
    expect(sameWording(words.replace("Visa ending 4242", "Visa ending 1111"), words)).toBe(false);
    expect(sameWording(agreementWording({ ...card, company: "Other Co" }), words)).toBe(false);
  });

  it("never carries a dash a customer would read as a machine's", () => {
    for (const text of [agreementWording(card), agreementWording(bank), autopayWording(card), autopayWording(bank)]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("a charge that did not go through", () => {
  const now = new Date("2026-10-05T15:00:00Z");

  it("hands the customer the payment when their bank wants them to confirm it", () => {
    expect(failureKind("authentication_required")).toBe("needs_customer");
    expect(failureKind("card_declined")).toBe("declined");
    expect(failureKind(null)).toBe("declined");
  });

  it("tries an automatic payment once more the next day, and never a third time", () => {
    expect(retryAt({ trigger: "autopay", attempt: 1, code: "card_declined", now })!.getTime())
      .toBe(now.getTime() + RETRY_AFTER_MS);
    expect(retryAt({ trigger: "autopay", attempt: 2, code: "card_declined", now })).toBeNull();
  });

  it("does not try again what tomorrow will not change, nor what the office charged", () => {
    expect(retryAt({ trigger: "autopay", attempt: 1, code: "authentication_required", now })).toBeNull();
    expect(retryAt({ trigger: "autopay", attempt: 1, code: "expired_card", now })).toBeNull();
    expect(retryAt({ trigger: "office", attempt: 1, code: "card_declined", now })).toBeNull();
  });

  it("tells the customer in plain words, never the processor's code", () => {
    const note = payLinkNote({ kind: "needs_customer", method: "Visa ending 4242", retrying: false });
    expect(note).toContain("your bank wants you to confirm the payment yourself");
    expect(note).not.toContain("authentication_required");
    expect(payLinkNote({ kind: "declined", method: "Visa ending 4242", retrying: true })).toContain("try once more tomorrow");
  });
});

describe("a backup card for paying automatically", () => {
  const card = { company: "Ortiz Air", method: "Mastercard ending 5555", kind: "card" as const };
  const bank = { company: "Ortiz Air", method: "Frost Bank account ending 6789", kind: "bank_account" as const };

  it("says when it is used, how often, that the customer is told, and that it can be stopped", () => {
    const words = backupWording(card);
    expect(words).toMatch(/^Use my Mastercard ending 5555 as a backup/);
    expect(words).toMatch(/cannot take a bill from the card I pay automatically with, or from a backup before this one/);
    expect(words).toMatch(/once, the same day/);
    expect(words).toMatch(/tell me which card paid/);
    expect(words).toMatch(/stop this at any time/);
    expect(backupWording(bank)).toMatch(/take the payment from my Frost Bank account ending 6789/);
  });

  it("names no other card, so it stays true when the first card changes", () => {
    expect(backupWording(card)).not.toMatch(/Visa/);
  });

  it("tells the customer which card did not go through and which paid", () => {
    expect(backupPaidNote({ tried: ["Visa ending 4242"], paid: "Mastercard ending 5555" }))
      .toBe("We could not take this bill from your Visa ending 4242, so we took it from your Mastercard ending 5555, the backup you chose. Nothing more is owed on it.");
    expect(backupPaidNote({ tried: ["Visa ending 4242", "Mastercard ending 5555"], paid: "Frost Bank account ending 6789" }))
      .toMatch(/from your Visa ending 4242 or Mastercard ending 5555, so we took it from your Frost Bank account ending 6789/);
    expect(MAX_BACKUPS).toBe(2);
  });
});
