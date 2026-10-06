import { describe, it, expect } from "vitest";
import * as labor from "../src/labor/index.js";
import * as px from "../src/pay-extras/index.js";
import { money, toString as m, sum } from "../src/money/index.js";
import { instantOfLocal } from "../src/time/index.js";
import { permissionsFor } from "../src/access/index.js";

/**
 * THE BACK OFFICE PAYS PEOPLE BESIDE THEIR HOURS
 *
 * What a person spent for the company, a day away, and how a tip is shared:
 * the rules core holds for them, none of which needs a database.
 */

const usd = (v: string) => money(v, "USD");
const TZ = "America/Chicago";
const at = (date: string, hhmm: string) => {
  const [h = "0", min = "0"] = hhmm.split(":");
  return instantOfLocal(date, Number(h) * 60 + Number(min), TZ);
};
const policy: labor.OvertimePolicy = {
  label: "Declared policy", timeZone: TZ, weekStartsOn: 0, dayAttribution: "shift_start",
  weeklyThresholdMinutes: 40 * 60, weeklyDoubleTimeThresholdMinutes: null,
  dailyThresholdMinutes: null, dailyDoubleTimeThresholdMinutes: null,
  overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
  onCallTreatment: "separate_rate_not_hours_worked", note: "Test policy.",
};
const period = { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 };

describe("a reimbursement and a day away on a pay statement", () => {
  const base = {
    personId: "tech-1", period, policy,
    basis: { kind: "hourly" as const, baseRate: usd("30") },
    entries: [{ id: "e1", personId: "tech-1", kind: "on_site" as const, startedAt: at("2026-06-15", "08:00"), endedAt: at("2026-06-15", "12:00") }],
    now: at("2026-12-31", "12:00"),
  };

  it("are their own lines, in the period they fall in, and not in the gross", () => {
    const result = labor.buildStatement({
      ...base,
      reimbursements: [
        { expenseId: "x1", personId: "tech-1", amount: usd("42.50"), label: "Reimbursement: capacitor, job 1042", occurredAt: at("2026-06-16", "10:00") },
        { expenseId: "x2", personId: "tech-2", amount: usd("99"), label: "Somebody else's", occurredAt: at("2026-06-16", "10:00") },
        { expenseId: "x3", personId: "tech-1", amount: usd("12"), label: "Last month", occurredAt: at("2026-06-01", "10:00") },
      ],
      perDiems: [
        { perDiemId: "d1", personId: "tech-1", amount: usd("75"), label: "Per diem, 2026-06-17, job 1042", occurredAt: at("2026-06-17", "00:00") },
        { perDiemId: "d2", personId: "tech-1", amount: usd("75"), label: "Per diem, 2026-06-21, job 1042", occurredAt: at("2026-06-21", "00:00") },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.statement;
    expect(s.lines.filter((l) => l.kind === "reimbursement").map((l) => [l.label, m(l.amount)]))
      .toEqual([["Reimbursement: capacitor, job 1042", "42.5000"]]);
    expect(s.lines.filter((l) => l.kind === "per_diem").map((l) => m(l.amount))).toEqual(["75.0000"]);
    // Four hours at thirty is the only wage.
    expect(m(s.gross)).toBe("120.0000");
    expect(m(s.nonTaxable)).toBe("117.5000");
    // The lines add up to the gross and the non-taxable together.
    expect(m(sum(s.lines.map((l) => l.amount), "USD"))).toBe("237.5000");
    const reimbursement = s.lines.find((l) => l.kind === "reimbursement")!;
    expect(reimbursement.explanation).toMatch(/no tax is taken/);
  });

  it("are never netted against a commission reversal that wages could not take", () => {
    const result = labor.buildStatement({
      ...base,
      entries: [],
      clawbacks: [{
        creditId: "inv-1",
        line: { personId: "tech-1", amount: usd("-50"), explanation: "A credit." },
        occurredAt: at("2026-06-16", "09:00"), earnedAt: at("2026-05-01", "09:00"),
      }],
      reimbursements: [
        { expenseId: "x1", personId: "tech-1", amount: usd("80"), label: "Reimbursement: diesel", occurredAt: at("2026-06-16", "10:00") },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // What the person spent is theirs to get back whole: the reversal is carried, not taken from it.
    expect(m(result.statement.gross)).toBe("0.0000");
    expect(m(result.statement.nonTaxable)).toBe("80.0000");
    expect(m(result.statement.carriedForward)).toBe("-50.0000");
  });

  it("refuse an amount in another currency rather than converting it", () => {
    const result = labor.buildStatement({
      ...base,
      reimbursements: [{ expenseId: "x1", personId: "tech-1", amount: money("10", "CAD"), label: "Toll", occurredAt: at("2026-06-16", "10:00") }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("what somebody typed as an expense", () => {
  const today = "2026-10-05";
  const check = (over: Partial<Parameters<typeof px.checkExpense>[0]> = {}) =>
    px.checkExpense({ amount: "42.50", spentOn: "2026-10-04", today, description: "Capacitor", ...over });

  it("accepts dollars and cents, a day that has happened and words", () => {
    const ok = check({ description: "  Capacitor   from the supply house " });
    expect(ok).toMatchObject({ ok: true, description: "Capacitor from the supply house" });
    if (ok.ok) expect(m(ok.amount)).toBe("42.5000");
  });

  it("says what is wrong in words the person can act on", () => {
    expect(check({ amount: "forty" })).toMatchObject({ ok: false, reason: expect.stringMatching(/dollars and cents/) });
    expect(check({ amount: "42.505" })).toMatchObject({ ok: false });
    expect(check({ amount: "0" })).toMatchObject({ ok: false, reason: expect.stringMatching(/more than nothing/) });
    expect(check({ amount: "10000.01" })).toMatchObject({ ok: false, reason: expect.stringMatching(/Ask the office/) });
    expect(check({ spentOn: "2026-10-06" })).toMatchObject({ ok: false, reason: expect.stringMatching(/not happened/) });
    expect(check({ spentOn: "2026-05-01" })).toMatchObject({ ok: false, reason: expect.stringMatching(/120 days/) });
    expect(check({ spentOn: "yesterday" })).toMatchObject({ ok: false });
    expect(check({ description: "   " })).toMatchObject({ ok: false, reason: expect.stringMatching(/what it was for/) });
    expect(check({ description: "x".repeat(301) })).toMatchObject({ ok: false });
  });

  it("allows exactly the largest amount and exactly the oldest day", () => {
    expect(check({ amount: "10000.00" }).ok).toBe(true);
    expect(check({ spentOn: "2026-06-07" }).ok).toBe(true);
    expect(check({ spentOn: "2026-06-06" }).ok).toBe(false);
  });
});

describe("the company's rate for a day away", () => {
  it("is dollars and cents, more than nothing and not a typing slip", () => {
    expect(px.checkPerDiemRate("75")).toEqual({ ok: true, rate: "75.00" });
    expect(px.checkPerDiemRate(" 74.5 ")).toEqual({ ok: true, rate: "74.50" });
    expect(px.checkPerDiemRate("0")).toMatchObject({ ok: false });
    expect(px.checkPerDiemRate("seventy")).toMatchObject({ ok: false });
    expect(px.checkPerDiemRate("1000.01")).toMatchObject({ ok: false, reason: expect.stringMatching(/slip of the keys/) });
    expect(px.checkPerDiemRate("1000")).toEqual({ ok: true, rate: "1000.00" });
  });

  it("reads a hand edited settings blob as the defaults rather than as nonsense", () => {
    expect(px.readPayExtras(undefined)).toEqual({ perDiemRate: null, tipSplit: "even" });
    expect(px.readPayExtras({ perDiemRate: "banana", tipSplit: "lottery" })).toEqual({ perDiemRate: null, tipSplit: "even" });
    expect(px.readPayExtras({ perDiemRate: "60", tipSplit: "lead" })).toEqual({ perDiemRate: "60.00", tipSplit: "lead" });
  });

  it("lists every day from the first to the last, and refuses a slip", () => {
    expect(px.daysAway("2026-10-01", "2026-10-03")).toEqual({ ok: true, days: ["2026-10-01", "2026-10-02", "2026-10-03"] });
    expect(px.daysAway("2026-10-03", "2026-10-03")).toEqual({ ok: true, days: ["2026-10-03"] });
    expect(px.daysAway("2026-10-03", "2026-10-01")).toMatchObject({ ok: false, reason: expect.stringMatching(/earlier day first/) });
    expect(px.daysAway("2026-01-01", "2026-12-31")).toMatchObject({ ok: false, reason: expect.stringMatching(/31 days/) });
    expect(px.daysAway("2026-10-01", "2026-10-31")).toMatchObject({ ok: true });
  });
});

describe("who may do what with expenses", () => {
  const actor = (role: string) => ({ userId: "u", organizationId: "o", roles: [role], grants: [] as string[] }) as never;

  it("lets everybody record their own, and only the office decide", () => {
    for (const role of ["technician", "crew_lead", "csr", "dispatcher", "readonly", "office_manager", "accountant"]) {
      expect(permissionsFor(actor(role)).has("expense:own"), role).toBe(true);
    }
    expect(permissionsFor(actor("technician")).has("expense:approve")).toBe(false);
    expect(permissionsFor(actor("crew_lead")).has("expense:approve")).toBe(false);
    expect(permissionsFor(actor("office_manager")).has("expense:approve")).toBe(true);
    expect(permissionsFor(actor("branch_manager")).has("expense:approve")).toBe(true);
    expect(permissionsFor(actor("accountant")).has("expense:approve")).toBe(true);
  });

  it("keeps payroll's money away from the administrator, as the rest of payroll is", () => {
    expect(permissionsFor(actor("admin")).has("expense:approve")).toBe(false);
    expect(permissionsFor(actor("admin")).has("tip:record")).toBe(false);
    expect(permissionsFor(actor("owner")).has("expense:approve")).toBe(true);
  });
});

describe("sharing a tip between the people on a job", () => {
  const people = [
    { technicianId: "tech-c", seconds: 3600, isLead: false },
    { technicianId: "tech-a", seconds: 7200, isLead: true },
    { technicianId: "tech-b", seconds: 0, isLead: false },
  ];
  const shares = (rule: px.TipSplitRule, tip: string, who = people) =>
    px.splitTipByRule(rule, usd(tip), who);
  const amounts = (split: px.TipSplit) => split.shares.map((s) => [s.technicianId, m(s.amount)]);

  it("shares evenly to the cent, the odd cent to the first by id, and keeps the rule it used", () => {
    const split = shares("even", "10.00");
    expect(amounts(split)).toEqual([["tech-a", "3.3400"], ["tech-b", "3.3300"], ["tech-c", "3.3300"]]);
    expect(split).toMatchObject({ rule: "even", note: "" });
  });

  it("shares by hours on the job: two thirds and one third, and nothing for somebody with no hours", () => {
    const split = shares("hours", "30.00");
    expect(amounts(split)).toEqual([["tech-a", "20.0000"], ["tech-c", "10.0000"]]);
    expect(split.rule).toBe("hours");
    expect(split.note).toMatch(/no hours recorded on it, so they have no share/);
  });

  it("adds back to the tip exactly whatever the hours, with the odd cents on the largest share", () => {
    const odd = [
      { technicianId: "a", seconds: 1000, isLead: false },
      { technicianId: "b", seconds: 1000, isLead: false },
      { technicianId: "c", seconds: 1001, isLead: false },
    ];
    for (const tip of ["0.01", "0.02", "7.77", "100.00", "123.45"]) {
      const split = shares("hours", tip, odd);
      expect(m(sum(split.shares.map((s) => s.amount), "USD"))).toBe(m(usd(tip)));
    }
    expect(amounts(shares("hours", "0.01", odd))).toEqual([["c", "0.0100"]]);
  });

  it("gives the lead all of it", () => {
    const split = shares("lead", "25.50");
    expect(amounts(split)).toEqual([["tech-a", "25.5000"]]);
    expect(split).toMatchObject({ rule: "lead", note: "" });
  });

  it("shares between leads when more than one is marked, and says so", () => {
    const split = shares("lead", "10", people.map((p) => ({ ...p, isLead: p.technicianId !== "tech-b" })));
    expect(amounts(split)).toEqual([["tech-a", "5.0000"], ["tech-c", "5.0000"]]);
    expect(split.note).toMatch(/More than one person is marked as lead/);
  });

  it("falls back to an even share and says why, rather than leaving a tip with nobody", () => {
    const noLead = shares("lead", "9", people.map((p) => ({ ...p, isLead: false })));
    expect(noLead.rule).toBe("even");
    expect(noLead.note).toMatch(/No lead is marked/);
    expect(m(sum(noLead.shares.map((s) => s.amount), "USD"))).toBe("9.0000");

    const noHours = shares("hours", "9", people.map((p) => ({ ...p, seconds: 0 })));
    expect(noHours.rule).toBe("even");
    expect(noHours.note).toMatch(/No hours were recorded/);
    expect(noHours.shares).toHaveLength(3);
  });

  it("is the same person once however many visits they are on, with the most hours and any lead mark", () => {
    const split = shares("lead", "10", [
      { technicianId: "tech-a", seconds: 60, isLead: false },
      { technicianId: "tech-a", seconds: 120, isLead: true },
      { technicianId: "tech-b", seconds: 60, isLead: false },
    ]);
    expect(amounts(split)).toEqual([["tech-a", "10.0000"]]);
  });

  it("shares nothing when there is nobody or nothing to share", () => {
    expect(shares("even", "10", []).shares).toEqual([]);
    expect(shares("hours", "0").shares).toEqual([]);
  });
});
