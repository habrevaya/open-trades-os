import type { Permission } from "../access/permissions.js";
export * from "./schedule.js";

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
  /**
   * The step that turns an event into something a person actually sees.
   * Relying on somebody to notice an estimate went unanswered for five days
   * is relying on a report nobody runs.
   */
  create_task: ["task:write"],
  call_webhook: ["settings:write"],
  /**
   * Run a report and email it. The report itself is run as whoever published
   * the version, re-checked against what they hold on the day it runs, so the
   * two permissions here are only the step's own: may it read reports at all,
   * and may it put an email in the outbox. A run that could email a report its
   * publisher can no longer see would be a way to keep access after losing it.
   */
  email_report: ["report:read", "message:send"],
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

/* ------------------------------------------------------------------ branching */

/**
 * BRANCHING, AS A FLAT LIST RATHER THAN A TREE
 *
 * `branch` has been in `STEP_PERMISSIONS` since that table was written, with no
 * executor behind it and no shape anybody could author. What a contractor wants
 * from it is ordinary: if the invoice is over a thousand dollars ring them,
 * otherwise send the text.
 *
 * The obvious model is a tree: a branch holding two lists of steps. It is wrong
 * HERE, and not because a tree is hard. The runner records one row per step with
 * an integer index, parks a waiting run on `resume_step_index`, and resumes by
 * reading which indices already succeeded. Every one of those is an integer, so a
 * tree means a path, which means a new resume model, a new unique index on the
 * step run table and a migration, to express something the flat form expresses
 * exactly.
 *
 * So a branch COUNTS the steps that follow it. `thenCount` of them belong to the
 * arm that runs when the condition holds, the next `elseCount` to the arm that
 * runs when it does not, and the other arm is written down as skipped. The step
 * list stays flat, the indices stay integers, resume keeps working, and the run
 * reads as a list on the screen that answers "why did this customer get that
 * text", which is the screen that matters.
 *
 * NESTING FALLS OUT OF IT rather than being a second feature. A branch inside an
 * arm is a branch whose own counts sit inside the enclosing count, and
 * `checkBranches` below is a bracket match: every arm has to close inside the arm
 * that contains it. That is the same check a parser does for parentheses, and it
 * is the whole of what makes the flat form unambiguous.
 *
 * WHAT A FLAT LIST CANNOT DO, said here rather than discovered: an arm cannot
 * jump backwards, so there are no loops. That is deliberate and it is the second
 * loop guard: a workflow that can jump back is a workflow that can send ten
 * thousand texts overnight, and the two guards upstream only catch a workflow
 * re-triggering itself, not one looping inside a single run.
 */
export interface BranchShape {
  conditions: ConditionGroup;
  /** Steps immediately after the branch that run when the condition holds. */
  thenCount: number;
  /** Steps after those that run when it does not. Zero means no otherwise arm. */
  elseCount: number;
}

export type BranchProblem =
  | { reason: "not_a_branch" }
  | { reason: "no_arms" }
  | { reason: "negative_arm" }
  | { reason: "runs_past_the_end"; needs: number; has: number };

/**
 * Read a stored config into a shape, or say what is wrong with it.
 *
 * A config is jsonb written by an older build or by a caller, so nothing about it
 * is guaranteed. `undefined` counts as zero for an arm, because an author who set
 * only `thenCount` meant "and nothing otherwise", and refusing that would make the
 * common case the verbose one.
 */
export function readBranch(
  config: Record<string, unknown> | undefined,
  /** How many steps follow this one. Used to refuse an arm that runs off the end. */
  following?: number,
): { ok: true; shape: BranchShape } | { ok: false; problem: BranchProblem } {
  const raw = config ?? {};
  const thenCount = raw["thenCount"] === undefined ? 0 : Number(raw["thenCount"]);
  const elseCount = raw["elseCount"] === undefined ? 0 : Number(raw["elseCount"]);

  if (!Number.isInteger(thenCount) || !Number.isInteger(elseCount)) {
    return { ok: false, problem: { reason: "not_a_branch" } };
  }
  if (thenCount < 0 || elseCount < 0) {
    return { ok: false, problem: { reason: "negative_arm" } };
  }
  /**
   * A branch with no arms at all decides nothing: both outcomes run the same
   * steps, which are whatever happens to come next. That is not a branch, it is a
   * condition somebody wrote and then did not use, and it is worth refusing at the
   * save because at run time it is invisible.
   */
  if (thenCount === 0 && elseCount === 0) {
    return { ok: false, problem: { reason: "no_arms" } };
  }
  if (following !== undefined && thenCount + elseCount > following) {
    return {
      ok: false,
      problem: { reason: "runs_past_the_end", needs: thenCount + elseCount, has: following },
    };
  }

  const conditions = (raw["conditions"] ?? {}) as ConditionGroup;
  return { ok: true, shape: { conditions, thenCount, elseCount } };
}

export interface BranchDecision {
  /** Which arm ran. `otherwise` even when that arm is empty, so the log says so. */
  taken: "then" | "otherwise";
  /** Offsets from the branch step, of the steps that are NOT to run. */
  skipOffsets: number[];
}

/**
 * Which arm, and what to write off.
 *
 * Offsets rather than absolute indices, so this stays a pure function of the
 * shape: the caller knows where the branch sits and this does not need to.
 */
export function decideBranch(shape: BranchShape, ctx: EvalContext): BranchDecision {
  const held = evaluateGroup(shape.conditions, ctx);
  const offsets: number[] = [];

  if (held) {
    // The otherwise arm sits after the then arm.
    for (let i = 0; i < shape.elseCount; i += 1) offsets.push(1 + shape.thenCount + i);
    return { taken: "then", skipOffsets: offsets };
  }
  for (let i = 0; i < shape.thenCount; i += 1) offsets.push(1 + i);
  return { taken: "otherwise", skipOffsets: offsets };
}

export type BranchListProblem =
  | { at: number; problem: BranchProblem }
  /**
   * An arm that ends outside the arm containing it.
   *
   * The flat form is only unambiguous while the arms bracket properly. A branch at
   * index 2 whose then arm covers 3 to 6, holding a branch at 4 whose arms cover 5
   * to 8, describes two overlapping regions and there is no reading of it that both
   * authors would agree with.
   */
  | { at: number; problem: { reason: "crosses_an_arm"; endsAt: number; armEndsAt: number } };

/**
 * Every branch in a step list, bracket matched.
 *
 * Called at publish rather than at run time, which is the only moment anybody can
 * fix it: a workflow whose arms overlap saves, enables, and then does something
 * no reading of the definition predicts.
 */
export function checkBranches(
  steps: readonly { kind: string; config?: Record<string, unknown> | undefined }[],
): BranchListProblem[] {
  const problems: BranchListProblem[] = [];
  /** The last index of each arm still open, innermost last. */
  const open: number[] = [];

  for (const [index, step] of steps.entries()) {
    while (open.length > 0 && open[open.length - 1]! < index) open.pop();

    if (step.kind !== "branch") continue;

    const read = readBranch(step.config, steps.length - index - 1);
    if (!read.ok) {
      problems.push({ at: index, problem: read.problem });
      continue;
    }

    const endsAt = index + read.shape.thenCount + read.shape.elseCount;
    const enclosing = open[open.length - 1];
    if (enclosing !== undefined && endsAt > enclosing) {
      problems.push({
        at: index,
        problem: { reason: "crosses_an_arm", endsAt, armEndsAt: enclosing },
      });
      continue;
    }
    open.push(endsAt);
  }

  return problems;
}

/** A branch problem as a sentence somebody can act on. */
export function explainBranch(problem: BranchListProblem): string {
  const at = `Step ${problem.at + 1}`;
  switch (problem.problem.reason) {
    case "not_a_branch":
      return `${at} is a branch with arm sizes that are not whole numbers.`;
    case "negative_arm":
      return `${at} is a branch with a negative arm.`;
    case "no_arms":
      return `${at} is a branch with nothing in either arm, so both answers do the same thing.`;
    case "runs_past_the_end":
      return `${at} is a branch covering ${problem.problem.needs} steps and only `
        + `${problem.problem.has} follow it.`;
    case "crosses_an_arm":
      return `${at} is a branch that ends at step ${problem.problem.endsAt + 1}, outside the `
        + `branch it sits in, which ends at step ${problem.problem.armEndsAt + 1}.`;
  }
}

/* ------------------------------------------------------- the shape on a canvas */

/**
 * A STEP AS A PERSON DRAWS IT, WHICH IS A TREE
 *
 * The engine runs a flat list with counts, for the reasons above. Nobody authors
 * one: "if the invoice is over a thousand, ring them, otherwise text them" is two
 * nested lanes on a screen, and asking somebody to write `thenCount: 2` is asking
 * them to do the compiler's job.
 *
 * So the canvas holds a tree and this is the pair of functions between them. Both
 * are here rather than in the screen because the SERVER has to do the same
 * translation when it parses what the form posted, and two implementations of a
 * translation disagree eventually: the one that would be wrong is the server's,
 * which is the one that decides what actually runs.
 *
 * `nest` is the inverse, so opening an existing automation rebuilds the lanes
 * somebody drew. A round trip is asserted in the tests, which is the only way to
 * be sure a definition saved today opens tomorrow as the same picture.
 */
export interface PlanNode {
  kind: string;
  config?: Record<string, unknown> | undefined;
  /** Present only on a branch. The steps that run when the condition holds. */
  then?: PlanNode[] | undefined;
  /** Present only on a branch. The steps that run when it does not. */
  otherwise?: PlanNode[] | undefined;
}

export interface FlatStep {
  kind: string;
  config?: Record<string, unknown> | undefined;
}

/** How many steps a subtree occupies in the flat list, including itself. */
function spanOf(nodes: readonly PlanNode[]): number {
  let span = 0;
  for (const node of nodes) {
    span += 1;
    if (node.kind === "branch") span += spanOf(node.then ?? []) + spanOf(node.otherwise ?? []);
  }
  return span;
}

/**
 * The tree as the list the engine runs.
 *
 * Pre-order, with each branch's counts computed from the spans of its arms, which
 * is the one piece of arithmetic nobody should be asked to do by hand. The arms
 * are emitted in the order the counts describe: the then arm first, then the
 * otherwise arm, which is what `decideBranch` assumes.
 */
export function flattenPlan(nodes: readonly PlanNode[]): FlatStep[] {
  const out: FlatStep[] = [];
  for (const node of nodes) {
    if (node.kind !== "branch") {
      out.push({ kind: node.kind, ...(node.config ? { config: node.config } : {}) });
      continue;
    }
    const then = node.then ?? [];
    const otherwise = node.otherwise ?? [];
    out.push({
      kind: "branch",
      config: {
        ...(node.config ?? {}),
        thenCount: spanOf(then),
        elseCount: spanOf(otherwise),
      },
    });
    out.push(...flattenPlan(then), ...flattenPlan(otherwise));
  }
  return out;
}

/**
 * The list as the tree somebody drew.
 *
 * Reads the counts and takes that many steps for each arm, recursively. A list
 * whose counts do not add up is not repaired: it comes back with the branch's arms
 * empty and the steps that followed as siblings, which is the honest reading of a
 * definition `checkBranches` would have refused, and it means opening a broken
 * workflow shows something rather than throwing.
 */
export function nestSteps(steps: readonly FlatStep[]): PlanNode[] {
  const [nodes] = takeNodes(steps, 0, steps.length);
  return nodes;
}

function takeNodes(
  steps: readonly FlatStep[],
  from: number,
  count: number,
): [PlanNode[], number] {
  const out: PlanNode[] = [];
  let at = from;
  const end = Math.min(from + count, steps.length);

  while (at < end) {
    const step = steps[at]!;
    if (step.kind !== "branch") {
      out.push({ kind: step.kind, ...(step.config ? { config: step.config } : {}) });
      at += 1;
      continue;
    }

    const read = readBranch(step.config, steps.length - at - 1);
    const { thenCount, elseCount } = read.ok
      ? read.shape
      : { thenCount: 0, elseCount: 0 };
    const { thenCount: _t, elseCount: _e, ...rest } = (step.config ?? {}) as Record<string, unknown>;

    const [then, afterThen] = takeNodes(steps, at + 1, thenCount);
    const [otherwise, afterElse] = takeNodes(steps, afterThen, elseCount);
    out.push({
      kind: "branch",
      ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
      then,
      otherwise,
    });
    at = afterElse;
  }

  return [out, at];
}
