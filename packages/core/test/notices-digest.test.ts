import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/**
 * THE DAILY DIGEST AND HOW LONG READ NOTICES STAY
 *
 * When a person's digest is due, what it says, and which read notices a
 * company's setting may remove, never one the worker would raise again.
 */
const QUIET = { startHour: 21, endHour: 8 };

describe("when the digest is due", () => {
  it("is the end of the company's quiet hours, or eight without them", () => {
    expect(notices.digestHour(QUIET)).toBe(8);
    expect(notices.digestHour({ startHour: 20, endHour: 7 })).toBe(7);
    expect(notices.digestHour(null)).toBe(notices.DIGEST_DEFAULT_HOUR);
  });

  it("is once per company day, from the morning on, never in quiet hours", () => {
    const at = (localHour: number, lastOn: string | null) =>
      notices.digestDue({ today: "2026-10-19", localHour, lastOn, quiet: QUIET });
    expect(at(7, null)).toBe(false);
    expect(at(8, null)).toBe(true);
    expect(at(15, "2026-10-18")).toBe(true);
    expect(at(9, "2026-10-19")).toBe(false);
    expect(at(22, null)).toBe(false);
    // Without quiet hours, any time from eight.
    expect(notices.digestDue({ today: "2026-10-19", localHour: 23, lastOn: null, quiet: null })).toBe(true);
  });
});

describe("the digest email", () => {
  it("counts, lists each notice in the bell's words, and says how to stop it", () => {
    const mail = notices.digestEmail({
      companyName: "Lone Star Air",
      notices: [
        { kindLabel: "A task given to you", title: "Call back Mrs Ortiz", body: null, link: "https://ops.test/notices/1" },
        { kindLabel: "Your expense answered", title: "Your fuel receipt was approved", body: "$42.10 on Oct 18.", link: null },
      ],
      allLink: "https://ops.test/notices",
      settingsLink: "https://ops.test/me#notices",
    });
    expect(mail.subject).toBe("2 unread notices at Lone Star Air");
    expect(mail.text).toContain("You have 2 unread notices.");
    expect(mail.text).toContain("A task given to you: Call back Mrs Ortiz\nOpen it: https://ops.test/notices/1");
    expect(mail.text).toContain("Your expense answered: Your fuel receipt was approved\n$42.10 on Oct 18.");
    expect(mail.text).toContain("All your notices: https://ops.test/notices");
    expect(mail.text).toContain("Turn it off at https://ops.test/me#notices");
    expect(mail.text).not.toMatch(/[\u2013\u2014]/);
  });

  it("lists at most twenty and counts the rest", () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ kindLabel: "Late", title: `Task ${i}`, body: null, link: null }));
    const mail = notices.digestEmail({ companyName: "Co", notices: many, allLink: null, settingsLink: null });
    expect(mail.subject).toBe("23 unread notices at Co");
    expect(mail.text).toContain("Task 19");
    expect(mail.text).not.toContain("Task 20");
    expect(mail.text).toContain("And 3 more.");
    expect(mail.text).toContain("Turn it off on your own page.");
  });

  it("says one notice in the singular", () => {
    const mail = notices.digestEmail({
      companyName: "Co", notices: [{ kindLabel: "Late", title: "T", body: null, link: null }], allLink: null, settingsLink: null,
    });
    expect(mail.subject).toBe("1 unread notice at Co");
  });
});

describe("keeping read notices", () => {
  const day = 86_400_000;
  const now = new Date("2026-10-19T15:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * day);

  it("reads a saved setting, anything unusable as keeping them for good", () => {
    expect(notices.keepReadDays(30)).toBe(30);
    expect(notices.keepReadDays(null)).toBeNull();
    expect(notices.keepReadDays(undefined)).toBeNull();
    expect(notices.keepReadDays(3)).toBeNull();
    expect(notices.keepReadDays("30")).toBeNull();
    expect(notices.keepReadProblem(30)).toBeNull();
    expect(notices.keepReadProblem(null)).toBeNull();
    expect(notices.keepReadProblem(6)).toMatch(/from 7 to 3650 days/);
    expect(notices.keepReadProblem(4000)).toMatch(/leave it empty/);
  });

  it("never removes an unread notice, or any while the company keeps them for good", () => {
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(400), readAt: null }, 7, now)).toBe(false);
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(400), readAt: ago(399) }, null, now)).toBe(false);
  });

  it("counts one kept off the bell as read from when it was raised", () => {
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(31), readAt: null, inApp: false }, 30, now)).toBe(true);
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(29), readAt: null, inApp: false }, 30, now)).toBe(false);
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(31), readAt: null, inApp: true }, 30, now)).toBe(false);
  });

  it("removes a read one once it has been read for the company's days", () => {
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(40), readAt: ago(31) }, 30, now)).toBe(true);
    expect(notices.sweepable({ kind: "task_assigned", createdAt: ago(40), readAt: ago(29) }, 30, now)).toBe(false);
  });

  it("keeps a licence or talk notice for as long as the worker could raise it again", () => {
    const licence = { kind: "qualification_expiry", readAt: ago(60) };
    expect(notices.sweepable({ ...licence, createdAt: ago(61) }, 30, now)).toBe(false);
    expect(notices.sweepable({ ...licence, createdAt: ago(notices.raisedAgainWithinDays("qualification_expiry")) }, 30, now)).toBe(true);
    expect(notices.raisedAgainWithinDays("qualification_expiry"))
      .toBeGreaterThan(notices.MAX_EXPIRY_NOTICE_DAYS + notices.EXPIRY_LATE_DAYS);
    const talk = { kind: "talk_unsigned", readAt: ago(7) };
    expect(notices.sweepable({ ...talk, createdAt: ago(7) }, 7, now)).toBe(false);
    expect(notices.sweepable({ ...talk, createdAt: ago(10) }, 7, now)).toBe(true);
  });
});
