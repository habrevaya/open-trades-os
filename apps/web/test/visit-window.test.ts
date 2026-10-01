import { describe, it, expect } from "vitest";
import { windowFrom } from "../src/lib/visit-window";

describe("a visit window from what the office typed", () => {
  it("reads the day and time in the company's zone, not the server's", () => {
    // Nine in Austin in October is two in the afternoon in UTC (CDT, -5).
    const result = windowFrom({ date: "2026-10-14", start: "09:00", windowHours: "2" }, "America/Chicago");
    expect(result).toEqual({
      kind: "window",
      windowStart: "2026-10-14T14:00:00.000Z",
      windowEnd: "2026-10-14T16:00:00.000Z",
    });
  });

  it("is no visit at all when the day is left empty, whatever the time box says", () => {
    expect(windowFrom({ date: "", start: "09:00" }, "America/Chicago")).toEqual({ kind: "none" });
  });

  it("refuses a time that is not one", () => {
    expect(windowFrom({ date: "2026-10-14", start: "" }, "UTC").kind).toBe("invalid");
    expect(windowFrom({ date: "2026-10-14", start: "25:00" }, "UTC").kind).toBe("invalid");
  });

  it("refuses the hour the clocks skip, rather than booking a different one", () => {
    // 2:30am on the second Sunday of March 2027 does not happen in Chicago.
    const result = windowFrom({ date: "2027-03-14", start: "02:30" }, "America/Chicago");
    expect(result.kind).toBe("invalid");
  });
});
