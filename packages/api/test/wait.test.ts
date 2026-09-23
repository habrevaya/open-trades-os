import { describe, it, expect } from "vitest";
import { waitStep } from "../src/services/workflow-steps";

/**
 * READING A WAIT
 *
 * Pure, and tested here rather than through a database, because the ways this
 * goes wrong are all arithmetic. A wait that quietly becomes zero turns
 * "chase in three days" into a second text one minute after the first, and a
 * wait that quietly becomes a year is a run sitting in a table long after
 * anybody remembers making it.
 */
const NOW = new Date("2026-09-22T12:00:00Z");
const wait = (config: Record<string, unknown>) => waitStep(config, NOW);

describe("a relative wait", () => {
  it("reads days", () => {
    const result = wait({ days: 3 });
    expect(result.ok && "waitUntil" in result && result.waitUntil.toISOString())
      .toBe("2026-09-25T12:00:00.000Z");
  });

  it("adds the units together", () => {
    const result = wait({ hours: 1, minutes: 30 });
    expect(result.ok && "waitUntil" in result && result.waitUntil.toISOString())
      .toBe("2026-09-22T13:30:00.000Z");
  });

  it("refuses a unit that is not a number", () => {
    // `{ days: "three" }` is what a hand-edited definition looks like, and
    // treating it as zero is the failure this test exists for.
    expect(wait({ days: "three" })).toEqual({ ok: false, reason: "days must be a number" });
    expect(wait({ hours: NaN }).ok).toBe(false);
  });

  it("refuses a negative wait", () => {
    // Somebody's arithmetic going wrong rather than an instruction.
    expect(wait({ days: -1 })).toEqual({ ok: false, reason: "days cannot be negative" });
  });

  it("refuses a wait with nothing in it", () => {
    expect(wait({}).ok).toBe(false);
    expect(wait({ weeks: 2 }).ok).toBe(false);
  });

  it("does not park for zero", () => {
    // Nothing to wait for, so no tick, no claim and no resume.
    const result = wait({ minutes: 0 });
    expect(result).toEqual({ ok: true, output: { waited: false } });
  });

  it("refuses a wait longer than a year", () => {
    // A workflow is not a calendar, and this is always somebody's units.
    expect(wait({ days: 400 }).ok).toBe(false);
    expect(wait({ days: 365 }).ok).toBe(true);
  });
});

describe("an absolute wait", () => {
  it("waits until the time given", () => {
    const result = wait({ until: "2026-10-01T09:00:00Z" });
    expect(result.ok && "waitUntil" in result && result.waitUntil.toISOString())
      .toBe("2026-10-01T09:00:00.000Z");
  });

  it("does not park for a time that has passed", () => {
    // "Wait until the appointment" on a job booked for this morning is an
    // ordinary case, not a mistake.
    expect(wait({ until: "2020-01-01T00:00:00Z" })).toEqual({ ok: true, output: { waited: false } });
  });

  it("refuses something that is not a time", () => {
    expect(wait({ until: "next tuesday" }).ok).toBe(false);
  });

  it("takes the absolute time over a relative one", () => {
    // Both given is a definition somebody edited badly. The explicit instant
    // is the one with an intention behind it.
    const result = wait({ until: "2026-10-01T09:00:00Z", days: 3 });
    expect(result.ok && "waitUntil" in result && result.waitUntil.toISOString())
      .toBe("2026-10-01T09:00:00.000Z");
  });
});
