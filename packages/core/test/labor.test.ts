import { describe, it, expect } from "vitest";
import * as labor from "../src/labor/index.js";
import { money, toString as m, zero, add, sum } from "../src/money/index.js";
import { instantOfLocal } from "../src/time/index.js";

/**
 * WHAT A PERSON GETS PAID
 *
 * Every test in here is a wage. The ones that matter most are the two nights
 * a year when a shift is not as long as the clock says it was, the week where
 * a daily rule and a weekly rule both look like they apply, and the split of
 * an amount that does not divide.
 */

const TZ = "America/Chicago";
const usd = (v: string) => money(v, "USD");

/** A punch, written the way a person would say it: a date and a wall clock. */
const at = (date: string, hhmm: string): Date => {
  const [h = "0", min = "0"] = hhmm.split(":");
  return instantOfLocal(date, Number(h) * 60 + Number(min), TZ);
};

const entry = (
  id: string,
  date: string,
  from: string,
  to: string | null,
  kind: labor.TimeEntryKind = "on_site",
  personId = "tech-1",
  endDate = date,
): labor.TimeEntry => ({
  id, personId, kind,
  startedAt: at(date, from),
  endedAt: to === null ? null : at(endDate, to),
});

/**
 * A declared policy with a daily AND a weekly rule, which is the shape that
 * makes the precedence question real. Nothing here is a claim about any
 * jurisdiction; it is what this imaginary operator says they have decided.
 */
const policy = (over: Partial<labor.OvertimePolicy> = {}): labor.OvertimePolicy => ({
  label: "Declared policy",
  timeZone: TZ,
  weekStartsOn: 0,
  dayAttribution: "shift_start",
  weeklyThresholdMinutes: 40 * 60,
  weeklyDoubleTimeThresholdMinutes: null,
  dailyThresholdMinutes: 8 * 60,
  dailyDoubleTimeThresholdMinutes: null,
  overtimeMultiplier: "1.5",
  doubleTimeMultiplier: "2",
  onCallTreatment: "separate_rate_not_hours_worked",
  note: "Declared by the operator on their own advice. Not legal advice from this software.",
  ...over,
});

const NOW = at("2026-12-31", "12:00");
const hours = (seconds: number) => seconds / 3600;

/* ------------------------------------------------------------------- DST */

describe("a shift that runs through a clock change is paid for the time actually worked", () => {
  it("pays seven hours for the eight hour night the clocks go forward", () => {
    /**
     * 22:00 on the Saturday to 06:00 on the Sunday reads as eight hours on
     * any wall clock in the building, and one of those hours did not happen:
     * the clocks jumped from 02:00 to 03:00. The technician stood there for
     * seven. A wall clock subtraction pays eight, every March, forever, and
     * nobody ever reports being overpaid.
     */
    const shift = entry("e1", "2026-03-07", "22:00", "06:00", "on_site", "tech-1", "2026-03-08");
    const weeks = labor.classifyWeeks([shift], policy());
    expect(hours(weeks[0]!.regularSeconds + weeks[0]!.overtimeSeconds)).toBe(7);
    expect(weeks[0]!.overtimeSeconds).toBe(0);
    /**
     * And it is a SATURDAY shift, in the week beginning Sunday 1 March. At
     * ten at night in Austin it is already Sunday the 8th in UTC, so reading
     * the date off the instant without a zone files the whole shift in the
     * following week, against a different forty hours.
     */
    expect(weeks[0]!.days[0]!.date).toBe("2026-03-07");
    expect(weeks[0]!.weekStartDate).toBe("2026-03-01");
  });

  it("pays nine hours for the eight hour night the clocks go back, and one of them is overtime", () => {
    /**
     * The same eight hours on the wall clock in November is nine hours of
     * work, because 01:00 to 02:00 happened twice. Against this operator's
     * eight hour daily threshold that ninth hour is overtime. A wall clock
     * subtraction loses the hour AND loses the premium on it, so the
     * technician is short an hour and a half of pay on the one night of the
     * year they worked the longest.
     */
    const shift = entry("e1", "2026-10-31", "22:00", "06:00", "on_site", "tech-1", "2026-11-01");
    const weeks = labor.classifyWeeks([shift], policy());
    expect(hours(weeks[0]!.regularSeconds)).toBe(8);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(1);
    expect(weeks[0]!.days[0]!.date).toBe("2026-10-31");
    expect(weeks[0]!.weekStartDate).toBe("2026-10-25");
  });

  it("splits the autumn night across two days without inventing or losing an hour", () => {
    // Under split at midnight the boundary is the real local midnight, which
    // is not the previous midnight plus twenty four hours on a 25 hour day.
    const shift = entry("e1", "2026-10-31", "22:00", "06:00", "on_site", "tech-1", "2026-11-01");
    const weeks = labor.classifyWeeks([shift], policy({ dayAttribution: "split_at_midnight" }));
    const days = weeks.flatMap((w) => w.days);
    expect(days.map((d) => [d.date, hours(d.countingSeconds)])).toEqual([
      ["2026-10-31", 2],
      ["2026-11-01", 7],
    ]);
    expect(hours(days.reduce((acc, d) => acc + d.countingSeconds, 0))).toBe(9);
  });

  it("ends the 25 hour day at the real local midnight, not 24 hours after it started", () => {
    /**
     * 1 November is 25 hours long. A shift from eight that evening to four
     * the next morning is four hours on the Sunday and four on the Monday.
     * Computing the day's end as its start plus 864e5 lands an hour early
     * and moves an hour of the shift into the wrong day, which is the wrong
     * daily overtime bucket and, at a week boundary, the wrong week.
     */
    const shift = entry("e1", "2026-11-01", "20:00", "04:00", "on_site", "tech-1", "2026-11-02");
    const weeks = labor.classifyWeeks([shift], policy({ dayAttribution: "split_at_midnight" }));
    const days = weeks.flatMap((w) => w.days);
    expect(days.map((d) => [d.date, hours(d.countingSeconds)])).toEqual([
      ["2026-11-01", 4],
      ["2026-11-02", 4],
    ]);
  });

  it("puts an evening shift on the evening's day, not on the day it is already in London", () => {
    /**
     * 18:00 on a Tuesday in Austin is already Wednesday in UTC. Reading the
     * date off the instant in UTC moves the shift into the wrong day, the
     * wrong daily overtime bucket and, one evening in seven, the wrong
     * workweek.
     */
    const shift = entry("e1", "2026-06-16", "18:00", "23:00");
    const weeks = labor.classifyWeeks([shift], policy({ dayAttribution: "split_at_midnight" }));
    expect(weeks[0]!.days[0]!.date).toBe("2026-06-16");
  });

  it("keeps a Saturday night shift inside a fortnight that contains the clocks going back", () => {
    /**
     * The period runs Sunday 25 October to Saturday 7 November. Computed as
     * the start plus fourteen times 864e5 it ends an hour early, because one
     * of those days was 25 hours long, and the last shift of the fortnight
     * falls out of the period onto nobody's payroll.
     */
    const period: labor.PayPeriod = { id: "pp-1", label: "Late October", startDate: "2026-10-25", weeks: 2 };
    const result = labor.buildStatement({
      personId: "tech-1",
      period,
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [entry("e1", "2026-11-07", "23:30", "03:30", "on_site", "tech-1", "2026-11-08")],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.lines.length).toBe(1);
    expect(hours(result.statement.lines[0]!.seconds ?? 0)).toBe(4);
  });
});

/* -------------------------------------------------------------- refusals */

describe("shapes that cannot be paid are refused rather than turned into a number", () => {
  it("refuses an entry that ends before it starts", () => {
    const broken: labor.TimeEntry = {
      id: "e1", personId: "tech-1", kind: "on_site",
      startedAt: at("2026-06-16", "14:00"),
      endedAt: at("2026-06-16", "09:00"),
    };
    const check = labor.checkEntries([broken], NOW);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals[0]!.code).toBe("entry_ends_before_it_starts");
    expect(check.refusals[0]!.message).toMatch(/one of the two times is wrong/);
  });

  it("refuses two entries that cover the same hour for one person", () => {
    const check = labor.checkEntries([
      entry("e1", "2026-06-16", "08:00", "12:00"),
      entry("e2", "2026-06-16", "11:00", "15:00"),
    ], NOW);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals[0]!.code).toBe("entries_overlap");
    expect(check.refusals[0]!.entryIds).toEqual(["e1", "e2"]);
  });

  it("finds the overlap even when the entries arrive out of order off a phone that was offline", () => {
    const check = labor.checkEntries([
      entry("e2", "2026-06-16", "11:00", "15:00"),
      entry("e1", "2026-06-16", "08:00", "12:00"),
    ], NOW);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    /**
     * Asserting only `ok === false` here would prove nothing. Comparing two
     * entries in ARRIVAL order also reports an overlap, because the one that
     * arrived second starts before the one that arrived first ends, so the
     * refusal fires whether or not anything sorted. The pair has to be named
     * in the order it actually happened, which is the thing only the sort
     * produces.
     */
    expect(check.refusals[0]!.entryIds).toEqual(["e1", "e2"]);
    expect(check.refusals.length).toBe(1);
  });

  it("accepts two entries that do not overlap but arrived in the wrong order", () => {
    /**
     * The other half of the same sort, and the half that actually costs
     * money. Comparing in arrival order, the afternoon entry ends after the
     * morning entry starts, so an unsorted check calls a perfectly ordinary
     * day an overlap and refuses to pay it until somebody works out that
     * nothing is wrong.
     */
    const check = labor.checkEntries([
      entry("e2", "2026-06-16", "13:00", "15:00"),
      entry("e1", "2026-06-16", "08:00", "10:00"),
    ], NOW);
    expect(check.ok).toBe(true);
  });

  it("allows one entry to end at the exact instant the next begins", () => {
    // Driving away from one job straight to the next is the normal case.
    const check = labor.checkEntries([
      entry("e1", "2026-06-16", "08:00", "12:00"),
      entry("e2", "2026-06-16", "12:00", "15:00", "travel"),
    ], NOW);
    expect(check.ok).toBe(true);
  });

  it("refuses an entry that is still open when a later one starts", () => {
    const check = labor.checkEntries([
      entry("e1", "2026-06-16", "08:00", null),
      entry("e2", "2026-06-16", "13:00", "17:00"),
    ], NOW);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals[0]!.code).toBe("entry_still_open");
    expect(check.refusals[0]!.message).toMatch(/forgot to clock out/);
  });

  it("refuses an entry that ends in the future", () => {
    const check = labor.checkEntries(
      [entry("e1", "2026-06-16", "08:00", "17:00")],
      at("2026-06-16", "10:00"),
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals[0]!.code).toBe("entry_ends_in_the_future");
  });

  it("refuses a wall clock correction typed into the hour that never happened", () => {
    /**
     * An office manager retyping a punch as 02:30 on the morning the clocks
     * went forward has typed a time that does not exist. Landing on 01:30 or
     * 03:30 silently is an hour of pay decided by a rounding rule nobody
     * chose.
     */
    const verdict = labor.wallEntry({ date: "2026-03-08", startMinutes: 150, endMinutes: 600, timeZone: TZ });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/that hour did not happen/);
  });

  it("accepts the hour that happens twice and says which one it took", () => {
    const verdict = labor.wallEntry({ date: "2026-11-01", startMinutes: 90, endMinutes: 360, timeZone: TZ });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.ambiguous).toBe(true);
    expect(verdict.note).toMatch(/happened twice/);
  });
});

/* -------------------------------------------------------------- overtime */

describe("an hour is paid at a premium once", () => {
  const week = (shape: number[], from = "2026-06-15") => {
    // Monday to Friday of an ordinary week, no clock changes anywhere near it.
    const dates = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20"];
    void from;
    return shape.map((h, i) => {
      const end = 6 + h;
      return entry(`e${i}`, dates[i]!, "06:00", `${String(end).padStart(2, "0")}:00`);
    });
  };

  it("does not pay a weekly premium on hours a daily premium already took", () => {
    /**
     * Four ten hour days and an eight hour day is forty eight hours. The
     * daily rule takes eight premium hours. Forty eight minus forty is
     * another eight, and paying both pays sixteen premium hours out of a
     * forty eight hour week: eight hours the person never worked. On this
     * technician that is a bit over five hundred dollars a week, paid
     * confidently by software that looks like it is working.
     */
    const weeks = labor.classifyWeeks(week([10, 10, 10, 10, 8]), policy());
    expect(weeks.length).toBe(1);
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(8);
    expect(weeks[0]!.explanations.join(" ")).toMatch(/only paid at a premium once/);
  });

  it("still adds a weekly premium where the daily rule found nothing", () => {
    // Six eight hour days is forty eight hours and no daily overtime at all.
    const weeks = labor.classifyWeeks(week([8, 8, 8, 8, 8, 8]), policy());
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(8);
  });

  it("tops the week up only by the part the daily rule did not already claim", () => {
    /**
     * Forty four hours, two of them already daily overtime. The week owes
     * four premium hours in total, so the weekly rule adds two, not four.
     */
    const weeks = labor.classifyWeeks(week([10, 10, 8, 8, 8]), policy());
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(4);
  });

  it("pays a daily premium in a week that never reaches the weekly threshold", () => {
    // Thirty eight hours, but one ten hour day. Daily overtime is owed anyway.
    const weeks = labor.classifyWeeks(week([10, 8, 8, 6, 6]), policy());
    expect(hours(weeks[0]!.regularSeconds)).toBe(36);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(2);
  });

  it("moves the longest hours of a long day up to double time", () => {
    const declared = policy({ dailyDoubleTimeThresholdMinutes: 12 * 60 });
    const weeks = labor.classifyWeeks(week([14, 8, 8, 8, 0]), declared);
    expect(hours(weeks[0]!.days[0]!.regularSeconds)).toBe(8);
    expect(hours(weeks[0]!.days[0]!.overtimeSeconds)).toBe(4);
    expect(hours(weeks[0]!.days[0]!.doubleTimeSeconds)).toBe(2);
  });

  it("does not pay double time twice where a daily and a weekly double time rule meet", () => {
    /**
     * Fourteen, fourteen, twelve, ten and ten is sixty hours, against an
     * eight hour day, a twelve hour day for double time, a forty hour week
     * and a forty eight hour week for double time.
     *
     * The daily rule takes four hours at 2x and sixteen at 1.5x. Twelve hours
     * of the week are above forty eight, four of which are already at 2x, so
     * the weekly double time rule promotes eight more and stops. Subtracting
     * what the daily rule already did is the whole of it: without that term
     * the weekly rule promotes twelve, and sixteen hours are paid at double
     * time out of the twelve that were ever above the threshold. On a $46.15
     * technician that is four hours at $46.15 handed over every week the
     * shape repeats.
     */
    const declared = policy({
      dailyDoubleTimeThresholdMinutes: 12 * 60,
      weeklyDoubleTimeThresholdMinutes: 48 * 60,
    });
    const weeks = labor.classifyWeeks(week([14, 14, 12, 10, 10]), declared);
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(8);
    expect(hours(weeks[0]!.doubleTimeSeconds)).toBe(12);
    // And nothing was invented or lost on the way through.
    const paid = weeks[0]!.regularSeconds + weeks[0]!.overtimeSeconds + weeks[0]!.doubleTimeSeconds;
    expect(hours(paid)).toBe(60);
  });

  it("puts the week boundary where the operator declared it, not where the calendar felt like it", () => {
    /**
     * The same five eight hour shifts, Wednesday to Sunday. Under a Sunday
     * workweek the Sunday falls into the NEXT week, so this is two weeks of
     * thirty two and eight and nobody is near the weekly threshold. Under a
     * Monday workweek it is one week of forty. Same work, same technician,
     * and the hours sit in different weeks purely because of a declaration
     * somebody made in configuration.
     */
    const shifts = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"]
      .map((d, i) => entry(`e${i}`, d, "08:00", "16:00"));
    const sunday = labor.classifyWeeks(shifts, policy({ weekStartsOn: 0 }));
    expect(sunday.map((w) => hours(w.regularSeconds))).toEqual([32, 8]);
    const monday = labor.classifyWeeks(shifts, policy({ weekStartsOn: 1 }));
    expect(monday.map((w) => hours(w.regularSeconds))).toEqual([40]);
  });

  it("takes an unpaid break out before any of it and leaves a paid one in", () => {
    const shifts = [
      entry("e1", "2026-06-16", "06:00", "12:00"),
      entry("e2", "2026-06-16", "12:00", "12:30", "unpaid_break"),
      entry("e3", "2026-06-16", "12:30", "15:00"),
      entry("e4", "2026-06-16", "15:00", "15:15", "paid_break"),
    ];
    const weeks = labor.classifyWeeks(shifts, policy());
    // Eight and three quarter hours on the clock, so three quarters of an
    // hour of it is over this operator's eight hour daily threshold.
    expect(hours(weeks[0]!.regularSeconds)).toBe(8);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(0.75);
    expect(hours(weeks[0]!.unpaidSeconds)).toBe(0.5);
  });

  it("keeps on call out of the overtime pot when the operator declared it is not hours worked", () => {
    const shifts = [
      ...["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"]
        .map((d, i) => entry(`e${i}`, d, "08:00", "16:00")),
      entry("oc", "2026-06-20", "08:00", "20:00", "on_call"),
    ];
    const weeks = labor.classifyWeeks(shifts, policy());
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(0);
    expect(hours(weeks[0]!.onCallSeconds)).toBe(12);
  });

  it("puts on call into the overtime pot when the operator declared it is hours worked", () => {
    const shifts = [
      ...["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"]
        .map((d, i) => entry(`e${i}`, d, "08:00", "16:00")),
      entry("oc", "2026-06-20", "08:00", "20:00", "on_call"),
    ];
    /**
     * Fifty two hours once the twelve hour on call Saturday counts. The daily
     * rule takes four of them, and the weekly rule tops that up by eight
     * rather than by twelve, because four were already at a premium.
     */
    const weeks = labor.classifyWeeks(shifts, policy({ onCallTreatment: "hours_worked_at_base" }));
    expect(hours(weeks[0]!.regularSeconds)).toBe(40);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(12);
    expect(hours(weeks[0]!.onCallSeconds)).toBe(0);
  });
});

describe("a declared policy that cannot be right is refused", () => {
  it("refuses a policy with no note on it", () => {
    const verdict = labor.checkOvertimePolicy(policy({ note: "   " }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses punch rounding that only ever runs the employer's way", () => {
    const verdict = labor.checkOvertimePolicy(policy({ punchRounding: { toMinutes: 15, mode: "down" } }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals[0]!.message).toMatch(/unpaid work by arithmetic/);
  });

  it("refuses a premium below the base rate", () => {
    const verdict = labor.checkOvertimePolicy(policy({ overtimeMultiplier: "0.9" }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses a double time threshold underneath the overtime threshold", () => {
    const verdict = labor.checkOvertimePolicy(policy({ weeklyDoubleTimeThresholdMinutes: 30 * 60 }));
    expect(verdict.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------- pay */

describe("money never touches a float", () => {
  it("keeps the cents on an hourly rate that does not divide into the hours worked", () => {
    /**
     * $46.15 an hour for seven hours and seventeen minutes. The tempting
     * version precomputes a per minute rate, which has to be rounded, and
     * then multiplies the rounding error by 437. Doing the multiply first
     * and the single divide last keeps it exact until the one rounding at
     * the end.
     *
     * 46.15 times 437 minutes is 20167.55, over 60 is 336.1258333...
     */
    const amount = labor.payFor(usd("46.15"), 437 * 60);
    expect(m(amount)).toBe("336.1258");
  });

  it("derives the overtime rate from the base rate instead of storing a second copy", () => {
    /**
     * A raise that updates one row and not the other underpays every premium
     * hour until somebody notices, and nobody checks the overtime line.
     */
    expect(m(labor.overtimeRate(usd("46.15"), "1.5"))).toBe("69.2250");
    expect(m(labor.overtimeRate(usd("46.15"), "2"))).toBe("92.3000");
  });

  it("makes the printed lines add up to the printed gross", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [
        entry("e1", "2026-06-15", "06:00", "16:00"),
        entry("e2", "2026-06-16", "06:00", "16:00"),
        entry("e3", "2026-06-17", "06:00", "16:00"),
        entry("e4", "2026-06-18", "06:00", "16:00"),
        entry("e5", "2026-06-19", "06:00", "14:00"),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const printed = sum(result.statement.lines.map((l) => l.amount), "USD");
    expect(m(printed)).toBe(m(result.statement.gross));
    // Forty regular at 46.15 and eight overtime at 69.225.
    expect(m(result.statement.gross)).toBe("2399.8000");
  });

  it("prints every statement line at a whole cent", () => {
    /**
     * Fifteen hours seventeen minutes at $46.15 is $705.3258, the premium
     * line is $188.0613 and the on call line is $199.0062. None of the three
     * is a payment. A statement whose lines are held at full scale adds up
     * correctly on screen and then disagrees with the bank by a cent a line
     * the moment anybody pays it.
     */
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15"), onCallRate: usd("17.33") },
      entries: [
        entry("e1", "2026-06-15", "06:00", "13:17"),
        entry("e2", "2026-06-16", "06:00", "16:43"),
        entry("oc", "2026-06-20", "08:00", "19:29", "on_call"),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.lines.length).toBeGreaterThan(2);
    for (const line of result.statement.lines) {
      // Four decimal places are how money is stored; the last two of them
      // have to be zero on anything that is going to be paid.
      expect(m(line.amount).slice(-2)).toBe("00");
    }
    expect(result.statement.lines.map((l) => m(l.amount)))
      .toEqual(["705.3300", "188.0600", "199.0100"]);
    const printed = sum(result.statement.lines.map((l) => l.amount), "USD");
    expect(m(printed)).toBe(m(result.statement.gross));
  });

  it("refuses to work out a premium from a salary on the operator's behalf", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "salary", perPeriod: usd("1800.00"), overtimeEligible: true },
      entries: [entry("e1", "2026-06-15", "06:00", "18:00")],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]!.code).toBe("salary_overtime_not_supported");
  });

  it("still records the hours a salaried person worked", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "salary", perPeriod: usd("1800.00"), overtimeEligible: false },
      entries: [entry("e1", "2026-06-15", "06:00", "18:00")],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(m(result.statement.gross)).toBe("1800.0000");
    expect(result.statement.warnings[0]).toMatch(/12.00 hours were recorded/);
  });
});

/* ------------------------------------------------------------ commission */

describe("a commission split has to add back to the commission", () => {
  it("splits an amount that does not divide evenly and still sums to the whole", () => {
    /**
     * Eight per cent of a $4,345.37 job is $347.6296. Two thirds and one
     * third of that are $231.7530666... and $115.8765333..., and there is no
     * such coin. Dividing and rounding each part gives a total that is a cent
     * away from the commission, on this job and on every job like it, and the
     * commission liability account never reconciles again.
     */
    const verdict = labor.computeCommission(
      { basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of the ticket." },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("4345.37"),
        shares: [{ personId: "tech-1", weight: "2" }, { personId: "tech-2", weight: "1" }],
      },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // 347.6296 is not payable, so it is made payable ONCE, before the split.
    expect(m(verdict.total)).toBe("347.6300");
    expect(verdict.parts.map((p) => m(p.amount))).toEqual(["231.7600", "115.8700"]);
    // The two parts are whole cents AND they add back to the commission.
    const back = add(verdict.parts[0]!.amount, verdict.parts[1]!.amount);
    expect(m(back)).toBe("347.6300");
    expect(m(labor.splitCommission(usd("347.63"), [
      { personId: "a", weight: "1" }, { personId: "b", weight: "1" },
    ]).reduce((acc, p) => add(acc, p.amount), zero("USD")))).toBe("347.6300");
  });

  it("splits a fifty fifty commission on an odd number of cents without losing one", () => {
    const parts = labor.splitCommission(usd("347.63"), [
      { personId: "a", weight: "1" }, { personId: "b", weight: "1" },
    ]);
    expect(parts.map((p) => m(p.amount))).toEqual(["173.8200", "173.8100"]);
  });

  it("refuses a margin commission while nobody knows what the job cost", () => {
    /**
     * The M17 problem, exactly. Treating the missing cost as zero pays
     * commission on the whole invoice as though none of it cost anything,
     * which is the most expensive default available and the one every
     * spreadsheet has.
     */
    const verdict = labor.computeCommission(
      { basis: "percent_of_gross_margin", rate: "0.02", note: "Two per cent of margin." },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("4345.37"),
        shares: [{ personId: "tech-1", weight: "1" }],
      },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/as though none of it cost anything/);
  });

  it("pays nothing rather than a negative on a job that lost money", () => {
    const verdict = labor.computeCommission(
      { basis: "percent_of_gross_margin", rate: "0.02", note: "Two per cent of margin." },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("1000.00"), cost: usd("1400.00"),
        shares: [{ personId: "tech-1", weight: "1" }],
      },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(m(verdict.total)).toBe("0.0000");
  });

  it("says what each basis is wrong about, in every case", () => {
    for (const key of labor.COMMISSION_BASES) {
      expect(labor.COMMISSION_BASIS[key].wrongAbout.length).toBeGreaterThan(80);
    }
    expect(labor.COMMISSION_BASIS.percent_of_revenue.wrongAbout).toMatch(/expensive option/);
    expect(labor.COMMISSION_BASIS.percent_of_gross_margin.wrongAbout).toMatch(/cost that nobody has/);
    expect(labor.COMMISSION_BASIS.flat_per_job.wrongAbout).toMatch(/volume/);
  });
});

/* -------------------------------------------------------------- clawback */

describe("a commission follows the invoice it came from", () => {
  const plan: labor.CommissionPlan = {
    basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of the ticket.",
  };
  const job: labor.CommissionEvent = {
    id: "c1", jobId: "j-1", invoiceId: "inv-1",
    occurredAt: at("2026-06-16", "17:00"),
    revenue: usd("4345.37"),
    shares: [{ personId: "tech-1", weight: "2" }, { personId: "tech-2", weight: "1" }],
  };

  it("reverses each technician's own part when the invoice is credited", () => {
    const verdict = labor.clawbackFor(plan, job, {
      id: "cr-1", commissionEventId: "c1",
      occurredAt: at("2026-07-20", "10:00"),
      reason: "credit_note",
      creditedRevenue: usd("1234.56"),
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    /**
     * The invoice falls to $3,110.81, so the commission recomputes from
     * $347.63 to $248.86 and $98.77 comes back. Deliberately an amount that
     * does not divide two to one: the two reversals are $65.85 and $32.92,
     * and they add back to $98.77 exactly because each one is the difference
     * of two allocations rather than a share of a difference.
     */
    expect(verdict.lines.map((l) => m(l.amount))).toEqual(["-65.8500", "-32.9200"]);
    expect(m(verdict.total)).toBe("-98.7700");
  });

  it("takes a clawback out of the period the credit landed in, not the closed one", () => {
    /**
     * The commission was earned in June and paid. Tax was withheld on the
     * amount paid and remitted. Reaching back into June means amending a
     * filing and leaves the technician's year to date figures disagreeing
     * with the ones the tax authority holds. So it is a negative line in
     * July, carrying the June date so the technician can see which job it
     * came from.
     */
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp-jul", label: "Week of 19 July", startDate: "2026-07-19", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [entry("e1", "2026-07-20", "08:00", "16:00")],
      clawbacks: [{
        creditId: "cr-1",
        occurredAt: at("2026-07-20", "10:00"),
        earnedAt: at("2026-06-16", "17:00"),
        line: { personId: "tech-1", amount: usd("-79.92"), explanation: "Job j-1 was credited." },
      }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reversal = result.statement.lines.find((l) => l.kind === "commission_clawback");
    expect(reversal).toBeDefined();
    expect(m(reversal!.amount)).toBe("-79.9200");
    expect(reversal!.explanation).toMatch(/already closed and filed/);
    // Eight hours at 46.15 is 369.20, less the reversal.
    expect(m(result.statement.gross)).toBe("289.2800");
    expect(m(result.statement.carriedForward)).toBe("0.0000");
  });

  it("carries a clawback forward rather than handing somebody a negative cheque", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp-jul", label: "Week of 19 July", startDate: "2026-07-19", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [entry("e1", "2026-07-20", "08:00", "10:00")],
      clawbacks: [{
        creditId: "cr-1",
        occurredAt: at("2026-07-20", "10:00"),
        earnedAt: at("2026-06-16", "17:00"),
        line: { personId: "tech-1", amount: usd("-500.00"), explanation: "Job j-1 was refunded." },
      }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(m(result.statement.gross)).toBe("0.0000");
    expect(m(result.statement.carriedForward)).toBe("-407.7000");
    expect(result.statement.warnings.join(" ")).toMatch(/carried forward/);
    /**
     * And it is on the statement, not only in a warnings array that a payroll
     * screen may or may not render. Printed at zero so the lines still add to
     * the gross while the amount is still visible.
     */
    const carried = result.statement.lines.find((l) => l.kind === "clawback_carried_forward");
    expect(carried).toBeDefined();
    expect(m(carried!.amount)).toBe("0.0000");
    expect(carried!.explanation).toMatch(/407\.70/);
    // The printed lines still add to the printed gross.
    const printed = sum(result.statement.lines.map((l) => l.amount), "USD");
    expect(m(printed)).toBe("0.0000");
  });
});

/* ------------------------------------------------------------- statement */

describe("assembling a pay period", () => {
  it("refuses a period that contains an open time entry rather than paying it as zero", () => {
    /**
     * A technician who forgot to clock out has still worked those hours.
     * Skipping the open entry produces a statement short by however long the
     * job took, and short silently, because nothing about the total says a
     * punch is missing.
     */
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [
        entry("e1", "2026-06-15", "08:00", "16:00"),
        entry("e2", "2026-06-16", "08:00", null),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.some((r) => r.code === "entry_still_open")).toBe(true);
    expect(result.refusals.map((r) => r.message).join(" ")).toMatch(/short by however long/);
  });

  it("refuses a period that begins part way through a workweek", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Semimonthly", startDate: "2026-06-16", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]!.code).toBe("period_not_whole_workweeks");
    expect(result.refusals[0]!.message).toMatch(/2026-06-14/);
  });

  it("gives every line a sentence the technician can check", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15"), onCallRate: usd("12.00") },
      entries: [
        ...["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"]
          .map((d, i) => entry(`e${i}`, d, "06:00", "16:00")),
        entry("oc", "2026-06-20", "08:00", "20:00", "on_call"),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const line of result.statement.lines) {
      expect(line.explanation.length).toBeGreaterThan(20);
    }
    const kinds = result.statement.lines.map((l) => l.kind);
    expect(kinds).toEqual(["regular", "overtime", "on_call"]);
    expect(result.statement.lines[1]!.explanation).toMatch(/worked out from the base rate/);
    expect(result.statement.lines[2]!.explanation).toMatch(/not counted as hours worked/);
    // Twelve hours carrying the phone at the DECLARED on call rate, not at
    // the base rate: $144, not $553.80.
    expect(m(result.statement.lines[2]!.rate!)).toBe("12.0000");
    expect(m(result.statement.lines[2]!.amount)).toBe("144.0000");
  });

  it("ignores another person's entries and another person's commission", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period: { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 },
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: [
        entry("e1", "2026-06-15", "08:00", "16:00"),
        entry("e2", "2026-06-15", "08:00", "16:00", "on_site", "tech-2"),
      ],
      commissions: [{
        eventId: "c1",
        occurredAt: at("2026-06-16", "17:00"),
        part: { personId: "tech-2", amount: usd("100.00"), explanation: "Not theirs." },
      }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(m(result.statement.gross)).toBe("369.2000");
  });

  it("applies punch rounding the operator declared, and only in the neutral direction", () => {
    const declared = policy({ punchRounding: { toMinutes: 15, mode: "nearest" } });
    const weeks = labor.classifyWeeks([entry("e1", "2026-06-15", "07:52", "16:04")], declared);
    // Eight hours twelve minutes, rounded to the nearest quarter hour.
    expect(hours(weeks[0]!.regularSeconds + weeks[0]!.overtimeSeconds)).toBe(8.25);
  });
});

/* --------------------------------------------- declarations that must bite */

describe("a declaration the operator made has to change what is paid", () => {
  const weekdays = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"];

  it("keeps a kind the policy declared out of the overtime pot out of the thresholds", () => {
    /**
     * Forty hours on site and four hours of travel on the Saturday. Under the
     * default the week is forty four and the weekly rule owes four premium
     * hours. This operator has declared that travel is paid but is not hours
     * worked for their thresholds. If that declaration changes nothing, the
     * settings screen offers a switch that does not exist and the operator is
     * paying a premium they were told they had turned off.
     */
    const shifts = [
      ...weekdays.map((d, i) => entry(`e${i}`, d, "08:00", "16:00")),
      entry("tr", "2026-06-20", "08:00", "12:00", "travel"),
    ];

    const asDeclared = labor.classifyWeeks(shifts, policy({ countsTowardOvertime: { travel: false } }));
    expect(hours(asDeclared[0]!.regularSeconds)).toBe(44);
    expect(hours(asDeclared[0]!.overtimeSeconds)).toBe(0);
    // The travel day is paid and is not in the pot the thresholds measure.
    const saturday = asDeclared[0]!.days.find((d) => d.date === "2026-06-20")!;
    expect(hours(saturday.regularSeconds)).toBe(4);
    expect(hours(saturday.countingSeconds)).toBe(0);
    expect(asDeclared[0]!.explanations.join(" ")).toMatch(/not to be hours worked/);

    // The same week under the default, so the difference is the declaration.
    const byDefault = labor.classifyWeeks(shifts, policy());
    expect(hours(byDefault[0]!.regularSeconds)).toBe(40);
    expect(hours(byDefault[0]!.overtimeSeconds)).toBe(4);
  });

  it("will not let hours declared out of the pot be promoted by the weekly rule", () => {
    // Thirty six on site hours and twelve declared-out travel hours. The week
    // is forty eight on the clock and thirty six in the pot, so nothing is
    // over the weekly threshold and no travel hour may be pulled up to 1.5x.
    const shifts = [
      ...weekdays.slice(0, 4).map((d, i) => entry(`e${i}`, d, "08:00", "17:00")),
      entry("tr", "2026-06-20", "06:00", "18:00", "travel"),
    ];
    const weeks = labor.classifyWeeks(shifts, policy({
      dailyThresholdMinutes: null,
      countsTowardOvertime: { travel: false },
    }));
    expect(hours(weeks[0]!.regularSeconds)).toBe(48);
    expect(hours(weeks[0]!.overtimeSeconds)).toBe(0);
  });

  it("refuses a policy that does not say how on call time is treated", () => {
    /**
     * The field is required by the type and is still the field most likely to
     * arrive empty out of a migration or a settings form. Falling through to
     * the base rate silently applies a treatment nobody declared to the one
     * question this module says it will not guess at.
     */
    const undeclared = policy({ onCallTreatment: "" as labor.OnCallTreatment });
    const verdict = labor.checkOvertimePolicy(undeclared);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((r) => r.code)).toContain("on_call_treatment_not_declared");
  });
});

/* ------------------------------------------------------- punch rounding */

describe("punch rounding is applied to the punch pair, once", () => {
  it("does not round a night shift twice because it crossed midnight", () => {
    /**
     * 22:07 to 06:07 is exactly eight hours. Split at midnight it is 1h53m
     * and 6h07m, and rounding each half UP to the quarter hour gives 2h00m
     * and 6h15m: eight and a quarter hours for an eight hour shift. The error
     * is per BOUNDARY rather than per punch, so a technician on nights
     * collects a free quarter hour every shift, which is over an hour a week,
     * paid by arithmetic nobody chose.
     */
    const declared = policy({
      dayAttribution: "split_at_midnight",
      punchRounding: { toMinutes: 15, mode: "up" },
    });
    const weeks = labor.classifyWeeks(
      [entry("e1", "2026-06-16", "22:07", "06:07", "on_site", "tech-1", "2026-06-17")],
      declared,
    );
    const days = weeks.flatMap((w) => w.days);
    expect(days.reduce((acc, d) => acc + d.countingSeconds, 0)).toBe(8 * 3600);
    // And the two parts are still the real boundary, not a rounded one each.
    expect(days.map((d) => [d.date, d.countingSeconds])).toEqual([
      ["2026-06-16", 6780],
      ["2026-06-17", 22020],
    ]);
  });

  it("rounds the whole shift to the nearest quarter and settles it on one day", () => {
    // 22:07 to 06:10 is 8h03m, which is eight hours to the nearest quarter.
    // Rounded per segment it is 2h00m plus 6h15m, which is 8h15m.
    const declared = policy({
      dayAttribution: "split_at_midnight",
      punchRounding: { toMinutes: 15, mode: "nearest" },
    });
    const weeks = labor.classifyWeeks(
      [entry("e1", "2026-06-16", "22:07", "06:10", "on_site", "tech-1", "2026-06-17")],
      declared,
    );
    const days = weeks.flatMap((w) => w.days);
    expect(hours(days.reduce((acc, d) => acc + d.countingSeconds, 0))).toBe(8);
  });
});

/* -------------------------------------------- more commission arithmetic */

describe("every commission split goes through allocate", () => {
  it("makes a full scale commission payable before it is divided", () => {
    /**
     * A caller holding a commission at the scale money is stored at, rather
     * than at the cent, is the normal case: that is what comes back out of
     * the multiply. Allocating it as it stands gives parts that are not whole
     * cents, and the sub cent remainder rides on the first part, so one
     * technician is paid $173.8196 and the other $173.81. Neither is a
     * payable amount and the pair is not the commission.
     */
    const parts = labor.splitCommission(money("347.6296", "USD"), [
      { personId: "a", weight: "1" }, { personId: "b", weight: "1" },
    ]);
    expect(parts.map((p) => m(p.amount))).toEqual(["173.8200", "173.8100"]);
    expect(m(parts.reduce((acc, p) => add(acc, p.amount), zero("USD")))).toBe("347.6300");
  });

  it("splits a flat per job commission three ways without losing a cent", () => {
    /**
     * A flat amount of $100.005 is not payable, and it does not divide by
     * three. It is made payable once, at $100.01, and then split: two people
     * get $33.34 and one gets $33.33, and the three add back to $100.01
     * exactly. A fixture where the flat amount is already whole cents and
     * divides evenly proves none of this.
     */
    const verdict = labor.computeCommission(
      { basis: "flat_per_job", flatAmount: money("100.005", "USD"), note: "A flat rate a job." },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("4345.37"),
        shares: [
          { personId: "a", weight: "1" },
          { personId: "b", weight: "1" },
          { personId: "c", weight: "1" },
        ],
      },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.parts.map((p) => m(p.amount))).toEqual(["33.3400", "33.3400", "33.3300"]);
    const back = verdict.parts.reduce((acc, p) => add(acc, p.amount), zero("USD"));
    // The plan's total is made payable too, or the total and the parts the
    // technicians are actually handed are two different numbers.
    expect(m(verdict.total)).toBe("100.0100");
    expect(m(back)).toBe(m(verdict.total));
  });

  it("gives an uneven weight split parts that still add back to the whole", () => {
    // Three to two to one, of an amount that divides into none of them.
    const parts = labor.splitCommission(usd("1000.01"), [
      { personId: "a", weight: "3" },
      { personId: "b", weight: "2" },
      { personId: "c", weight: "1" },
    ]);
    expect(m(parts.reduce((acc, p) => add(acc, p.amount), zero("USD")))).toBe("1000.0100");
    expect(parts.map((p) => m(p.amount))).toEqual(["500.0100", "333.3400", "166.6600"]);
  });

  it("refuses a commission plan with no note and a job with nobody on it", () => {
    const noNote = labor.computeCommission(
      { basis: "percent_of_revenue", rate: "0.08", note: "  " },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("4345.37"),
        shares: [{ personId: "a", weight: "1" }],
      },
    );
    expect(noNote.ok).toBe(false);

    const nobody = labor.computeCommission(
      { basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent." },
      {
        id: "c1", jobId: "j-1", invoiceId: "inv-1",
        occurredAt: at("2026-06-16", "17:00"),
        revenue: usd("4345.37"),
        shares: [],
      },
    );
    expect(nobody.ok).toBe(false);
    if (nobody.ok) return;
    expect(nobody.reason).toMatch(/nobody to pay it to/);
  });
});

/* ------------------------------------- what belongs in which pay period */

describe("a commission belongs to the period it happened in", () => {
  const period: labor.PayPeriod = { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 };
  const worked = [entry("e1", "2026-06-15", "08:00", "16:00")];

  it("leaves a commission earned in another period out of this one", () => {
    /**
     * The obvious thing for a caller to hand this function is the person's
     * commission list. If `occurredAt` decides nothing, every commission they
     * have ever earned is paid again in every period that is ever run.
     */
    const result = labor.buildStatement({
      personId: "tech-1",
      period,
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: worked,
      commissions: [
        {
          eventId: "this-week",
          occurredAt: at("2026-06-16", "17:00"),
          part: { personId: "tech-1", amount: usd("100.00"), explanation: "Earned this week." },
        },
        {
          eventId: "paid-in-may",
          occurredAt: at("2026-05-20", "17:00"),
          part: { personId: "tech-1", amount: usd("500.00"), explanation: "Earned and paid in May." },
        },
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.lines.filter((l) => l.kind === "commission").map((l) => l.label))
      .toEqual(["Commission, this-week"]);
    // Eight hours at 46.15 is 369.20, plus the one commission that is this period's.
    expect(m(result.statement.gross)).toBe("469.2000");
  });

  it("leaves a credit that landed in another period out of this one", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period,
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: worked,
      clawbacks: [{
        creditId: "cr-later",
        occurredAt: at("2026-08-03", "10:00"),
        earnedAt: at("2026-06-16", "17:00"),
        line: { personId: "tech-1", amount: usd("-79.92"), explanation: "Job j-1 was credited in August." },
      }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.lines.some((l) => l.kind === "commission_clawback")).toBe(false);
    expect(m(result.statement.gross)).toBe("369.2000");
  });

  it("refuses a reversal in a currency the statement is not in, rather than throwing", () => {
    const result = labor.buildStatement({
      personId: "tech-1",
      period,
      policy: policy(),
      basis: { kind: "hourly", baseRate: usd("46.15") },
      entries: worked,
      clawbacks: [{
        creditId: "cr-eur",
        occurredAt: at("2026-06-16", "10:00"),
        earnedAt: at("2026-06-16", "17:00"),
        line: { personId: "tech-1", amount: money("-50.00", "EUR"), explanation: "Credited in euros." },
      }],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]!.code).toBe("currency_mismatch");
  });
});

/**
 * THE NIGHT THE CLOCKS GO BACK, OUTSIDE AMERICA
 *
 * `wallEntry` builds a timesheet correction from `instantOfLocal`, which
 * resolved an ambiguous wall time to the LATER occurrence everywhere at or
 * east of Greenwich. A technician in London who worked 01:30 to 09:30 on the
 * clocks-back Sunday stood there for nine hours and the entry paid eight.
 *
 * The `ambiguous` flag that exists to catch exactly that was false as well,
 * because `isRepeatedHour` asks whether one real hour later reads the same
 * wall clock, which is only true when sitting on the FIRST of the pair. The
 * bug disarmed its own safety net, which is why nothing reported it.
 */
describe("a shift through an hour that happens twice", () => {
  const cases = [
    { zone: "Europe/London", date: "2026-10-25" },
    { zone: "Europe/Berlin", date: "2026-10-25" },
    { zone: "America/New_York", date: "2026-11-01" },
    { zone: "Australia/Sydney", date: "2026-04-05" },
  ];

  it("pays the hours the shift actually lasted, in every zone", () => {
    for (const { zone, date } of cases) {
      /**
       * Starting BEFORE the transition in each zone, so the repeated hour is
       * inside the shift. Sydney goes back at 03:00 local, the others at
       * 02:00 or 03:00, and one thirty is before all of them.
       */
      const verdict = labor.wallEntry({
        date, startMinutes: 90, endMinutes: 570, timeZone: zone,
      });
      if (!verdict.ok) throw new Error(`${zone}: ${verdict.reason}`);

      const hours = (verdict.endedAt.getTime() - verdict.startedAt.getTime()) / 3600_000;
      expect([zone, hours], `${zone} paid the wrong number of hours`)
        .toEqual([zone, 9]);
    }
  });

  it("flags an entry whose START is one of the two readings", () => {
    /**
     * The safety net, which the bug had silently disarmed everywhere the
     * wrong reading was returned.
     *
     * Each zone needs its own start time, and getting that wrong is how this
     * test first failed. The repeated hour is 01:00 to 02:00 in London and
     * New York, and 02:00 to 03:00 in Berlin and Sydney, where the clocks go
     * back at three rather than at two. Asking about 01:30 in Berlin asks
     * about an ordinary unambiguous half past one, and `ambiguous: false` was
     * the right answer to a question I had not meant to ask.
     */
    const ambiguousStarts = [
      { zone: "Europe/London", date: "2026-10-25", startMinutes: 90 },
      { zone: "Europe/Berlin", date: "2026-10-25", startMinutes: 150 },
      { zone: "America/New_York", date: "2026-11-01", startMinutes: 90 },
      { zone: "Australia/Sydney", date: "2026-04-05", startMinutes: 150 },
    ];

    for (const { zone, date, startMinutes } of ambiguousStarts) {
      const verdict = labor.wallEntry({
        date, startMinutes, endMinutes: startMinutes + 480, timeZone: zone,
      });
      if (!verdict.ok) throw new Error(`${zone}: ${verdict.reason}`);
      expect([zone, verdict.ambiguous]).toEqual([zone, true]);
      // And it says so in words, because the flag alone is not on a payslip.
      expect(verdict.note.length).toBeGreaterThan(0);
    }
  });

  it("does not flag a shift that merely crosses the repeated hour", () => {
    /**
     * Half past one in Berlin is an ordinary time. The shift is still nine
     * hours long, because the repeat happens inside it, and the START is not
     * the thing a person needs to check.
     */
    const verdict = labor.wallEntry({
      date: "2026-10-25", startMinutes: 90, endMinutes: 570, timeZone: "Europe/Berlin",
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const hours = (verdict.endedAt.getTime() - verdict.startedAt.getTime()) / 3600_000;
    expect([hours, verdict.ambiguous]).toEqual([9, false]);
  });

  it("leaves an ordinary shift alone", () => {
    // Eight hours in July is eight hours, with nothing to flag.
    const verdict = labor.wallEntry({
      date: "2026-07-14", startMinutes: 480, endMinutes: 960, timeZone: "Europe/London",
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const hours = (verdict.endedAt.getTime() - verdict.startedAt.getTime()) / 3600_000;
    expect([hours, verdict.ambiguous]).toEqual([8, false]);
  });
});
