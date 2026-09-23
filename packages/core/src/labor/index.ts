import {
  type Money, add, subtract, multiply, divide, round, zero, allocate,
  isNegative, isZero, compare, toString as moneyToString,
} from "../money/index.js";
import {
  dateIn, dayBoundsIn, daysFrom, nextDay, startOfDayIn, instantOfLocal, wallTimeExists,
} from "../time/index.js";

/**
 * TIME, PAY AND COMMISSION
 *
 * THIS MODULE DECIDES WHAT A PERSON GETS PAID. A BUG IN HERE IS SOMEBODY'S
 * WAGES.
 *
 * That is not a slogan at the top of a file. It is the reason every choice
 * below is made the way it is. The failure modes are not "a report looks
 * odd". They are:
 *
 *   A technician works a nine hour night across the autumn clock change, the
 *   arithmetic subtracts wall clock readings, and they are paid eight. One
 *   hour, at time and a half, gone, on a night they were the only person
 *   awake. They will notice, and the company will have no answer.
 *
 *   The same arithmetic in March pays nine hours for seven. Nobody reports
 *   that one, so it never gets found, and the company quietly overpays every
 *   spring for years.
 *
 *   A week with four ten hour days and one eight hour day gets daily overtime
 *   AND weekly overtime on the same hours, because nothing told the code that
 *   an hour may only earn a premium once. The payroll runs, the bureau files
 *   it, and unwinding it means amending returns.
 *
 *   A five hundred dollar commission is split between two technicians by
 *   dividing, each half is rounded, and the two halves do not add back to the
 *   commission. One cent a job, every job, and the commission liability
 *   account never reconciles again.
 *
 * So: no floats on money, ever, and everything goes through `../money`. No
 * clock inside the logic, ever: `now` is a parameter. Every decision is a
 * discriminated union, and every refusal carries text a person can act on,
 * because the alternative to refusing is paying a wrong number.
 *
 * WHAT IS NOT IN HERE, DELIBERATELY: any claim about the law of any place.
 * See OVERTIME POLICY below. Nothing in this file is legal advice.
 */

/* ------------------------------------------------------------------- units */

/**
 * The internal unit of worked time is WHOLE SECONDS, not minutes.
 *
 * A punch at 07:58:40 is a real punch. Rounding it to a minute at the entry
 * and then adding the entries up loses up to thirty seconds per punch pair.
 * Two punch pairs a day, five days a week, is roughly four minutes a week and
 * something like three hours a year, per technician, in whichever direction
 * the rounding happens to favour. Seconds are exact, integer, and cost
 * nothing, so there is no reason to be approximate about it.
 *
 * Thresholds are still DECLARED in minutes, because that is how an operator
 * thinks and writes them down. They are converted once, here.
 */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const DAY_MS = 86_400_000;

const minutesToSeconds = (minutes: number): number => Math.round(minutes * SECONDS_PER_MINUTE);

/** For display only. A statement shows hours and minutes, not seconds. */
export const secondsToMinutes = (seconds: number): number => seconds / SECONDS_PER_MINUTE;

/**
 * Elapsed time between two instants.
 *
 * This is a difference of INSTANTS and that is the entire point. A shift is
 * however long it actually was, and the clocks going forward or back in the
 * middle of it does not change how long the person stood there. Every attempt
 * to compute this from wall clock readings pays the wrong number twice a year,
 * and `../time/index.js` exists because this codebase has been bitten by the
 * same class of mistake in the other direction.
 */
function elapsedSeconds(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 1000);
}

/* ------------------------------------------------------------- time entries */

export const TIME_ENTRY_KINDS = [
  "travel", "on_site", "shop", "unpaid_break", "paid_break", "on_call",
  "training", "pto", "holiday",
] as const;
export type TimeEntryKind = (typeof TIME_ENTRY_KINDS)[number];

export interface TimeEntryKindProfile {
  label: string;
  /** One sentence a technician would recognise on their own timesheet. */
  meaning: string;
  paid: boolean;
  /**
   * Whether these seconds go into the pot that overtime thresholds are
   * measured against. Paid and counting are not the same question: time can
   * be paid without being hours worked, and the difference is worth money.
   */
  countsTowardOvertime: boolean;
  /**
   * The part of this kind that an operator has to settle for themselves,
   * written out so it is visible on the settings screen rather than buried in
   * a default somebody inherited.
   */
  contested: string;
}

/**
 * Defaults, not law. A policy may override `countsTowardOvertime` per kind,
 * and the one that is genuinely contested, on call, is not defaulted at all:
 * the policy has to declare it or assembly is refused.
 */
export const TIME_ENTRY_KIND: Record<TimeEntryKind, TimeEntryKindProfile> = {
  travel: {
    label: "Travel",
    meaning: "Driving between the shop and a job, or between jobs.",
    paid: true,
    countsTowardOvertime: true,
    contested:
      "Whether the first drive of the day and the last drive home are paid at all is an operator decision with real money in it, and it is not the same answer for a van the technician takes home as for one they collect from the yard.",
  },
  on_site: {
    label: "On site",
    meaning: "At the customer's property, working.",
    paid: true,
    countsTowardOvertime: true,
    contested: "Nothing. This is the uncontroversial one.",
  },
  shop: {
    label: "Shop time",
    meaning: "Loading, stocking, paperwork, training, meetings.",
    paid: true,
    countsTowardOvertime: true,
    contested:
      "Shop time is the line most often left off a timesheet because it is not attached to a job, and leaving it off is unpaid work.",
  },
  unpaid_break: {
    label: "Unpaid break",
    meaning: "A real break, off the clock, not paid and not hours worked.",
    paid: false,
    countsTowardOvertime: false,
    contested:
      "A break the technician was interrupted during was not a break. Recording it as one is the single most common wage claim in field service, and this module cannot tell the difference: somebody has to.",
  },
  paid_break: {
    label: "Paid break",
    meaning: "A short rest period that stays on the clock.",
    paid: true,
    countsTowardOvertime: true,
    contested: "How many, how long, and whether they may be combined or skipped.",
  },
  on_call: {
    label: "On call",
    meaning: "Carrying the phone, available, not working.",
    paid: true,
    countsTowardOvertime: false,
    contested:
      "Whether waiting is working. It turns on how constrained the person actually is, and it is the question in this file with the widest spread of correct answers, so the policy has to declare a treatment and this module will not guess.",
  },

  /**
   * THE THREE BELOW ARE PAID AND ARE NOT HOURS WORKED, which is the whole
   * reason they are separate kinds rather than absences kept somewhere else.
   *
   * They were added because the database enum had them and this list did
   * not. A row whose kind was `pto` reached `TIME_ENTRY_KIND[kind].paid`,
   * found undefined, and threw out of a timesheet. The two vocabularies had
   * drifted, which is the same failure this repository already carries a
   * `vocabulary.test.ts` for on party roles, and there is now one here too.
   */
  training: {
    label: "Training",
    meaning: "A class, a certification day, a manufacturer course.",
    paid: true,
    /**
     * Counting, unlike the two below. Training is generally hours worked when
     * the employer requires it, which is the case a field service company is
     * almost always in, and the operator can override it per kind if theirs
     * is the voluntary sort.
     */
    countsTowardOvertime: true,
    contested:
      "Voluntary training outside working hours, with no job duties performed, is the one shape that is usually not hours worked. Whether a given course is voluntary is a question about the employer's own communications, not about a timesheet.",
  },
  pto: {
    label: "Paid time off",
    meaning: "Vacation or sick leave taken, paid, and not worked.",
    paid: true,
    /**
     * NOT counted. Paying eight hours of holiday and then paying a premium on
     * Friday because the week crossed forty is a real overpayment, and the
     * federal rule is explicit that hours not worked do not count toward the
     * threshold. An operator whose agreement says otherwise overrides it.
     */
    countsTowardOvertime: false,
    contested:
      "A union agreement or a company policy can be more generous than the statute and count it. That is a choice somebody makes, not a default anybody should inherit.",
  },
  holiday: {
    label: "Holiday",
    meaning: "A company holiday, paid, not worked.",
    paid: true,
    countsTowardOvertime: false,
    contested:
      "Holiday premium pay, where a company pays extra for working ON a holiday, is a different thing from this and belongs on the day actually worked.",
  },
};

export interface TimeEntry {
  id: string;
  personId: string;
  kind: TimeEntryKind;
  startedAt: Date;
  /**
   * `null` while the person is still on the clock.
   *
   * Modelled as null rather than as an optional field that might be missing,
   * because "still clocked in" is a state the rest of this file has to reason
   * about explicitly. An open entry is never worth zero: it is worth an
   * unknown amount, and paying an unknown amount as zero is the failure this
   * module refuses to commit.
   */
  endedAt: Date | null;
  /** Which job the labour cost lands on. Absent for shop time and on call. */
  jobId?: string | undefined;
}

/* ------------------------------------------------------------ wall clock in */

export type WallEntryVerdict =
  | { ok: true; startedAt: Date; endedAt: Date; ambiguous: boolean; note: string }
  | { ok: false; reason: string };

/**
 * Turn an office manager's correction, typed as wall clock readings, into
 * instants.
 *
 * This is the one place a daylight saving boundary genuinely makes an entry
 * IMPOSSIBLE rather than merely awkward, and the one place this module
 * refuses over it. A technician's punch is already an instant and a shift
 * that ran through the clock change is a perfectly good shift. But somebody
 * typing "2:30am" on the morning the clocks go forward has typed a time that
 * did not happen, and the honest answer is to say so rather than to silently
 * land on 1:30 or 3:30 and pay an hour that either did not exist or was never
 * worked.
 *
 * The other direction, the hour that happens twice in the autumn, IS a real
 * instant and is resolved to the earlier of the two, which is the reading the
 * person who typed it meant. It is returned flagged, because the difference
 * between the two is an hour of pay and somebody should look.
 */
export function wallEntry(input: {
  date: string;
  startMinutes: number;
  endMinutes: number;
  timeZone: string;
}): WallEntryVerdict {
  const { date, startMinutes, endMinutes, timeZone } = input;
  const crossesMidnight = endMinutes <= startMinutes;
  const endDate = crossesMidnight ? nextDay(date) : date;

  if (!wallTimeExists(date, startMinutes, timeZone)) {
    return {
      ok: false,
      reason: `There is no ${clockOf(startMinutes)} on ${date} in ${timeZone}. The clocks went forward and that hour did not happen, so nobody clocked in during it. Enter the time they actually started.`,
    };
  }
  if (!wallTimeExists(endDate, endMinutes, timeZone)) {
    return {
      ok: false,
      reason: `There is no ${clockOf(endMinutes)} on ${endDate} in ${timeZone}. The clocks went forward and that hour did not happen. Enter the time they actually finished.`,
    };
  }

  const startedAt = instantOfLocal(date, startMinutes, timeZone);
  const endedAt = instantOfLocal(endDate, endMinutes, timeZone);

  /**
   * An hour that happened twice is detected by asking whether the same wall
   * reading an hour later is the same distance from UTC. Cheaper and more
   * honest than a transition table, and it is only used to raise a flag.
   */
  const ambiguous = isRepeatedHour(date, startMinutes, timeZone)
    || isRepeatedHour(endDate, endMinutes, timeZone);

  return {
    ok: true,
    startedAt,
    endedAt,
    ambiguous,
    note: ambiguous
      ? "The clocks went back that night, so the time typed happened twice. This was read as the first of the two, which is an hour earlier than the second. If the shift ran through the change, check the total."
      : "",
  };
}

function isRepeatedHour(date: string, minutes: number, timeZone: string): boolean {
  const here = instantOfLocal(date, minutes, timeZone);
  const anHourLater = new Date(here.getTime() + 3_600_000);
  // If moving forward one real hour leaves the wall clock reading unchanged,
  // the reading is one of a repeated pair.
  return dateIn(anHourLater, timeZone) === date
    && minutesOfInstant(anHourLater, timeZone) === minutes;
}

function minutesOfInstant(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (field("hour") % 24) * 60 + field("minute");
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/* -------------------------------------------------------------- refusals */

export type RefusalCode =
  | "entry_ends_before_it_starts"
  | "entry_ends_in_the_future"
  | "entries_overlap"
  | "entry_still_open"
  | "policy_invalid"
  | "period_not_whole_workweeks"
  | "on_call_treatment_not_declared"
  | "salary_overtime_not_supported"
  | "currency_mismatch";

export interface Refusal {
  code: RefusalCode;
  /** Text for the person who has to fix it. Never an error code on its own. */
  message: string;
  entryIds?: string[] | undefined;
}

export type EntryCheck =
  | { ok: true; entries: TimeEntry[] }
  | { ok: false; refusals: Refusal[] };

/**
 * Whether a person's entries are a shape that can be paid at all.
 *
 * Every refusal here is a shape that, left alone, produces a number rather
 * than an error, and a number is worse. A negative duration silently
 * subtracts from the week. An overlap pays the same hour twice. An entry left
 * open and then punched over is somebody who forgot to clock out at four and
 * is about to be paid either nothing for the afternoon or sixteen hours for
 * the night.
 *
 * `now` is a parameter. Nothing in this module reads a clock, so a test can
 * stand anywhere in time and so a re-run of a closed period produces the same
 * answer it did the first time.
 */
export function checkEntries(entries: readonly TimeEntry[], now: Date): EntryCheck {
  const refusals: Refusal[] = [];

  for (const entry of entries) {
    if (entry.endedAt && entry.endedAt.getTime() < entry.startedAt.getTime()) {
      refusals.push({
        code: "entry_ends_before_it_starts",
        message: `Entry ${entry.id} ends before it starts. Nobody clocked out before they clocked in, so one of the two times is wrong. Fix the punch rather than letting it subtract from the week.`,
        entryIds: [entry.id],
      });
    }
    if (entry.endedAt && entry.endedAt.getTime() > now.getTime()) {
      refusals.push({
        code: "entry_ends_in_the_future",
        message: `Entry ${entry.id} ends in the future. A device clock was wrong or somebody typed a date. This would pay time that has not been worked yet.`,
        entryIds: [entry.id],
      });
    }
  }

  /**
   * Overlap is checked per PERSON and in chronological order. Sorting first
   * matters: entries arrive from a phone that was offline, in whatever order
   * the queue drained, and comparing only adjacent rows of an unsorted list
   * finds nothing.
   */
  const byPerson = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const list = byPerson.get(entry.personId) ?? [];
    list.push(entry);
    byPerson.set(entry.personId, list);
  }

  for (const [personId, list] of byPerson) {
    const sorted = [...list].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;

      if (previous.endedAt === null) {
        refusals.push({
          code: "entry_still_open",
          message: `${personId} started entry ${current.id} while entry ${previous.id} was still open. They forgot to clock out. Close the earlier entry at the time they actually finished; leaving it open pays either nothing for that span or everything until the next punch.`,
          entryIds: [previous.id, current.id],
        });
        continue;
      }

      /**
       * Touching is allowed and overlapping is not. An entry that ends at the
       * exact instant the next begins is a technician driving away from one
       * job straight to the next, which is the normal case and must not be
       * refused. Strictly less than is the whole difference.
       */
      if (current.startedAt.getTime() < previous.endedAt.getTime()) {
        refusals.push({
          code: "entries_overlap",
          message: `${personId} has two entries covering the same time: ${previous.id} and ${current.id}. One person cannot be in two places, and paying both pays the same hour twice. Decide which one is real.`,
          entryIds: [previous.id, current.id],
        });
      }
    }
  }

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, entries: [...entries] };
}

/* -------------------------------------------------------- overtime policy */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday",
  4: "Thursday", 5: "Friday", 6: "Saturday",
};

/**
 * How a punch pair is rounded before it is paid.
 *
 * Rounding to the nearest quarter hour is an old and widespread practice and
 * it is legitimate only while it is NEUTRAL. `down` is in this type because
 * systems do it, and it is flagged rather than quietly supported: rounding
 * that only ever runs in the employer's direction is the pattern that turns
 * a timesheet into a class action. `up` costs a few minutes a day and has
 * never cost anybody a lawsuit.
 *
 * Applied ONCE TO THE PUNCH PAIR, and then settled across the days the shift
 * touched, so the parts of a shift that crossed midnight still add up to the
 * shift.
 *
 * Rounding each day segment separately is the version that looks equivalent
 * and is not. A shift from 22:07 to 06:07 split at midnight is 1h53m and
 * 6h07m; rounding each half up to the quarter hour gives 2h00m and 6h15m,
 * which is 8h15m for an eight hour shift. The error is per BOUNDARY rather
 * than per punch, so it is paid on every night shift and it compounds across
 * a week. One shift is one punch pair and is rounded once.
 */
export interface PunchRounding {
  toMinutes: number;
  mode: "nearest" | "up" | "down";
}

export type OnCallTreatment = "separate_rate_not_hours_worked" | "hours_worked_at_base";

/**
 * OVERTIME POLICY, DECLARED BY THE OPERATOR
 *
 * There is no table of jurisdictions in this file, and that is deliberate, in
 * exactly the way `CONSENT_RULES` in `../telephony/index.js` carries no table
 * of recording rules.
 *
 * Overtime law is not uniform and does not stay still. A weekly threshold
 * here, a daily threshold there, double time above some other number, a
 * seventh consecutive day rule in one place and nothing like it anywhere
 * else, different answers again for public work, and all of it amendable by a
 * legislature that does not tell this project. Shipping a built in table of
 * who owes what would be shipping a legal opinion, into a product that is
 * SELF HOSTED and therefore can never be corrected in the field once a
 * contractor has installed it. The stale table would keep computing confident
 * wrong numbers for years.
 *
 * So what is modelled here is the MECHANISM. The operator declares a policy,
 * in configuration, having taken their own advice, and this file applies what
 * they declared and shows them the declaration. NOTHING IN THIS FILE IS LEGAL
 * ADVICE AND NONE OF IT IS A CLAIM ABOUT ANY PARTICULAR PLACE.
 *
 * `note` is required and may not be blank for the same reason the telephony
 * policies require one: it is what the settings screen shows the person who
 * has to decide whether the declaration is right, and a blank one tells them
 * nothing.
 */
export interface OvertimePolicy {
  label: string;
  /** The company's zone. Not the server's, which is a container in UTC. */
  timeZone: string;
  /**
   * Which day the workweek starts on. Explicit, never inferred, because it
   * moves the boundary of the pot that the weekly threshold is measured
   * against, and a week boundary in the wrong place moves overtime between
   * two weeks and changes what is owed.
   */
  weekStartsOn: Weekday;
  /**
   * What to do with a shift that runs through midnight.
   *
   * There is no universal answer. Attributing the whole shift to the day it
   * started is the convention most night shift operations use, and it keeps a
   * single shift whole so a daily threshold sees it as one span. Splitting at
   * midnight puts each hour in the day it happened, which is what a literal
   * reading of a daily threshold implies. They pay differently: a nine hour
   * night shift is one day of nine against an eight hour daily threshold, or
   * two days of two and seven against nothing. The operator declares it.
   */
  dayAttribution: "shift_start" | "split_at_midnight";
  weeklyThresholdMinutes: number | null;
  weeklyDoubleTimeThresholdMinutes: number | null;
  dailyThresholdMinutes: number | null;
  dailyDoubleTimeThresholdMinutes: number | null;
  /** "1.5" for time and a half. A decimal string, never a float. */
  overtimeMultiplier: string;
  doubleTimeMultiplier: string;
  onCallTreatment: OnCallTreatment;
  punchRounding?: PunchRounding | null | undefined;
  /** Per kind overrides of `countsTowardOvertime`. Absent means the default. */
  countsTowardOvertime?: Partial<Record<TimeEntryKind, boolean>> | undefined;
  /** What the operator is claiming, in their words. Shown on the settings screen. */
  note: string;
}

export type PolicyVerdict = { ok: true } | { ok: false; refusals: Refusal[] };

export function checkOvertimePolicy(policy: OvertimePolicy): PolicyVerdict {
  const refusals: Refusal[] = [];
  const bad = (message: string) => refusals.push({ code: "policy_invalid", message });

  if (policy.note.trim() === "") {
    bad("The overtime policy has no note. The note is what the person approving payroll reads to decide whether this declaration is right, and a blank one tells them nothing.");
  }
  if (!Number.isInteger(policy.weekStartsOn) || policy.weekStartsOn < 0 || policy.weekStartsOn > 6) {
    bad(`The workweek starts on day ${String(policy.weekStartsOn)}, which is not a day. It has to be 0 for Sunday through 6 for Saturday: the week boundary decides which week an hour of overtime falls in.`);
  }
  for (const [name, value] of [
    ["weekly threshold", policy.weeklyThresholdMinutes],
    ["weekly double time threshold", policy.weeklyDoubleTimeThresholdMinutes],
    ["daily threshold", policy.dailyThresholdMinutes],
    ["daily double time threshold", policy.dailyDoubleTimeThresholdMinutes],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      bad(`The ${name} is ${String(value)}. A threshold is a number of minutes and cannot be negative.`);
    }
  }
  if (
    policy.weeklyThresholdMinutes !== null
    && policy.weeklyDoubleTimeThresholdMinutes !== null
    && policy.weeklyDoubleTimeThresholdMinutes < policy.weeklyThresholdMinutes
  ) {
    bad("The weekly double time threshold is below the weekly overtime threshold, so every overtime hour would also be a double time hour and the overtime rate would never be used. One of the two numbers is wrong.");
  }
  if (
    policy.dailyThresholdMinutes !== null
    && policy.dailyDoubleTimeThresholdMinutes !== null
    && policy.dailyDoubleTimeThresholdMinutes < policy.dailyThresholdMinutes
  ) {
    bad("The daily double time threshold is below the daily overtime threshold. One of the two numbers is wrong.");
  }
  for (const [name, value] of [
    ["overtime multiplier", policy.overtimeMultiplier],
    ["double time multiplier", policy.doubleTimeMultiplier],
  ] as const) {
    if (!/^\d+(\.\d+)?$/.test(value.trim())) {
      bad(`The ${name} is ${JSON.stringify(value)}, which is not a decimal string. Rates are strings here because 1.5 is fine as a float and 0.1 is not, and a rate that is almost right is a wage that is almost right.`);
    } else if (compare(multiply({ amount: 10_000n, currency: "USD" }, value), { amount: 10_000n, currency: "USD" }) < 0) {
      bad(`The ${name} is ${value}, which is less than 1. A premium below the base rate pays somebody less for working longer.`);
    }
  }
  if (
    policy.onCallTreatment !== "separate_rate_not_hours_worked"
    && policy.onCallTreatment !== "hours_worked_at_base"
  ) {
    /**
     * The one kind that is not defaulted. Whether waiting is working has the
     * widest spread of correct answers in this file, and a policy assembled
     * from configuration, a migration or an API payload can arrive with this
     * field missing or misspelled however carefully the type is written. Left
     * alone it falls through to the base rate and quietly stops counting on
     * call toward the thresholds, which is a treatment nobody declared.
     */
    refusals.push({
      code: "on_call_treatment_not_declared",
      message: `This policy does not declare how on call time is treated. It has to say either separate_rate_not_hours_worked or hours_worked_at_base, and it says ${JSON.stringify(String(policy.onCallTreatment))}. Whether waiting is working is the question in this module with the widest spread of correct answers, and it will not be guessed on the operator's behalf.`,
    });
  }
  if (policy.punchRounding) {
    const { toMinutes, mode } = policy.punchRounding;
    if (!Number.isInteger(toMinutes) || toMinutes <= 0) {
      bad(`Punch rounding is set to ${String(toMinutes)} minutes, which is not an interval.`);
    }
    if (mode === "down") {
      bad("Punch rounding is set to always round down. Rounding that only ever runs in the employer's direction is unpaid work by arithmetic. Use nearest, or up.");
    }
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true };
}

/* ------------------------------------------------------ days and workweeks */

/**
 * The day before a calendar date.
 *
 * Plain UTC arithmetic on a DATE is safe: a date has no time of day, UTC has
 * no daylight saving, and stepping back one day from a `YYYY-MM-DD` always
 * lands on the previous `YYYY-MM-DD`. The identical arithmetic on an INSTANT
 * is the bug this whole module is defending against, which is why it is
 * spelled out here rather than left to be inferred.
 */
function previousDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Not a calendar date: ${date}`);
  return new Date(parsed - DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date on which the workweek containing `date` begins. */
export function weekStartDate(date: string, weekStartsOn: Weekday): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Not a calendar date: ${date}`);
  const dayOfWeek = new Date(parsed).getUTCDay();
  let cursor = date;
  for (let back = (dayOfWeek - weekStartsOn + 7) % 7; back > 0; back -= 1) {
    cursor = previousDay(cursor);
  }
  return cursor;
}

export interface DaySegment {
  date: string;
  entryId: string;
  kind: TimeEntryKind;
  seconds: number;
}

function roundSeconds(seconds: number, rounding: PunchRounding | null | undefined): number {
  if (!rounding || rounding.toMinutes <= 0) return seconds;
  const step = minutesToSeconds(rounding.toMinutes);
  switch (rounding.mode) {
    case "up": return Math.ceil(seconds / step) * step;
    case "down": return Math.floor(seconds / step) * step;
    case "nearest": return Math.round(seconds / step) * step;
  }
}

/**
 * Settle a punch pair's rounding across the days the shift touched.
 *
 * The whole shift is rounded once, and the difference is put on the LAST
 * segment, because the end punch is the one a rounding rule is adjusting and
 * the last segment is the day it fell in. If that segment is shorter than the
 * adjustment, the rest walks backwards rather than being allowed to turn a
 * day negative. The invariant is the one the comment on `PunchRounding`
 * claims: the segments sum to the rounded shift, exactly.
 */
function settleRounding(
  segments: DaySegment[],
  rawTotal: number,
  rounding: PunchRounding | null | undefined,
): DaySegment[] {
  if (!rounding || rounding.toMinutes <= 0 || segments.length === 0) return segments;
  let delta = roundSeconds(rawTotal, rounding) - rawTotal;
  if (delta === 0) return segments;
  const out = segments.map((segment) => ({ ...segment }));
  for (let i = out.length - 1; i >= 0 && delta !== 0; i -= 1) {
    const segment = out[i]!;
    const move = delta > 0 ? delta : -Math.min(segment.seconds, -delta);
    segment.seconds += move;
    delta -= move;
  }
  return out.filter((segment) => segment.seconds > 0);
}

/**
 * Attribute a closed entry's seconds to calendar days in the company's zone.
 *
 * The two lines that matter:
 *
 *   `dateIn(instant, timeZone)` rather than `instant.toISOString().slice(0,10)`.
 *   The second one asks what day it was in London. For a shop in Austin, a
 *   shift that started at six on Tuesday evening is a Wednesday shift as far
 *   as UTC is concerned, which moves it into the wrong day, the wrong daily
 *   overtime bucket and, one day in seven, the wrong workweek.
 *
 *   `dayBoundsIn(date, timeZone).end` rather than the day's start plus twenty
 *   four hours. Two days a year that is wrong by an hour, and it is wrong in
 *   the middle of exactly the night shifts this function is here to split.
 */
export function attributeToDays(entry: TimeEntry, policy: OvertimePolicy): DaySegment[] {
  if (entry.endedAt === null) return [];
  const total = elapsedSeconds(entry.startedAt, entry.endedAt);
  if (total <= 0) return [];

  if (policy.dayAttribution === "shift_start") {
    return settleRounding([{
      date: dateIn(entry.startedAt, policy.timeZone),
      entryId: entry.id,
      kind: entry.kind,
      seconds: total,
    }], total, policy.punchRounding);
  }

  const segments: DaySegment[] = [];
  let cursor = entry.startedAt;
  let date = dateIn(cursor, policy.timeZone);
  let guard = 0;

  while (cursor.getTime() < entry.endedAt.getTime()) {
    if ((guard += 1) > 400) {
      throw new Error(`Entry ${entry.id} spans more than a year of days. Something is wrong with its punches.`);
    }
    const bounds = dayBoundsIn(date, policy.timeZone);
    const segmentEnd = bounds.end.getTime() < entry.endedAt.getTime() ? bounds.end : entry.endedAt;
    const seconds = elapsedSeconds(cursor, segmentEnd);
    if (seconds > 0) {
      segments.push({ date, entryId: entry.id, kind: entry.kind, seconds });
    }
    cursor = segmentEnd;
    date = nextDay(date);
  }
  return settleRounding(segments, total, policy.punchRounding);
}

/* -------------------------------------------------------- classification */

export interface DayClassification {
  date: string;
  /** Seconds that count toward overtime thresholds. */
  countingSeconds: number;
  /**
   * Seconds paid at the base rate. Not simply `countingSeconds` less the two
   * premium buckets: it also carries the hours the policy declared out of the
   * overtime pot, which are paid and are not counted, so this can be greater
   * than `countingSeconds`.
   */
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
}

export interface WeekClassification {
  /** The calendar date the workweek begins, in the policy's zone. */
  weekStartDate: string;
  days: DayClassification[];
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
  /** Paid but not hours worked, under the declared on call treatment. */
  onCallSeconds: number;
  /** Not paid at all. Carried so the statement can explain the gap. */
  unpaidSeconds: number;
  /** Plain sentences explaining how these numbers came out this way. */
  explanations: string[];
}

function countsTowardOvertime(kind: TimeEntryKind, policy: OvertimePolicy): boolean {
  if (kind === "on_call") return policy.onCallTreatment === "hours_worked_at_base";
  return policy.countsTowardOvertime?.[kind] ?? TIME_ENTRY_KIND[kind].countsTowardOvertime;
}

function isPaidAsWorked(kind: TimeEntryKind, policy: OvertimePolicy): boolean {
  if (!TIME_ENTRY_KIND[kind].paid) return false;
  if (kind === "on_call") return policy.onCallTreatment === "hours_worked_at_base";
  return true;
}

const hoursOf = (seconds: number): string => (seconds / SECONDS_PER_HOUR).toFixed(2);

/**
 * WHICH HOURS EARN A PREMIUM, AND WHICH PREMIUM.
 *
 * The rule, stated once and applied everywhere below:
 *
 *   AN HOUR MAY EARN A PREMIUM ONCE. THE DAILY RULE IS APPLIED FIRST, AND THE
 *   WEEKLY RULE ONLY TOPS UP WHAT THE DAILY RULE DID NOT ALREADY CLAIM.
 *
 * Why the daily rule wins rather than the weekly one: the daily premium is
 * already fixed at the end of that day. Nothing that happens on Thursday can
 * make Monday's ninth hour ordinary again. The weekly threshold, by contrast,
 * is a statement about the week as a whole and can only be settled once the
 * week is over, so it is the one that has to give way.
 *
 * The concrete case, because it is the expensive one. Four ten hour days and
 * one eight hour day is forty eight hours, with an eight hour daily threshold
 * and a forty hour weekly threshold:
 *
 *   Daily: eight hours of overtime, two on each of the four long days.
 *   Weekly, naively: forty eight minus forty is another eight hours.
 *   Paying both is sixteen premium hours out of a forty eight hour week,
 *   which is eight hours the person never worked. On a fifty dollar an hour
 *   technician that is two hundred dollars a week, every week, and it is
 *   paid confidently by software that looks like it is working.
 *
 * What is actually paid: eight premium hours. The weekly top up is
 *
 *   max(0, total - weeklyThreshold - premium seconds the daily rule already took)
 *
 * which gives zero here, and gives the right answer in the cases where the
 * weekly rule really does add something: six eight hour days is forty eight
 * hours with no daily overtime at all, and the formula promotes eight.
 */
export function classifyWeek(
  weekStart: string,
  segments: readonly DaySegment[],
  policy: OvertimePolicy,
): WeekClassification {
  const explanations: string[] = [];

  const byDate = new Map<string, number>();
  /**
   * Paid at the base rate, and declared OUT of the pot the thresholds are
   * measured against. Held apart from `byDate` rather than added to it: they
   * are two different questions and adding them together is the bug this
   * separation exists to prevent. Seconds in this map are paid, are never
   * promoted to a premium, and never push anybody over a threshold.
   */
  const declaredOutByDate = new Map<string, number>();
  let onCallSeconds = 0;
  let unpaidSeconds = 0;

  for (const segment of segments) {
    if (!TIME_ENTRY_KIND[segment.kind].paid) {
      unpaidSeconds += segment.seconds;
      continue;
    }
    if (!isPaidAsWorked(segment.kind, policy)) {
      onCallSeconds += segment.seconds;
      continue;
    }
    if (!countsTowardOvertime(segment.kind, policy)) {
      declaredOutByDate.set(
        segment.date, (declaredOutByDate.get(segment.date) ?? 0) + segment.seconds,
      );
      continue;
    }
    byDate.set(segment.date, (byDate.get(segment.date) ?? 0) + segment.seconds);
  }

  const dailyThreshold = policy.dailyThresholdMinutes === null
    ? null : minutesToSeconds(policy.dailyThresholdMinutes);
  const dailyDoubleThreshold = policy.dailyDoubleTimeThresholdMinutes === null
    ? null : minutesToSeconds(policy.dailyDoubleTimeThresholdMinutes);

  const dates = [...new Set([...byDate.keys(), ...declaredOutByDate.keys()])]
    .sort((a, b) => (a < b ? -1 : 1));

  const days: DayClassification[] = dates.map((date) => {
    const countingSeconds = byDate.get(date) ?? 0;
    const declaredOut = declaredOutByDate.get(date) ?? 0;
    const doubleTimeSeconds = dailyDoubleThreshold === null
      ? 0 : Math.max(0, countingSeconds - dailyDoubleThreshold);
    const capped = dailyDoubleThreshold === null
      ? countingSeconds : Math.min(countingSeconds, dailyDoubleThreshold);
    const overtimeSeconds = dailyThreshold === null
      ? 0 : Math.max(0, capped - dailyThreshold);
    return {
      date,
      countingSeconds,
      // Hours the operator declared out of the pot are still paid, so they
      // ride here, but they took no part in the two lines above.
      regularSeconds: countingSeconds - overtimeSeconds - doubleTimeSeconds + declaredOut,
      overtimeSeconds,
      doubleTimeSeconds,
    };
  });

  const declaredOutSeconds = [...declaredOutByDate.values()].reduce((a, b) => a + b, 0);
  const total = days.reduce((acc, d) => acc + d.countingSeconds, 0);
  let regular = days.reduce((acc, d) => acc + d.regularSeconds, 0);
  let overtime = days.reduce((acc, d) => acc + d.overtimeSeconds, 0);
  let doubleTime = days.reduce((acc, d) => acc + d.doubleTimeSeconds, 0);
  /**
   * The part of `regular` that a WEEKLY rule may promote: the counting hours
   * that no daily rule has already claimed.
   *
   * Held apart from `regular` because `regular` now also carries hours the
   * operator declared out of the pot, and those may never be pulled into a
   * premium by a threshold they were never measured against. The two weekly
   * rules below cap what they promote by an amount that is itself derived
   * from `total`, so on today's arithmetic neither can reach past this cap
   * anyway. It is written this way so that stays true if a rule is added,
   * not because a rule currently gets it wrong.
   */
  let promotableRegular = total - overtime - doubleTime;

  if (overtime > 0 || doubleTime > 0) {
    explanations.push(
      `The daily rule took ${hoursOf(overtime)} hours at ${policy.overtimeMultiplier}x and ${hoursOf(doubleTime)} hours at ${policy.doubleTimeMultiplier}x before the week was looked at.`,
    );
  }

  if (policy.weeklyThresholdMinutes !== null) {
    const weeklyThreshold = minutesToSeconds(policy.weeklyThresholdMinutes);
    const alreadyPremium = overtime + doubleTime;
    /**
     * The subtraction of `alreadyPremium` is the no pyramiding rule and it is
     * the single most load bearing term in this file. Removing it pays the
     * same hour twice.
     */
    const topUp = Math.min(
      promotableRegular, Math.max(0, total - weeklyThreshold - alreadyPremium),
    );
    if (topUp > 0) {
      regular -= topUp;
      promotableRegular -= topUp;
      overtime += topUp;
      explanations.push(
        `The week came to ${hoursOf(total)} hours against a ${hoursOf(weeklyThreshold)} hour week, and ${hoursOf(alreadyPremium)} of those were already paid at a premium by the daily rule, so the weekly rule added ${hoursOf(topUp)} hours. An hour is only paid at a premium once.`,
      );
    } else if (total > weeklyThreshold) {
      explanations.push(
        `The week came to ${hoursOf(total)} hours, over the ${hoursOf(weeklyThreshold)} hour week, but the daily rule had already paid a premium on ${hoursOf(alreadyPremium)} of them, so the weekly rule adds nothing. An hour is only paid at a premium once.`,
      );
    }
  }

  if (policy.weeklyDoubleTimeThresholdMinutes !== null) {
    const weeklyDoubleThreshold = minutesToSeconds(policy.weeklyDoubleTimeThresholdMinutes);
    let needed = Math.max(0, total - weeklyDoubleThreshold - doubleTime);
    // Promoted out of the overtime bucket first, because those hours are
    // already the latest and dearest in the week.
    const fromOvertime = Math.min(overtime, needed);
    overtime -= fromOvertime;
    needed -= fromOvertime;
    const fromRegular = Math.min(promotableRegular, needed);
    regular -= fromRegular;
    promotableRegular -= fromRegular;
    doubleTime += fromOvertime + fromRegular;
    if (fromOvertime + fromRegular > 0) {
      explanations.push(
        `The week passed ${hoursOf(weeklyDoubleThreshold)} hours, so ${hoursOf(fromOvertime + fromRegular)} hours moved up to ${policy.doubleTimeMultiplier}x.`,
      );
    }
  }

  if (onCallSeconds > 0) {
    explanations.push(
      `${hoursOf(onCallSeconds)} hours on call are paid at the on call rate and, under this policy, are not hours worked for the overtime thresholds.`,
    );
  }
  if (unpaidSeconds > 0) {
    explanations.push(`${hoursOf(unpaidSeconds)} hours of unpaid break were taken out before any of this.`);
  }
  if (declaredOutSeconds > 0) {
    explanations.push(
      `${hoursOf(declaredOutSeconds)} hours are paid at the base rate but were declared by this policy not to be hours worked for the overtime thresholds, so they neither earned a premium nor pushed the rest of the week over one.`,
    );
  }

  return {
    weekStartDate: weekStart,
    days,
    regularSeconds: regular,
    overtimeSeconds: overtime,
    doubleTimeSeconds: doubleTime,
    onCallSeconds,
    unpaidSeconds,
    explanations,
  };
}

/** Group a person's entries into workweeks and classify each one. */
export function classifyWeeks(
  entries: readonly TimeEntry[],
  policy: OvertimePolicy,
): WeekClassification[] {
  const byWeek = new Map<string, DaySegment[]>();
  for (const entry of entries) {
    for (const segment of attributeToDays(entry, policy)) {
      const week = weekStartDate(segment.date, policy.weekStartsOn);
      const list = byWeek.get(week) ?? [];
      list.push(segment);
      byWeek.set(week, list);
    }
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, segments]) => classifyWeek(week, segments, policy));
}

/* ------------------------------------------------------------------- pay */

export type PayBasis =
  | { kind: "hourly"; baseRate: Money; onCallRate?: Money | undefined }
  | {
      kind: "salary";
      perPeriod: Money;
      /**
       * Declared, not inferred. Salaried and exempt are different words and
       * treating them as the same one is how a salaried dispatcher working
       * sixty hour weeks is paid for forty.
       */
      overtimeEligible: boolean;
    };

/**
 * The effective overtime rate, DERIVED rather than stored.
 *
 * Storing an overtime rate next to a base rate means a raise updates one row
 * and not the other. The technician sees the new base on their next stub,
 * does not think to check the overtime line, and is underpaid on every
 * premium hour for as long as it takes somebody to notice. Deriving it means
 * there is only one number to get right.
 */
export const overtimeRate = (baseRate: Money, multiplier: string): Money =>
  multiply(baseRate, multiplier);

/**
 * Pay for a span of time at an hourly rate.
 *
 * The order of operations is the point. `rate * seconds` first, as exact
 * bigint arithmetic, and the single division by 3600 last, so there is one
 * rounding in the whole calculation and it happens at the end.
 *
 * The tempting version precomputes a per minute or per second rate and
 * multiplies by the span. That rounds first and multiplies the rounding error
 * by the number of units. On a $46.15 rate, a per minute rate rounded to four
 * places is off by a fraction that becomes a visible cent over a seven hour
 * shift, and it is off in the same direction on every shift forever.
 */
export function payFor(rate: Money, seconds: number): Money {
  if (!Number.isFinite(seconds)) throw new RangeError(`Not a span of seconds: ${String(seconds)}`);
  if (seconds < 0) throw new RangeError("Cannot pay a negative span of time");
  const whole = Math.round(seconds);
  return divide(multiply(rate, String(whole)), String(SECONDS_PER_HOUR));
}

/* ------------------------------------------------------------ commission */

export const COMMISSION_BASES = [
  "percent_of_revenue", "percent_of_gross_margin", "flat_per_job", "percent_of_collected",
] as const;
export type CommissionBasisKey = (typeof COMMISSION_BASES)[number];

export interface CommissionBasisSpec {
  key: CommissionBasisKey;
  label: string;
  /** What it does, in one sentence somebody can repeat in a truck. */
  meaning: string;
  /**
   * WHAT IT IS WRONG ABOUT. Required, not optional, and shown beside the plan
   * wherever it is configured, in the same way the attribution models in
   * `../marketing/index.js` carry theirs. Every basis here rewards something,
   * and what it rewards is not always what the owner meant to reward. A
   * commission plan is the most powerful instruction a contractor ever gives
   * a technician, and it is usually given by accident.
   */
  wrongAbout: string;
  needs: "rate" | "flat";
}

export const COMMISSION_BASIS: Record<CommissionBasisKey, CommissionBasisSpec> = {
  percent_of_revenue: {
    key: "percent_of_revenue",
    label: "Percentage of revenue",
    meaning: "A share of what the job invoiced for.",
    wrongAbout:
      "It rewards selling the expensive option, not the right one. The technician is paid more for the four thousand dollar system than the two thousand dollar repair that would have done, and paid more for the job with eleven hundred dollars of parts in it than the one that was all labour, even though the second one made the company far more money. It is the easiest plan to explain and the easiest one to sell the wrong thing under.",
    needs: "rate",
  },
  percent_of_gross_margin: {
    key: "percent_of_gross_margin",
    label: "Percentage of gross margin",
    meaning: "A share of revenue less the cost of what it took to do the job.",
    wrongAbout:
      "It rewards selling the profitable option, which is what the owner meant, and it depends on a cost that nobody has at the moment the technician is standing in the driveway. The part has not been invoiced, the labour is estimated, and the final cost lands days later in accounting. So the number the technician was told and the number they are paid are computed from different facts, and the gap is always discovered on payday. Every argument about a margin plan is really an argument about when the cost was known.",
    needs: "rate",
  },
  flat_per_job: {
    key: "flat_per_job",
    label: "Flat amount per job",
    meaning: "A fixed amount for each completed job, whatever it was worth.",
    wrongAbout:
      "It rewards volume and nothing else. The fastest route to a bigger cheque is more calls, shorter, which is the same thing as leaving before the problem is properly fixed. It is also the plan under which a technician has the least reason to take the difficult call, and difficult calls are the ones a company gets remembered for.",
    needs: "flat",
  },
  percent_of_collected: {
    key: "percent_of_collected",
    label: "Percentage of what was collected",
    meaning: "A share of the cash actually received against the invoice.",
    wrongAbout:
      "It puts the technician's pay behind the office's collections. They did the work in March and get paid when somebody in the office chases an invoice in June, over something they had no part in and cannot influence. It is also the basis most likely to be quietly unlawful as a deduction from wages already earned, depending on where the operator is, which is their question and not this file's.",
    needs: "rate",
  },
};

export interface CommissionPlan {
  basis: CommissionBasisKey;
  /** "0.08" is eight per cent. Required for a percentage basis. */
  rate?: string | undefined;
  /** Required for a flat basis. */
  flatAmount?: Money | undefined;
  note: string;
}

export interface CommissionShare {
  personId: string;
  /** A weight, not a percentage. "2" and "1" is a two thirds, one third split. */
  weight: string;
}

export interface CommissionEvent {
  id: string;
  jobId: string;
  invoiceId: string;
  /** When it was earned. Decides which pay period it belongs to. */
  occurredAt: Date;
  revenue: Money;
  /** Absent when nobody knows yet. A margin plan cannot be settled without it. */
  cost?: Money | undefined;
  /** Cash received against the invoice, for a collected basis. */
  collected?: Money | undefined;
  shares: CommissionShare[];
}

export interface CommissionPart {
  personId: string;
  amount: Money;
  explanation: string;
}

export type CommissionVerdict =
  | { ok: true; total: Money; parts: CommissionPart[]; explanation: string }
  | { ok: false; reason: string };

function commissionBase(plan: CommissionPlan, event: CommissionEvent):
  { ok: true; base: Money; describe: string } | { ok: false; reason: string } {
  switch (plan.basis) {
    case "percent_of_revenue":
      return { ok: true, base: event.revenue, describe: `revenue of ${moneyToString(event.revenue)}` };
    case "percent_of_gross_margin": {
      if (!event.cost) {
        /**
         * The refusal the whole margin basis exists to make. Treating an
         * unknown cost as zero pays commission on the full invoice as though
         * it were all profit, which is the most expensive default available,
         * and it is the default every spreadsheet has.
         */
        return {
          ok: false,
          reason: `Job ${event.jobId} has no cost recorded, so its gross margin is not known and a margin commission cannot be settled. Post the parts and the labour cost first. Treating the missing cost as zero would pay commission on the whole invoice as though none of it cost anything.`,
        };
      }
      if (event.cost.currency !== event.revenue.currency) {
        return { ok: false, reason: `Job ${event.jobId} has revenue in ${event.revenue.currency} and cost in ${event.cost.currency}.` };
      }
      const margin = subtract(event.revenue, event.cost);
      return { ok: true, base: margin, describe: `gross margin of ${moneyToString(margin)} on revenue of ${moneyToString(event.revenue)}` };
    }
    case "percent_of_collected": {
      if (!event.collected) {
        return {
          ok: false,
          reason: `Job ${event.jobId} has no collected amount recorded, so a collected basis commission cannot be settled. If nothing has been collected yet, record zero rather than leaving it blank: blank and nothing are different facts and only one of them is a decision.`,
        };
      }
      return { ok: true, base: event.collected, describe: `${moneyToString(event.collected)} collected against invoice ${event.invoiceId}` };
    }
    case "flat_per_job":
      return { ok: true, base: zero(event.revenue.currency), describe: `job ${event.jobId}` };
  }
}

/**
 * What a job's commission is, and how it divides between the people on it.
 *
 * THE SPLIT USES `money.allocate` AND NEVER DIVISION. A commission of $347.63
 * split two ways is $173.815 each, and there is no such coin. Dividing and
 * rounding each half gives either $347.62 or $347.64 and the commission
 * liability account is out by a cent, on that job and on every job like it,
 * forever. `allocate` hands the odd cent to one of them deterministically and
 * the parts sum back to the whole exactly, which is the only property that
 * makes a payroll reconcile.
 *
 * Allocated at precision 2 rather than at full scale, because these parts are
 * going to be PAID. A part of $173.8150 is not payable; rounding it at the
 * point of payment is where the cent would go missing all over again.
 */
export function computeCommission(plan: CommissionPlan, event: CommissionEvent): CommissionVerdict {
  if (plan.note.trim() === "") {
    return { ok: false, reason: "This commission plan has no note on it. The note is what a technician is shown when they ask how the number was worked out." };
  }
  if (event.shares.length === 0) {
    return { ok: false, reason: `Job ${event.jobId} has a commission but nobody to pay it to.` };
  }

  const spec = COMMISSION_BASIS[plan.basis];
  let total: Money;
  let explanation: string;

  if (spec.needs === "flat") {
    if (!plan.flatAmount) {
      return { ok: false, reason: `A ${spec.label.toLowerCase()} plan needs an amount per job, and this one has none.` };
    }
    // To the cent here, for the same reason the percentage branch below is:
    // the parts are allocated out of a PAYABLE whole, and a total that is not
    // payable cannot equal the sum of parts that are.
    total = round(plan.flatAmount, 2);
    explanation = `${moneyToString(total)} flat for job ${event.jobId}.`;
  } else {
    if (!plan.rate) {
      return { ok: false, reason: `A ${spec.label.toLowerCase()} plan needs a rate, and this one has none.` };
    }
    const base = commissionBase(plan, event);
    if (!base.ok) return base;
    /**
     * A negative base is a job that lost money. Commission on it is zero, not
     * a negative that quietly eats into the rest of the period's commission.
     * If the operator wants losses to claw back, that is a clawback, which is
     * an explicit event below with its own audit trail.
     */
    if (isNegative(base.base)) {
      return {
        ok: true,
        total: zero(event.revenue.currency),
        parts: event.shares.map((share) => ({
          personId: share.personId,
          amount: zero(event.revenue.currency),
          explanation: `Job ${event.jobId} had a negative ${spec.label.toLowerCase()}, so it earned no commission. It was not turned into a deduction from the rest of the period.`,
        })),
        explanation: `Job ${event.jobId} lost money, so there is no commission on it.`,
      };
    }
    const exact = multiply(base.base, plan.rate);
    /**
     * Rounded to the cent HERE, before it is split, and deliberately not at
     * full scale the way an invoice line is held.
     *
     * The rule in `../money/index.js` is that rounding happens once at the
     * document rather than on every line, and that is right for an invoice,
     * where the customer checks the total. A commission is not a document
     * line: it is a PAYMENT, and $231.7596 is not payable. Rounding it after
     * the split would round each part separately and the parts would stop
     * adding back to the commission, which is the exact failure this module
     * uses `allocate` to avoid. So the whole is made payable first, and then
     * the payable whole is allocated.
     */
    total = round(exact, 2);
    explanation = moneyToString(exact) === moneyToString(total)
      ? `${plan.rate} of ${base.describe} is ${moneyToString(total)}.`
      : `${plan.rate} of ${base.describe} is ${moneyToString(exact)}, which is ${moneyToString(total)} to the cent.`;
  }

  const parts = splitCommission(total, event.shares);
  return {
    ok: true,
    total,
    parts: parts.map((part) => ({
      ...part,
      explanation: `${explanation} ${part.explanation}`,
    })),
    explanation,
  };
}

/**
 * Split one job's commission across the people who did it.
 *
 * `allocate`, not division. See the note on `computeCommission`.
 */
export function splitCommission(
  total: Money,
  shares: readonly CommissionShare[],
): { personId: string; amount: Money; explanation: string }[] {
  // Made payable before it is divided, for the reason set out above: parts
  // that are already whole cents are the only parts that can add back to the
  // whole after they have been paid.
  const payable = round(total, 2);
  const amounts = allocate(payable, shares.map((s) => s.weight), 2);
  const weights = shares.map((s) => s.weight).join(" to ");
  return shares.map((share, index) => ({
    personId: share.personId,
    amount: amounts[index] ?? zero(total.currency),
    explanation: shares.length === 1
      ? "All of it."
      : `Split ${weights} between ${shares.length} people, which puts ${moneyToString(amounts[index] ?? zero(payable.currency))} here. The parts add back to ${moneyToString(payable)} exactly; the odd cent goes to the largest share rather than disappearing.`,
  }));
}

/* ------------------------------------------------------------- clawback */

export type CreditReason = "refund" | "credit_note" | "write_off" | "callback";

export interface CreditEvent {
  id: string;
  commissionEventId: string;
  /** When the credit happened, which is usually not when the job did. */
  occurredAt: Date;
  reason: CreditReason;
  /** How much of the revenue came back off. */
  creditedRevenue: Money;
  /** How much of the cost came back off with it, if any. */
  creditedCost?: Money | undefined;
}

export interface ClawbackLine {
  personId: string;
  /** Negative. What this person's commission should give back. */
  amount: Money;
  explanation: string;
}

export type ClawbackVerdict =
  | { ok: true; total: Money; lines: ClawbackLine[]; explanation: string }
  | { ok: false; reason: string };

/**
 * A commission is a claim on an invoice, so when the invoice is credited or
 * written off the commission has to follow it.
 *
 * Every field service product this project looked at gets this wrong in the
 * same way: the commission is computed once when the job closes and then
 * never looked at again. The customer disputes the bill in April, the money
 * goes back, and the technician keeps eight per cent of a job the company was
 * never paid for. It is not malice, it is that nothing in the system connects
 * the two events.
 *
 * The clawback is computed by RECOMPUTING the commission against what the
 * invoice actually came to, and taking the difference, rather than by
 * applying the rate to the credit. Those two are the same number for a simple
 * percentage and are not the same number for anything with a floor, a tier or
 * a margin, and recomputing is the one that stays right when the plan gets
 * more complicated.
 *
 * The split is recomputed from the same shares and then differenced per
 * person, so each technician gives back exactly their own part and the parts
 * still add back to the whole.
 */
export function clawbackFor(
  plan: CommissionPlan,
  original: CommissionEvent,
  credit: CreditEvent,
): ClawbackVerdict {
  const before = computeCommission(plan, original);
  if (!before.ok) return before;

  if (credit.creditedRevenue.currency !== original.revenue.currency) {
    return { ok: false, reason: `The credit on job ${original.jobId} is in ${credit.creditedRevenue.currency} and the job is in ${original.revenue.currency}.` };
  }

  const reduced: CommissionEvent = {
    ...original,
    revenue: subtract(original.revenue, credit.creditedRevenue),
    ...(original.cost
      ? { cost: credit.creditedCost ? subtract(original.cost, credit.creditedCost) : original.cost }
      : {}),
    ...(original.collected
      ? { collected: subtract(original.collected, credit.creditedRevenue) }
      : {}),
  };

  /**
   * A flat per job plan is the awkward one. Crediting half an invoice does
   * not halve a flat amount, so the recomputation returns the same flat
   * figure and nothing is clawed back unless the whole job went away. That is
   * the correct behaviour for the basis as declared, and it is named here
   * because it surprises people.
   */
  const after = plan.basis === "flat_per_job" && isZero(reduced.revenue)
    ? ({ ok: true, total: zero(original.revenue.currency), parts: original.shares.map((s) => ({ personId: s.personId, amount: zero(original.revenue.currency), explanation: "" })), explanation: "" } as CommissionVerdict)
    : computeCommission(plan, reduced);
  if (!after.ok) return after;

  const lines: ClawbackLine[] = before.parts.map((part, index) => {
    const now = after.ok ? (after.parts[index]?.amount ?? zero(part.amount.currency)) : zero(part.amount.currency);
    const delta = subtract(now, part.amount);
    return {
      personId: part.personId,
      amount: delta,
      explanation: `Job ${original.jobId} was ${REASON_WORDS[credit.reason]} for ${moneyToString(credit.creditedRevenue)}. The commission on it recomputes from ${moneyToString(part.amount)} to ${moneyToString(now)}, so ${moneyToString(delta)} comes back.`,
    };
  });

  const total = lines.reduce((acc, line) => add(acc, line.amount), zero(original.revenue.currency));
  return {
    ok: true,
    total,
    lines,
    explanation: `Commission on job ${original.jobId} recomputed after a ${REASON_WORDS[credit.reason]} of ${moneyToString(credit.creditedRevenue)}: ${moneyToString(before.total)} becomes ${moneyToString(after.total)}.`,
  };
}

const REASON_WORDS: Record<CreditReason, string> = {
  refund: "refunded",
  credit_note: "credited",
  write_off: "written off",
  callback: "credited after a callback",
};

/* ----------------------------------------------------------- pay periods */

/**
 * A pay period, declared in CALENDAR terms and turned into instants here.
 *
 * Declared as a start date and a number of whole workweeks rather than as two
 * instants, for two reasons.
 *
 * First, overtime is measured over a workweek and only over a workweek. A
 * period that cuts a workweek in half cannot be settled: half the hours that
 * decide whether Thursday was overtime are in the other period, which may
 * already be closed and filed. Semimonthly periods, the fifteenth and the
 * last day of the month, do exactly this, which is why they are refused here
 * rather than half supported.
 *
 * Second, the instants have to be derived with `daysFrom`, which knows that a
 * week containing a clock change is 167 or 169 hours. A period whose end is
 * computed as the start plus seven times 864e5 is an hour short twice a year,
 * and the shift in that hour falls out of the period entirely: a technician
 * works a Saturday night and it is on nobody's payroll.
 */
export interface PayPeriod {
  id: string;
  label: string;
  /** The first calendar date of the period, in the policy's zone. */
  startDate: string;
  /** How many whole workweeks it covers. */
  weeks: number;
}

export function periodBounds(period: PayPeriod, policy: OvertimePolicy): { start: Date; end: Date } {
  return daysFrom(period.startDate, period.weeks * 7, policy.timeZone);
}

export function checkPeriod(period: PayPeriod, policy: OvertimePolicy): PolicyVerdict {
  const refusals: Refusal[] = [];
  if (!Number.isInteger(period.weeks) || period.weeks < 1) {
    refusals.push({
      code: "period_not_whole_workweeks",
      message: `Pay period ${period.id} covers ${String(period.weeks)} weeks. A period is a whole number of workweeks or overtime cannot be settled in it.`,
    });
  }
  const startWeek = weekStartDate(period.startDate, policy.weekStartsOn);
  if (startWeek !== period.startDate) {
    refusals.push({
      code: "period_not_whole_workweeks",
      message: `Pay period ${period.id} starts on ${period.startDate}, and the workweek under this policy starts on a ${WEEKDAY_NAMES[policy.weekStartsOn]}, most recently ${startWeek}. Overtime is measured over a whole workweek, so a period that begins mid week would have to decide what to do with hours sitting in the other half, which may already be closed. Move the period to ${startWeek}, or change the workweek.`,
    });
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true };
}

/* ------------------------------------------------------------- statement */

export type StatementLineKind =
  | "regular" | "overtime" | "double_time" | "on_call"
  | "salary" | "commission" | "commission_clawback" | "clawback_carried_forward";

export interface StatementLine {
  kind: StatementLineKind;
  label: string;
  /**
   * Why this number is this number, in a sentence the person being paid can
   * check against their own memory of the week. The first thing a technician
   * does with a statement is check it and the second is ask, and a line that
   * cannot answer the question turns into a phone call to an office manager
   * who also cannot answer it.
   */
  explanation: string;
  seconds?: number | undefined;
  rate?: Money | undefined;
  /** Paid to the cent. The lines on a statement have to add up as printed. */
  amount: Money;
}

export interface PayStatement {
  personId: string;
  period: PayPeriod;
  periodStart: Date;
  periodEnd: Date;
  lines: StatementLine[];
  /** The sum of the lines as printed, to the cent. */
  gross: Money;
  /**
   * A clawback the period could not absorb without taking gross below zero.
   * Carried rather than applied, and surfaced rather than hidden.
   */
  carriedForward: Money;
  weeks: WeekClassification[];
  warnings: string[];
}

export type StatementVerdict =
  | { ok: true; statement: PayStatement }
  | { ok: false; refusals: Refusal[] };

export interface StatementInput {
  personId: string;
  period: PayPeriod;
  policy: OvertimePolicy;
  basis: PayBasis;
  entries: readonly TimeEntry[];
  /**
   * Already computed and split. Only this person's parts are used, and only
   * the ones whose `occurredAt` falls inside this period.
   *
   * The period filter is not a convenience. A caller handing this function a
   * person's whole commission history, which is the obvious thing to hand it,
   * would otherwise be paid every commission they have ever earned in every
   * period that is run, forever.
   */
  commissions?: readonly { eventId: string; part: CommissionPart; occurredAt: Date }[] | undefined;
  /**
   * `occurredAt` is when the CREDIT happened and decides which period the
   * reversal lands in. `earnedAt` is when the original commission was earned
   * and is carried only so the technician can see which job it came from.
   */
  clawbacks?: readonly { creditId: string; line: ClawbackLine; occurredAt: Date; earnedAt: Date }[] | undefined;
  currency?: string | undefined;
  now: Date;
}

/**
 * Assemble one person's pay for one period.
 *
 * The refusals are the feature. Every one of them is a case where this
 * function could return a plausible looking number instead, and the number
 * would be wrong in a way that only the person being paid would notice.
 *
 * The one that matters most: AN OPEN TIME ENTRY IS NOT ZERO HOURS. A
 * technician who forgot to clock out at the end of a job has worked those
 * hours. Summing entries and skipping the open one produces a statement that
 * is short by however long that job took, and it is short silently, because
 * nothing about the total says a punch is missing. Refusing forces somebody
 * to look at the entry and close it at the time the work actually ended,
 * which is the only thing that produces a correct number.
 */
export function buildStatement(input: StatementInput): StatementVerdict {
  const { personId, period, policy, basis, now } = input;
  const currency = input.currency
    ?? (basis.kind === "hourly" ? basis.baseRate.currency : basis.perPeriod.currency);
  const refusals: Refusal[] = [];

  const policyCheck = checkOvertimePolicy(policy);
  if (!policyCheck.ok) refusals.push(...policyCheck.refusals);
  const periodCheck = checkPeriod(period, policy);
  if (!periodCheck.ok) refusals.push(...periodCheck.refusals);
  if (refusals.length > 0) return { ok: false, refusals };

  const bounds = periodBounds(period, policy);

  const mine = input.entries
    .filter((entry) => entry.personId === personId)
    .filter((entry) =>
      entry.startedAt.getTime() >= bounds.start.getTime()
      && entry.startedAt.getTime() < bounds.end.getTime());

  const entryCheck = checkEntries(mine, now);
  if (!entryCheck.ok) refusals.push(...entryCheck.refusals);

  for (const entry of mine) {
    if (entry.endedAt === null) {
      refusals.push({
        code: "entry_still_open",
        message: `${personId} is still clocked in on entry ${entry.id}, which started at ${entry.startedAt.toISOString()}. This period cannot be assembled while a punch is open. Paying an open entry as zero would be short by however long that job actually took, and nothing on the statement would say so. Close it at the time the work finished.`,
        entryIds: [entry.id],
      });
    }
  }

  if (basis.kind === "salary" && basis.overtimeEligible) {
    refusals.push({
      code: "salary_overtime_not_supported",
      message: `${personId} is on a salary and marked overtime eligible. Working out a premium from a salary means first deriving a regular hourly rate from it, and there is more than one accepted way to do that depending on what the salary was agreed to cover. This module will not pick one on the operator's behalf. Put them on an hourly basis with the agreed rate, or take advice and record that.`,
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const weeks = classifyWeeks(mine, policy);
  const lines: StatementLine[] = [];
  const warnings: string[] = [];

  if (basis.kind === "hourly") {
    const otRate = overtimeRate(basis.baseRate, policy.overtimeMultiplier);
    const dtRate = overtimeRate(basis.baseRate, policy.doubleTimeMultiplier);

    for (const week of weeks) {
      const weekLabel = `week of ${week.weekStartDate}`;
      if (week.regularSeconds > 0) {
        lines.push({
          kind: "regular",
          label: `Regular hours, ${weekLabel}`,
          explanation: `${hoursOf(week.regularSeconds)} hours at ${moneyToString(basis.baseRate)} an hour. ${week.explanations.join(" ")}`.trim(),
          seconds: week.regularSeconds,
          rate: basis.baseRate,
          amount: round(payFor(basis.baseRate, week.regularSeconds), 2),
        });
      }
      if (week.overtimeSeconds > 0) {
        lines.push({
          kind: "overtime",
          label: `Overtime, ${weekLabel}`,
          explanation: `${hoursOf(week.overtimeSeconds)} hours at ${moneyToString(otRate)} an hour, which is ${moneyToString(basis.baseRate)} times ${policy.overtimeMultiplier}. The overtime rate is worked out from the base rate rather than kept separately, so a change to one cannot leave the other behind. ${week.explanations.join(" ")}`.trim(),
          seconds: week.overtimeSeconds,
          rate: otRate,
          amount: round(payFor(otRate, week.overtimeSeconds), 2),
        });
      }
      if (week.doubleTimeSeconds > 0) {
        lines.push({
          kind: "double_time",
          label: `Double time, ${weekLabel}`,
          explanation: `${hoursOf(week.doubleTimeSeconds)} hours at ${moneyToString(dtRate)} an hour, which is ${moneyToString(basis.baseRate)} times ${policy.doubleTimeMultiplier}.`,
          seconds: week.doubleTimeSeconds,
          rate: dtRate,
          amount: round(payFor(dtRate, week.doubleTimeSeconds), 2),
        });
      }
      if (week.onCallSeconds > 0) {
        const onCall = basis.onCallRate ?? basis.baseRate;
        lines.push({
          kind: "on_call",
          label: `On call, ${weekLabel}`,
          explanation: `${hoursOf(week.onCallSeconds)} hours carrying the phone at ${moneyToString(onCall)} an hour. Under this policy on call time is paid at its own rate and is not counted as hours worked toward the overtime thresholds.`,
          seconds: week.onCallSeconds,
          rate: onCall,
          amount: round(payFor(onCall, week.onCallSeconds), 2),
        });
      }
    }
  } else {
    lines.push({
      kind: "salary",
      label: "Salary",
      explanation: `${moneyToString(basis.perPeriod)} for ${period.label}. Hours are still recorded and still shown below, because a salary is not a reason to stop knowing how long the work took.`,
      amount: round(basis.perPeriod, 2),
    });
    const worked = weeks.reduce((acc, w) => acc + w.regularSeconds + w.overtimeSeconds + w.doubleTimeSeconds, 0);
    if (worked > 0) {
      warnings.push(`${hoursOf(worked)} hours were recorded against a salary that does not vary with them.`);
    }
  }

  /**
   * A commission or a credit belongs to the period it HAPPENED in, which is
   * what `occurredAt` records on both. Nothing else decides it: not the job
   * date, not the order the caller happened to pass them in.
   */
  const inPeriod = (instant: Date): boolean =>
    instant.getTime() >= bounds.start.getTime() && instant.getTime() < bounds.end.getTime();

  for (const commission of input.commissions ?? []) {
    if (commission.part.personId !== personId) continue;
    if (!inPeriod(commission.occurredAt)) continue;
    if (commission.part.amount.currency !== currency) {
      return {
        ok: false,
        refusals: [{
          code: "currency_mismatch",
          message: `Commission ${commission.eventId} is in ${commission.part.amount.currency} and this statement is in ${currency}. Converting it here would bake a rate nobody chose into somebody's wages.`,
        }],
      };
    }
    if (isZero(commission.part.amount)) continue;
    lines.push({
      kind: "commission",
      label: `Commission, ${commission.eventId}`,
      explanation: commission.part.explanation,
      amount: round(commission.part.amount, 2),
    });
  }

  /**
   * CLAWBACKS LAND IN THE PERIOD THE CREDIT HAPPENED IN, NOT THE ONE THE
   * COMMISSION WAS PAID IN.
   *
   * This is the question the brief about clawbacks always comes down to, and
   * the answer is not a preference. The earlier period is closed. It was
   * paid, tax was withheld on the amount paid, and that withholding was
   * remitted and reported. Reaching back into it means amending a filing, and
   * in the meantime the technician's year to date figures disagree with the
   * ones the tax authority holds. So the clawback is a NEGATIVE LINE IN THE
   * CURRENT PERIOD, carrying the date of the original commission on it so the
   * technician can see which job it came from, and the earlier statement
   * stands as issued.
   *
   * And a clawback may not drive this period's gross negative. That is not
   * arithmetic squeamishness: recovering an overpayment out of wages already
   * earned is constrained in most places, sometimes to nothing, and a payroll
   * run that hands somebody a negative cheque has already made that decision
   * for the operator. What cannot be absorbed is carried forward and shown,
   * so a person decides.
   */
  let carriedForward = zero(currency);
  for (const clawback of input.clawbacks ?? []) {
    if (clawback.line.personId !== personId) continue;
    if (!inPeriod(clawback.occurredAt)) continue;
    if (isZero(clawback.line.amount)) continue;
    if (clawback.line.amount.currency !== currency) {
      return {
        ok: false,
        refusals: [{
          code: "currency_mismatch",
          message: `Commission reversal ${clawback.creditId} is in ${clawback.line.amount.currency} and this statement is in ${currency}. Converting it here would bake a rate nobody chose into somebody's wages, and it would do it to money being taken back off them.`,
        }],
      };
    }
    const later = clawback.earnedAt.getTime() < bounds.start.getTime();
    lines.push({
      kind: "commission_clawback",
      label: `Commission reversed, ${clawback.creditId}`,
      explanation: later
        ? `${clawback.line.explanation} The commission was earned on ${dateIn(clawback.earnedAt, policy.timeZone)}, in a pay period that is already closed and filed. It is taken off this period rather than reopening that one, because the earlier statement was paid and its tax was withheld and remitted on the amount shown.`
        : clawback.line.explanation,
      amount: round(clawback.line.amount, 2),
    });
  }

  let gross = lines.reduce((acc, line) => add(acc, line.amount), zero(currency));

  if (isNegative(gross)) {
    /**
     * Pull back exactly enough of the clawback to land on zero and carry the
     * rest. The clawback lines are adjusted in place so the printed lines
     * still add to the printed gross, because a statement whose lines do not
     * add up is worse than one with an awkward number on it.
     */
    carriedForward = gross;
    let shortfall = negateMoney(gross);
    for (let i = lines.length - 1; i >= 0 && !isZero(shortfall); i -= 1) {
      const line = lines[i]!;
      if (line.kind !== "commission_clawback") continue;
      const magnitude = negateMoney(line.amount);
      const relief = compare(magnitude, shortfall) <= 0 ? magnitude : shortfall;
      lines[i] = {
        ...line,
        amount: add(line.amount, relief),
        explanation: `${line.explanation} Only ${moneyToString(subtract(magnitude, relief))} of this could be taken out of this period without the statement going negative. ${moneyToString(relief)} is carried forward and somebody has to decide whether it may lawfully be recovered from future wages at all.`,
      };
      shortfall = subtract(shortfall, relief);
    }
    /**
     * Printed at zero, on purpose. It carries no money, so the lines still
     * add to the gross, and it puts the carried amount where a technician
     * actually looks, which is the list of lines rather than a warnings array
     * a payroll screen may or may not render.
     */
    lines.push({
      kind: "clawback_carried_forward",
      label: "Commission reversal carried forward",
      explanation: `${moneyToString(negateMoney(carriedForward))} of a commission reversal was more than this period could absorb without the statement going negative, so it was not taken here. It carries forward, and somebody has to decide whether it may lawfully be recovered from future wages at all. This line is shown at zero so the amount is visible and the lines above still add to the gross.`,
      amount: zero(currency),
    });
    gross = lines.reduce((acc, line) => add(acc, line.amount), zero(currency));
    warnings.push(`A commission reversal of ${moneyToString(negateMoney(carriedForward))} was more than this period could absorb. It has been carried forward rather than issuing a negative statement.`);
  }

  return {
    ok: true,
    statement: {
      personId,
      period,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      lines,
      gross,
      carriedForward,
      weeks,
      warnings,
    },
  };
}

const negateMoney = (m: Money): Money => subtract(zero(m.currency), m);

/** The instant a calendar date begins in the policy's zone. Re exported for callers assembling periods. */
export const startOfPolicyDay = (date: string, policy: OvertimePolicy): Date =>
  startOfDayIn(date, policy.timeZone);
