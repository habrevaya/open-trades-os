import { describe, it, expect } from "vitest";
import {
  readPath, evaluateCondition, evaluateGroup, shouldTrigger, runKey, canPublish,
  MAX_CAUSATION_DEPTH, type TriggerEvent, type WorkflowSpec,
} from "../src/automation/index";
import { permissionsFor } from "../src/access/index";

const ctx = (payload: Record<string, unknown>, previous?: Record<string, unknown>) =>
  ({ payload, previous });

describe("reading a path", () => {
  it("walks a dotted path", () => {
    expect(readPath({ job: { status: "completed" } }, "job.status")).toBe("completed");
  });

  it("returns nothing for a path that is not there", () => {
    expect(readPath({ job: {} }, "job.status")).toBeUndefined();
    expect(readPath({}, "a.b.c")).toBeUndefined();
  });

  it("refuses to walk into the prototype", () => {
    // A condition path is author supplied, and `__proto__.x` is the oldest
    // trick there is.
    //
    // The assertions have to be ones that differ WITH and WITHOUT the guard.
    // `__proto__.polluted` is undefined either way, because walking to
    // Object.prototype and asking for a key nobody set also yields undefined,
    // so a test built on it passes against an unguarded reader. These do not:
    // each resolves to something real when the guard is removed.
    expect(readPath({}, "__proto__")).toBeUndefined();
    expect(readPath({}, "__proto__.toString")).toBeUndefined();
    expect(readPath({ a: { b: 1 } }, "a.__proto__")).toBeUndefined();
    expect(readPath({}, "constructor")).toBeUndefined();
  });

  it("does not walk through a primitive", () => {
    expect(readPath({ a: "string" }, "a.length")).toBeUndefined();
  });
});

describe("comparing", () => {
  it("handles equality and presence", () => {
    const c = ctx({ job: { status: "completed", note: null } });
    expect(evaluateCondition({ path: "job.status", op: "eq", value: "completed" }, c)).toBe(true);
    expect(evaluateCondition({ path: "job.status", op: "ne", value: "lead" }, c)).toBe(true);
    expect(evaluateCondition({ path: "job.status", op: "exists" }, c)).toBe(true);
    expect(evaluateCondition({ path: "job.note", op: "not_exists" }, c)).toBe(true);
  });

  it("compares a money string without the author casting it", () => {
    // Money is a decimal string everywhere in this product.
    const c = ctx({ invoice: { balance: "2480.5000" } });
    expect(evaluateCondition({ path: "invoice.balance", op: "gt", value: 1000 }, c)).toBe(true);
    expect(evaluateCondition({ path: "invoice.balance", op: "lte", value: 100 }, c)).toBe(false);
  });

  it("is false rather than throwing on an incomparable pair", () => {
    // A workflow that throws on one odd record stops running for every record.
    const c = ctx({ job: { status: "completed" } });
    expect(evaluateCondition({ path: "job.status", op: "gt", value: 5 }, c)).toBe(false);
  });

  it("handles membership and containment", () => {
    const c = ctx({ job: { status: "completed", tags: ["callback", "warranty"] } });
    expect(evaluateCondition({ path: "job.status", op: "in", value: ["completed", "invoiced"] }, c)).toBe(true);
    expect(evaluateCondition({ path: "job.status", op: "not_in", value: ["lead"] }, c)).toBe(true);
    expect(evaluateCondition({ path: "job.tags", op: "contains", value: "warranty" }, c)).toBe(true);
  });

  it("treats an unknown operator as false, never true", () => {
    // A condition that cannot be evaluated must not count as satisfied.
    const c = ctx({ job: { status: "completed" } });
    expect(evaluateCondition({ path: "job.status", op: "sideways" as never, value: 1 }, c)).toBe(false);
  });
});

describe("a change, rather than a state", () => {
  it("fires on the transition into a value and not on later edits", () => {
    // "When a job becomes completed" must not re-fire every time somebody
    // edits an already completed job.
    const becoming = ctx({ job: { status: "completed" } }, { job: { status: "in_progress" } });
    const alreadyThere = ctx({ job: { status: "completed" } }, { job: { status: "completed" } });

    const condition = { path: "job.status", op: "changed_to" as const, value: "completed" };
    expect(evaluateCondition(condition, becoming)).toBe(true);
    expect(evaluateCondition(condition, alreadyThere)).toBe(false);
  });

  it("detects any change", () => {
    const c = ctx({ job: { status: "completed" } }, { job: { status: "scheduled" } });
    expect(evaluateCondition({ path: "job.status", op: "changed" }, c)).toBe(true);
  });

  it("is false with nothing to compare against, rather than true", () => {
    // "changed" with no previous values would fire on every event.
    const c = ctx({ job: { status: "completed" } });
    expect(evaluateCondition({ path: "job.status", op: "changed" }, c)).toBe(false);
    expect(evaluateCondition({ path: "job.status", op: "changed_to", value: "completed" }, c)).toBe(false);
  });
});

describe("combining conditions", () => {
  const c = ctx({ job: { status: "completed", total: "500.00", tags: ["warranty"] } });

  it("requires every condition in all", () => {
    expect(evaluateGroup({ all: [
      { path: "job.status", op: "eq", value: "completed" },
      { path: "job.total", op: "gt", value: 100 },
    ] }, c)).toBe(true);

    expect(evaluateGroup({ all: [
      { path: "job.status", op: "eq", value: "completed" },
      { path: "job.total", op: "gt", value: 10000 },
    ] }, c)).toBe(false);
  });

  it("requires one of any, and treats an empty any as not asked", () => {
    expect(evaluateGroup({ any: [
      { path: "job.status", op: "eq", value: "lead" },
      { path: "job.status", op: "eq", value: "completed" },
    ] }, c)).toBe(true);
    expect(evaluateGroup({ any: [] }, c)).toBe(true);
  });

  it("refuses when any of none matches", () => {
    expect(evaluateGroup({ none: [{ path: "job.tags", op: "contains", value: "warranty" }] }, c)).toBe(false);
    expect(evaluateGroup({ none: [{ path: "job.tags", op: "contains", value: "callback" }] }, c)).toBe(true);
  });

  it("matches everything when nothing is asked", () => {
    expect(evaluateGroup({}, c)).toBe(true);
  });
});

describe("whether an event starts a workflow", () => {
  const spec = (over: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
    id: "w1", versionId: "v1", enabled: true,
    triggerEvents: ["job.completed"],
    conditions: {},
    ...over,
  });
  const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
    name: "job.completed", payload: { job: { status: "completed" } }, causationDepth: 0, ...over,
  });

  it("runs on a subscribed event that meets the conditions", () => {
    expect(shouldTrigger(spec(), event())).toEqual({ run: true });
  });

  it("does not run when disabled", () => {
    expect(shouldTrigger(spec({ enabled: false }), event()))
      .toEqual({ run: false, reason: "disabled" });
  });

  it("ignores an event it is not subscribed to", () => {
    expect(shouldTrigger(spec(), event({ name: "invoice.paid" })))
      .toEqual({ run: false, reason: "event_not_subscribed" });
  });

  it("does not run when the conditions are unmet", () => {
    const s = spec({ conditions: { all: [{ path: "job.total", op: "gt", value: 1000 }] } });
    expect(shouldTrigger(s, event())).toEqual({ run: false, reason: "conditions_unmet" });
  });

  it("never responds to its own output", () => {
    // A workflow that edits a job produces an event that would trigger it
    // again. The direct loop.
    const decision = shouldTrigger(spec(), event({ causedByRunId: "run-1" }), ["run-1"]);
    expect(decision).toEqual({ run: false, reason: "self_triggered" });
  });

  it("still runs on an event caused by a different workflow", () => {
    expect(shouldTrigger(spec(), event({ causedByRunId: "other" }), ["run-1"]))
      .toEqual({ run: true });
  });

  it("stops an indirect loop at the depth limit", () => {
    // A triggers B triggers A. No single-workflow check can see it, so the
    // chain depth is the only thing that stops it.
    expect(shouldTrigger(spec(), event({ causationDepth: MAX_CAUSATION_DEPTH })))
      .toEqual({ run: false, reason: "depth_exceeded" });
    expect(shouldTrigger(spec(), event({ causationDepth: MAX_CAUSATION_DEPTH - 1 })))
      .toEqual({ run: true });
  });

  it("checks the loop guards before the conditions", () => {
    // Cheap and absolute first. A runaway chain should stop whether or not
    // its conditions happen to match.
    const s = spec({ conditions: { all: [{ path: "nope", op: "exists" }] } });
    expect(shouldTrigger(s, event({ causationDepth: MAX_CAUSATION_DEPTH })).run).toBe(false);
    expect(shouldTrigger(s, event({ causationDepth: MAX_CAUSATION_DEPTH })))
      .toEqual({ run: false, reason: "depth_exceeded" });
  });
});

describe("running once", () => {
  it("derives the same key for the same version and event", () => {
    // A worker that crashes after starting and retries has to land on the
    // same key, or the customer gets the text twice.
    expect(runKey("v1", "e1")).toBe(runKey("v1", "e1"));
  });

  it("lets a new version legitimately re-run against the same event", () => {
    expect(runKey("v2", "e1")).not.toBe(runKey("v1", "e1"));
  });
});

/**
 * A workflow acts, so it runs with somebody's authority, and authoring one is
 * a way to acquire authority. The obvious implementation, running as the
 * owner, hands every author the owner's powers.
 */
describe("what an author may publish", () => {
  const owner = permissionsFor({ userId: "u", organizationId: "o", roles: ["owner"] });
  const tech = permissionsFor({ userId: "u", organizationId: "o", roles: ["technician"] });

  it("lets an owner publish a workflow that sends a message", () => {
    const result = canPublish(owner, [{ kind: "send_message" }]);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.required).toContain("message:send");
  });

  it("refuses a step whose permission the author lacks", () => {
    const result = canPublish(tech, [{ kind: "assign_visit" }]);
    expect(result).toMatchObject({ ok: false, reason: "missing_permission" });
  });

  it("refuses a step this build does not know, rather than skipping it", () => {
    // Skipping would let a definition written against a newer version run
    // here with the steps it could not perform quietly dropped.
    const result = canPublish(owner, [{ kind: "launch_missiles" }]);
    expect(result).toMatchObject({ ok: false, reason: "unknown_step" });
    expect(result.ok === false && result.reason === "unknown_step" && result.kinds)
      .toContain("launch_missiles");
  });

  it("reports the required set so it can be stored on the version", () => {
    const result = canPublish(owner, [{ kind: "send_message" }, { kind: "update_job" }, { kind: "wait" }]);
    expect(result.ok && result.required.sort()).toEqual(["job:write", "message:send"]);
  });

  it("allows steps that need nothing", () => {
    expect(canPublish(new Set(), [{ kind: "wait" }, { kind: "branch" }])).toMatchObject({ ok: true });
  });

  it("does not double count a permission two steps share", () => {
    const result = canPublish(owner, [{ kind: "update_job" }, { kind: "add_note" }]);
    expect(result.ok && result.required).toEqual(["job:write"]);
  });
});
