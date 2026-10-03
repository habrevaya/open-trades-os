import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { ledger, type Actor } from "@opentradesos/core";
import type { z } from "zod";
import * as payroll from "../src/services/payroll";
import * as commissions from "../src/services/commissions";
import * as labor from "../src/services/labor";
import * as laborSettings from "../src/services/labor-settings";
import * as fieldOps from "../src/services/field";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { payrollRoutes } from "../src/contracts/payroll";
import type { RouteDefinition } from "../src/lib/define";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * PAYROLL EXPORT
 *
 * What a bureau takes is hours by employee by pay period, at the rates
 * applied, split by the categories that are taxed differently. Every piece of
 * that existed in this codebase and had never been joined up.
 *
 * THREE PROPERTIES, AND ALMOST EVERY TEST HERE IS ONE OF THEM.
 *
 * The period CLOSES, or the same fortnight gets exported twice and the second
 * file is as authoritative looking as the first.
 *
 * The export is REPRODUCIBLE: running it twice on one close gives the same
 * bytes, asserted by a checksum rather than hoped for.
 *
 * An edit after the close is VISIBLE: a punch approved, corrected or added
 * afterwards moves the fingerprint and the export refuses, rather than
 * quietly producing a different file nobody can tell from the first.
 *
 * The hours come from real punches through the real field sync, which is what
 * a technician's phone calls, so the rate on them is the one `freezeRate`
 * actually writes rather than one a fixture chose.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("payroll:org");
const OWNER_USER = fixtureId("payroll:owner");
const RAY_USER = fixtureId("payroll:ray");
const DANA_USER = fixtureId("payroll:dana");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(OWNER_USER, ["owner"]);

let rayId = "";
let danaId = "";
let customerId = "";
let propertyId = "";

/** Monday the 5th of January 2026. Austin is six hours behind UTC in January. */
const START = "2026-01-05";
const localNoonOffset = 6;
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 0, day, hour + localNoonOffset, minute)).toISOString();

const uuid = () => crypto.randomUUID();

/**
 * A day of work, through the field sync a phone actually calls.
 *
 * Not a row insert. The punch out is what triggers `freezeRate`, and the rate
 * it freezes is the thing the whole export is priced from; a fixture that
 * writes `applied_base_rate` itself would be testing the fixture.
 */
async function workDays(
  userId: string, technicianId: string,
  days: { day: number; from: number; to: number }[],
): Promise<void> {
  const ctx = as(userId, ["technician"]);
  const { deviceId } = await fieldOps.register(ctx, { installationId: `install-${uuid()}` });

  const operations = days.flatMap((shift, index) => [
    {
      clientId: uuid(), sequence: index * 2 + 1, kind: "timeclock.punch_in" as const,
      occurredAt: at(shift.day, shift.from),
      payload: { technicianId, classification: "Journeyman" },
    },
    {
      clientId: uuid(), sequence: index * 2 + 2, kind: "timeclock.punch_out" as const,
      occurredAt: at(shift.day, shift.to),
      payload: { technicianId },
    },
  ]);

  const result = await fieldOps.sync(ctx, { deviceId, operations });
  const bad = result.results.filter((r) => r.status !== "applied");
  if (bad.length > 0) throw new Error(`punches did not apply: ${JSON.stringify(bad)}`);
}

async function accountBalance(account: string): Promise<string> {
  const [row] = await raw`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return (row as { net: string }).net;
}

async function declarePeriod(startDate = START, weeks = 2, label = "Fortnight to 18 January") {
  return payroll.declarePeriod(owner(), { label, startDate, weeks });
}

/** A paid invoice with a commission on it, dated inside the period. */
async function commissionInPeriod(technicianId: string, total: string, occurredAt: string) {
  const plan = await commissions.declarePlan(owner(), {
    label: `Plan ${uuid().slice(0, 8)}`,
    basis: "percent_of_revenue", rate: "0.10",
    note: "A tenth of what the job invoiced for.",
  });
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Install", tags: [], customFields: {},
  });
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [{ name: "Install", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return commissions.settle(owner(), {
    invoiceId: invoice.id as string,
    planId: plan.id,
    shares: [{ technicianId, weight: "1" }],
    occurredAt: new Date(occurredAt),
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER_USER, name: "Payroll Co", slug: "payroll-co" });

  for (const [id, email] of [[RAY_USER, "payroll-ray@test.local"], [DANA_USER, "payroll-dana@test.local"]]) {
    await raw`insert into public."user" (id, email) values (${id!}, ${email!})
      on conflict (id) do nothing`;
    await raw`insert into public.membership (organization_id, user_id, role)
      values (${ORG}, ${id!}, 'technician')`;
  }

  const memberships = await raw<{ id: string; user_id: string }[]>`
    select id, user_id from public.membership where organization_id = ${ORG}`;
  const membershipOf = (userId: string) => memberships.find((m) => m.user_id === userId)!.id;

  const [ray] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membershipOf(RAY_USER)}, 'Nunez, Ray', 'Journeyman') returning id`;
  rayId = ray!.id;
  const [dana] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membershipOf(DANA_USER)}, 'Pike, Dana', 'Journeyman') returning id`;
  danaId = dana!.id;

  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.payroll_export where organization_id = ${ORG}`;
  await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
  await raw`delete from public.pay_period where organization_id = ${ORG}`;
  await raw`delete from public.commission_entry where organization_id = ${ORG}`;
  await raw`delete from public.commission_reversal where organization_id = ${ORG}`;
  await raw`delete from public.commission_event where organization_id = ${ORG}`;
  await raw`delete from public.commission_plan where organization_id = ${ORG}`;
  await raw`delete from public.timeclock_entry where organization_id = ${ORG}`;
  await raw`delete from public.field_operation where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`set session_replication_role = replica`;
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw`set session_replication_role = origin`;
  await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
  await raw`delete from public.wage_scale where organization_id = ${ORG}`;

  await laborSettings.setScale(owner(), {
    classification: "Journeyman", baseRate: "40.00", fringeRate: "8.00",
    effectiveFrom: "2026-01-01",
  });
  await laborSettings.setPolicy(owner(), {
    label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1,
    dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
    onCallTreatment: "separate_rate_not_hours_worked",
    note: "Forty hours a week at time and a half. Nothing daily.",
  });
});

/* ======================================================== the pay calendar */

run("a pay period is whole workweeks or it is nothing", () => {
  it("refuses a period that does not start on the workweek boundary", async () => {
    /**
     * Overtime is measured over a workweek and only over a workweek. A period
     * starting on a Thursday cannot be settled: half the hours that decide
     * whether that Thursday was overtime are in the other period, which may
     * already be closed and paid. Semimonthly periods do exactly this.
     */
    await expect(payroll.declarePeriod(owner(), {
      label: "Half a month", startDate: "2026-01-15", weeks: 2,
    })).rejects.toThrow(/whole workweek|starts on/i);
  });

  it("refuses two periods that cover the same day", async () => {
    await declarePeriod();
    await expect(payroll.declarePeriod(owner(), {
      label: "Overlapping", startDate: "2026-01-12", weeks: 2,
    })).rejects.toThrow(/overlaps/i);
  });

  it("derives the end with the policy's zone rather than adding milliseconds", async () => {
    /**
     * A week containing a clock change is 167 or 169 hours. A period whose end
     * is the start plus seven times 864e5 is an hour short twice a year, and
     * the shift in that hour falls out of the period entirely: somebody works a
     * Saturday night and it is on nobody's payroll. March the 8th 2026 is the
     * spring change in Austin.
     */
    const period = await payroll.declarePeriod(owner(), {
      label: "Spring forward", startDate: "2026-03-02", weeks: 2,
    });
    const elapsedHours = (period.periodEnd.getTime() - period.periodStart.getTime()) / 3_600_000;
    expect(elapsedHours).toBe(14 * 24 - 1);
  });
});

/* =========================================================== the register */

run("the register, from real punches", () => {
  beforeEach(async () => {
    if (!url) return;
    /** Forty hours, then a Saturday morning that tips into overtime. */
    await workDays(RAY_USER, rayId, [
      { day: 5, from: 8, to: 16 }, { day: 6, from: 8, to: 16 }, { day: 7, from: 8, to: 16 },
      { day: 8, from: 8, to: 16 }, { day: 9, from: 8, to: 16 }, { day: 10, from: 8, to: 12 },
      { day: 12, from: 8, to: 16 }, { day: 13, from: 8, to: 16 },
    ]);
    await workDays(DANA_USER, danaId, [
      { day: 5, from: 8, to: 16 }, { day: 6, from: 8, to: 16 }, { day: 7, from: 8, to: 16 },
    ]);
  });

  it("pays the BASE rate frozen on the punch, never the loaded one", async () => {
    /**
     * The scale is forty an hour base and eight of fringe, so the loaded rate
     * is forty eight. Job costing uses the loaded rate because that is what
     * the hours cost the company. PAYROLL PAYS THE BASE: the fringe is a
     * contribution to a health, pension or training fund, and paying it to the
     * technician as wages hands them their own pension money and leaves the
     * fund short by exactly that amount on every hour anybody works.
     */
    const period = await declarePeriod();
    const register = await payroll.register(owner(), { periodId: period.id });

    const ray = register.rows.find((row) => row.technicianId === rayId)!;
    const regular = ray.lines.filter((line) => line.kind === "regular");
    expect(regular.every((line) => line.rate === "40.0000")).toBe(true);

    /** Fifty six straight hours at forty, four overtime at sixty. */
    expect(ray.gross).toBe("2480.0000");

    const overtime = ray.lines.find((line) => line.kind === "overtime")!;
    expect(overtime.hours).toBe("4.00");
    expect(overtime.rate).toBe("60.0000");
  });

  it("splits the categories that are taxed differently rather than one hours figure", async () => {
    const period = await declarePeriod();
    const register = await payroll.register(owner(), { periodId: period.id });
    const ray = register.rows.find((row) => row.technicianId === rayId)!;

    const kinds = new Set(ray.lines.map((line) => line.kind));
    expect(kinds.has("regular")).toBe(true);
    expect(kinds.has("overtime")).toBe(true);

    /** And the lines add to the gross as printed. */
    const summed = ray.lines.reduce((total, line) => total + Number(line.amount), 0);
    expect(summed).toBeCloseTo(Number(ray.gross), 10);
  });

  it("explains every line in a sentence the person paid can check", async () => {
    const period = await declarePeriod();
    const register = await payroll.register(owner(), { periodId: period.id });
    for (const row of register.rows) {
      for (const line of row.lines) {
        expect(line.explanation.length, `${row.technicianName} ${line.kind}`).toBeGreaterThan(20);
      }
    }
  });

  it("reports a person whose hours have no rate as a problem, not as a smaller number", async () => {
    /**
     * Blending over the punches that do have a rate would pay the unpriced
     * hours at somebody else's rate, and the only symptom is a figure slightly
     * too large or too small.
     */
    await raw`update public.timeclock_entry set applied_base_rate = null
      where organization_id = ${ORG} and technician_id = ${danaId}`;
    const period = await declarePeriod();
    const register = await payroll.register(owner(), { periodId: period.id });

    expect(register.rows.some((row) => row.technicianId === danaId)).toBe(false);
    const problem = register.problems.find((p) => p.technicianId === danaId)!;
    expect(problem.messages.join(" ")).toMatch(/no rate frozen/i);
  });
});

/* ============================================================== the close */

run("closing a period", () => {
  it("refuses while a punch inside it is still open", async () => {
    /**
     * AN OPEN PUNCH IS NOT ZERO HOURS. Somebody forgot to clock out and has
     * worked them. Summing the entries and skipping the open one produces a
     * statement short by however long that job took, silently, because nothing
     * about the total says a punch is missing.
     */
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }]);
    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, classification)
      values (${ORG}, ${danaId}, 'on_site', ${at(6, 8)}, 'Journeyman')`;

    const period = await declarePeriod();
    await expect(payroll.closePeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/still open/i);
  });

  it("refuses a period that has not finished yet", async () => {
    /** Closing one freezes hours still being worked. */
    const period = await payroll.declarePeriod(owner(), {
      label: "Next year", startDate: "2027-01-04", weeks: 2,
    });
    await expect(payroll.closePeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/has not happened yet/i);
  });

  it("refuses a second close over a live one", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await expect(payroll.closePeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/already closed/i);
  });

  it("keeps the reopened close on the record rather than overwriting it", async () => {
    /**
     * "This fortnight was closed, reopened on the 14th by Dana, and closed
     * again" is a fact a payroll auditor asks for, and a column overwritten by
     * the second close cannot answer it.
     */
    const period = await declarePeriod();
    const first = await payroll.closePeriod(owner(), { periodId: period.id });
    await payroll.reopenPeriod(owner(), { periodId: period.id, reason: "Ray's Saturday was missing" });
    const second = await payroll.closePeriod(owner(), { periodId: period.id });

    expect(second.closeId).not.toBe(first.closeId);
    const rows = await raw<{ reopened_reason: string | null }[]>`
      select reopened_reason from public.pay_period_close
      where pay_period_id = ${period.id} order by closed_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.reopened_reason).toMatch(/Saturday/);
  });

  it("will not reopen without a reason", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await expect(payroll.reopenPeriod(owner(), { periodId: period.id, reason: "  " }))
      .rejects.toThrow(/needs a reason/i);
  });
});

/* ============================================================= the export */

run("the export", () => {
  beforeEach(async () => {
    if (!url) return;
    await workDays(RAY_USER, rayId, [
      { day: 5, from: 8, to: 16 }, { day: 6, from: 8, to: 16 }, { day: 7, from: 8, to: 16 },
      { day: 8, from: 8, to: 16 }, { day: 9, from: 8, to: 16 }, { day: 10, from: 8, to: 12 },
    ]);
    await workDays(DANA_USER, danaId, [{ day: 12, from: 8, to: 16 }]);
  });

  it("REFUSES an open period", async () => {
    /**
     * A file produced from a period that is still open is a file that will be
     * produced again tomorrow with different numbers in it, and nothing on
     * either copy says which one the bureau was sent.
     */
    const period = await declarePeriod();
    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/not closed/i);
  });

  it("produces one row per employee per pay category, with a header", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id, note: "To the bureau" });
    const file = await payroll.exportPeriod(owner(), { periodId: period.id });

    const lines = file.content.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "period,period_start,period_end,employee_id,employee_name,classification,pay_category,hours,rate,amount",
    );
    expect(lines.length - 1).toBe(file.rowCount);

    const rows = lines.slice(1).map(parseCsvRow);
    expect(rows.every((row) => row.length === 10)).toBe(true);

    const categories = rows.map((row) => row[6]);
    expect(categories).toContain("regular");
    expect(categories).toContain("overtime");

    /** The amounts in the file add to the gross the register reports. */
    const summed = rows.reduce((total, row) => total + Number(row[9]), 0);
    expect(summed).toBeCloseTo(Number(file.grossTotal), 10);
  });

  it("quotes a name with a comma in it", async () => {
    /**
     * "Nunez, Ray" is the ordinary way a payroll file holds a name, and an
     * unquoted one shifts every column after it by one. The bureau's importer
     * then reads the classification as the pay category and the amount as
     * nothing.
     */
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    const file = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(file.content).toContain('"Nunez, Ray"');
  });

  it("IS REPRODUCIBLE: the same close gives the same bytes", async () => {
    /**
     * `buildStatement` takes `now` as a parameter so a re-run of a closed
     * period gives the answer it gave the first time. Passing the current time
     * instead would make the entry checks move under it, and an export that is
     * almost reproducible is not reproducible: the second file differs for a
     * reason nobody can name.
     */
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });

    const first = await payroll.exportPeriod(owner(), { periodId: period.id });
    const second = await payroll.exportPeriod(owner(), { periodId: period.id });

    expect(second.content).toBe(first.content);
    expect(second.checksum).toBe(first.checksum);
    expect(second.previouslyExported).toBe(true);
    expect(first.previouslyExported).toBe(false);

    const history = await payroll.exportsFor(owner(), { periodId: period.id });
    expect(history).toHaveLength(2);
    expect(history[0]!.checksum).toBe(history[1]!.checksum);
  });

  it("builds the statement against the instant of the CLOSE, not the current time", async () => {
    /**
     * Every input to a reproducible export has to be frozen, and the clock is
     * an input: `buildStatement` takes `now` as a parameter precisely so a
     * re-run of a closed period gives the answer it gave the first time, and
     * reading the wall clock inside it would mean the entry checks move under
     * the file between runs.
     *
     * THE CLOSE INSTANT IS MOVED BACK DIRECTLY HERE, and it has to be. The
     * service never writes a close that predates the punches inside its own
     * period, because it refuses to close a period that has not finished. The
     * property under test is which of the two clocks the statement is built
     * against, and the only way to see the difference is to make them
     * disagree. Under the current time this file would export happily; under
     * the stored close instant, core refuses a punch that ends after it.
     */
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await raw`update public.pay_period_close set closed_at = ${at(6, 0)}
      where pay_period_id = ${period.id} and reopened_at is null`;

    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/ends in the future/i);
  });

  it("REFUSES after a punch inside the period is approved", async () => {
    /**
     * THE GUARD THAT LOOKS FINE UNTIL THE DAY IT MATTERS. An approval, a
     * corrected punch or one that arrives late off a phone all change what the
     * file would say. Without the fingerprint the second export is simply a
     * different file, equally authoritative looking, and the only way anybody
     * finds out is a technician comparing two payslips.
     */
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await payroll.exportPeriod(owner(), { periodId: period.id });

    const entries = await raw<{ id: string }[]>`select id from public.timeclock_entry
      where organization_id = ${ORG} and technician_id = ${rayId} limit 1`;
    await labor.approve(owner(), { entryIds: [entries[0]!.id] });

    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/changed after it was closed/i);
  });

  it("REFUSES after a punch is added inside the period", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });

    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, ended_at, minutes,
       classification, applied_base_rate, applied_loaded_rate)
      values (${ORG}, ${danaId}, 'on_site', ${at(13, 8)}, ${at(13, 16)}, 480,
              'Journeyman', '40.0000', '48.0000')`;

    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/changed after it was closed/i);
  });

  it("exports again once the period is reopened and closed over the change", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    const before = await payroll.exportPeriod(owner(), { periodId: period.id });

    const entries = await raw<{ id: string }[]>`select id from public.timeclock_entry
      where organization_id = ${ORG} and technician_id = ${rayId} limit 1`;
    await labor.approve(owner(), { entryIds: [entries[0]!.id] });

    await payroll.reopenPeriod(owner(), { periodId: period.id, reason: "Approvals landed late" });
    await payroll.closePeriod(owner(), { periodId: period.id });
    const after = await payroll.exportPeriod(owner(), { periodId: period.id });

    /** The same hours, so the same file, but a deliberate act in between. */
    expect(after.content).toBe(before.content);
    expect(after.closeId).not.toBe(before.closeId);
  });

  it("refuses a format it does not produce", async () => {
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await expect(payroll.exportPeriod(owner(), { periodId: period.id, format: "adp" }))
      .rejects.toThrow(/CSV is the only one/i);
  });

  it("refuses when somebody's statement cannot be assembled", async () => {
    await raw`update public.timeclock_entry set applied_base_rate = null
      where organization_id = ${ORG} and technician_id = ${danaId}`;
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/cannot be assembled/i);
  });
});

/* =============================================== commission on the payroll */

run("commission earned in the period", () => {
  it("appears on the register and in the file as its own category", async () => {
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }]);
    await commissionInPeriod(rayId, "1000.00", at(7, 10));

    const period = await declarePeriod();
    const register = await payroll.register(owner(), { periodId: period.id });
    const ray = register.rows.find((row) => row.technicianId === rayId)!;

    const commission = ray.lines.find((line) => line.kind === "commission")!;
    expect(commission.amount).toBe("100.0000");
    /** Eight hours at forty, plus the commission. */
    expect(ray.gross).toBe("420.0000");

    await payroll.closePeriod(owner(), { periodId: period.id });
    const file = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(file.content).toMatch(/,commission,,,100\.0000/);
  });

  it("refuses to backdate an earning into a period that has been closed", async () => {
    /**
     * A commission dated into a fortnight that has been exported and paid
     * changes a figure the bureau holds, the technician has been paid on, and
     * tax has been withheld and remitted against. The same argument the
     * accounting close makes about a late invoice pushed into a filed quarter.
     */
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }]);
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });

    await expect(commissionInPeriod(rayId, "1000.00", at(7, 10)))
      .rejects.toThrow(/was closed .* and has been run|falls inside/i);
  });

  it("moves the fingerprint when it is settled after the close", async () => {
    /** Not only punches. A commission is money in the period too. */
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }]);
    await commissionInPeriod(rayId, "1000.00", at(7, 10));
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    await payroll.exportPeriod(owner(), { periodId: period.id });

    /** A reversal is dated now, so it lands outside: the fingerprint holds. */
    const fine = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(fine.rowCount).toBeGreaterThan(0);

    /** Editing the amount of a line inside the period does move it. */
    await raw`update public.commission_entry set amount = '90.0000'
      where organization_id = ${ORG}`;
    await expect(payroll.exportPeriod(owner(), { periodId: period.id }))
      .rejects.toThrow(/changed after it was closed/i);
  });
});

/* ========================================================= paying it out */

run("paying the commission", () => {
  it("clears the liability against cash and expenses nothing twice", async () => {
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }]);
    await commissionInPeriod(rayId, "1000.00", at(7, 10));

    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-100.0000");
    const expenseBefore = await accountBalance(ledger.ACCOUNTS.COMMISSION_EXPENSE);

    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });
    const run_ = await payroll.payCommissions(owner(), { periodId: period.id });

    expect(run_.total).toBe("100.0000");
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("0.0000");
    /**
     * The expense was recognised when the work was sold. Recognising it again
     * at payout would double the cost of every job.
     */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_EXPENSE)).toBe(expenseBefore);
    expect(await accountBalance(ledger.ACCOUNTS.CASH)).toBe("-100.0000");
  });

  it("refuses to pay out of an open period", async () => {
    await commissionInPeriod(rayId, "1000.00", at(7, 10));
    const period = await declarePeriod();
    await expect(payroll.payCommissions(owner(), { periodId: period.id }))
      .rejects.toThrow(/not closed/i);
  });

  it("does not pay the same commission twice", async () => {
    await commissionInPeriod(rayId, "1000.00", at(7, 10));
    const period = await declarePeriod();
    await payroll.closePeriod(owner(), { periodId: period.id });

    await payroll.payCommissions(owner(), { periodId: period.id });
    const second = await payroll.payCommissions(owner(), { periodId: period.id });

    expect(second.total).toBe("0.0000");
    expect(second.ledgerTransactionId).toBeNull();
    expect(await accountBalance(ledger.ACCOUNTS.CASH)).toBe("-100.0000");
  });

  it("carries a person whose net is negative rather than handing them a negative cheque", async () => {
    /**
     * Recovering an overpayment out of wages already earned is constrained in
     * most places, sometimes to nothing, and a payroll run that writes a
     * negative cheque has made that decision on the operator's behalf. The
     * rows stay unpaid and offset the next run.
     */
    const earned = await commissionInPeriod(rayId, "1000.00", at(7, 10));
    await commissions.reverse(owner(), {
      invoiceId: earned.invoiceId, reason: "write_off", creditedRevenue: "1000.00",
      causeType: "invoice.written_off", causeId: earned.invoiceId,
    });

    const period = await payroll.declarePeriod(owner(), {
      label: "Covering today", startDate: "2026-01-05", weeks: 2,
    });
    await payroll.closePeriod(owner(), { periodId: period.id });

    /** The reversal is dated now, which is after this period, so nothing nets. */
    const first = await payroll.payCommissions(owner(), { periodId: period.id });
    expect(first.total).toBe("100.0000");

    /** A later period catches the reversal and is negative, so it is carried. */
    const later = await payroll.declarePeriod(owner(), {
      label: "Today", startDate: thisWeekMonday(), weeks: 1,
    });
    await raw`insert into public.pay_period_close
      (organization_id, pay_period_id, closed_at, hours_fingerprint)
      values (${ORG}, ${later.id}, now(), 'forced-for-this-test')`;

    const run_ = await payroll.payCommissions(owner(), { periodId: later.id });
    expect(run_.total).toBe("0.0000");
    expect(run_.carried).toHaveLength(1);
    expect(run_.carried[0]!.amount).toBe("-100.0000");
  });
});

/**
 * A CSV row, respecting quotes.
 *
 * Splitting on commas is what the file's own escaping exists to defeat, and a
 * test that split naively would pass against an implementation that did not
 * quote at all.
 */
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** The Monday of the week we are standing in, in the policy's zone. */
function thisWeekMonday(): string {
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/* ==================================================== a technician's own */

run("a technician reading their own time", () => {
  it("answers whether they are still clocked in, and for how long this week", async () => {
    await workDays(RAY_USER, rayId, [{ day: 5, from: 8, to: 16 }, { day: 6, from: 8, to: 16 }]);
    const mine = await labor.myWeek(as(RAY_USER, ["technician"]), { weekOf: START });
    expect(mine.technicianId).toBe(rayId);
    expect(mine.regularHours).toBe("16.00");
    expect(mine.openSince).toBeNull();
  });

  it("is scoped to the caller, so it cannot be pointed at somebody else", async () => {
    /**
     * There is no technician id on the call. An endpoint that took one under
     * `timeclock:own` would let any technician read any other technician's
     * hours, and hours are what somebody is paid for.
     */
    await workDays(DANA_USER, danaId, [{ day: 5, from: 8, to: 16 }]);
    const mine = await labor.myWeek(as(RAY_USER, ["technician"]), { weekOf: START });
    expect(mine.technicianId).toBe(rayId);
    expect(mine.entries).toHaveLength(0);
  });

  it("tells an account with no route that it has no timeclock", async () => {
    await expect(labor.myWeek(owner(), { weekOf: START })).rejects.toThrow(ConflictError);
  });
});

/* ================================================= the contract and the code */

/**
 * THE HANDLERS MATCH THE CONTRACT, CHECKED BY THE COMPILER.
 *
 * The registry in src/routes wires these up and demands exactly this shape. It
 * is asserted here as well because these services are published before they
 * are wired, and a handler whose argument does not match the route's validated
 * input is a 500 the first time somebody calls it rather than a build error.
 */
type SessionHandler<R> = R extends RouteDefinition<infer I, z.ZodTypeAny>
  ? (ctx: ServiceContext, input: z.infer<I>) => Promise<unknown>
  : never;

const wiring: { [K in keyof typeof payrollRoutes]: SessionHandler<(typeof payrollRoutes)[K]> } = {
  listCommissionBases: commissions.handlers.listCommissionBases,
  listCommissionPlans: commissions.handlers.listCommissionPlans,
  declareCommissionPlan: commissions.handlers.declareCommissionPlan,
  deactivateCommissionPlan: commissions.handlers.deactivateCommissionPlan,
  settleCommission: commissions.handlers.settleCommission,
  reverseCommission: commissions.handlers.reverseCommission,
  listCommissionEarnings: commissions.handlers.listCommissionEarnings,
  declarePayPeriod: payroll.handlers.declarePayPeriod,
  listPayPeriods: payroll.handlers.listPayPeriods,
  closePayPeriod: payroll.handlers.closePayPeriod,
  reopenPayPeriod: payroll.handlers.reopenPayPeriod,
  getPayrollRegister: payroll.handlers.getPayrollRegister,
  exportPayPeriod: payroll.handlers.exportPayPeriod,
  listPayrollExports: payroll.handlers.listPayrollExports,
  payCommissions: payroll.handlers.payCommissions,
  payTips: payroll.handlers.payTips,
  getMyTimeclock: labor.handlers.getMyTimeclock,
};

describe("every published route has a handler of the right shape", () => {
  it("names one for each", () => {
    expect(Object.keys(wiring).sort()).toEqual(Object.keys(payrollRoutes).sort());
  });
});
