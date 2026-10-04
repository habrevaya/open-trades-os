import { describe, it, expect } from "vitest";
import * as people from "../src/people/index.js";

describe("onboarding progress", () => {
  it("is done only when every required line is, whatever the optional ones say", () => {
    const now = new Date();
    const progress = people.onboardingProgress([
      { required: true, doneAt: now }, { required: true, doneAt: null }, { required: false, doneAt: now },
    ]);
    expect(progress).toMatchObject({ total: 3, done: 2, required: 2, requiredDone: 1, complete: false });
    expect(progress.sentence).toBe("1 of 2 required lines done, 1 still to do.");
    expect(people.onboardingProgress([{ required: true, doneAt: now }, { required: false, doneAt: null }]).complete).toBe(true);
  });

  it("is not complete for somebody nobody started", () => {
    expect(people.onboardingProgress([]).complete).toBe(false);
  });
});

describe("continuing education hours", () => {
  it("counts only the hours since the licence was last issued, in hundredths", () => {
    const progress = people.ceProgress({
      required: "16",
      entries: [
        { completedOn: "2025-02-01", hours: "8" }, // the last cycle's
        { completedOn: "2026-03-01", hours: "0.1" },
        { completedOn: "2026-04-01", hours: "0.2" },
        { completedOn: "2026-05-01", hours: "6.5" },
      ],
      since: "2026-01-15",
      by: "2028-01-14",
    });
    expect(progress).toMatchObject({ logged: "6.8", remaining: "9.2", met: false });
    expect(progress.sentence).toContain("before it expires on 2028-01-14");
  });

  it("says enough when enough, and says nothing is asked when nothing is", () => {
    expect(people.ceProgress({ required: "4", entries: [{ completedOn: "2026-01-01", hours: "4.00" }], since: null, by: null }).met).toBe(true);
    expect(people.ceProgress({ required: null, entries: [], since: null, by: null }).met).toBeNull();
  });

  it("refuses hours that are not a number of hours", () => {
    expect(() => people.hundredths("1.255")).toThrow(RangeError);
    expect(() => people.hundredths("-1")).toThrow(RangeError);
  });
});

describe("signing a document the office gave somebody", () => {
  it("takes a typed name or a drawing, and refuses both or neither", () => {
    expect(people.checkSignature({ typedName: "  Ray Ortiz ", drawn: false, ownName: "Ray Ortiz" }))
      .toEqual({ ok: true, method: "typed", signerName: "Ray Ortiz" });
    expect(people.checkSignature({ drawn: true, ownName: "Ray Ortiz" }))
      .toEqual({ ok: true, method: "drawn", signerName: "Ray Ortiz" });
    expect(people.checkSignature({ typedName: "Ray", drawn: true, ownName: "Ray Ortiz" }).ok).toBe(false);
    expect(people.checkSignature({ typedName: "   ", drawn: false, ownName: "Ray Ortiz" }).ok).toBe(false);
    expect(people.checkSignature({ typedName: "R", drawn: false, ownName: "Ray Ortiz" }).ok).toBe(false);
  });
});

describe("where an invite stands", () => {
  const now = new Date("2026-10-04T15:00:00Z");
  it("says when the link stops working, and whether it was emailed", () => {
    expect(people.inviteStanding({ expiresAt: new Date("2026-10-11T15:00:00Z"), now, email: "sent", expiresOn: "Oct 11" }))
      .toEqual({ expired: false, sentence: "Emailed. The link works until Oct 11." });
    expect(people.inviteStanding({
      expiresAt: new Date("2026-10-11T15:00:00Z"), now, email: "not_sent", emailNote: "no email provider is connected", expiresOn: "Oct 11",
    }).sentence).toBe("Not emailed (no email provider is connected), so send them the link yourself. The link works until Oct 11.");
  });

  it("is expired from the instant the link stops working", () => {
    expect(people.inviteStanding({ expiresAt: now, now, email: "sent", expiresOn: "Oct 4" }))
      .toEqual({ expired: true, sentence: "The invite ran out on Oct 4. Send a new one." });
  });
});
