import { describe, it, expect } from "vitest";
import { people } from "../src/index";

describe("how many days an invite's link works", () => {
  it("is a week unless the company says otherwise", () => {
    expect(people.INVITE_DAYS).toBe(7);
    expect(people.inviteDaysOf(undefined)).toBe(7);
    expect(people.inviteDaysOf(null)).toBe(7);
  });

  it("takes whole days from one to thirty", () => {
    for (const days of [1, 7, 14, 30]) {
      expect(people.inviteDaysProblem(days)).toBeNull();
      expect(people.inviteDaysOf(days)).toBe(days);
    }
  });

  it("refuses the rest in words, and reads a bad saved value as the usual week", () => {
    for (const bad of [0, 31, -1, 2.5, "7", null, undefined, Number.NaN]) {
      expect(people.inviteDaysProblem(bad)).toBe("Give the number of days as a whole number from 1 to 30.");
      expect(people.inviteDaysOf(bad)).toBe(7);
    }
  });

  it("says days in the singular for one", () => {
    expect(people.inviteDaysWords(1)).toBe("1 day");
    expect(people.inviteDaysWords(7)).toBe("7 days");
  });
});
