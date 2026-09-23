import {
  type Money,
  type CurrencyCode,
  add,
  divide,
  zero,
  toString as moneyToString,
} from "../money/index.js";
import {
  type RecurrenceSpec,
  addDays,
  compareDates,
  nextOccurrence,
  parseDate,
} from "../recurrence/index.js";

/**
 * FLEET, TOOLS AND COMPANY ASSETS: THE DECISION LOGIC
 *
 * The problem in the words a contractor uses: a technician leaves and there is
 * thirty thousand dollars of tools in their truck that nobody has a list of.
 * A boom lift needs its 250 hour service and nobody knows what the meter said.
 * A van goes out of warranty and a four thousand dollar repair that would have
 * been covered gets paid in cash. A thermal imager is eight months out of
 * calibration and the moisture reports it produced in that time are the ones
 * an insurer is now disputing.
 *
 * All of that is one shape of problem: the company owns things, the things
 * move, wear out and expire, and nothing writes any of it down.
 *
 * Everything here is a pure function. No database, no clock, no I/O. `now` is
 * a parameter everywhere it matters, because a maintenance projection that
 * reads the wall clock cannot be tested, cannot be replayed, and cannot answer
 * "what did the board look like on the first of the month" when somebody asks
 * why nobody was warned.
 *
 * THE THREE IDEAS THAT CARRY THE FILE
 *
 *   1. CUSTODY IS A HISTORY, NOT A FIELD. Same argument the inventory module
 *      makes about stock levels: a mutable "current holder" column is a value
 *      nobody can explain when it is wrong, and it will be wrong, because two
 *      people will hand the same thermal imager on in the same afternoon. The
 *      current holder is a fold over an append only assignment history, and an
 *      incoherent history is refused rather than silently resolved.
 *
 *   2. A TIME INTERVAL AND A METER INTERVAL ARE DIFFERENT PROBLEMS. "Every six
 *      months" is a recurrence and goes through ../recurrence/index.js, which
 *      already knows about seasonal anchoring, exceptions, and counting from
 *      actual completion rather than from the scheduled date. "Every 250
 *      hours" cannot go through it at all, for reasons spelled out at
 *      `meterDue` below, and the honest output for a meter interval is
 *      sometimes "I cannot tell you" rather than a date.
 *
 *   3. A PROJECTION IS A GUESS AND MUST SAY SO. Every projected due date here
 *      carries how many readings it came from, over how many days, and a
 *      caveat in words. A due date printed with no provenance gets treated as
 *      a fact, and the first time somebody plans a week of work around one
 *      built from two readings taken nine days apart, the projection loses all
 *      of its credibility rather than the number losing some of its weight.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not depreciate anything. Depreciation is an accounting policy with
 * tax consequences, it belongs next to the ledger, and a second module that
 * thinks it knows the book value of a van is a second answer that will drift
 * from the first. It does not decide who is allowed to check a tool out
 * either: that is the access module's job.
 */

// ---------------------------------------------------------------------------
// What an asset is
// ---------------------------------------------------------------------------

/** What kind of counter an asset carries, if it carries one at all. */
export type MeterUnit = "hours" | "miles" | "kilometres" | "cycles";

export const METER_UNITS: Record<
  MeterUnit,
  { readonly label: string; readonly short: string; readonly maxPerDay: number }
> = {
  /**
   * 24 is not a guess or a policy, it is the number of hours in a day. A run
   * hour meter that gains more than 24 hours in a day has been misread, has
   * been typed into the wrong asset, or has been replaced without anybody
   * saying so. Accepting it moves the next service due date months out and
   * the failure shows up as a seized machine, not as a bad row.
   */
  hours: { label: "Engine or run hours", short: "h", maxPerDay: 24 },
  /** A service van doing more than this in a day is a typo, usually a digit. */
  miles: { label: "Odometer miles", short: "mi", maxPerDay: 1200 },
  kilometres: { label: "Odometer kilometres", short: "km", maxPerDay: 2000 },
  cycles: { label: "Counted cycles", short: "cycles", maxPerDay: 20000 },
};

/** A date obligation that can expire and stop something happening. */
export type ComplianceKind = "registration" | "inspection" | "insurance" | "calibration";

export const ASSET_KINDS = [
  "vehicle",
  "powered_tool",
  "hand_tool",
  "instrument",
  "trailer",
  "equipment",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetKindProfile {
  readonly label: string;
  /**
   * What actually makes this kind different to manage. Not decoration: the
   * screen has to tell somebody why a thermal imager asks for a calibration
   * date and a pipe wrench does not.
   */
  readonly distinguishedBy: string;
  /** The counter this kind wears out by, or null when it wears out by time. */
  readonly meter: MeterUnit | null;
  /**
   * Whether each unit gets its own record and its own label.
   *
   * Twenty core drills are twenty records because any one of them can be the
   * one that does not come back. A box of screwdrivers is a quantity, because
   * serialising a screwdriver costs more than the screwdriver, and a register
   * that demands it is a register nobody fills in.
   */
  readonly trackedIndividually: boolean;
  /**
   * Whether custody normally sits with a PERSON rather than a PLACE. This is
   * the difference between "who has it" and "where is it", and getting it
   * backwards is how a trailer gets marked as being in somebody's pocket.
   */
  readonly travelsWithATechnician: boolean;
  readonly obligations: readonly ComplianceKind[];
}

export const ASSET_KIND_PROFILES: Record<AssetKind, AssetKindProfile> = {
  vehicle: {
    label: "Vehicle",
    distinguishedBy:
      "Registered with the state, insured, inspected, and metered in miles. It is the only kind that can be legally forbidden from leaving the yard.",
    meter: "miles",
    trackedIndividually: true,
    travelsWithATechnician: true,
    obligations: ["registration", "inspection", "insurance"],
  },
  powered_tool: {
    label: "Powered tool",
    distinguishedBy:
      "Wears out by run time rather than by age, walks off in a truck, and is worth enough that losing one is a line on the P and L.",
    meter: "hours",
    trackedIndividually: true,
    travelsWithATechnician: true,
    obligations: [],
  },
  hand_tool: {
    label: "Hand tool",
    distinguishedBy:
      "No meter, no obligations, and cheap enough per unit that it is counted rather than serialised. It matters in bulk, at handover, not one at a time.",
    meter: null,
    trackedIndividually: false,
    travelsWithATechnician: true,
    obligations: [],
  },
  instrument: {
    label: "Measuring instrument",
    distinguishedBy:
      "Produces NUMBERS that go into reports somebody relies on. Its calibration date is not paperwork, it is what makes those numbers mean anything.",
    meter: null,
    trackedIndividually: true,
    travelsWithATechnician: true,
    obligations: ["calibration"],
  },
  trailer: {
    label: "Trailer",
    distinguishedBy:
      "Registered and inspected like a vehicle but has no engine and no meter, so its service interval can only ever be by time or by inspection.",
    meter: null,
    trackedIndividually: true,
    travelsWithATechnician: false,
    obligations: ["registration", "inspection"],
  },
  equipment: {
    label: "Heavy equipment",
    distinguishedBy:
      "Metered in hours, inspected annually, and usually sits at a yard or a site rather than in anybody's truck. The most expensive thing to have idle.",
    meter: "hours",
    trackedIndividually: true,
    travelsWithATechnician: false,
    obligations: ["inspection"],
  },
};

export interface Asset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly label: string;
  /** Serial, VIN or asset tag. Absent for a pooled hand tool record. */
  readonly identifier?: string;
  readonly acquiredOn?: string;
  readonly retiredOn?: string;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every decision below either succeeds or refuses, and a refusal carries the
 * numbers somebody needs to fix it. "Invalid reading" sends a dispatcher to go
 * and look at a screen; "the meter read 4,812 on 3 March and 91 on 4 March, so
 * either it was misread or it was replaced" tells them which of the two
 * buttons to press.
 */
export type AssetRefusal =
  | { ok: false; reason: "custody_overlap"; assetId: string; first: CustodyAssignment; second: CustodyAssignment }
  | { ok: false; reason: "custody_ends_before_it_starts"; assignment: CustodyAssignment }
  | { ok: false; reason: "custody_history_mixes_assets"; expected: string; found: string }
  | { ok: false; reason: "reading_not_a_whole_number"; assetId: string; value: number }
  | { ok: false; reason: "reading_negative"; assetId: string; value: number }
  | { ok: false; reason: "reading_unit_mismatch"; assetId: string; expected: MeterUnit; found: MeterUnit }
  | { ok: false; reason: "reading_out_of_order"; assetId: string; takenOn: string; latestOn: string }
  | { ok: false; reason: "reading_in_the_future"; assetId: string; takenOn: string; now: string }
  | { ok: false; reason: "reading_goes_backwards"; assetId: string; previous: number; found: number; previousOn: string; takenOn: string }
  | { ok: false; reason: "reset_rewinds_the_old_meter"; assetId: string; previous: number; declaredFinal: number }
  | { ok: false; reason: "implausible_jump"; assetId: string; unit: MeterUnit; gained: number; overDays: number; perDay: number; maxPerDay: number }
  | { ok: false; reason: "not_enough_readings"; assetId: string; from: string; to: string; found: number }
  | { ok: false; reason: "no_recorded_use"; assetId: string; unit: MeterUnit; from: string; to: string; detail: string };

/** The refusal in the sentence an office manager would actually say. */
export function explainRefusal(refusal: AssetRefusal): string {
  switch (refusal.reason) {
    case "custody_overlap":
      return (
        `${refusal.assetId} is recorded as being with ${custodianLabel(refusal.first)} from ${refusal.first.from} ` +
        `and with ${custodianLabel(refusal.second)} from ${refusal.second.from}, and the first hand over was never closed. ` +
        `One thing cannot be in two places. Close the earlier assignment on the day it really ended.`
      );
    case "custody_ends_before_it_starts":
      return (
        `An assignment of ${refusal.assignment.assetId} to ${custodianLabel(refusal.assignment)} runs from ` +
        `${refusal.assignment.from} until ${String(refusal.assignment.until)}, which is backwards.`
      );
    case "custody_history_mixes_assets":
      return `This custody history is for ${refusal.expected} but contains an assignment of ${refusal.found}. Two assets cannot share one history.`;
    case "reading_not_a_whole_number":
      return (
        `A meter reading of ${refusal.value} was recorded against ${refusal.assetId}. Readings are whole units as they appear ` +
        `on the face of the meter, because a fraction here becomes float arithmetic that later divides money.`
      );
    case "reading_negative":
      return `A meter reading of ${refusal.value} was recorded against ${refusal.assetId}. A meter does not read below zero.`;
    case "reading_unit_mismatch":
      return `${refusal.assetId} is metered in ${refusal.expected} and a reading arrived in ${refusal.found}. One of the two is against the wrong asset.`;
    case "reading_out_of_order":
      return (
        `A reading dated ${refusal.takenOn} arrived for ${refusal.assetId} after one dated ${refusal.latestOn}. ` +
        `Readings are accepted in order, because usage between two of them is meaningless if the order is guessed.`
      );
    case "reading_in_the_future":
      return `A reading for ${refusal.assetId} is dated ${refusal.takenOn}, which is after today, ${refusal.now}. Check the date on the device that sent it.`;
    case "reading_goes_backwards":
      return (
        `${refusal.assetId} read ${refusal.previous} on ${refusal.previousOn} and ${refusal.found} on ${refusal.takenOn}. ` +
        `A meter does not run backwards. If the meter was replaced, record this reading as a declared reset with what the old one ` +
        `finally read, so the hours already run are not thrown away. If it was misread, correct the number.`
      );
    case "reset_rewinds_the_old_meter":
      return (
        `${refusal.assetId} was already recorded at ${refusal.previous}, and the reset says the old meter finally read ` +
        `${refusal.declaredFinal}. The old meter cannot have run backwards either. The final reading is the highest it ever showed.`
      );
    case "implausible_jump":
      return (
        `${refusal.assetId} gained ${refusal.gained} ${refusal.unit} over ${refusal.overDays} day(s), which is ` +
        `${refusal.perDay.toFixed(1)} a day against a ceiling of ${refusal.maxPerDay}. ` +
        `Either a digit was mistyped, the reading belongs to a different asset, or the meter was replaced and nobody said so.`
      );
    case "not_enough_readings":
      return (
        `${refusal.assetId} has ${refusal.found} reading(s) between ${refusal.from} and ${refusal.to}. ` +
        `Usage is the difference between two readings, so one reading is not usage and no readings is not zero usage.`
      );
    case "no_recorded_use":
      return (
        `${refusal.assetId} has no recorded ${refusal.unit} between ${refusal.from} and ${refusal.to}, so a cost per ` +
        `${refusal.unit.replace(/s$/, "")} would be a division by zero. ${refusal.detail}`
      );
  }
}

// ---------------------------------------------------------------------------
// Dates. Calendar days throughout, never timestamps.
// ---------------------------------------------------------------------------

/**
 * Whole days between two calendar dates. Built on the recurrence module's
 * parser so that a malformed date is rejected in exactly one place, and so
 * that nothing here ever constructs a Date out of a raw string and inherits
 * the local timezone of whatever machine is running.
 */
export const daysBetween = (from: string, to: string): number =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);

const isWeekend = (date: string): boolean => {
  const day = parseDate(date).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * The last working day on or before a date.
 *
 * Deliberately moves BACKWARDS and never forwards. Every date in the
 * compliance section is a deadline, and the counties, inspection stations and
 * calibration labs that clear them are shut at the weekend. Rolling a renewal
 * deadline forward to Monday is renewing it after it expired, which is the
 * exact failure the warning exists to prevent: the van is off the road on
 * Monday morning either way.
 *
 * Public holidays are not modelled. They are per country, per state and
 * sometimes per county, they need a table somebody maintains, and getting them
 * wrong by one day in the safe direction is survivable where getting the
 * weekend wrong is not.
 */
export function lastWorkingDayOnOrBefore(date: string): string {
  let cursor = date;
  let guard = 0;
  while (isWeekend(cursor) && guard++ < 7) cursor = addDays(cursor, -1);
  return cursor;
}

// ---------------------------------------------------------------------------
// 1. Custody: where the thing is, as an append only history
// ---------------------------------------------------------------------------

export type CustodianKind = "technician" | "location" | "job";

/**
 * One period during which one asset was with one custodian.
 *
 * Half open, `[from, until)`, for the same reason the time module's day bounds
 * are: the alternative is deciding what happens on the day of a handover, and
 * every answer to that double counts or loses a day. A handover on the 4th
 * means the old assignment runs until the 4th and the new one starts on the
 * 4th, and the asset is in exactly one place on the 4th.
 *
 * `until` absent means the assignment is open: they still have it.
 *
 * THIS IS NEVER EDITED. A mistaken assignment is corrected by closing it and
 * opening the true one, so the record of what people believed at the time
 * survives. When a technician leaves and the imager is not in the box, the
 * question is "who had it, when, and who said so", and an overwritten field
 * cannot answer any part of it.
 */
export interface CustodyAssignment {
  readonly assetId: string;
  readonly custodianKind: CustodianKind;
  readonly custodianId: string;
  readonly from: string;
  readonly until?: string | undefined;
  readonly recordedBy?: string | undefined;
  readonly note?: string | undefined;
}

const custodianLabel = (a: CustodyAssignment): string => `${a.custodianKind} ${a.custodianId}`;

const byFrom = (a: CustodyAssignment, b: CustodyAssignment): number => compareDates(a.from, b.from);

export type CustodyHistoryCheck =
  | { ok: true; ordered: readonly CustodyAssignment[] }
  | AssetRefusal;

/**
 * Is this history coherent?
 *
 * The check that earns its place is the OVERLAP. Two open assignments of one
 * asset is the ordinary way this goes wrong: a technician hands a core drill
 * to somebody on site and mentions it to the office, and nobody closes the
 * first assignment. With a mutable holder field the second write silently
 * wins and the first custodian is forgotten. Here it is refused, loudly, with
 * both assignments attached, because the fix is a two second edit if you find
 * out today and a thirty thousand dollar argument if you find out when
 * somebody resigns.
 *
 * A GAP between assignments is allowed and is not an error. An asset really
 * can sit in a yard unassigned, and refusing that would force people to invent
 * a fake custodian, which is worse than a truthful gap.
 */
export function checkCustodyHistory(history: readonly CustodyAssignment[]): CustodyHistoryCheck {
  if (history.length === 0) return { ok: true, ordered: [] };

  const expected = history[0]!.assetId;
  for (const assignment of history) {
    if (assignment.assetId !== expected) {
      return { ok: false, reason: "custody_history_mixes_assets", expected, found: assignment.assetId };
    }
    if (assignment.until != null && compareDates(assignment.until, assignment.from) < 0) {
      return { ok: false, reason: "custody_ends_before_it_starts", assignment };
    }
  }

  const ordered = [...history].sort(byFrom);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    // Half open: `until` equal to the next `from` is a clean handover, not an
    // overlap. Anything strictly later is two custodians at once.
    if (previous.until == null || compareDates(previous.until, current.from) > 0) {
      return { ok: false, reason: "custody_overlap", assetId: expected, first: previous, second: current };
    }
  }

  return { ok: true, ordered };
}

export type CustodyAt =
  | { ok: true; held: true; assignment: CustodyAssignment }
  | { ok: true; held: false; lastKnown: CustodyAssignment | null; explanation: string }
  | AssetRefusal;

/**
 * Who had it on a given day, derived every time from the history.
 *
 * There is no `currentCustodianId` anywhere in this module and there should be
 * no such column. The moment there is, some code path writes an assignment
 * without updating it, and from then on the register confidently names the
 * wrong person. It is always the same bug, it is always found by the person
 * who no longer works here, and it is the same argument the inventory module
 * makes about a stored `available`.
 */
export function custodyAt(history: readonly CustodyAssignment[], date: string): CustodyAt {
  const checked = checkCustodyHistory(history);
  if (!checked.ok) return checked;

  const ordered = checked.ordered;
  let lastKnown: CustodyAssignment | null = null;

  for (const assignment of ordered) {
    if (compareDates(assignment.from, date) > 0) break;
    lastKnown = assignment;
    const stillOpen = assignment.until == null || compareDates(date, assignment.until) < 0;
    if (stillOpen) return { ok: true, held: true, assignment };
  }

  return {
    ok: true,
    held: false,
    lastKnown,
    explanation: lastKnown
      ? `Nobody has ${lastKnown.assetId} on ${date}. It was last with ${custodianLabel(lastKnown)} until ${String(lastKnown.until)}.`
      : `There is no record of anybody holding this asset on or before ${date}.`,
  };
}

/** Everything one custodian was holding on a day, across many histories. */
export function heldBy(
  histories: readonly (readonly CustodyAssignment[])[],
  custodianKind: CustodianKind,
  custodianId: string,
  date: string,
): { assetIds: string[]; refusals: AssetRefusal[] } {
  const assetIds: string[] = [];
  const refusals: AssetRefusal[] = [];
  for (const history of histories) {
    const at = custodyAt(history, date);
    if (!at.ok) {
      refusals.push(at);
      continue;
    }
    if (at.held && at.assignment.custodianKind === custodianKind && at.assignment.custodianId === custodianId) {
      assetIds.push(at.assignment.assetId);
    }
  }
  return { assetIds, refusals };
}

// ---------------------------------------------------------------------------
// 3. Meter readings
// ---------------------------------------------------------------------------

/**
 * A meter that was replaced, declared rather than inferred.
 *
 * A replaced hour meter is a real and ordinary event: the gauge fails, it gets
 * swapped, and the new one starts at zero. The machine still has 4,812 hours
 * on it. Inferring a reset from a decrease is the tempting shortcut and it
 * throws all of them away, so the 250 hour service quietly restarts and the
 * asset's cost per hour doubles overnight for no reason anybody can find.
 *
 * So a decrease is REFUSED, and the way through is to declare what the old
 * meter finally read. That keeps cumulative usage continuous across the swap,
 * which is the only number that maintenance and cost per hour can both be
 * built on.
 *
 * ONE THING THIS SHAPE CANNOT SAY. The new meter is taken to have been fitted
 * at zero, so the reading on its face counts in full as use since the swap. A
 * second hand or preset gauge fitted at 1,200 would need a declared starting
 * value here, and adding that field is a schema decision rather than a logic
 * one. Until it exists, a preset gauge over counts by whatever it was preset
 * to, which is at least loud and in the direction of servicing early.
 */
export interface MeterReset {
  /** The highest the OLD meter ever showed, immediately before replacement. */
  readonly previousFinalValue: number;
  readonly reason: string;
}

export interface MeterReading {
  readonly assetId: string;
  readonly unit: MeterUnit;
  /** Whole units as they appear on the face of the meter. */
  readonly value: number;
  readonly takenOn: string;
  readonly source: "technician" | "telematics" | "invoice" | "import";
  readonly reset?: MeterReset | undefined;
}

export interface ReadingOptions {
  /** Today, in the company's zone. Absent means do not check for the future. */
  readonly now?: string | undefined;
  /** Override the per day ceiling, for something that genuinely runs harder. */
  readonly maxPerDay?: number | undefined;
}

export type ReadingOutcome =
  | { ok: true; reading: MeterReading; unitsSincePrevious: number }
  | AssetRefusal;

/**
 * Accept one reading against the history already accepted.
 *
 * The plausibility ceiling is the guard people argue about and it is the one
 * that pays for itself. A technician typing 48122 for 4812 on a machine that
 * services every 250 hours pushes the next service out by more than a hundred
 * years, and nothing else in the system will ever flag it, because from that
 * point every later reading looks like it goes backwards and gets refused for
 * the wrong reason. Catching it at the keyboard is the only cheap moment.
 */
export function acceptReading(
  history: readonly MeterReading[],
  candidate: MeterReading,
  options: ReadingOptions = {},
): ReadingOutcome {
  if (!Number.isInteger(candidate.value)) {
    return { ok: false, reason: "reading_not_a_whole_number", assetId: candidate.assetId, value: candidate.value };
  }
  if (candidate.value < 0) {
    return { ok: false, reason: "reading_negative", assetId: candidate.assetId, value: candidate.value };
  }
  if (options.now && compareDates(candidate.takenOn, options.now) > 0) {
    return { ok: false, reason: "reading_in_the_future", assetId: candidate.assetId, takenOn: candidate.takenOn, now: options.now };
  }

  const mine = [...history].filter((r) => r.assetId === candidate.assetId).sort((a, b) => compareDates(a.takenOn, b.takenOn));
  const previous = mine[mine.length - 1];
  if (!previous) return { ok: true, reading: candidate, unitsSincePrevious: 0 };

  if (previous.unit !== candidate.unit) {
    return { ok: false, reason: "reading_unit_mismatch", assetId: candidate.assetId, expected: previous.unit, found: candidate.unit };
  }
  if (compareDates(candidate.takenOn, previous.takenOn) < 0) {
    return { ok: false, reason: "reading_out_of_order", assetId: candidate.assetId, takenOn: candidate.takenOn, latestOn: previous.takenOn };
  }

  const reset = candidate.reset;
  if (reset) {
    if (reset.previousFinalValue < previous.value) {
      return { ok: false, reason: "reset_rewinds_the_old_meter", assetId: candidate.assetId, previous: previous.value, declaredFinal: reset.previousFinalValue };
    }
  } else if (candidate.value < previous.value) {
    return {
      ok: false,
      reason: "reading_goes_backwards",
      assetId: candidate.assetId,
      previous: previous.value,
      found: candidate.value,
      previousOn: previous.takenOn,
      takenOn: candidate.takenOn,
    };
  }

  const gained = segmentUsage(previous, candidate);
  /**
   * Two readings on the same day are allowed one full day of movement rather
   * than being divided by zero. A van really can be read at the yard in the
   * morning and at a supply house in the afternoon, and the honest ceiling for
   * that pair is a day's worth, not an infinite rate.
   */
  const overDays = Math.max(1, daysBetween(previous.takenOn, candidate.takenOn));
  const maxPerDay = options.maxPerDay ?? METER_UNITS[candidate.unit].maxPerDay;
  const perDay = gained / overDays;
  if (perDay > maxPerDay) {
    return { ok: false, reason: "implausible_jump", assetId: candidate.assetId, unit: candidate.unit, gained, overDays, perDay, maxPerDay };
  }

  return { ok: true, reading: candidate, unitsSincePrevious: gained };
}

/** Fold `acceptReading` over a whole history, stopping at the first refusal. */
export function validateReadings(
  readings: readonly MeterReading[],
  options: ReadingOptions = {},
): { ok: true; accepted: readonly MeterReading[] } | AssetRefusal {
  const accepted: MeterReading[] = [];
  for (const reading of readings) {
    const outcome = acceptReading(accepted, reading, options);
    if (!outcome.ok) return outcome;
    accepted.push(outcome.reading);
  }
  return { ok: true, accepted };
}

/**
 * Usage between two consecutive readings, across a declared reset.
 *
 * Without a reset it is subtraction. With one it is TWO pieces added: what the
 * OLD meter gained before it was pulled, plus what the new meter has already
 * put on its own face since it was fitted.
 *
 * The second piece is not a refinement and dropping it is not a rounding
 * error. A gauge fails in May, is swapped, and nobody reads the new one until
 * August, when it shows 400. The machine ran those 400 hours. Counting only
 * the 36 the old meter gained before it went loses them for good, silently:
 * the 250 hour service restarts, the cost per hour halves overnight, and no
 * number in the file ever disagrees with any other. That is the same failure
 * `MeterReset` exists to prevent, arriving from the other side of the swap.
 *
 * This assumes the new meter was fitted reading ZERO, which is what a
 * replacement gauge does and what `MeterReset` says. A used or preset gauge
 * would need its starting value declared and there is nowhere to declare it:
 * see the note on `MeterReset`.
 */
function segmentUsage(before: MeterReading, after: MeterReading): number {
  const reset = after.reset;
  if (reset) return reset.previousFinalValue - before.value + after.value;
  return after.value - before.value;
}

const sortReadings = (readings: readonly MeterReading[]): MeterReading[] =>
  [...readings].sort((a, b) => compareDates(a.takenOn, b.takenOn));

function sumSegments(sorted: readonly MeterReading[], startIndex: number, endIndex: number): number {
  let total = 0;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    total += segmentUsage(sorted[i - 1]!, sorted[i]!);
  }
  return total;
}

export type UsageOutcome =
  | {
      ok: true;
      unit: MeterUnit;
      units: number;
      from: MeterReading;
      to: MeterReading;
      observedDays: number;
      readingsUsed: number;
      /** True when a declared meter replacement falls inside the window. */
      crossedAReset: boolean;
    }
  | AssetRefusal;

/**
 * How much an asset was used between two dates.
 *
 * Bounded by the READINGS that exist inside the window, not by the window
 * itself, and `observedDays` reports the span actually covered rather than the
 * span asked for. Pretending a window with one reading near the end covers the
 * whole month is how a cost per hour comes out four times too high.
 */
export function usageBetween(
  readings: readonly MeterReading[],
  from: string,
  to: string,
): UsageOutcome {
  const sorted = sortReadings(readings).filter(
    (r) => compareDates(r.takenOn, from) >= 0 && compareDates(r.takenOn, to) <= 0,
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last || sorted.length < 2) {
    return {
      ok: false,
      reason: "not_enough_readings",
      assetId: first?.assetId ?? last?.assetId ?? "unknown",
      from,
      to,
      found: sorted.length,
    };
  }

  return {
    ok: true,
    unit: first.unit,
    units: sumSegments(sorted, 0, sorted.length - 1),
    from: first,
    to: last,
    observedDays: daysBetween(first.takenOn, last.takenOn),
    readingsUsed: sorted.length,
    crossedAReset: sorted.slice(1).some((r) => r.reset != null),
  };
}

// ---------------------------------------------------------------------------
// 2. Maintenance that is due
// ---------------------------------------------------------------------------

/**
 * A time interval IS a recurrence, and goes through the recurrence module.
 *
 * Not reimplemented here, and the reason is not tidiness. That module already
 * knows three things this one would get wrong within a month:
 *
 *   - `anchored_to_completion` counts from when the service ACTUALLY happened,
 *     not from when it was booked, so a van serviced two weeks late does not
 *     spend the rest of its life two weeks out of step.
 *   - Seasonal anchoring pins a service to a month. A generator serviced
 *     before storm season is serviced in September whoever bought it in March.
 *   - Exceptions are data. A skipped service was a decision somebody made and
 *     re-offering it next week is how people stop trusting the list.
 *
 * A second implementation of any of those is a second answer, and the second
 * answer is always the one that drifts.
 */
export interface TimeInterval {
  readonly basis: "time";
  readonly spec: RecurrenceSpec;
}

/**
 * A meter interval CANNOT go through the recurrence module, and this is the
 * central distinction in the file.
 *
 * A recurrence is a function of the calendar: given a rule and a date, the next
 * date is knowable now, exactly, forever. "Every 250 hours" is a function of
 * something that has not happened yet. The next service date depends on how
 * hard the machine gets used next month, which depends on the weather, the job
 * mix and whether it is sitting in a yard. There is no rule that produces it.
 *
 * What CAN be produced is a projection from the recent rate of use, and a
 * projection is a guess. Putting a guess through the recurrence machinery
 * would launder it into a date that looks exactly like a calendar fact, and
 * the whole cost of that mistake lands at once: a machine sits in a yard for
 * two months, the projection made from its busy season still says the service
 * is due next week, somebody drives out to it, and it has done eleven hours.
 * Or worse in the other direction, the machine goes onto a demolition job, the
 * stale projection says three weeks, and the hydraulic pump goes at 340 hours.
 */
export interface MeterInterval {
  readonly basis: "meter";
  readonly unit: MeterUnit;
  /** Units of use between services. 250 hours, 5000 miles. */
  readonly everyUnits: number;
}

export type MaintenanceInterval = TimeInterval | MeterInterval;

export interface MaintenancePlan {
  readonly assetId: string;
  readonly taskId: string;
  readonly label: string;
  readonly interval: MaintenanceInterval;
  /**
   * When this task was last actually done. The load bearing field for both
   * bases: the time branch counts from it and the meter branch measures usage
   * from the reading taken nearest it.
   */
  readonly lastServicedOn?: string | undefined;
}

export type ProjectionConfidence = "weak" | "fair" | "good";

export type MeterProjectionBlock =
  | "no_readings"
  | "stale_readings"
  | "not_enough_history"
  | "no_reading_at_service"
  | "no_use_observed"
  | "projection_beyond_horizon";

export type MaintenanceStatus =
  | { basis: "time"; state: "scheduled"; dueOn: string; daysUntilDue: number; overdue: boolean }
  | { basis: "time"; state: "no_further_service_due"; explanation: string }
  | { basis: "meter"; state: "due_now"; unit: MeterUnit; usedSinceService: number; unitsOverdue: number; explanation: string }
  | {
      basis: "meter";
      state: "projected";
      unit: MeterUnit;
      dueOn: string;
      unitsRemaining: number;
      unitsPerDay: number;
      observedDays: number;
      readingsUsed: number;
      confidence: ProjectionConfidence;
      caveat: string;
    }
  | {
      basis: "meter";
      state: "cannot_project";
      unit: MeterUnit;
      reason: MeterProjectionBlock;
      unitsRemaining: number | null;
      explanation: string;
    };

export interface MaintenanceOptions {
  /**
   * A reading older than this makes a projection dishonest rather than
   * imprecise. Six weeks is roughly the point at which a machine has either
   * been on a job nobody logged or has not moved at all, and the two produce
   * opposite answers from the same stale number.
   */
  readonly staleAfterDays?: number | undefined;
  /** How far back to look when measuring the recent rate of use. */
  readonly rateWindowDays?: number | undefined;
  /** Below this span, the rate is noise rather than a rate. */
  readonly minimumObservationDays?: number | undefined;
  /**
   * How far after a service a reading can be taken and still count as the
   * reading at service. An asset serviced on Friday and read on Monday is the
   * ordinary case and refusing it would make the feature unusable.
   */
  readonly serviceReadingToleranceDays?: number | undefined;
  /** Beyond this, a projected date is arithmetic rather than information. */
  readonly projectionHorizonDays?: number | undefined;
}

const DEFAULTS = {
  staleAfterDays: 45,
  rateWindowDays: 90,
  minimumObservationDays: 14,
  serviceReadingToleranceDays: 7,
  projectionHorizonDays: 730,
} as const;

/**
 * When is this task next due.
 *
 * The two bases return the same shape of answer and genuinely different kinds
 * of answer: the time branch returns a DATE, the meter branch returns a date,
 * a "due now", or an honest refusal to guess.
 */
export function maintenanceDue(
  plan: MaintenancePlan,
  readings: readonly MeterReading[],
  now: string,
  options: MaintenanceOptions = {},
): MaintenanceStatus {
  return plan.interval.basis === "time"
    ? timeDue(plan, plan.interval, now)
    : meterDue(plan, plan.interval, readings, now, options);
}

function timeDue(plan: MaintenancePlan, interval: TimeInterval, now: string): MaintenanceStatus {
  /**
   * The completion date is pushed into the spec rather than being used to do
   * arithmetic here, so that the recurrence module stays the only thing in the
   * codebase that turns a rule into dates.
   */
  const spec: RecurrenceSpec =
    interval.spec.model === "anchored_to_completion" && plan.lastServicedOn
      ? { ...interval.spec, lastOccurredOn: plan.lastServicedOn }
      : interval.spec;

  /**
   * Asked from the last service rather than from today, deliberately. Asking
   * from today returns the NEXT one and hides an overdue service completely,
   * which is the single most expensive way to be wrong here: the screen is
   * calm and the compressor is not.
   */
  const anchor = plan.lastServicedOn ?? addDays(spec.startsOn, -1);
  const dueOn = nextOccurrence(spec, anchor);
  if (!dueOn) {
    return {
      basis: "time",
      state: "no_further_service_due",
      explanation: `${plan.label} has no further occurrence after ${anchor}. The schedule has ended or was cancelled.`,
    };
  }

  const daysUntilDue = daysBetween(now, dueOn);
  return { basis: "time", state: "scheduled", dueOn, daysUntilDue, overdue: daysUntilDue < 0 };
}

function meterDue(
  plan: MaintenancePlan,
  interval: MeterInterval,
  readings: readonly MeterReading[],
  now: string,
  options: MaintenanceOptions,
): MaintenanceStatus {
  const staleAfterDays = options.staleAfterDays ?? DEFAULTS.staleAfterDays;
  const rateWindowDays = options.rateWindowDays ?? DEFAULTS.rateWindowDays;
  const minimumObservationDays = options.minimumObservationDays ?? DEFAULTS.minimumObservationDays;
  const tolerance = options.serviceReadingToleranceDays ?? DEFAULTS.serviceReadingToleranceDays;
  const horizon = options.projectionHorizonDays ?? DEFAULTS.projectionHorizonDays;

  const sorted = sortReadings(readings).filter((r) => r.assetId === plan.assetId && r.unit === interval.unit);
  const latest = sorted[sorted.length - 1];
  const blocked = (reason: MeterProjectionBlock, unitsRemaining: number | null, explanation: string): MaintenanceStatus =>
    ({ basis: "meter", state: "cannot_project", unit: interval.unit, reason, unitsRemaining, explanation });

  if (!latest) {
    return blocked(
      "no_readings",
      null,
      `${plan.label} is due every ${interval.everyUnits} ${interval.unit} and ${plan.assetId} has no readings at all. ` +
        `Nothing can be said about it until somebody walks out and reads the meter.`,
    );
  }

  /**
   * THE CASE THIS SECTION EXISTS FOR.
   *
   * An asset with no readings for months is not an asset with a known rate of
   * use. It is an asset nobody has looked at, and the last thing anybody knows
   * about it is how hard it was working before it went quiet. Projecting from
   * that is worse than saying nothing, because "service due 14 March" reads
   * identically whether it came from telematics yesterday or from a technician
   * in April, and only one of those is worth acting on.
   */
  const sinceLastReading = daysBetween(latest.takenOn, now);
  if (sinceLastReading > staleAfterDays) {
    return blocked(
      "stale_readings",
      null,
      `The last reading for ${plan.assetId} was ${latest.value} ${interval.unit} on ${latest.takenOn}, ${sinceLastReading} days ago. ` +
        `Any due date from that is a guess about months nobody logged. Get a current reading before planning around this one.`,
    );
  }

  // Usage since the service, measured from the reading taken nearest to it,
  // rather than from a stored "last service reading" number. A stored reading
  // is meaningless the moment the meter is replaced; a date survives it.
  const servicedOn = plan.lastServicedOn;
  let baselineIndex = -1;
  if (servicedOn) {
    for (let i = 0; i < sorted.length; i += 1) {
      if (compareDates(sorted[i]!.takenOn, servicedOn) <= 0) baselineIndex = i;
    }
    if (baselineIndex === -1) {
      const firstReading = sorted[0]!;
      const lag = daysBetween(servicedOn, firstReading.takenOn);
      if (lag >= 0 && lag <= tolerance) baselineIndex = 0;
    }
    if (baselineIndex === -1) {
      return blocked(
        "no_reading_at_service",
        null,
        `${plan.label} was done on ${servicedOn} and the earliest reading for ${plan.assetId} is ${sorted[0]!.takenOn}. ` +
          `Without a reading from around the service there is no way to know how much of the ${interval.everyUnits} ${interval.unit} has been used up.`,
      );
    }
  } else {
    baselineIndex = 0;
  }

  const usedSinceService = sumSegments(sorted, baselineIndex, sorted.length - 1);
  const unitsRemaining = interval.everyUnits - usedSinceService;

  if (unitsRemaining <= 0) {
    return {
      basis: "meter",
      state: "due_now",
      unit: interval.unit,
      usedSinceService,
      unitsOverdue: -unitsRemaining,
      explanation:
        `${plan.assetId} has run ${usedSinceService} ${interval.unit} since ${plan.label} was last done` +
        `${servicedOn ? ` on ${servicedOn}` : ""}, against an interval of ${interval.everyUnits}. ` +
        `This is not a projection: the meter already says so.`,
    };
  }

  // The recent rate of use, from the readings inside the rate window only. A
  // rate averaged over the whole life of a machine tells you about last year.
  const windowStart = addDays(latest.takenOn, -rateWindowDays);
  let rateStart = sorted.length - 1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (compareDates(sorted[i]!.takenOn, windowStart) >= 0) {
      rateStart = i;
      break;
    }
  }
  const readingsUsed = sorted.length - rateStart;
  const observedDays = daysBetween(sorted[rateStart]!.takenOn, latest.takenOn);

  /**
   * Three clauses, and only two of them can ever be the deciding one.
   *
   * `readingsUsed < 2` states the rule: a rate is a difference, so one reading
   * is not a rate. It is kept because it is the rule, but it can never fire on
   * its own, because a single reading inside the window is always the latest
   * reading and therefore spans zero days. Do not write a test claiming to
   * exercise it; the span clause below gets there first, every time.
   *
   * `observedDays < 1` is a different question from the minimum span and is
   * asked separately, because `minimumObservationDays` belongs to the caller
   * and a caller can set it to zero. Two readings taken on the same morning
   * span no days at all. Dividing by that span gives Infinity when the machine
   * moved and NaN when it did not, and neither is caught further down:
   * Infinity is not `<= 0`, so it becomes a projection due today built on a
   * rate of Infinity, and NaN reaches `addDays` and throws `RangeError` out of
   * a function whose entire contract is that it answers or refuses.
   */
  if (readingsUsed < 2 || observedDays < 1 || observedDays < minimumObservationDays) {
    return blocked(
      "not_enough_history",
      unitsRemaining,
      `${plan.assetId} has ${readingsUsed} reading(s) over ${observedDays} day(s), which is not enough to say how fast it is being used. ` +
        `${unitsRemaining} ${interval.unit} remain on ${plan.label}. Ask again after a few more readings.`,
    );
  }

  const usedInWindow = sumSegments(sorted, rateStart, sorted.length - 1);
  const unitsPerDay = usedInWindow / observedDays;
  if (unitsPerDay <= 0) {
    return blocked(
      "no_use_observed",
      unitsRemaining,
      `${plan.assetId} has not moved in the last ${observedDays} days. At a rate of zero there is no date: ` +
        `${unitsRemaining} ${interval.unit} remain and will remain until somebody uses it.`,
    );
  }

  const daysToDue = Math.ceil(unitsRemaining / unitsPerDay);
  if (daysToDue > horizon) {
    return blocked(
      "projection_beyond_horizon",
      unitsRemaining,
      `At ${unitsPerDay.toFixed(2)} ${interval.unit} a day, ${plan.label} on ${plan.assetId} is ${daysToDue} days away. ` +
        `That is far enough out that the rate will have changed several times before it arrives, so it is not a date worth showing.`,
    );
  }

  /**
   * Confidence is reported rather than used to suppress anything. A weak
   * projection is still the best available answer and hiding it leaves the
   * screen blank, which reads as "nothing is due". The caveat is written in
   * words because the number of readings and the span they cover is what a
   * person needs in order to decide whether to believe the date.
   */
  const confidence: ProjectionConfidence =
    observedDays >= 90 && readingsUsed >= 6 ? "good" : observedDays >= 30 && readingsUsed >= 3 ? "fair" : "weak";

  return {
    basis: "meter",
    state: "projected",
    unit: interval.unit,
    dueOn: addDays(now, daysToDue),
    unitsRemaining,
    unitsPerDay,
    observedDays,
    readingsUsed,
    confidence,
    caveat:
      `A projection, not a schedule. ${unitsRemaining} ${interval.unit} remain, and this assumes ${unitsPerDay.toFixed(2)} a day, ` +
      `which is what ${readingsUsed} readings over ${observedDays} days suggest. A quiet fortnight or a demolition job moves it.`,
  };
}

// ---------------------------------------------------------------------------
// 4. What an asset costs to keep
// ---------------------------------------------------------------------------

export const ASSET_COST_KINDS = [
  "acquisition",
  "maintenance",
  "fuel",
  "repair",
  "insurance",
  "registration",
  "storage",
  "other",
] as const;

export type AssetCostKind = (typeof ASSET_COST_KINDS)[number];

export interface AssetCost {
  readonly assetId: string;
  readonly kind: AssetCostKind;
  readonly amount: Money;
  readonly incurredOn: string;
  readonly note?: string | undefined;
}

export interface CostSummary {
  readonly from: string;
  readonly to: string;
  readonly currency: CurrencyCode;
  readonly byKind: Readonly<Record<AssetCostKind, Money>>;
  readonly total: Money;
  /**
   * Everything except acquisition.
   *
   * Kept separate because a purchase is a one off capital event and running
   * cost is a rate. Folding the two together makes the month a van was bought
   * look like the most expensive month in its life and every month after it
   * look free, and no comparison between two vans survives that.
   */
  readonly runningTotal: Money;
  readonly acquisition: Money;
}

export function costsOverPeriod(
  costs: readonly AssetCost[],
  from: string,
  to: string,
  currency: CurrencyCode = "USD",
): CostSummary {
  const inWindow = costs.filter(
    (c) => compareDates(c.incurredOn, from) >= 0 && compareDates(c.incurredOn, to) <= 0,
  );

  const byKind = Object.fromEntries(
    ASSET_COST_KINDS.map((kind) => [kind, zero(currency)]),
  ) as Record<AssetCostKind, Money>;

  let total = zero(currency);
  for (const cost of inWindow) {
    byKind[cost.kind] = add(byKind[cost.kind], cost.amount);
    total = add(total, cost.amount);
  }

  const acquisition = byKind.acquisition;
  return {
    from,
    to,
    currency,
    byKind,
    total,
    runningTotal: ASSET_COST_KINDS.filter((k) => k !== "acquisition").reduce(
      (running, kind) => add(running, byKind[kind]),
      zero(currency),
    ),
    acquisition,
  };
}

export type CostPerUnitOutcome =
  | {
      ok: true;
      unit: MeterUnit;
      units: number;
      cost: Money;
      perUnit: Money;
      observedDays: number;
      /**
       * False when the window is too short for the number to mean anything.
       * Reported rather than enforced, for the same reason projection
       * confidence is.
       */
      reliable: boolean;
      caveat: string | null;
    }
  | AssetRefusal;

/**
 * What it costs to run this thing, per hour or per mile.
 *
 * TWO THINGS THAT HAVE TO BE SAID OUT LOUD.
 *
 * The division by zero. An asset with no recorded use has no cost per hour,
 * and the answer is a refusal, not a zero and not an infinity. Zero reads as
 * "this van is free", and the cheapest asset in the fleet becomes the one
 * nobody is reading the odometer on. That is the exact opposite of the truth
 * and it is the kind of wrong that gets acted on.
 *
 * The short window. Three weeks of data on a van that has had one oil change
 * and no tyres is not a cost per mile, it is a cost per mile of three weeks in
 * which nothing broke. Every real cost of keeping a vehicle, tyres, brakes,
 * the transmission, the one big repair, arrives in lumps that are months or
 * years apart, so a short window either misses all of them and reads far too
 * cheap, or catches one and reads absurdly expensive. Neither number should be
 * put next to another van's. Ninety days is the floor here and it is still
 * generous.
 *
 * The division itself goes through money, on an INTEGER unit count. The rate
 * of use is a float and is never allowed anywhere near this: floats belong to
 * projections, not to invoices.
 */
export function costPerUnitOfUse(input: {
  readonly assetId: string;
  readonly costs: readonly AssetCost[];
  readonly readings: readonly MeterReading[];
  readonly from: string;
  readonly to: string;
  readonly currency?: CurrencyCode | undefined;
  readonly includeAcquisition?: boolean | undefined;
  readonly minimumReliableDays?: number | undefined;
}): CostPerUnitOutcome {
  const currency = input.currency ?? "USD";
  const minimumReliableDays = input.minimumReliableDays ?? 90;
  const mine = input.readings.filter((r) => r.assetId === input.assetId);
  const usage = usageBetween(mine, input.from, input.to);

  if (!usage.ok) {
    return {
      ok: false,
      reason: "no_recorded_use",
      assetId: input.assetId,
      unit: mine[0]?.unit ?? "hours",
      from: input.from,
      to: input.to,
      detail:
        `Usage is the difference between two readings and there are not two in the window. ` +
        `Record a reading at each end of the period rather than treating the gap as zero use.`,
    };
  }

  if (usage.units <= 0) {
    return {
      ok: false,
      reason: "no_recorded_use",
      assetId: input.assetId,
      unit: usage.unit,
      from: input.from,
      to: input.to,
      detail:
        `The meter read ${usage.from.value} on ${usage.from.takenOn} and shows no movement by ${usage.to.takenOn}. ` +
        `An idle asset still costs money to keep, so report its standing cost, not a cost per ${usage.unit.replace(/s$/, "")}.`,
    };
  }

  const summary = costsOverPeriod(
    input.costs.filter((c) => c.assetId === input.assetId),
    input.from,
    input.to,
    currency,
  );
  const cost = input.includeAcquisition ? summary.total : summary.runningTotal;
  const perUnit = divide(cost, String(usage.units));
  const reliable = usage.observedDays >= minimumReliableDays;

  return {
    ok: true,
    unit: usage.unit,
    units: usage.units,
    cost,
    perUnit,
    observedDays: usage.observedDays,
    reliable,
    caveat: reliable
      ? null
      : `${moneyToString(perUnit)} per ${usage.unit.replace(/s$/, "")} from ${usage.observedDays} days of use. ` +
        `Tyres, brakes and the one big repair arrive months apart, so a window this short is a number about a quiet spell, not about the asset. Do not compare it to another asset's.`,
  };
}

// ---------------------------------------------------------------------------
// 5. Compliance dates
// ---------------------------------------------------------------------------

export interface ComplianceProfile {
  readonly label: string;
  readonly description: string;
  /** How much notice this one needs, in days, to be cleared in time. */
  readonly warningDays: number;
  /** Expiry stops the asset being used at all. */
  readonly groundsTheAsset: boolean;
  /** Expiry casts doubt on work ALREADY DONE. */
  readonly invalidatesPastWork: boolean;
}

export const COMPLIANCE: Record<ComplianceKind, ComplianceProfile> = {
  registration: {
    label: "Registration",
    description: "The plate is current. Expired, and the van is one traffic stop from a citation and an impound.",
    warningDays: 30,
    groundsTheAsset: true,
    invalidatesPastWork: false,
  },
  inspection: {
    label: "Safety inspection",
    description: "A van with an expired inspection is a van that cannot leave the yard, and a crew standing next to it.",
    warningDays: 30,
    groundsTheAsset: true,
    invalidatesPastWork: false,
  },
  insurance: {
    label: "Insurance",
    description: "Lapsed cover is the one expiry where the cost of being wrong is unbounded.",
    warningDays: 21,
    groundsTheAsset: true,
    invalidatesPastWork: false,
  },
  calibration: {
    /**
     * THE EXPENSIVE CASE NOBODY THINKS ABOUT.
     *
     * The other three expiries stop something happening tomorrow. This one
     * reaches backwards. A thermal imager, a manometer or a combustion
     * analyser that is out of calibration did not start producing bad numbers
     * on the day the certificate lapsed: it has been drifting, and there is no
     * way to know from when. So every report it produced since the last good
     * calibration is in question, and those reports are the ones that went to
     * insurers, to buyers and into warranty claims.
     *
     * That is why this one carries `invalidatesPastWork` and a list of work at
     * risk, and why it gets the longest warning of the four despite not
     * grounding anything. The cost of noticing late is not a day off the road,
     * it is re-doing eight months of inspections you already charged for, and
     * explaining to somebody's lawyer why the moisture reading in their file
     * came off an uncalibrated instrument.
     */
    label: "Calibration",
    description: "An instrument out of calibration invalidates every report it produced since the last good certificate.",
    warningDays: 45,
    groundsTheAsset: false,
    invalidatesPastWork: true,
  },
};

export interface ComplianceObligation {
  readonly assetId: string;
  readonly kind: ComplianceKind;
  readonly expiresOn: string;
  readonly reference?: string | undefined;
  /** For calibration: the last date the instrument was certified good. */
  readonly lastCertifiedOn?: string | undefined;
}

export type ComplianceStatus = "expired" | "act_now" | "upcoming" | "clear";

export interface ComplianceAlert {
  readonly obligation: ComplianceObligation;
  readonly status: ComplianceStatus;
  readonly daysUntilExpiry: number;
  readonly warningDays: number;
  /** The last working day on which somebody can still get this cleared. */
  readonly actBy: string;
  /** The last working day the asset is actually usable under this obligation. */
  readonly lastUsableDay: string;
  /** True when either of the two dates was pulled back off a weekend. */
  readonly movedOffAWeekend: boolean;
  readonly groundsTheAsset: boolean;
  /**
   * Set only when a lapse reaches backwards. The date from which work done
   * with this asset is in question.
   */
  readonly workAtRiskSince?: string;
}

export interface ComplianceOptions {
  /** How far ahead to call something upcoming rather than clear. */
  readonly lookaheadDays?: number | undefined;
}

/**
 * What expires when, in the order somebody should deal with it.
 *
 * Ordered by the date action is actually needed rather than by expiry, because
 * a calibration that needs six weeks of notice and expires in fifty days is
 * more urgent than a registration that needs thirty and expires in forty. A
 * list sorted by expiry puts them the other way round and the instrument goes
 * out of certificate while the screen looked calm.
 */
export function complianceOutlook(
  obligations: readonly ComplianceObligation[],
  now: string,
  options: ComplianceOptions = {},
): ComplianceAlert[] {
  const lookaheadDays = options.lookaheadDays ?? 180;

  return obligations
    .map((obligation): ComplianceAlert => {
      const profile = COMPLIANCE[obligation.kind];
      const daysUntilExpiry = daysBetween(now, obligation.expiresOn);
      const rawActBy = addDays(obligation.expiresOn, -profile.warningDays);
      const actBy = lastWorkingDayOnOrBefore(rawActBy);
      const lastUsableDay = lastWorkingDayOnOrBefore(obligation.expiresOn);

      const status: ComplianceStatus =
        daysUntilExpiry < 0
          ? "expired"
          : compareDates(now, actBy) >= 0
            ? "act_now"
            : daysUntilExpiry <= lookaheadDays
              ? "upcoming"
              : "clear";

      const atRisk =
        profile.invalidatesPastWork && status === "expired" ? obligation.lastCertifiedOn : undefined;

      return {
        obligation,
        status,
        daysUntilExpiry,
        warningDays: profile.warningDays,
        actBy,
        lastUsableDay,
        movedOffAWeekend: actBy !== rawActBy || lastUsableDay !== obligation.expiresOn,
        groundsTheAsset: profile.groundsTheAsset,
        ...(atRisk != null ? { workAtRiskSince: atRisk } : {}),
      };
    })
    .sort(
      (a, b) =>
        compareDates(a.actBy, b.actBy) ||
        compareDates(a.obligation.expiresOn, b.obligation.expiresOn) ||
        a.obligation.kind.localeCompare(b.obligation.kind),
    );
}

/** The alert in the sentence somebody would say about it. */
export function explainAlert(alert: ComplianceAlert): string {
  const { obligation, status } = alert;
  const profile = COMPLIANCE[obligation.kind];
  const what = `${profile.label} on ${obligation.assetId}`;

  if (status === "expired") {
    const grounded = alert.groundsTheAsset ? " It cannot be used until this is cleared." : "";
    const backwards = alert.workAtRiskSince
      ? ` Every report this asset produced since ${alert.workAtRiskSince} was made on an instrument with no valid certificate and is open to challenge.`
      : "";
    return `${what} expired on ${obligation.expiresOn}, ${-alert.daysUntilExpiry} days ago.${grounded}${backwards}`;
  }
  if (status === "act_now") {
    return (
      `${what} expires on ${obligation.expiresOn} and needs ${alert.warningDays} days to clear, ` +
      `so it should have been started by ${alert.actBy}. The last working day it can be used is ${alert.lastUsableDay}.`
    );
  }
  return `${what} expires on ${obligation.expiresOn}, in ${alert.daysUntilExpiry} days. Start it by ${alert.actBy}.`;
}

/**
 * Obligations a kind of asset should have on file and does not.
 *
 * A van with an EXPIRED inspection is loud. A van with NO inspection record at
 * all is silent, and it is the same van in the same yard with the same
 * problem. An outlook built only from the rows that exist can never say so,
 * which is why this is a separate question with a separate answer.
 */
export function missingObligations(
  kind: AssetKind,
  obligations: readonly ComplianceObligation[],
): ComplianceKind[] {
  const present = new Set(obligations.map((o) => o.kind));
  return ASSET_KIND_PROFILES[kind].obligations.filter((required) => !present.has(required));
}
