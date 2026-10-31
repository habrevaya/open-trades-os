import { describe, it, expect } from "vitest";
import { people as p, notices } from "../src/index";

/**
 * WHAT THE OFFICE IS TOLD WHEN SOMEBODY CHANGES THEIR OWN PHONE OR ADDRESS,
 * AND THE SECOND MAILBOX FOR THEIR LICENCE EMAILS
 *
 * The sentence says what they did and never what the new number or address is.
 */
const was = { phone: "+15125550143", addressLine1: "12 Oak St", addressLine2: null, city: "Austin", state: "TX", postalCode: "78701" };

describe("the sentence the office is told", () => {
  it("says changed, added and removed, once where it repeats, and never the new details", () => {
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...was, phone: "+15125550199" }))).toBe("changed their phone number");
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...was, city: "Round Rock", postalCode: "78664" }))).toBe("changed their home address");
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...was, phone: "+15125550199", city: "Round Rock", postalCode: "78664" })))
      .toBe("changed their phone number and home address");
    expect(p.ownContactNoticeWords(p.ownContactChanges(null, was))).toBe("added a phone number and home address");
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...p.NO_OWN_CONTACT }))).toBe("removed their phone number and home address");
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...was, phone: null, city: "Round Rock", postalCode: "78664" })))
      .toBe("removed their phone number and changed their home address");
    expect(p.ownContactNoticeWords([])).toBe("");
    expect(p.ownContactNoticeWords(p.ownContactChanges(was, { ...was, phone: "+15125550199" }))).not.toMatch(/\d/);
  });

  it("is a kind the person can switch off like any other, never emailed", () => {
    expect(notices.NOTICE_KINDS).toContain("contact_changed");
    expect(notices.NOTICE_KIND_WORDS.contact_changed.label).toBe("A colleague changed their phone or address");
    expect(notices.isEmailKind("contact_changed")).toBe(false);
    expect(notices.NOTICE_KIND_WORDS.contact_changed.description).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("the second mailbox", () => {
  it("keeps an address in lower case, and empty is none", () => {
    expect(p.checkSecondEmail("  Ann.Smith@Example.COM ", "ann@work.test")).toEqual({ ok: true, email: "ann.smith@example.com" });
    expect(p.checkSecondEmail("", "ann@work.test")).toEqual({ ok: true, email: null });
    expect(p.checkSecondEmail(null, "ann@work.test")).toEqual({ ok: true, email: null });
    expect(p.checkSecondEmail("   ", "ann@work.test")).toEqual({ ok: true, email: null });
  });

  it("refuses what is not an address, and the address they sign in with, in words", () => {
    for (const bad of ["ann", "ann@", "ann@example", "ann @example.com", "a@b.com, c@d.com"]) {
      const r = p.checkSecondEmail(bad, "ann@work.test");
      expect(r.ok === false && r.reason).toContain("is not an email address");
    }
    const same = p.checkSecondEmail("ANN@work.test", "ann@work.test");
    expect(same.ok === false && same.reason).toContain("already sign in with");
  });
});
