import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/**
 * A NOTICE BY EMAIL
 *
 * Which kinds are emailed at all, what a person gets before they choose, and
 * the words of the email, which are the notice's own and nothing more.
 */
describe("which notices come by email", () => {
  it("is only a licence or skill running out", () => {
    expect(notices.EMAIL_KINDS).toEqual(["qualification_expiry"]);
    for (const kind of notices.NOTICE_KINDS) {
      expect(notices.isEmailKind(kind)).toBe(kind === "qualification_expiry");
    }
  });

  it("is on until the person switches it off, and never for a kind that is not emailed", () => {
    expect(notices.emailFor([], "qualification_expiry")).toBe(true);
    expect(notices.emailFor([{ kind: "qualification_expiry", email: null }], "qualification_expiry")).toBe(true);
    expect(notices.emailFor([{ kind: "qualification_expiry", email: false }], "qualification_expiry")).toBe(false);
    expect(notices.emailFor([{ kind: "qualification_expiry", email: true }], "qualification_expiry")).toBe(true);
    // A saved "true" on a kind nothing emails still sends nothing.
    expect(notices.emailFor([{ kind: "task_assigned", email: true }], "task_assigned")).toBe(false);
    expect(notices.emailFor([], "expense_decided")).toBe(false);
  });

  it("leaves the three older switches exactly as they were", () => {
    expect(notices.DEFAULT_SWITCHES).toEqual({ inApp: true, push: true, text: false });
  });
});

describe("the email for a notice", () => {
  it("is the notice's title, its sentence, the page it opens and who it is from", () => {
    const mail = notices.noticeEmail({
      companyName: "Lone Star Air", title: "Your EPA 608 runs out soon",
      body: "Your EPA 608 runs out in 12 days, on 2026-11-02.", link: "https://ops.example.com/me",
    });
    expect(mail.subject).toBe("Your EPA 608 runs out soon");
    expect(mail.text).toBe(
      "Your EPA 608 runs out in 12 days, on 2026-11-02.\n\nOpen it: https://ops.example.com/me\n\nSent by Lone Star Air.",
    );
  });

  it("leaves out the link when the company has no public address, and a body when there is none", () => {
    const mail = notices.noticeEmail({ companyName: "Lone Star Air", title: "Hello", body: null, link: null });
    expect(mail.text).toBe("Sent by Lone Star Air.");
  });

  it("never writes a dash for a person to read as a machine", () => {
    const mail = notices.noticeEmail({ companyName: "A", title: "T", body: "B", link: "https://x.test/y" });
    expect(`${mail.subject}${mail.text}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("caps the number of people who can keep the renewals list", () => {
    expect(notices.MAX_RENEWALS_KEEPERS).toBe(20);
  });
});
