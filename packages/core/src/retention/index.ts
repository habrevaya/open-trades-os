/**
 * RETENTION, THE RULES WITHOUT THE DATABASE
 *
 * A retention policy says how long a kind of record is kept and from when the
 * clock runs. This file decides, for one record, whether that time has passed,
 * and the decision is deliberately biased one way: when the clock cannot be
 * worked out, the record is KEPT. A purge that guesses deletes records a
 * contractor is still required to hold, and that cannot be undone; a purge
 * that keeps a record it could have removed costs a few kilobytes.
 *
 * The clock starts are the ones the schema names, and the comment on
 * `retention_clock_start` is the reason they exist: retention almost never
 * runs from the day a row was written.
 */

export type ClockStart =
  | "record_created"
  | "calendar_year_end"
  | "work_completed"
  | "report_prepared"
  | "employment_ended"
  | "next_activity_of_type"
  | "contract_ended"
  | "equipment_removed";

export const CLOCK_STARTS: readonly ClockStart[] = [
  "record_created", "calendar_year_end", "work_completed", "report_prepared",
  "employment_ended", "next_activity_of_type", "contract_ended", "equipment_removed",
];

/** The clock start in the words the retention screen uses. */
export const CLOCK_WORDS: Record<ClockStart, string> = {
  record_created: "from when the record was made",
  calendar_year_end: "from the end of the calendar year it falls in",
  work_completed: "from when the work was finished",
  report_prepared: "from when the report was finished",
  employment_ended: "from when the person left",
  next_activity_of_type: "from the next one of the same kind at the same place",
  contract_ended: "from when the agreement ended",
  equipment_removed: "from when the equipment was taken out",
};

/**
 * What a record knows about the dates its clock could start from.
 *
 * Every field but `createdAt` is optional and nullable, and the two mean
 * different things to the reader of a preview. Absent: this kind of record
 * has no such date at all, so a policy using that clock can never act on it.
 * Null: it could have one and does not yet, like a job not finished, so the
 * clock has not started.
 */
export interface ClockFacts {
  createdAt: Date;
  /** The day the record is ABOUT: when the incident happened, the talk was held, the test performed. */
  recordDate?: Date | null;
  workCompletedAt?: Date | null;
  reportPreparedAt?: Date | null;
  employmentEndedAt?: Date | null;
  nextActivityAt?: Date | null;
  contractEndedAt?: Date | null;
  equipmentRemovedAt?: Date | null;
}

/**
 * When the clock started, or null when it has not or cannot.
 *
 * The end of a calendar year is read in the LATEST time zone there is, twelve
 * hours behind Greenwich, so that a record from the evening of the thirty
 * first in Honolulu is never treated as belonging to a year that has already
 * ended. Keeping a record twelve hours longer than the rule asks is the
 * cheap direction to be wrong in.
 */
export function clockStartsAt(clock: ClockStart, facts: ClockFacts): Date | null {
  switch (clock) {
    case "record_created":
      return facts.createdAt;
    case "calendar_year_end": {
      const anchor = facts.recordDate ?? facts.createdAt;
      // The year as seen twelve hours behind UTC.
      const year = new Date(anchor.getTime() - 12 * 3_600_000).getUTCFullYear();
      return new Date(Date.UTC(year + 1, 0, 1, 12, 0, 0));
    }
    case "work_completed":
      return facts.workCompletedAt ?? null;
    case "report_prepared":
      return facts.reportPreparedAt ?? null;
    case "employment_ended":
      return facts.employmentEndedAt ?? null;
    case "next_activity_of_type":
      return facts.nextActivityAt ?? null;
    case "contract_ended":
      return facts.contractEndedAt ?? null;
    case "equipment_removed":
      return facts.equipmentRemovedAt ?? null;
  }
}

/**
 * The first moment a record may go: its clock start plus the months.
 *
 * Calendar months in UTC, and the day is clamped to the end of a shorter
 * month rather than rolling over: thirty six months after the thirty first of
 * January is the thirty first of January, and one month after it is the end of
 * February, never the third of March.
 */
export function purgeableFrom(start: Date, retainMonths: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + retainMonths;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    targetYear, targetMonth, day,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds(),
  ));
}

/**
 * What a purge would do with one record, and the sentence that says why.
 *
 * `due`       past its time, nothing holding it. The purge removes it.
 * `held`      past its time and under a hold. Kept, and counted.
 * `not_yet`   its time has not come.
 * `no_clock`  its clock has not started, or cannot be worked out. Kept.
 */
export type Verdict =
  | { state: "due"; clockStart: Date; purgeableFrom: Date; why: string }
  | { state: "held"; clockStart: Date; purgeableFrom: Date; why: string }
  | { state: "not_yet"; clockStart: Date; purgeableFrom: Date; why: string }
  | { state: "no_clock"; why: string };

export function judge(
  policy: { clockStart: ClockStart; retainMonths: number },
  facts: ClockFacts,
  now: Date,
  held: boolean,
): Verdict {
  const start = clockStartsAt(policy.clockStart, facts);
  if (!start) {
    return {
      state: "no_clock",
      why: `Kept: the clock runs ${CLOCK_WORDS[policy.clockStart]}, and that has not happened for this record.`,
    };
  }
  const from = purgeableFrom(start, policy.retainMonths);
  const day = from.toISOString().slice(0, 10);
  if (from.getTime() > now.getTime()) {
    return { state: "not_yet", clockStart: start, purgeableFrom: from, why: `Kept until ${day}.` };
  }
  if (held) {
    return {
      state: "held", clockStart: start, purgeableFrom: from,
      why: `Past its time on ${day}, and kept because somebody put a hold on it.`,
    };
  }
  return { state: "due", clockStart: start, purgeableFrom: from, why: `Past its time on ${day}.` };
}

/** A policy read back as a sentence: "Kept 60 months from when the report was finished." */
export function describePolicy(policy: { clockStart: ClockStart; retainMonths: number }): string {
  const years = policy.retainMonths % 12 === 0 ? policy.retainMonths / 12 : null;
  const span = years !== null
    ? `${years} year${years === 1 ? "" : "s"}`
    : `${policy.retainMonths} month${policy.retainMonths === 1 ? "" : "s"}`;
  return `Kept ${span} ${CLOCK_WORDS[policy.clockStart]}.`;
}
