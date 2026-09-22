import { describe, it, expect } from "vitest";
import {
  OPERATION_KINDS, CONFLICT_RULES, VISIT_TRANSITIONS,
  resolveOccurredAt, orderOperations, findSequenceGaps, applicablePrefix, evaluate,
  VISIT_STATES, stateAfter, allowedFrom, REPORT_TRANSITIONS,
  type FieldOperation, type OperationKind,
} from "../src/field/index.js";

const at = (iso: string) => new Date(iso);

const op = (over: Partial<FieldOperation> = {}): FieldOperation => ({
  clientId: "c1",
  deviceId: "phone-a",
  kind: "visit.arrive",
  sequence: 1,
  occurredAt: at("2026-04-02T09:00:00Z"),
  subjectId: "visit-1",
  payload: {},
  ...over,
});

describe("the operation catalogue", () => {
  it("gives every kind a conflict rule", () => {
    // A kind without a rule is a kind whose behaviour under conflict was never
    // decided, which surfaces as whatever the last branch happened to do.
    for (const kind of OPERATION_KINDS) {
      expect(CONFLICT_RULES[kind], `${kind} has no conflict rule`).toBeDefined();
    }
  });

  it("names no rule for a kind that does not exist", () => {
    const known = new Set<string>(OPERATION_KINDS);
    for (const kind of Object.keys(CONFLICT_RULES)) {
      expect(known.has(kind), `${kind} has a rule but is not an operation`).toBe(true);
    }
  });

  it("treats both punches as facts", () => {
    // Somebody is paid from these. They are never dropped and never overwritten.
    expect(CONFLICT_RULES["timeclock.punch_in"]).toBe("fact");
    expect(CONFLICT_RULES["timeclock.punch_out"]).toBe("fact");
  });

  /**
   * The first version of this test listed the states by hand and passed, while
   * the transition table named two states the schema does not have. Both were
   * wrong in the same way, so the test agreed with the assumption rather than
   * with the database. It now checks against the exported list, and an
   * integration test checks that list against the real pgEnum.
   */
  it("only references real visit states in the transition table", () => {
    for (const [kind, from] of Object.entries(VISIT_TRANSITIONS)) {
      for (const s of from) {
        expect(VISIT_STATES as readonly string[], `${kind} allows unknown state ${s}`)
          .toContain(s);
      }
    }
  });
});

describe("the device clock", () => {
  it("takes the device's word when it is plausible", () => {
    const r = resolveOccurredAt({
      claimed: at("2026-04-02T09:00:00Z"),
      receivedAt: at("2026-04-02T13:00:00Z"),
    });
    expect(r.occurredAt.toISOString()).toBe("2026-04-02T09:00:00.000Z");
    expect(r.clamped).toBeNull();
  });

  it("clamps an occurrence in the future", () => {
    // The alternative is a timesheet that bills tomorrow.
    const r = resolveOccurredAt({
      claimed: at("2026-04-03T09:00:00Z"),
      receivedAt: at("2026-04-02T13:00:00Z"),
    });
    expect(r.occurredAt.toISOString()).toBe("2026-04-02T13:00:00.000Z");
    expect(r.clamped).toBe("future");
  });

  it("tolerates ordinary drift rather than calling it fraud", () => {
    const r = resolveOccurredAt({
      claimed: at("2026-04-02T13:00:20Z"),
      receivedAt: at("2026-04-02T13:00:00Z"),
    });
    expect(r.clamped).toBeNull();
  });

  it("clamps an occurrence that runs backwards on the same device", () => {
    const r = resolveOccurredAt({
      claimed: at("2026-04-02T08:00:00Z"),
      receivedAt: at("2026-04-02T13:00:00Z"),
      previousOccurredAt: at("2026-04-02T09:00:00Z"),
    });
    expect(r.occurredAt.toISOString()).toBe("2026-04-02T09:00:00.000Z");
    expect(r.clamped).toBe("reordered");
  });

  it("always keeps what the device claimed", () => {
    // A clamp is evidence. Throwing it away is what makes a payroll dispute
    // unanswerable six weeks later.
    const r = resolveOccurredAt({
      claimed: at("2026-04-03T09:00:00Z"),
      receivedAt: at("2026-04-02T13:00:00Z"),
    });
    expect(r.claimed.toISOString()).toBe("2026-04-03T09:00:00.000Z");
  });
});

describe("ordering", () => {
  it("orders one device by its own sequence, not by its clock", () => {
    const ops = [
      op({ sequence: 3, occurredAt: at("2026-04-02T09:00:00Z") }),
      op({ sequence: 1, occurredAt: at("2026-04-02T11:00:00Z") }),
      op({ sequence: 2, occurredAt: at("2026-04-02T10:00:00Z") }),
    ];
    expect(orderOperations(ops).map((o) => o.sequence)).toEqual([1, 2, 3]);
  });

  it("orders across devices by when things happened", () => {
    const ops = [
      op({ deviceId: "phone-b", sequence: 1, occurredAt: at("2026-04-02T11:00:00Z") }),
      op({ deviceId: "phone-a", sequence: 1, occurredAt: at("2026-04-02T09:00:00Z") }),
    ];
    expect(orderOperations(ops).map((o) => o.deviceId)).toEqual(["phone-a", "phone-b"]);
  });

  it("is deterministic when two devices claim the same instant", () => {
    // Two operations at the same instant have no true order. Any stable answer
    // beats one that changes between a retry and the original.
    const same = at("2026-04-02T09:00:00Z");
    const a = op({ deviceId: "phone-a", occurredAt: same });
    const b = op({ deviceId: "phone-b", occurredAt: same });

    expect(orderOperations([b, a]).map((o) => o.deviceId))
      .toEqual(orderOperations([a, b]).map((o) => o.deviceId));
  });

  it("does not mutate what it was given", () => {
    const ops = [op({ sequence: 2 }), op({ sequence: 1 })];
    orderOperations(ops);
    expect(ops.map((o) => o.sequence)).toEqual([2, 1]);
  });
});

describe("gaps in a device's sequence", () => {
  it("finds an operation that did not arrive", () => {
    const ops = [op({ sequence: 4 }), op({ sequence: 5 }), op({ sequence: 7 })];
    expect(findSequenceGaps(ops, { "phone-a": 3 })).toEqual([
      { deviceId: "phone-a", missing: [6] },
    ]);
  });

  it("finds nothing when the run is complete", () => {
    const ops = [op({ sequence: 4 }), op({ sequence: 5 }), op({ sequence: 6 })];
    expect(findSequenceGaps(ops, { "phone-a": 3 })).toEqual([]);
  });

  it("treats a device it has never seen as starting at one", () => {
    const ops = [op({ sequence: 3 })];
    expect(findSequenceGaps(ops, {})).toEqual([
      { deviceId: "phone-a", missing: [1, 2] },
    ]);
  });
});

describe("what can be applied now", () => {
  it("applies a complete run", () => {
    const ops = [op({ sequence: 1 }), op({ sequence: 2 }), op({ sequence: 3 })];
    const { applicable, held } = applicablePrefix(ops, {});
    expect(applicable).toHaveLength(3);
    expect(held).toHaveLength(0);
  });

  it("holds the tail after a gap rather than rejecting the batch", () => {
    // The missing operation usually arrives on the next attempt, and rejecting
    // everything makes a bad connection worse.
    const ops = [op({ sequence: 1 }), op({ sequence: 2 }), op({ sequence: 4 })];
    const { applicable, held } = applicablePrefix(ops, {});
    expect(applicable.map((o) => o.sequence)).toEqual([1, 2]);
    expect(held.map((o) => o.sequence)).toEqual([4]);
  });

  it("holds everything behind the gap, not just the next one", () => {
    const ops = [op({ sequence: 1 }), op({ sequence: 3 }), op({ sequence: 4 })];
    const { applicable, held } = applicablePrefix(ops, {});
    expect(applicable.map((o) => o.sequence)).toEqual([1]);
    expect(held.map((o) => o.sequence)).toEqual([3, 4]);
  });

  it("accepts a replay of something already applied", () => {
    // Normal on a flaky connection: the device did not hear the acknowledgement.
    const ops = [op({ sequence: 2 }), op({ sequence: 3 })];
    const { applicable, held } = applicablePrefix(ops, { "phone-a": 2 });
    expect(applicable.map((o) => o.sequence)).toEqual([2, 3]);
    expect(held).toHaveLength(0);
  });

  it("does not let one device's gap block another device", () => {
    const ops = [
      op({ deviceId: "phone-a", sequence: 3, occurredAt: at("2026-04-02T09:00:00Z") }),
      op({ deviceId: "phone-b", sequence: 1, occurredAt: at("2026-04-02T09:30:00Z") }),
    ];
    const { applicable, held } = applicablePrefix(ops, {});
    expect(applicable.map((o) => o.deviceId)).toEqual(["phone-b"]);
    expect(held.map((o) => o.deviceId)).toEqual(["phone-a"]);
  });
});

describe("applying against state that moved", () => {
  const now = at("2026-04-02T09:00:00Z");

  it("always applies an append", () => {
    const r = evaluate({ kind: "visit.add_line", currentState: "cancelled", occurredAt: now, allowedFrom: allowedFrom("visit.add_line") });
    expect(r.apply).toBe(true);
    expect(r.conflict).toBeNull();
  });

  /**
   * The case this whole module exists for. A dispatcher cancels a visit while
   * the technician is under a house. The technician arrives. Both are true.
   */
  it("records an arrival at a visit that was cancelled, and flags it", () => {
    const r = evaluate({ kind: "visit.arrive", currentState: "cancelled", occurredAt: now, allowedFrom: allowedFrom("visit.arrive") });
    expect(r.apply).toBe(true);
    expect(r.conflict).toMatch(/cancelled/);
  });

  it("records a completion of a visit somebody reassigned", () => {
    const r = evaluate({ kind: "visit.complete", currentState: "cancelled", occurredAt: now, allowedFrom: allowedFrom("visit.complete") });
    expect(r.apply).toBe(true);
    expect(r.conflict).not.toBeNull();
  });

  it("raises nothing when the state agrees", () => {
    const r = evaluate({ kind: "visit.arrive", currentState: "dispatched", occurredAt: now, allowedFrom: allowedFrom("visit.arrive") });
    expect(r.apply).toBe(true);
    expect(r.conflict).toBeNull();
  });

  it("refuses to submit a report that was already submitted", () => {
    // Usually this means the technician edited after submitting and expects
    // the change to land. Accepting it silently would tell them it did.
    const r = evaluate({
      kind: "service_report.submit", currentState: "submitted", occurredAt: now,
      allowedFrom: allowedFrom("service_report.submit"),
    });
    expect(r.apply).toBe(false);
    expect(r.conflict).toMatch(/submitted/);
  });

  it("submits a report that is still being written", () => {
    for (const from of REPORT_TRANSITIONS) {
      const r = evaluate({
        kind: "service_report.submit", currentState: from, occurredAt: now,
        allowedFrom: allowedFrom("service_report.submit"),
      });
      expect(r.apply, `could not submit from ${from}`).toBe(true);
    }
  });

  it("does not evaluate a punch against visit states", () => {
    // The punch has no allowed-from set of its own, so there is nothing for it
    // to contradict. An earlier version looked up the visit table for every
    // kind, which meant payroll was being checked against dispatch.
    expect(allowedFrom("timeclock.punch_in")).toBeUndefined();
  });

  it("keeps the newer of two edits to the same field", () => {
    const older = evaluate({
      kind: "service_report.set_field",
      occurredAt: at("2026-04-02T09:00:00Z"),
      lastEditAt: at("2026-04-02T10:00:00Z"),
    });
    expect(older.apply).toBe(false);

    const newer = evaluate({
      kind: "service_report.set_field",
      occurredAt: at("2026-04-02T11:00:00Z"),
      lastEditAt: at("2026-04-02T10:00:00Z"),
    });
    expect(newer.apply).toBe(true);
    expect(newer.supersedes).toBe(true);
  });

  it("treats an edit at exactly the same instant as already applied", () => {
    const same = at("2026-04-02T10:00:00Z");
    const r = evaluate({ kind: "service_report.set_field", occurredAt: same, lastEditAt: same });
    expect(r.apply).toBe(false);
  });

  it("applies an operation about a subject with no state at all", () => {
    const r = evaluate({ kind: "visit.arrive", occurredAt: now });
    expect(r.apply).toBe(true);
    expect(r.conflict).toBeNull();
  });

  it("never drops a punch, whatever the visit is doing", () => {
    for (const kind of ["timeclock.punch_in", "timeclock.punch_out"] as OperationKind[]) {
      for (const state of ["cancelled", "completed", "unassigned"]) {
        const r = evaluate({
          kind, currentState: state, occurredAt: now, allowedFrom: allowedFrom(kind),
        });
        expect(r.apply, `${kind} dropped against ${state}`).toBe(true);
      }
    }
  });
});

describe("a full offline day", () => {
  /**
   * The scenario in the phase's definition of done: a technician runs a day
   * from a phone with no signal and everything is in the system when they
   * surface. Eleven operations, queued in order, submitted in one batch.
   */
  it("applies a whole day submitted at once, in the right order", () => {
    const day: FieldOperation[] = [
      { kind: "timeclock.punch_in", sequence: 1, occurredAt: at("2026-04-02T07:02:00Z") },
      { kind: "visit.en_route", sequence: 2, occurredAt: at("2026-04-02T07:40:00Z") },
      { kind: "visit.arrive", sequence: 3, occurredAt: at("2026-04-02T08:05:00Z") },
      { kind: "visit.start", sequence: 4, occurredAt: at("2026-04-02T08:08:00Z") },
      { kind: "attachment.attach", sequence: 5, occurredAt: at("2026-04-02T08:30:00Z") },
      { kind: "service_report.set_field", sequence: 6, occurredAt: at("2026-04-02T08:45:00Z") },
      { kind: "visit.add_line", sequence: 7, occurredAt: at("2026-04-02T09:10:00Z") },
      { kind: "service_report.submit", sequence: 8, occurredAt: at("2026-04-02T09:30:00Z") },
      { kind: "signature.capture", sequence: 9, occurredAt: at("2026-04-02T09:35:00Z") },
      { kind: "visit.complete", sequence: 10, occurredAt: at("2026-04-02T09:36:00Z") },
      { kind: "timeclock.punch_out", sequence: 11, occurredAt: at("2026-04-02T16:20:00Z") },
    ].map((o, i) => op({ ...o, clientId: `c${i}` } as Partial<FieldOperation>));

    const { applicable, held } = applicablePrefix(day, {});
    expect(held).toHaveLength(0);
    expect(applicable.map((o) => o.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // Submitted in a different order, as a retry might arrive, the result is
    // the same. This is the property that makes a resend safe.
    const shuffled = [...day].reverse();
    expect(applicablePrefix(shuffled, {}).applicable.map((o) => o.sequence))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("survives the batch arriving twice", () => {
    const ops = [op({ sequence: 1 }), op({ sequence: 2 })];
    const first = applicablePrefix(ops, {});
    expect(first.applicable).toHaveLength(2);

    // Second attempt, after the first was applied but before the device heard.
    const second = applicablePrefix(ops, { "phone-a": 2 });
    expect(second.applicable).toHaveLength(2);
    expect(second.held).toHaveLength(0);
  });
});


describe("where a visit ends up", () => {
  /**
   * `completed_after_cancellation` is in the schema for one case, and it is
   * the case this whole module was built around.
   */
  it("keeps the cancellation visible when work happened anyway", () => {
    expect(stateAfter("visit.complete", "cancelled")).toBe("completed_after_cancellation");
  });

  it("does not quietly revive a cancelled visit", () => {
    // Anything short of completing it leaves the cancellation standing. A
    // technician turning up does not un-cancel a job the office called off.
    for (const kind of ["visit.en_route", "visit.arrive", "visit.start"] as OperationKind[]) {
      expect(stateAfter(kind, "cancelled"), `${kind} revived a cancelled visit`).toBeNull();
    }
  });

  it("moves an ordinary visit through the day", () => {
    expect(stateAfter("visit.en_route", "dispatched")).toBe("en_route");
    expect(stateAfter("visit.start", "en_route")).toBe("working");
    expect(stateAfter("visit.complete", "working")).toBe("completed");
  });

  it("changes nothing for an operation that is not a state change", () => {
    expect(stateAfter("visit.note", "working")).toBeNull();
    expect(stateAfter("timeclock.punch_in", "working")).toBeNull();
    expect(stateAfter("attachment.attach", "working")).toBeNull();
  });
});
