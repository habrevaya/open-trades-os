import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as payroll from "../src/services/payroll";
import * as laborSettings from "../src/services/labor-settings";
import * as fieldOps from "../src/services/field";
import * as fieldSales from "../src/services/field-sales";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { routes } from "../src/contracts";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A MILEAGE RATE FOR REIMBURSEMENTS
 *
 * The company sets what one mile is paid, from a day. A claim entered as miles is
 * worked out at the rate in force on the day of the drive, to the cent, and keeps
 * that rate; it is approved like any expense, exported with the other
 * reimbursements, and never posted to the ledger.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("mileage:org");
const OWNER = fixtureId("mileage:owner");
const RAY = fixtureId("mileage:ray");
const OFFICE = fixtureId("mileage:office");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const office = (): ServiceContext => ({
  actor: { userId: OFFICE, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
});

let rayTech = "";
let jobId = "";
const uuid = () => crypto.randomUUID();
const today = () => companyToday();
const OLD = companyToday(-40);
const NEW = companyToday(-10);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Mileage Co", slug: "mileage-co" });
  for (const [id, name, role] of [[RAY, "Ray Nunez", "technician"], [OFFICE, "Olive Office", "office_manager"]] as const) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@mileage.test`;
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
    const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role) returning id`;
    if (role === "technician") {
      const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name, wage_classification)
        values (${ORG}, ${m!.id}, ${name}, 'Journeyman') returning id`;
      rayTech = t!.id as string;
    }
  }
  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  const job = await jobs.create(owner(), { customerId: created.id as string, propertyId: (prop as { id: string }).id, summary: "Install a furnace", tags: [], customFields: {} });
  jobId = job.id as string;
  await laborSettings.setScale(owner(), { classification: "Journeyman", baseRate: "40.00", fringeRate: "8.00", effectiveFrom: "2026-01-01" });
  await laborSettings.setPolicy(owner(), {
    label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1, dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2", onCallTreatment: "separate_rate_not_hours_worked", note: "Forty hours a week.",
  });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.payroll_export where organization_id = ${ORG}`;
  await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
  await raw`delete from public.pay_period where organization_id = ${ORG}`;
  await raw`delete from public.expense where organization_id = ${ORG}`;
  await raw`delete from public.field_operation where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'payExtras' where id = ${ORG}`;
});

/* ======================================================= the rate itself */

run("the company sets what one mile is paid, from a day", () => {
  it("starts with none, takes a line from a day, and keeps them oldest first", async () => {
    expect(await payExtras.get(owner())).toMatchObject({ mileageRates: [], mileageRateToday: null });
    await payExtras.addMileageRate(owner(), { from: NEW, perMile: "0.725" });
    const view = await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    expect(view.mileageRates).toEqual([{ from: OLD, perMile: "0.700" }, { from: NEW, perMile: "0.725" }]);
    expect(view.mileageRateToday).toBe("0.725");
    /** Anybody who reads the timesheet reads it. */
    expect((await payExtras.get(office())).mileageRateToday).toBe("0.725");
  });

  it("is refused in words when it cannot be right, and a day cannot have two", async () => {
    await expect(payExtras.addMileageRate(owner(), { from: today(), perMile: "seventy cents" })).rejects.toThrow(/dollars/);
    await expect(payExtras.addMileageRate(owner(), { from: today(), perMile: "72" })).rejects.toThrow(/slip of the keys/);
    await expect(payExtras.addMileageRate(owner(), { from: "2026-02-30", perMile: "0.70" })).rejects.toThrow(/first day/);
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await expect(payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.80" })).rejects.toThrow(/already a rate from/);
    expect((await payExtras.get(owner())).mileageRates).toHaveLength(1);
  });

  it("is the same line sent again, and taking off one that is not there changes nothing", async () => {
    const added = async () => (await raw`select count(*)::int as n from public.audit_log where action = 'mileage_rate.added' and entity_id = ${ORG}`)[0]!.n as number;
    const before = await added();
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    const again = await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.700" });
    expect(again.mileageRates).toHaveLength(1);
    expect(await added()).toBe(before + 1);
    const gone = await payExtras.removeMileageRate(owner(), { from: NEW });
    expect(gone.mileageRates).toHaveLength(1);
    const removed = await payExtras.removeMileageRate(owner(), { from: OLD });
    expect(removed.mileageRates).toEqual([]);
    const [audit] = await raw`select before, after from public.audit_log where action = 'mileage_rate.removed' and entity_id = ${ORG}`;
    expect(audit).toBeDefined();
  });

  it("is payroll:configure's to change: the office that approves expenses may not, and a technician may not read it", async () => {
    await expect(payExtras.addMileageRate(office(), { from: OLD, perMile: "0.70" })).rejects.toBeInstanceOf(PermissionError);
    await expect(payExtras.removeMileageRate(office(), { from: OLD })).rejects.toBeInstanceOf(PermissionError);
    await expect(payExtras.get(ray())).rejects.toBeInstanceOf(PermissionError);
  });

  it("leaves the tip rule and the day away rate as they were", async () => {
    await payExtras.set(owner(), { perDiemRate: "75.00", tipSplit: "hours" });
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    const view = await payExtras.set(owner(), { perDiemRate: "80.00" });
    expect(view).toMatchObject({ perDiemRate: "80.00", tipSplit: "hours" });
    expect(view.mileageRates).toEqual([{ from: OLD, perMile: "0.700" }]);
  });

  it("is on the contract: a route to add one, one to take one off, and the claim takes miles or an amount", () => {
    expect(routes.addMileageRate.permissions).toEqual(["payroll:configure"]);
    expect(routes.removeMileageRate.permissions).toEqual(["payroll:configure"]);
    const base = { spentOn: today(), description: "Drive" };
    expect(routes.recordExpense.input.safeParse({ ...base, miles: "12.5" }).success).toBe(true);
    expect(routes.recordExpense.input.safeParse({ ...base, amount: "9" }).success).toBe(true);
    expect(routes.recordExpense.input.safeParse({ ...base, miles: "12.5", amount: "9" }).success).toBe(false);
    expect(routes.recordExpense.input.safeParse(base).success).toBe(false);
  });
});

/* ====================================================== a claim in miles */

run("a claim in miles", () => {
  it("is refused, saying so, when no rate has started for the day driven", async () => {
    await expect(expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive to the supply house" }))
      .rejects.toThrow(/no mileage rate for/);
    await payExtras.addMileageRate(owner(), { from: companyToday(1), perMile: "0.70" });
    await expect(expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive" }))
      .rejects.toThrow(/no mileage rate for/);
    expect((await expenses.mine(ray())).expenses).toEqual([]);
  });

  it("is worked out at the rate in force on the day driven, to the cent, and keeps the rate", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await payExtras.addMileageRate(owner(), { from: NEW, perMile: "0.725" });

    const before = await expenses.record(ray(), { miles: "100", spentOn: companyToday(-20), description: "Drive to Houston", jobId });
    expect(before).toMatchObject({ miles: "100.0", mileageRate: "0.700", amount: "70.0000", status: "pending", jobId });
    const after = await expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive to the supply house" });
    expect(after).toMatchObject({ miles: "12.5", mileageRate: "0.725", amount: "9.0600" });
    /** The day the new rate starts is paid at it, and the day before is not. */
    expect(await expenses.record(ray(), { miles: "10", spentOn: NEW, description: "On the day" }))
      .toMatchObject({ mileageRate: "0.725", amount: "7.2500" });
    expect(await expenses.record(ray(), { miles: "10", spentOn: companyToday(-11), description: "The day before" }))
      .toMatchObject({ mileageRate: "0.700", amount: "7.0000" });

    /** A rate added or taken off later reprices nothing. */
    await payExtras.removeMileageRate(owner(), { from: NEW });
    await payExtras.addMileageRate(owner(), { from: companyToday(-5), perMile: "0.90" });
    const mine = await expenses.mine(ray());
    expect(mine.expenses.find((e) => e.id === after.id)).toMatchObject({ amount: "9.0600", mileageRate: "0.725" });
    expect(mine.mileageRate).toBe("0.900");
    const [stored] = await raw`select miles::text, mileage_rate::text, amount::text from public.expense where id = ${after.id}`;
    expect(stored).toEqual({ miles: "12.5", mileage_rate: "0.725", amount: "9.0600" });
  });

  it("is one or the other: miles and an amount together are refused, and so is neither", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await expect(expenses.record(ray(), { miles: "12", amount: "9", spentOn: today(), description: "Drive" }))
      .rejects.toThrow(/not both/);
    await expect(expenses.record(ray(), { spentOn: today(), description: "Drive" })).rejects.toThrow(/dollars and cents/);
  });

  it("refuses miles that cannot be right, in words", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    const drive = (miles: string, spentOn = today()) => expenses.record(ray(), { miles, spentOn, description: "Drive" });
    await expect(drive("about 20")).rejects.toThrow(/to a tenth/);
    await expect(drive("18.45")).rejects.toThrow(/to a tenth/);
    await expect(drive("0")).rejects.toThrow(/more than nothing/);
    await expect(drive("2000.1")).rejects.toThrow(/2000\.0/);
    await expect(drive("12", "2999-01-01")).rejects.toThrow(/not happened/);
    await expect(drive("12", "last Tuesday")).rejects.toThrow(/Say the day you drove/);
    expect((await expenses.mine(ray())).expenses).toEqual([]);
  });

  it("is recorded once for the same id, like any expense", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    const id = uuid();
    const first = await expenses.record(ray(), { id, miles: "20", spentOn: today(), description: "Drive" });
    await payExtras.addMileageRate(owner(), { from: companyToday(-1), perMile: "0.95" });
    const again = await expenses.record(ray(), { id, miles: "20", spentOn: today(), description: "Drive" });
    expect(again).toMatchObject({ id: first.id, amount: "14.0000", mileageRate: "0.700" });
  });

  it("reaches the office with the miles, the rate and the amount, and is approved like any expense", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.725" });
    const made = await expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive to the supply house" });
    const listed = (await expenses.list(office(), { status: "pending" })).expenses[0]!;
    expect(listed).toMatchObject({ id: made.id, miles: "12.5", mileageRate: "0.725", amount: "9.0600" });
    const decided = await expenses.decide(office(), { id: made.id, decision: "approve" });
    expect(decided).toMatchObject({ status: "approved", amount: "9.0600", miles: "12.5" });
  });
});

/* ================================================== paid, and not booked */

run("an approved claim in miles", () => {
  it("is exported as a reimbursement, with the rate said on its line, and nothing is posted to the ledger", async () => {
    await payExtras.addMileageRate(owner(), { from: "2025-01-01", perMile: "0.725" });
    const made = await expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive to the supply house", jobId });
    const [{ n: journalBefore }] = await raw`select count(*)::int as n from public.journal_entry where organization_id = ${ORG}` as unknown as [{ n: number }];
    const [{ n: ledgerBefore }] = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}` as unknown as [{ n: number }];
    await expenses.decide(office(), { id: made.id, decision: "approve" });
    await raw`update public.expense set decided_at = '2026-01-07T15:00:00Z' where id = ${made.id}`;
    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: "2026-01-05", weeks: 2 });
    await payroll.closePeriod(owner(), { periodId: period.id });

    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianId === rayTech)!;
    expect(row.lines.filter((l) => l.kind === "reimbursement")).toEqual([
      expect.objectContaining({ label: expect.stringContaining("(12.5 miles at $0.725 a mile)"), amount: "9.0600" }),
    ]);
    expect(register.reimbursementTotal).toBe("9.0600");
    expect(register.grossTotal).toBe("0.0000");
    const file = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(file.content.split("\n").find((l) => l.includes(",reimbursement,"))!.endsWith(",reimbursement,,,9.0600")).toBe(true);

    const [{ n: journalAfter }] = await raw`select count(*)::int as n from public.journal_entry where organization_id = ${ORG}` as unknown as [{ n: number }];
    const [{ n: ledgerAfter }] = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}` as unknown as [{ n: number }];
    expect([journalAfter, ledgerAfter]).toEqual([journalBefore, ledgerBefore]);
  });

  it("counts in the cost of the job it was for", async () => {
    await payExtras.addMileageRate(owner(), { from: "2025-01-01", perMile: "0.700" });
    const made = await expenses.record(ray(), { miles: "100", spentOn: today(), description: "Drive", jobId });
    await expenses.decide(office(), { id: made.id, decision: "approve" });
    const onJob = await expenses.forJob(owner(), { jobId });
    expect(onJob.total).toBe("70.0000");
  });
});

/* ======================================================== from the phone */

run("a claim in miles from the phone", () => {
  async function send(ops: Array<{ kind: string; subjectId?: string; payload?: Record<string, unknown> }>) {
    const device = await fieldOps.register(ray(), { installationId: `phone-${uuid()}` });
    const result = await fieldOps.sync(ray(), {
      deviceId: device.deviceId,
      operations: ops.map((op, i) => ({
        clientId: uuid(), sequence: i + 1, kind: op.kind as never,
        ...(op.subjectId ? { subjectId: op.subjectId } : {}),
        occurredAt: new Date(Date.now() - (ops.length - i) * 1000).toISOString(),
        payload: op.payload ?? {},
      })),
    });
    return result.results;
  }

  it("is sent as miles and worked out by the server, never as an amount the phone made up", async () => {
    await payExtras.addMileageRate(owner(), { from: "2025-01-01", perMile: "0.725" });
    const id = uuid();
    const results = await send([{ kind: "expense.record", subjectId: id, payload: { miles: "12.5", spentOn: today(), description: "Drive", jobId } }]);
    expect(results.map((r) => r.status)).toEqual(["applied"]);
    const [row] = await raw`select technician_id, status, amount::text, miles::text, mileage_rate::text from public.expense where id = ${id}`;
    expect(row).toMatchObject({ technician_id: rayTech, status: "pending", amount: "9.0600", miles: "12.5", mileage_rate: "0.725" });
  });

  it("is refused in words when the phone sends both, or when there is no rate", async () => {
    const both = await send([{ kind: "expense.record", subjectId: uuid(), payload: { miles: "12", amount: "9", spentOn: today(), description: "Drive" } }]);
    expect(both[0]).toMatchObject({ status: "rejected" });
    expect(JSON.stringify(both[0])).toMatch(/not both|no mileage rate/);
    const none = await send([{ kind: "expense.record", subjectId: uuid(), payload: { miles: "12", spentOn: today(), description: "Drive" } }]);
    expect(none[0]).toMatchObject({ status: "rejected" });
    expect(JSON.stringify(none[0])).toMatch(/no mileage rate for/);
  });

  it("comes back on the day with the miles and the rate, and the phone is told today's rate", async () => {
    await payExtras.addMileageRate(owner(), { from: "2025-01-01", perMile: "0.725" });
    const id = uuid();
    await send([{ kind: "expense.record", subjectId: id, payload: { miles: "12.5", spentOn: today(), description: "Drive" } }]);
    const own = await inTenant(ray(), (tx) => fieldSales.expensesFor(tx, rayTech));
    expect(own.find((e) => e.id === id)).toMatchObject({ amount: "9.0600", miles: "12.5", mileageRate: "0.725" });
    expect((await inTenant(ray(), (tx) => fieldSales.abilitiesFor(tx, ray()))).mileageRate).toBe("0.725");
    await payExtras.removeMileageRate(owner(), { from: "2025-01-01" });
    expect((await inTenant(ray(), (tx) => fieldSales.abilitiesFor(tx, ray()))).mileageRate).toBeNull();
  });
});
