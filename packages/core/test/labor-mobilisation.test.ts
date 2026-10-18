import { describe, it, expect } from "vitest";
import * as labor from "../src/labor/index";
import { money, toString as m } from "../src/money/index";
import { instantOfLocal } from "../src/time/index";

/**
 * GETTING A JOB READY IS PAID EXACTLY AS ON SITE TIME
 *
 * A crew loading the trailer, driving out to a build and unloading on its
 * first day punched on site before mobilisation had a kind of its own. Giving
 * it one must change nobody's pay: the same week punched either way is the
 * same statement, under the default and under a policy that declares on site
 * time out of the overtime pot. Only the production per crew hour reads the
 * kind.
 */

const TZ = "America/Chicago";
const at = (date: string, hhmm: string): Date => {
  const [h = "0", min = "0"] = hhmm.split(":");
  return instantOfLocal(date, Number(h) * 60 + Number(min), TZ);
};
const entry = (id: string, date: string, from: string, to: string, kind: labor.TimeEntryKind): labor.TimeEntry => ({
  id, personId: "tech-1", kind, startedAt: at(date, from), endedAt: at(date, to),
});
const policy = (over: Partial<labor.OvertimePolicy> = {}): labor.OvertimePolicy => ({
  label: "Declared policy", timeZone: TZ, weekStartsOn: 0, dayAttribution: "shift_start",
  weeklyThresholdMinutes: 40 * 60, weeklyDoubleTimeThresholdMinutes: null,
  dailyThresholdMinutes: 8 * 60, dailyDoubleTimeThresholdMinutes: null,
  overtimeMultiplier: "1.5", doubleTimeMultiplier: "2", onCallTreatment: "separate_rate_not_hours_worked",
  note: "Declared by the operator on their own advice.", ...over,
});

/** A week of five ten hour days, the first two hours of Monday spent getting the job ready. */
const week = (first: labor.TimeEntryKind) => [
  entry("m0", "2026-06-15", "06:00", "08:00", first),
  entry("m1", "2026-06-15", "08:00", "16:00", "on_site"),
  ...["2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"].map((d, i) => entry(`d${i}`, d, "06:00", "16:00", "on_site")),
];

function statement(kind: labor.TimeEntryKind, declared: labor.OvertimePolicy) {
  const result = labor.buildStatement({
    personId: "tech-1",
    period: { id: "pp", label: "Mid June", startDate: "2026-06-14", weeks: 1 },
    policy: declared,
    basis: { kind: "hourly", baseRate: money("30", "USD") },
    entries: week(kind),
    now: at("2026-12-31", "12:00"),
  });
  if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join(" "));
  return result.statement.lines.map((l) => [l.kind, l.seconds ?? null, m(l.amount)]);
}

describe("getting a job ready", () => {
  it("is paid as on site time, line for line, under the default", () => {
    expect(statement("mobilisation", policy())).toEqual(statement("on_site", policy()));
  });

  it("follows what the policy says about on site time, never an answer of its own", () => {
    const outOfPot = policy({ countsTowardOvertime: { on_site: false } });
    expect(statement("mobilisation", outOfPot)).toEqual(statement("on_site", outOfPot));
    expect(labor.payKindOf("mobilisation")).toBe("on_site");
    expect(labor.payKindOf("travel")).toBe("travel");
  });

  it("cannot be declared out of the overtime pot on its own", () => {
    const verdict = labor.checkOvertimePolicy(policy({ countsTowardOvertime: { mobilisation: false } }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals[0]!.message).toMatch(/exactly as "On site" is/);
  });

  it("is working time at a site wherever on site hours are paid, costed or billed", () => {
    expect([...labor.ON_SITE_KINDS]).toEqual(["on_site", "mobilisation"]);
  });
});
