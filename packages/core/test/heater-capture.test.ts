import { describe, it, expect } from "vitest";
import { reporting as r, inspection } from "../src/index";

const heater = (over: Partial<r.HeaterSeen> = {}): r.HeaterSeen => ({
  installedOn: "2012-03-01", inspectedOn: "2026-06-10", replacements: [], declines: [], ...over,
});

describe("a water heater we looked at", () => {
  it("is caught when we replaced it on one of our jobs on or after the day we looked", () => {
    expect(r.heaterCaptureOf(heater({ replacements: [{ movedOn: "2026-06-20", byUs: true }] }))).toBe("replaced");
    expect(r.heaterCaptureOf(heater({ replacements: [{ movedOn: "2026-06-10", byUs: true }] }))).toBe("replaced");
    /** Replaced before we looked, or recorded with no job of ours: not a catch. */
    expect(r.heaterCaptureOf(heater({ replacements: [{ movedOn: "2026-06-09", byUs: true }] }))).toBe("open");
    expect(r.heaterCaptureOf(heater({ replacements: [{ movedOn: "2026-06-20", byUs: false }] }))).toBe("open");
  });

  it("counts only a heater over ten years old on the day it was inspected", () => {
    expect(r.heaterCaptureOf(heater({ installedOn: "2016-06-10" }))).toBe("young");
    expect(r.heaterCaptureOf(heater({ installedOn: "2016-06-09" }))).toBe("open");
    expect(r.heaterCaptureOf(heater({ installedOn: null }))).toBe("unknown_age");
  });

  it("leaves out one the customer had booked with somebody else, said as a code and never read from words", () => {
    expect(r.heaterCaptureOf(heater({ declines: [{ declinedOn: "2026-06-10", code: "booked_elsewhere" }] }))).toBe("booked_elsewhere");
    expect(r.heaterCaptureOf(heater({ declines: [{ declinedOn: "2026-06-10", code: "price" }] }))).toBe("open");
    expect(r.heaterCaptureOf(heater({ declines: [{ declinedOn: "2026-06-10", code: null }] }))).toBe("open");
    /** Booked elsewhere last year and still there when we looked: an opportunity again. */
    expect(r.heaterCaptureOf(heater({ declines: [{ declinedOn: "2025-06-10", code: "booked_elsewhere" }] }))).toBe("open");
  });

  it("is caught when we replaced it after all, whatever the customer said first", () => {
    expect(r.heaterCaptureOf(heater({
      declines: [{ declinedOn: "2026-06-10", code: "booked_elsewhere" }],
      replacements: [{ movedOn: "2026-07-01", byUs: true }],
    }))).toBe("replaced");
  });

  it("counts ten years back the way the database does, the 29th of February included", () => {
    expect(r.tenYearsBefore("2026-06-10")).toBe("2016-06-10");
    expect(r.tenYearsBefore("2024-02-29")).toBe("2014-02-28");
  });

  it("names every decline code in words", () => {
    for (const code of inspection.DECLINE_CODES) expect(inspection.DECLINE_CODE_WORDS[code]).toMatch(/\w/);
  });
});
