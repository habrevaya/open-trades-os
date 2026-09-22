/**
 * OFFLINE FIELD OPERATIONS
 *
 * A technician spends the day in basements, crawl spaces, mechanical rooms and
 * the middle of a county with one bar. The phone is offline for most of it and
 * the work still has to be recorded. This module is the part of that which can
 * be reasoned about without a database.
 *
 * THE ONE DECISION EVERYTHING ELSE FOLLOWS
 *
 * A write from the field is a named INTENT, not a row diff.
 *
 *   { kind: "visit.arrive", visitId, occurredAt, latitude, longitude }
 *
 * rather than
 *
 *   { table: "visit", id, set: { arrivedAt, status: "in_progress" } }
 *
 * The two look equivalent when nothing else has changed. They are not
 * equivalent when something has. If a dispatcher cancelled that visit while
 * the technician was under a house, the row diff overwrites the cancellation
 * and the visit quietly comes back to life. The intent can say the true thing:
 * somebody did arrive, the visit was cancelled, and a human needs to know
 * both. A row diff has thrown away the information needed to notice.
 *
 * This is why "last write wins" is the wrong default here and why the conflict
 * rule is per kind rather than global. Some of these operations are facts that
 * happened and must always be recorded. Some are edits that can lose.
 */

/** Every operation the field app can send. Closed on purpose: a new kind is a
 *  schema decision and a conflict decision, not something a client invents. */
export const OPERATION_KINDS = [
  // Visit lifecycle. Facts about what a person did and when.
  "visit.en_route",
  "visit.arrive",
  "visit.start",
  "visit.complete",
  "visit.pause",
  "visit.note",
  // Timeclock. Append only, and the classification is captured at the punch.
  "timeclock.punch_in",
  "timeclock.punch_out",
  // What was done and what it needs.
  "service_report.set_field",
  "service_report.submit",
  "visit.checklist_item",
  "visit.add_line",
  "equipment.record",
  // Attachments. The blob syncs separately; this is the record that it exists.
  "attachment.attach",
  "signature.capture",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * How an operation behaves when the world moved while it was queued.
 *
 *   fact        It happened. Record it whatever the current state is, and
 *               raise a conflict if the current state disagrees. Arriving at a
 *               visit somebody cancelled is still an arrival.
 *
 *   append      It adds a row. Nothing can conflict with it, so it always
 *               applies. A part used, a photo taken, a note written.
 *
 *   edit        It sets a value. The most recent one by occurrence time wins
 *               and the others are superseded, which is correct for a form
 *               field somebody typed into twice.
 *
 *   transition  It moves state and only makes sense from certain states. If
 *               the state moved underneath it, it is rejected and returned to
 *               the device rather than forced.
 */
export type ConflictRule = "fact" | "append" | "edit" | "transition";

export const CONFLICT_RULES: Record<OperationKind, ConflictRule> = {
  // Every one of these is something a person did at a time. None of them can
  // be undone by the office having changed its mind in the meantime.
  "visit.en_route": "fact",
  "visit.arrive": "fact",
  "visit.start": "fact",
  "visit.complete": "fact",
  "visit.pause": "fact",
  "visit.note": "append",

  // A punch is a payroll record. It is never dropped, never overwritten, and
  // never reordered: somebody is paid from these.
  "timeclock.punch_in": "fact",
  "timeclock.punch_out": "fact",

  // A form field typed into twice should keep the second value.
  "service_report.set_field": "edit",
  "service_report.submit": "transition",
  "visit.checklist_item": "edit",

  "visit.add_line": "append",
  "equipment.record": "append",
  "attachment.attach": "append",
  "signature.capture": "append",
};

export interface FieldOperation {
  /**
   * Generated on the device. This is the idempotency key, and it is the
   * client's job to keep it stable across retries: a phone that regenerates it
   * on every attempt will clock the technician in four times from one tap.
   */
  clientId: string;
  deviceId: string;
  kind: OperationKind;
  /**
   * Monotonic per device. Not global: two technicians working offline have no
   * shared clock and no shared order, and pretending otherwise invents one.
   */
  sequence: number;
  /** The device's clock at the moment it happened. See `resolveOccurredAt`. */
  occurredAt: Date;
  subjectId: string;
  payload: Record<string, unknown>;
}

export class OperationError extends Error {
  constructor(message: string, public readonly clientId: string) {
    super(message);
    this.name = "OperationError";
  }
}

/**
 * The device clock is recorded, and it is not trusted.
 *
 * A phone that has been offline since breakfast may have drifted, may have had
 * its timezone changed crossing a state line, or may have been set by hand by
 * somebody who wanted an earlier punch. Two rules, both cheap:
 *
 * An occurrence in the future did not happen. Clamp it to the moment the
 * server heard about it, because the alternative is a timesheet that bills
 * tomorrow.
 *
 * An occurrence before the device's previous operation did not happen either,
 * because the device numbers its own operations and cannot have run backwards.
 * Clamp it forward to the previous one.
 *
 * Both return the original alongside the resolved value. A clamp is evidence
 * of something and throwing it away is what makes a payroll dispute
 * unanswerable.
 */
export function resolveOccurredAt(input: {
  claimed: Date;
  receivedAt: Date;
  previousOccurredAt?: Date | undefined;
  /** Tolerance for ordinary clock drift, rather than treating a second as fraud. */
  toleranceMs?: number;
}): { occurredAt: Date; claimed: Date; clamped: null | "future" | "reordered" } {
  const tolerance = input.toleranceMs ?? 60_000;

  if (input.claimed.getTime() > input.receivedAt.getTime() + tolerance) {
    return { occurredAt: input.receivedAt, claimed: input.claimed, clamped: "future" };
  }

  if (
    input.previousOccurredAt &&
    input.claimed.getTime() < input.previousOccurredAt.getTime()
  ) {
    return {
      occurredAt: input.previousOccurredAt,
      claimed: input.claimed,
      clamped: "reordered",
    };
  }

  return { occurredAt: input.claimed, claimed: input.claimed, clamped: null };
}

/**
 * Order a batch for application.
 *
 * Per device by sequence, because that is the only order the device actually
 * asserted. Across devices by occurrence time, with the device id as the tie
 * break so the result is deterministic rather than dependent on which phone
 * reconnected first.
 *
 * Determinism matters more than being right about simultaneity. Two operations
 * at the same instant from two devices have no true order, and any stable
 * answer is better than one that changes between a retry and the original.
 */
export function orderOperations(ops: FieldOperation[]): FieldOperation[] {
  return [...ops].sort((a, b) => {
    if (a.deviceId === b.deviceId) return a.sequence - b.sequence;
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
  });
}

/**
 * A gap in a device's sequence means operations are missing.
 *
 * The device numbers its own operations from one and never skips. A batch
 * arriving with 4, 5, 7 is a batch where 6 exists somewhere and did not make
 * it, and applying 7 anyway can produce a punch out with no punch in.
 *
 * Returns the sequences that should be there and are not, so the server can
 * hold the tail rather than reject the batch: 4 and 5 are still perfectly
 * applicable.
 */
export function findSequenceGaps(
  ops: FieldOperation[],
  lastAppliedSequence: Record<string, number>,
): { deviceId: string; missing: number[] }[] {
  const byDevice = new Map<string, number[]>();
  for (const op of ops) {
    byDevice.set(op.deviceId, [...(byDevice.get(op.deviceId) ?? []), op.sequence]);
  }

  const gaps: { deviceId: string; missing: number[] }[] = [];
  for (const [deviceId, sequences] of byDevice) {
    const sorted = [...sequences].sort((a, b) => a - b);
    const from = (lastAppliedSequence[deviceId] ?? 0) + 1;
    const missing: number[] = [];

    for (let n = from; n < (sorted[sorted.length - 1] ?? from); n++) {
      if (!sorted.includes(n)) missing.push(n);
    }
    if (missing.length > 0) gaps.push({ deviceId, missing });
  }
  return gaps;
}

/**
 * The prefix of a device's operations that can be applied now.
 *
 * Everything up to the first gap. The tail is held rather than dropped,
 * because the missing operation usually arrives on the next attempt and
 * rejecting the whole batch makes a bad connection worse.
 */
export function applicablePrefix(
  ops: FieldOperation[],
  lastAppliedSequence: Record<string, number>,
): { applicable: FieldOperation[]; held: FieldOperation[] } {
  const ordered = orderOperations(ops);
  const nextExpected = new Map<string, number>();
  const blocked = new Set<string>();

  const applicable: FieldOperation[] = [];
  const held: FieldOperation[] = [];

  for (const op of ordered) {
    if (blocked.has(op.deviceId)) {
      held.push(op);
      continue;
    }

    const expected = nextExpected.get(op.deviceId) ?? (lastAppliedSequence[op.deviceId] ?? 0) + 1;

    if (op.sequence < expected) {
      // Already applied. A replay, which is normal on a flaky connection: the
      // device did not hear the acknowledgement and sent it again.
      applicable.push(op);
      continue;
    }

    if (op.sequence > expected) {
      blocked.add(op.deviceId);
      held.push(op);
      continue;
    }

    applicable.push(op);
    nextExpected.set(op.deviceId, op.sequence + 1);
  }

  return { applicable, held };
}

/**
 * Every state a visit can be in.
 *
 * Declared here rather than imported, because this package deliberately does
 * not depend on the database, and asserted against the real pgEnum by an
 * integration test so the two cannot drift. Getting this list wrong is not a
 * type error: the transition table below would simply never match, and every
 * operation would take the "no current state" path and apply unconditionally.
 */
export const VISIT_STATES = [
  "unassigned", "scheduled", "dispatched", "en_route",
  "working", "completed", "cancelled", "no_show",
  "completed_after_cancellation",
] as const;

export type VisitState = (typeof VISIT_STATES)[number];

/**
 * The visit states each operation can legally come from.
 *
 * Only `transition` operations refuse when the state is not in the list. A
 * `fact` is recorded and flagged instead, because arriving at a visit somebody
 * cancelled is still an arrival.
 */
export const VISIT_TRANSITIONS: Record<string, readonly VisitState[]> = {
  "visit.en_route": ["scheduled", "dispatched"],
  "visit.arrive": ["scheduled", "dispatched", "en_route"],
  "visit.start": ["scheduled", "dispatched", "en_route"],
  "visit.complete": ["working", "en_route", "dispatched"],
  "visit.pause": ["working"],
};

/**
 * Where a visit ends up after an operation that arrived late.
 *
 * `completed_after_cancellation` exists in the schema for exactly this: the
 * office cancelled, the technician was under a house and did the work anyway,
 * and both of those are true. Moving it to plain `completed` would hide that
 * somebody was sent to a job that had been called off, which is a dispatch
 * problem worth seeing. Leaving it `cancelled` would lose the work.
 */
export function stateAfter(
  kind: OperationKind,
  current: VisitState | undefined,
): VisitState | null {
  if (current === "cancelled") {
    return kind === "visit.complete" ? "completed_after_cancellation" : null;
  }

  switch (kind) {
    case "visit.en_route": return "en_route";
    case "visit.arrive": return "en_route";
    case "visit.start": return "working";
    case "visit.pause": return "working";
    case "visit.complete": return "completed";
    default: return null;
  }
}

/**
 * Whether an operation can be applied against the state the server now holds.
 *
 * The shape of the answer matters as much as the answer. A `fact` that
 * disagrees with current state is applied AND flagged: the caller records the
 * event and raises something a human resolves. Silently applying it loses the
 * disagreement, and refusing it loses the fact.
 */
export function evaluate(input: {
  kind: OperationKind;
  currentState?: string | undefined;
  /**
   * The states this operation may be applied from, supplied by the caller
   * because only the caller knows what kind of thing the subject is.
   *
   * An earlier version looked up VISIT_TRANSITIONS here for every kind, which
   * meant a timeclock punch was silently evaluated against a table of visit
   * states, and the one `transition` kind in the catalogue had no entry there
   * at all, so the transition rule never refused anything. Passing it in makes
   * both of those impossible to write by accident.
   */
  allowedFrom?: readonly string[] | undefined;
  /** The occurrence time of the last `edit` already applied to this subject. */
  lastEditAt?: Date | undefined;
  occurredAt: Date;
}): { apply: boolean; conflict: null | string; supersedes: boolean } {
  const rule = CONFLICT_RULES[input.kind];

  if (rule === "append") return { apply: true, conflict: null, supersedes: false };

  if (rule === "edit") {
    // An older edit arriving after a newer one is not an error. The newer
    // value is already correct, so this one is recorded and does not overwrite.
    if (input.lastEditAt && input.occurredAt <= input.lastEditAt) {
      return { apply: false, conflict: null, supersedes: false };
    }
    return { apply: true, conflict: null, supersedes: true };
  }

  // With nothing to check against, both remaining rules apply. That is the
  // right default: a subject with no state cannot contradict anything.
  if (!input.allowedFrom || !input.currentState) {
    return { apply: true, conflict: null, supersedes: false };
  }

  const allowed = input.allowedFrom.includes(input.currentState);

  if (rule === "transition") {
    return allowed
      ? { apply: true, conflict: null, supersedes: false }
      : {
          apply: false,
          conflict: `Cannot ${input.kind} from ${input.currentState}`,
          supersedes: false,
        };
  }

  // fact. It happened, so it is recorded either way; a disagreement with the
  // current state is something a person resolves, not something to refuse.
  return allowed
    ? { apply: true, conflict: null, supersedes: false }
    : {
        apply: true,
        conflict:
          `Recorded ${input.kind}, but the visit was ${input.currentState} by the time it ` +
          `reached us. Somebody needs to look at this.`,
        supersedes: false,
      };
}

/**
 * The report states a submission may come from.
 *
 * Derived from timestamps rather than stored as an enum, because that is how
 * the report table models it: nothing submitted and nothing published is a
 * draft, submitted and not published is awaiting the office, and published has
 * reached the customer.
 *
 * Submitting twice is refused rather than treated as a no-op. The second
 * submission usually means the technician edited after submitting and expects
 * the change to land, and silently accepting it would tell them it did.
 */
export const REPORT_STATES = ["draft", "submitted", "published"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const REPORT_TRANSITIONS: readonly ReportState[] = ["draft"];

/** The allowed-from set for an operation, by the kind of subject it names. */
export function allowedFrom(kind: OperationKind): readonly string[] | undefined {
  if (kind === "service_report.submit") return REPORT_TRANSITIONS;
  return VISIT_TRANSITIONS[kind];
}
