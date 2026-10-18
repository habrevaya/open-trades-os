import { describe, it, expect } from "vitest";
import { clockWords, mobilisationPunch, projectDay, type FieldSnapshot, type QueuedOperation } from "../src/index";

/**
 * GETTING A JOB READY, ON THE CLOCK
 *
 * Loading, driving out and unloading is clocked in for against one of the
 * day's stops. The punch names the stop and its kind, and the clock says what
 * it is for, from the phone's own punch before it is sent and from the
 * server's open punch after.
 */
let seq = 0;
const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
  clientId: `op-${++seq}`, sequence: seq, kind: "visit.note", occurredAt: "2026-10-02T15:00:00.000Z",
  payload: {}, status: "pending", attempts: 0, ...over,
});
const snapshot = (openTimeEntry: FieldSnapshot["openTimeEntry"] = null): FieldSnapshot => ({
  revision: 1, unchanged: false, openTimeEntry, priceBook: [], visits: [],
});

describe("clocking in to get a job ready", () => {
  it("is a punch of its own kind naming the stop", () => {
    expect(mobilisationPunch("v1")).toEqual({ kind: "timeclock.punch_in", subjectId: "v1", payload: { kind: "mobilisation" } });
  });

  it("is what the clock says it is for, until it is clocked out", () => {
    const punch = mobilisationPunch("v1");
    let day = projectDay({ snapshot: snapshot(), operations: [op(punch)] });
    expect(day.clockKind).toEqual({ kind: "mobilisation", visitId: "v1" });
    expect(clockWords(day.clockKind?.kind)).toBe("Getting a job ready");

    day = projectDay({ snapshot: snapshot(), operations: [op(punch), op({ kind: "timeclock.punch_out" })] });
    expect(day.clockKind).toBeNull();

    day = projectDay({ snapshot: snapshot(), operations: [op({ kind: "timeclock.punch_in" })] });
    expect(clockWords(day.clockKind?.kind)).toBe("On the clock");
  });

  it("is read from the server's open punch once it has landed", () => {
    const day = projectDay({
      snapshot: snapshot({ id: "t", kind: "mobilisation", startedAt: "2026-10-02T12:00:00Z", visitId: "v2" }),
      operations: [],
    });
    expect(day.clockKind).toEqual({ kind: "mobilisation", visitId: "v2" });
  });
});
