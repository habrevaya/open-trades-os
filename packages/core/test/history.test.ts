import { describe, it, expect } from "vitest";
import {
  classifyDate, classifyInstant, postingInstant, isClosed, daysBetween, LATE_ENTRY_DAYS,
} from "../src/history/index.js";

describe("where a business date sits", () => {
  it("counts whole calendar days", () => {
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("calls tomorrow the future, a week ago recent, and earlier history", () => {
    expect(classifyDate("2026-10-02", "2026-10-01")).toBe("future");
    expect(classifyDate("2026-10-01", "2026-10-01")).toBe("today");
    expect(classifyDate("2026-09-24", "2026-10-01")).toBe("recent");
    expect(daysBetween("2026-09-24", "2026-10-01")).toBe(LATE_ENTRY_DAYS);
    expect(classifyDate("2026-09-23", "2026-10-01")).toBe("historical");
    expect(classifyDate("2019-03-14", "2026-10-01")).toBe("historical");
  });

  it("reads an instant in the company's zone, not in UTC", () => {
    // 7pm in Chicago on the 1st is already the 2nd in UTC. It is today.
    const now = new Date("2026-10-02T00:30:00Z");
    expect(classifyInstant(new Date("2026-10-02T00:00:00Z"), now, "America/Chicago")).toBe("today");
    // Eight days back in Chicago's calendar is history.
    expect(classifyInstant(new Date("2026-09-23T17:00:00Z"), now, "America/Chicago")).toBe("historical");
  });

  it("allows a phone's clock to be a little ahead, and no more", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    expect(classifyInstant(new Date("2026-10-01T15:03:00Z"), now, "UTC")).toBe("today");
    expect(classifyInstant(new Date("2026-10-01T15:10:00Z"), now, "UTC")).toBe("future");
  });
});

describe("the instant a back-dated posting carries", () => {
  it("keeps the wall clock for today", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    expect(postingInstant("2026-10-01", "America/Chicago", now)).toBe(now);
  });

  it("stamps an earlier day at noon in the company's zone, so it stays on that day", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    const stamped = postingInstant("2023-12-31", "America/Chicago", now);
    expect(stamped.toISOString()).toBe("2023-12-31T18:00:00.000Z");
  });
});

describe("a closed period", () => {
  it("includes its last day and nothing after", () => {
    expect(isClosed("2026-03-31", "2026-03-31")).toBe(true);
    expect(isClosed("2026-04-01", "2026-03-31")).toBe(false);
    expect(isClosed("2026-04-01", null)).toBe(false);
  });
});
