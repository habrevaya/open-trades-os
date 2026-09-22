import type { Permission } from "../access/permissions.js";

/**
 * THE WORKFLOW ENGINE'S DECISIONS
 *
 * Everything here is pure: given an event, a definition and a little context,
 * should this run, and what does it do. No database, no clock, no provider.
 * The parts that are hard to get right are all decisions rather than plumbing,
 * and decisions are the part worth testing exhaustively.
 */

/* ------------------------------------------------------------- conditions */

/**
 * Conditions are DATA, evaluated by this file. They are never code and never
 * reach an evaluator.
 *
 * A workflow builder that accepts an expression string and evaluates it has
 * handed anybody with `workflow:write` the ability to run arbitrary code on
 * the server, in a product whose whole premise is that a contractor self
 * hosts it. A small declarative shape is less expressive and that is the
 * trade being made deliberately.
 */
export type Comparator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "in" | "not_in" | "contains" | "exists" | "not_exists"
  | "changed" | "changed_to";

export interface Condition {
  /** Dotted path into the event payload: `job.status`, `invoice.balance`. */
  path: string;
  op: Comparator;
  value?: unknown;
}

export interface ConditionGroup {
  all?: Condition[] | undefined;
  any?: Condition[] | undefined;
  none?: Condition[] | undefined;
}

/**
 * Reads a dotted path, and refuses to walk into anything it should not.
 *
 * Prototype keys are rejected rather than resolved, because a condition path
 * is author supplied and `__proto__.x` is the oldest trick there is.
 */
export function readPath(source: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Money is a decimal string everywhere in this product, so a comparison on
  // a balance has to work without the author casting anything.
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export interface EvalContext {
  payload: Record<string, unknown>;
  /** The values before the change, when the event carries them. */
  previous?: Record<string, unknown> | undefined;
}

export function evaluateCondition(condition: Condition, ctx: EvalContext): boolean {
  const actual = readPath(ctx.payload, condition.path);

  switch (condition.op) {
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;

    case "eq": return actual === condition.value;
    case "ne": return actual !== condition.value;

    case "gt": case "gte": case "lt": case "lte": {
      const left = asNumber(actual);
      const right = asNumber(condition.value);
      // An incomparable pair is false rather than an error. A workflow that
      // throws on one odd record stops running for every record.
      if (left === null || right === null) return false;
      return condition.op === "gt" ? left > right
        : condition.op === "gte" ? left >= right
        : condition.op === "lt" ? left < right
        : left <= right;
    }

    case "in": return Array.isArray(condition.value) && condition.value.includes(actual);
    case "not_in": return Array.isArray(condition.value) && !condition.value.includes(actual);

    case "contains":
      if (Array.isArray(actual)) return actual.includes(condition.value);
      if (typeof actual === "string" && typeof condition.value === "string") {
        return actual.toLowerCase().includes(condition.value.toLowerCase());
      }
      return false;

    /**
     * Did this field change at all. Needs the previous values, and is false
     * without them rather than true: "changed" with nothing to compare
     * against would fire on every event, which is the opposite of the intent.
     */
    case "changed": {
      if (!ctx.previous) return false;
      return readPath(ctx.previous, condition.path) !== actual;
    }

    /**
     * Changed INTO a particular value. The one that makes "when a job becomes
     * completed" mean the transition rather than the state, so a workflow
     * does not re-fire on every later edit of an already completed job.
     */
    case "changed_to": {
      if (!ctx.previous) return false;
      const before = readPath(ctx.previous, condition.path);
      return before !== condition.value && actual === condition.value;
    }

    default:
      // An operator this file does not know is false, never true. A condition
      // that cannot be evaluated must not be treated as satisfied.
      return false;
  }
}

export function evaluateGroup(group: ConditionGroup, ctx: EvalContext): boolean {
  const all = group.all ?? [];
  const any = group.any ?? [];
  const none = group.none ?? [];

  if (!all.every((c) => evaluateCondition(c, ctx))) return false;
  // An empty `any` is not a failed match. It means the author did not ask.
  if (any.length > 0 && !any.some((c) => evaluateCondition(c, ctx))) return false;
  if (none.some((c) => evaluateCondition(c, ctx))) return false;
  return true;
}

/* ------------------------------------------------------------- triggering */

export const MAX_CAUSATION_DEPTH = 5;

export interface TriggerEvent {
  name: string;
  payload: Record<string, unknown>;
  previous?: Record<string, unknown> | undefined;
  causationDepth: number;
  /** The run that produced this event, if a workflow did. */
  causedByRunId?: string | undefined;
}

export interface WorkflowSpec {
  id: string;
  versionId: string;
  enabled: boolean;
  triggerEvents: readonly string[];
  conditions: ConditionGroup;
}

export type TriggerDecision =
  | { run: true }
  | { run: false; reason: "disabled" | "event_not_subscribed" | "conditions_unmet" | "depth_exceeded" | "self_triggered" };

/**
 * Whether an event should start this workflow.
 *
 * The two interesting refusals are the loop guards. A workflow that edits a
 * job produces an event that can trigger the same workflow, and without a
 * guard the only symptom is a tenant sending ten thousand texts overnight.
 *
 * `self_triggered` stops the direct loop: a workflow never responds to its
 * own output. `depth_exceeded` stops the indirect one, where A triggers B
 * triggers A, which no single-workflow check can see.
 */
export function shouldTrigger(
  workflow: WorkflowSpec,
  event: TriggerEvent,
  runsOfThisWorkflow: readonly string[] = [],
): TriggerDecision {
  if (!workflow.enabled) return { run: false, reason: "disabled" };
  if (!workflow.triggerEvents.includes(event.name)) {
    return { run: false, reason: "event_not_subscribed" };
  }
  if (event.causedByRunId && runsOfThisWorkflow.includes(event.causedByRunId)) {
    return { run: false, reason: "self_triggered" };
  }
  if (event.causationDepth >= MAX_CAUSATION_DEPTH) {
    return { run: false, reason: "depth_exceeded" };
  }
  if (!evaluateGroup(workflow.conditions, { payload: event.payload, previous: event.previous })) {
    return { run: false, reason: "conditions_unmet" };
  }
  return { run: true };
}

/**
 * The key that makes a run happen once.
 *
 * Derived from the version and the event rather than generated, so a worker
 * that crashes after starting and retries lands on the same key and the
 * unique index refuses the second insert. Generating a key would make every
 * retry a new run, which for a workflow that sends a text means the customer
 * gets it twice.
 *
 * The VERSION is in the key, not the workflow, so publishing a new version
 * legitimately re-runs against an event the old version already handled.
 */
export const runKey = (versionId: string, eventId: string): string =>
  `${versionId}:${eventId}`;

/* -------------------------------------------------------------- authority */

export type PublishRefusal =
  | { ok: false; reason: "missing_permission"; permissions: Permission[] }
  | { ok: false; reason: "unknown_step"; kinds: string[] };

export type PublishDecision = { ok: true; required: Permission[] } | PublishRefusal;

/**
 * What each kind of step needs in order to act.
 *
 * A workflow acts, so it runs with somebody's authority, and authoring one is
 * therefore a way to acquire authority. Same shape as `role:write`: a
 * container that runs as an actor is a way to become that actor.
 *
 * The obvious implementation is to run workflows as the owner. That hands
 * every author the owner's powers, so instead a version declares what it
 * needs, the author must hold all of it, and the run gets exactly that set.
 */
export const STEP_PERMISSIONS: Record<string, Permission[]> = {
  send_message: ["message:send"],
  send_estimate: ["estimate:send"],
  send_invoice: ["invoice:send"],
  create_job: ["job:write"],
  update_job: ["job:write"],
  schedule_visit: ["visit:write"],
  assign_visit: ["visit:dispatch"],
  record_payment: ["payment:collect"],
  issue_portal_link: ["portal:grant"],
  add_note: ["job:write"],
  call_webhook: ["settings:write"],
  wait: [],
  branch: [],
};

/**
 * Whether this author may publish this definition.
 *
 * Deliberately not a check on `workflow:write`, which answers whether they
 * may touch workflows at all. This answers whether the thing they wrote is
 * inside what they already hold, which is the part that stops the escalation.
 */
export function canPublish(
  held: ReadonlySet<Permission>,
  steps: readonly { kind: string }[],
): PublishDecision {
  const unknown = [...new Set(steps.map((s) => s.kind))].filter((k) => !(k in STEP_PERMISSIONS));
  if (unknown.length > 0) {
    // A step this build does not know is refused rather than skipped. Skipping
    // would let a definition written against a newer version run here with
    // the steps it could not perform quietly dropped.
    return { ok: false, reason: "unknown_step", kinds: unknown };
  }

  const required = [...new Set(steps.flatMap((s) => STEP_PERMISSIONS[s.kind] ?? []))];
  const missing = required.filter((p) => !held.has(p));
  if (missing.length > 0) {
    return { ok: false, reason: "missing_permission", permissions: missing };
  }
  return { ok: true, required };
}
