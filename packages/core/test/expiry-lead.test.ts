import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/**
 * THE NOTICE BEFORE A LICENCE OR SKILL RUNS OUT, BY ITS OWN RENEWAL PERIOD
 *
 * A licence with a six week renewal is on the renewals list six weeks out, and
 * now on the person's phone from the same day rather than from thirty days.
 */
describe("the notice before a licence or skill runs out", () => {
  it("starts when the record's renewal period does", () => {
    expect(notices.expiryNoticeDue("2026-12-15", "2026-10-30", 45)).toBeNull();
    expect(notices.expiryNoticeDue("2026-12-15", "2026-10-31", 45)).toBe("soon");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-25", 10)).toBeNull();
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-26", 10)).toBe("soon");
  });

  it("is thirty days for a record that says nothing, and still the day itself whatever the period", () => {
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-06")).toBe("soon");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-10-05")).toBeNull();
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-05", 90)).toBe("today");
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-05", 0)).toBe("today");
  });

  it("says nothing ahead for a period of none, and reads one past a year as a year", () => {
    expect(notices.expiryNoticeDue("2026-11-05", "2026-11-04", 0)).toBeNull();
    expect(notices.noticeLead(-5)).toBe(0);
    expect(notices.noticeLead(900)).toBe(notices.MAX_EXPIRY_NOTICE_DAYS);
    expect(notices.expiryNoticeDue("2027-11-05", "2026-11-04", 900)).toBeNull();
    expect(notices.expiryNoticeDue("2027-11-05", "2026-11-05", 900)).toBe("soon");
  });
});
