import { describe, it, expect } from "vitest";
import { notices } from "../src/index";

/** A person's own hour for the daily email, and what applying the company's defaults does to one kind. */
describe("the hour of a person's daily email", () => {
  const quiet = { startHour: 21, endHour: 8 };

  it("is an hour of the company's day, from its morning to the start of its quiet hours", () => {
    expect(notices.digestHourChoices(quiet)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(notices.digestHourChoices(null)[0]).toBe(8);
    expect(notices.digestHourChoices(null).at(-1)).toBe(23);
    expect(notices.digestHourChoices({ startHour: 22, endHour: 6 })).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it("refuses an hour in the quiet hours or before the morning, and takes null as the morning", () => {
    expect(notices.digestHourProblem(null, quiet)).toBeNull();
    expect(notices.digestHourProblem(14, quiet)).toBeNull();
    expect(notices.digestHourProblem(22, quiet)).toMatch(/from 8 to 20/);
    expect(notices.digestHourProblem(6, quiet)).toMatch(/outside its quiet hours/);
    expect(notices.digestHourProblem(9.5, quiet)).not.toBeNull();
  });

  it("goes at the morning hour when the quiet hours later cover the hour chosen", () => {
    expect(notices.digestHourFor(14, quiet)).toBe(14);
    expect(notices.digestHourFor(null, quiet)).toBe(8);
    expect(notices.digestHourFor(20, { startHour: 19, endHour: 7 })).toBe(7);
  });

  it("is due at the person's own hour and not before", () => {
    const base = { today: "2026-10-30", lastOn: null, quiet };
    expect(notices.digestDue({ ...base, localHour: 9, hour: 14 })).toBe(false);
    expect(notices.digestDue({ ...base, localHour: 14, hour: 14 })).toBe(true);
    expect(notices.digestDue({ ...base, localHour: 16, hour: 14 })).toBe(true);
    expect(notices.digestDue({ ...base, localHour: 8 })).toBe(true);
    expect(notices.digestDue({ ...base, localHour: 15, hour: 14, lastOn: "2026-10-30" })).toBe(false);
  });
});

describe("applying the company's defaults to one kind", () => {
  const off = { inApp: false, push: false, email: null };

  it("keeps a kind the person chose", () => {
    expect(notices.appliedDefault({ inApp: true, push: true, email: null, chosen: true }, off, "task_deadline")).toBe("kept");
  });

  it("replaces a kind copied from the defaults, and fills in one with no row", () => {
    expect(notices.appliedDefault({ inApp: true, push: true, email: null, chosen: false }, off, "task_deadline")).toEqual(off);
    expect(notices.appliedDefault(null, off, "task_deadline")).toEqual(off);
  });

  it("changes nothing where the person already has what the company gives", () => {
    expect(notices.appliedDefault(null, { inApp: true, push: true, email: null }, "task_deadline")).toBeNull();
    expect(notices.appliedDefault(null, { inApp: true, push: true, email: true }, "qualification_expiry")).toBeNull();
    expect(notices.appliedDefault(null, { inApp: true, push: true, email: false }, "qualification_expiry"))
      .toEqual({ inApp: true, push: true, email: false });
  });
});
