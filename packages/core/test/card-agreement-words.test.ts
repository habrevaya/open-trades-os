import { describe, it, expect } from "vitest";
import {
  agreementWording, agreementWayLabel, agreementWayOf, formWording, officeWording, phoneScript, sameWording,
} from "../src/customer-portal/index.js";

/**
 * THE WORDS AN AGREEMENT THE OFFICE RECORDS IS GIVEN UNDER
 *
 * A phone script the office reads out, and the words a signed form carries.
 * Both are the product's: nothing here takes the company's own wording.
 */
describe("the words for an agreement the office records", () => {
  const card = { company: "Cool Air Co", method: "Visa ending 4242", kind: "card" as const };
  const bank = { company: "Cool Air Co", method: "Frost Bank account ending 6789", kind: "bank_account" as const };

  it("reads out as a question: who, what card, what may be taken, a receipt, how to stop, and does the customer agree", () => {
    const script = phoneScript(card);
    expect(script).toContain("Cool Air Co would like to charge your Visa ending 4242 for bills you owe them");
    expect(script).toContain("only take the amount a bill says you owe");
    expect(script).toContain("you will get a receipt each time");
    expect(script).toContain("from your account or by calling Cool Air Co");
    expect(script).toMatch(/Do you agree\?$/);
    expect(phoneScript(bank)).toContain("take payments from your Frost Bank account ending 6789");
  });

  it("makes a signed form carry the very words the customer would agree to on the screen", () => {
    expect(formWording(card)).toBe(agreementWording(card));
    expect(officeWording("signed_form", card)).toBe(agreementWording(card));
    expect(officeWording("phone", card)).toBe(phoneScript(card));
    expect(sameWording(officeWording("phone", card), officeWording("signed_form", card))).toBe(false);
  });

  it("names the way as the column keeps it and as a person reads it", () => {
    expect(agreementWayOf("phone")).toBe("office_phone");
    expect(agreementWayOf("signed_form")).toBe("office_form");
    expect(agreementWayLabel("office_phone")).toBe("Agreed by phone");
    expect(agreementWayLabel("office_form")).toBe("Agreed on a signed form");
    expect(agreementWayLabel("portal_sign_in")).toBe("Agreed in their account");
  });

  it("never carries a dash a customer would read as a machine's", () => {
    for (const text of [phoneScript(card), phoneScript(bank), formWording(card), formWording(bank)]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
