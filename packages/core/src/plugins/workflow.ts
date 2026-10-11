import type { Permission } from "../access/permissions.js";

/**
 * A JOB WORKFLOW AN APPLICATION REGISTERED, CHECKED WITHOUT THE DATABASE
 *
 * A connected application can say how one job type moves: a named list of
 * stages in order ("Survey", "Permit", "Install", "Inspection"), which of
 * the job's statuses belongs to each, and what has to be true before a job
 * may leave a stage (a checklist item ticked on a visit, one of the
 * company's own fields filled in on the job).
 *
 * IT IS DATA, NEVER CODE. A plugin here is a shape the application posts,
 * held to the closed vocabulary below and refused in words when it does not
 * fit. Nothing an application sends is run: a gate names a checklist item or
 * a field by its key, and this file decides whether it holds.
 *
 * THE STATUSES STAY THE PRODUCT'S. A stage is a name over statuses the
 * product already has, not a status of its own, so every report, the board,
 * the ledger and the lifecycle rules in `services/jobs.ts` keep working on
 * the nine statuses they know. A workflow that invented statuses would be a
 * second lifecycle nothing else could read.
 */

/** The nine statuses a job can have, in the order the product walks them. */
export const JOB_STATUSES = [
  "lead", "estimating", "scheduled", "in_progress", "on_hold",
  "completed", "invoiced", "paid", "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A plugin's key, chosen by the application: lowercase, starting with a letter. */
export const KEY = /^[a-z][a-z0-9_]{0,47}$/;

/** A stage's key, the same shape. */
const STAGE_KEY = KEY;

export const MAX_STAGES = 12;
export const MAX_GATES = 10;

/**
 * WHAT HAS TO HOLD BEFORE A JOB LEAVES A STAGE. Closed, because each one is
 * a question this product can answer from rows it already keeps:
 *
 *   `checklist`  an item of the job type's own checklist is ticked on at
 *                least one of the job's visits that was not cancelled.
 *   `field`      one of the company's own fields on the job holds a value.
 */
export type Gate =
  | { kind: "checklist"; itemId: string }
  | { kind: "field"; key: string };

export interface Stage {
  key: string;
  name: string;
  statuses: JobStatus[];
  /** Every one has to hold before a job may move to a later stage. */
  gates: Gate[];
}

export interface JobWorkflow {
  stages: Stage[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/**
 * What reading a gate needs. A checklist is ticked on a visit and a field is
 * written on the job, so an application may only gate on what it could read
 * itself: registering a gate is asking the product to read it on every move.
 */
export const GATE_READS: Record<Gate["kind"], Permission[]> = {
  checklist: ["visit:read"],
  field: ["job:read"],
};

/** Every permission a workflow reads, so registration can hold the application to them. */
export function workflowReads(workflow: JobWorkflow): Permission[] {
  const reads = new Set<Permission>(["job:read"]);
  for (const stage of workflow.stages) {
    for (const gate of stage.gates) for (const p of GATE_READS[gate.kind]) reads.add(p);
  }
  return [...reads].sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Check a workflow the way core checks everything an author writes: every
 * problem at once, each a sentence, so an application learns all of what
 * is wrong from one refusal rather than one at a time.
 *
 * `known` is what the company has today: the item ids on this job type's
 * checklist and the keys of the fields defined on jobs. A gate naming
 * anything else is refused, because a gate that can never be met holds
 * every job in its stage forever, and one that names nothing holds nobody
 * and looks as if it does.
 */
export function checkJobWorkflow(
  input: unknown,
  known: { checklistItemIds: readonly string[]; fieldKeys: readonly string[] },
): Checked<JobWorkflow> {
  const problems: string[] = [];
  if (!isRecord(input) || !Array.isArray(input["stages"])) {
    return { ok: false, problems: ["A workflow is a list of stages."] };
  }
  const raw = input["stages"] as unknown[];
  if (raw.length < 2) problems.push("A workflow needs at least two stages.");
  if (raw.length > MAX_STAGES) problems.push(`A workflow has at most ${MAX_STAGES} stages.`);

  const items = new Set(known.checklistItemIds);
  const fields = new Set(known.fieldKeys);
  const seenKeys = new Set<string>();
  const seenStatuses = new Map<string, string>();
  const stages: Stage[] = [];

  raw.forEach((entry, index) => {
    const n = index + 1;
    if (!isRecord(entry)) { problems.push(`Stage ${n} is not a stage.`); return; }
    const key = typeof entry["key"] === "string" ? entry["key"] : "";
    const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
    if (!STAGE_KEY.test(key)) problems.push(`Stage ${n} needs a key of lowercase letters, digits and underscores.`);
    else if (seenKeys.has(key)) problems.push(`Two stages have the key "${key}".`);
    seenKeys.add(key);
    if (name.length === 0 || name.length > 60) problems.push(`Stage ${n} needs a name of 1 to 60 characters.`);
    const label = name || `Stage ${n}`;

    const statuses: JobStatus[] = [];
    const rawStatuses = Array.isArray(entry["statuses"]) ? entry["statuses"] as unknown[] : [];
    if (rawStatuses.length === 0) problems.push(`"${label}" covers no job status.`);
    for (const status of rawStatuses) {
      if (typeof status !== "string" || !(JOB_STATUSES as readonly string[]).includes(status)) {
        problems.push(`"${label}" names "${String(status)}", which is not a job status.`);
        continue;
      }
      const other = seenStatuses.get(status);
      if (other !== undefined) problems.push(`The status "${status}" is in both "${other}" and "${label}".`);
      seenStatuses.set(status, label);
      statuses.push(status as JobStatus);
    }

    const gates: Gate[] = [];
    const rawGates = entry["gates"] === undefined ? [] : entry["gates"];
    if (!Array.isArray(rawGates)) {
      problems.push(`"${label}" has gates that are not a list.`);
    } else {
      if (rawGates.length > MAX_GATES) problems.push(`"${label}" has more than ${MAX_GATES} gates.`);
      for (const gate of rawGates as unknown[]) {
        if (!isRecord(gate)) { problems.push(`"${label}" has a gate that is not a gate.`); continue; }
        if (gate["kind"] === "checklist") {
          const itemId = typeof gate["itemId"] === "string" ? gate["itemId"] : "";
          if (!items.has(itemId)) {
            problems.push(`"${label}" waits on checklist item "${itemId}", which is not on this job type's checklist.`);
          } else gates.push({ kind: "checklist", itemId });
        } else if (gate["kind"] === "field") {
          const fieldKey = typeof gate["key"] === "string" ? gate["key"] : "";
          if (!fields.has(fieldKey)) {
            problems.push(`"${label}" waits on the field "${fieldKey}", which the company has not defined on jobs.`);
          } else gates.push({ kind: "field", key: fieldKey });
        } else {
          problems.push(`"${label}" has a gate of kind "${String(gate["kind"])}". A gate is "checklist" or "field".`);
        }
      }
    }
    stages.push({ key, name, statuses, gates });
  });

  /**
   * EVERY STATUS IS IN EXACTLY ONE STAGE. A status left out is a job with no
   * stage on the board, which reads as a job nobody is looking after.
   */
  const missing = JOB_STATUSES.filter((status) => !seenStatuses.has(status));
  if (missing.length > 0) problems.push(`Every job status needs a stage. Not placed: ${missing.join(", ")}.`);

  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { stages } };
}

/** The stage a status belongs to, with its place in the order. */
export function stageOf(workflow: JobWorkflow, status: string): { index: number; stage: Stage } | null {
  const index = workflow.stages.findIndex((stage) => (stage.statuses as string[]).includes(status));
  return index < 0 ? null : { index, stage: workflow.stages[index]! };
}

/**
 * THE GATES A MOVE HAS TO PASS.
 *
 * Moving forward, from one stage to a later one, passes the gates of the
 * stage it leaves and of every stage it skips: a job does not get past
 * "Permit" by going straight from "Survey" to "Install". Staying inside a
 * stage passes nothing, and so does going back to an earlier one, because
 * reopening work is never the thing a gate is there to stop.
 *
 * CANCELLING IS NEVER HELD. A customer calling the work off is a fact about
 * the world rather than a step in the work, and a gate that refused it would
 * leave a job on the board that nobody is going to do.
 */
export function gatesToPass(workflow: JobWorkflow, from: string, to: string): Array<{ stage: Stage; gate: Gate }> {
  if (to === "cancelled") return [];
  const a = stageOf(workflow, from);
  const b = stageOf(workflow, to);
  if (!a || !b || b.index <= a.index) return [];
  return workflow.stages.slice(a.index, b.index).flatMap((stage) => stage.gates.map((gate) => ({ stage, gate })));
}

/** What is known about one job when a move is asked for. */
export interface GateFacts {
  /** Checklist item ids ticked on any of the job's visits that was not cancelled. */
  done: ReadonlySet<string>;
  /** Keys of the job's own fields that hold a value. */
  filled: ReadonlySet<string>;
  /** The words for each, so a refusal names what a person sees. */
  checklistLabel: (itemId: string) => string;
  fieldLabel: (key: string) => string;
}

export function gateMet(gate: Gate, facts: GateFacts): boolean {
  return gate.kind === "checklist" ? facts.done.has(gate.itemId) : facts.filled.has(gate.key);
}

/** One gate, in the words of the person who has to meet it. */
export function gateWords(gate: Gate, facts: Pick<GateFacts, "checklistLabel" | "fieldLabel">): string {
  return gate.kind === "checklist"
    ? `tick "${facts.checklistLabel(gate.itemId)}" on a visit`
    : `fill in "${facts.fieldLabel(gate.key)}" on the job`;
}

/**
 * Whether a field's stored value counts as filled in. An empty string, an
 * empty list and null are the same as nothing: a required permit number
 * saved as "" has not been given.
 */
export function holdsValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The refusal for a move, or null when it may go ahead. One sentence per
 * stage it cannot leave, naming every gate not met, so the person reading
 * it knows the whole of what is left rather than the first thing.
 */
export function moveRefusal(workflow: JobWorkflow, from: string, to: string, facts: GateFacts): string | null {
  const unmet = gatesToPass(workflow, from, to).filter(({ gate }) => !gateMet(gate, facts));
  if (unmet.length === 0) return null;
  const byStage = new Map<string, string[]>();
  for (const { stage, gate } of unmet) {
    byStage.set(stage.name, [...(byStage.get(stage.name) ?? []), gateWords(gate, facts)]);
  }
  return [...byStage.entries()]
    .map(([stage, words]) => `This job cannot leave "${stage}" yet: ${joinWords(words)}.`)
    .join(" ");
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
