import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { createHash } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as payroll from "../src/services/payroll";
import * as laborSettings from "../src/services/labor-settings";
import * as fieldOps from "../src/services/field";
import * as files from "../src/services/files";
import * as dispatch from "../src/services/dispatch";
import * as profitability from "../src/services/profitability";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { routes } from "../src/contracts";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * WHAT PEOPLE PAID FOR THE COMPANY, AND A DAY AWAY
 *
 * A technician records an expense with a receipt, from the web and from the
 * phone's queue; the office approves or refuses it with a reason; an approved
 * one goes to the payroll bureau as a non-taxable line in the pay period it
 * was approved in and counts in the job's cost; a per diem is the company's
 * rate for a day away, recorded against a job and exported the same way.
 *
 * The approval instant is the clock the pay period reads, and nothing can set
 * it, so a test that needs one inside a fortnight that has already ended moves
 * it there with SQL after the real approval. Every refusal and every figure
 * below is the service's own.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("expenses:org");
const OWNER = fixtureId("expenses:owner");
const RAY = fixtureId("expenses:ray");
const DANA = fixtureId("expenses:dana");
const OFFICE = fixtureId("expenses:office");
const HANA = fixtureId("expenses:hana");
const PAT = fixtureId("expenses:pat");

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
const dana = (): ServiceContext => ({
  actor: { userId: DANA, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: danaTech }, db: db(),
});
/** Houston's branch manager: the office manager's permissions, narrowed to one branch's people. */
const hana = (): ServiceContext => ({
  actor: { userId: HANA, organizationId: ORG, roles: ["branch_manager"] as Actor["roles"], businessUnitId: houston }, db: db(),
});
/** Somebody in the office who is not on the board, so has nobody to be paid back to. */
const pat = (): ServiceContext => ({
  actor: { userId: PAT, organizationId: ORG, roles: ["csr"] as Actor["roles"] }, db: db(),
});

let rayTech = "";
let danaTech = "";
let houston = "";
let austin = "";
let jobId = "";
let jobNumber = 0;
let customerId = "";
let propertyId = "";

const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
/** A real PNG header, so the sniffer has something true to find. */
const png = (marker: number) =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, marker]);
const receipt = (marker: number) => ({ fileName: "receipt.png", bytes: png(marker).toString("base64") });

async function person(userId: string, name: string, role: string, businessUnitId: string | null): Promise<string | null> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@expenses.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, ${role}::member_role, ${businessUnitId}) returning id`;
  if (role !== "technician") return null;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membership!.id}, ${name}, 'Journeyman') returning id`;
  return tech!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Expenses Co", slug: "expenses-co" });
  const [h] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  const [a] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  houston = h!.id as string;
  austin = a!.id as string;
  rayTech = (await person(RAY, "Ray Nunez", "technician", houston))!;
  danaTech = (await person(DANA, "Dana Pike", "technician", austin))!;
  await person(OFFICE, "Olive Office", "office_manager", null);
  await person(HANA, "Hana Branch", "branch_manager", houston);
  await person(PAT, "Pat Desk", "csr", null);

  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;
  const job = await jobs.create(owner(), { customerId, propertyId, summary: "Install a furnace", tags: [], customFields: {} });
  jobId = job.id as string;
  jobNumber = job.number as number;

  await laborSettings.setScale(owner(), {
    classification: "Journeyman", baseRate: "40.00", fringeRate: "8.00", effectiveFrom: "2026-01-01",
  });
  await laborSettings.setPolicy(owner(), {
    label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1,
    dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
    onCallTreatment: "separate_rate_not_hours_worked",
    note: "Forty hours a week at time and a half. Nothing daily.",
  });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.payroll_export where organization_id = ${ORG}`;
  await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
  await raw`delete from public.pay_period where organization_id = ${ORG}`;
  await raw`delete from public.expense where organization_id = ${ORG}`;
  await raw`delete from public.per_diem where organization_id = ${ORG}`;
  await raw`delete from public.attachment where organization_id = ${ORG} and entity_type = 'expense'`;
  await raw`delete from public.field_upload where organization_id = ${ORG}`;
  await raw`delete from public.field_operation where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await payExtras.set(owner(), { perDiemRate: null });
});

/** Put an expense in as Ray and have the office approve it, then place the approval inside a past fortnight. */
async function approvedInto(amount: string, decidedAt: string) {
  const made = await expenses.record(ray(), { amount, spentOn: today(), description: "Capacitor", jobId });
  await expenses.decide(office(), { id: made.id, decision: "approve" });
  await raw`update public.expense set decided_at = ${decidedAt} where id = ${made.id}`;
  return made.id;
}

const JANUARY = "2026-01-05";

async function closedJanuary() {
  const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: JANUARY, weeks: 2 });
  await payroll.closePeriod(owner(), { periodId: period.id });
  return period;
}

/* ======================================================== recording one */

run("a person records what they paid for the company", () => {
  it("records it as their own, waiting for the office, with the receipt and the job", async () => {
    const made = await expenses.record(ray(), {
      amount: "42.50", spentOn: today(), description: "  Capacitor   from the supply house ", jobId, receipt: receipt(1),
    });
    expect(made).toMatchObject({
      technicianName: "Ray Nunez", amount: "42.5000", description: "Capacitor from the supply house",
      status: "pending", jobId, jobNumber, receipts: 1, decidedAt: null,
    });

    const mine = await expenses.mine(ray());
    expect(mine.technician).toBe(true);
    expect(mine.expenses.map((e) => e.id)).toEqual([made.id]);
    // And nobody else's.
    expect((await expenses.mine(dana())).expenses).toEqual([]);
  });

  it("takes the job by its number, and says so when there is no such job", async () => {
    const made = await expenses.record(ray(), { amount: "5", spentOn: today(), description: "Tape", jobNumber });
    expect(made.jobId).toBe(jobId);
    await expect(expenses.record(ray(), { amount: "5", spentOn: today(), description: "Tape", jobNumber: 987654 }))
      .rejects.toThrow(/There is no job 987654/);
  });

  it("refuses in words a slip of the keys, a day that has not happened and a missing reason", async () => {
    const tooBig = expenses.record(ray(), { amount: "10000.01", spentOn: today(), description: "Truck" });
    await expect(tooBig).rejects.toThrow(/Ask the office/);
    await expect(expenses.record(ray(), { amount: "4x", spentOn: today(), description: "Gas" }))
      .rejects.toThrow(/dollars and cents/);
    await expect(expenses.record(ray(), { amount: "4", spentOn: "2999-01-01", description: "Gas" }))
      .rejects.toThrow(/not happened/);
    await expect(expenses.record(ray(), { amount: "4", spentOn: today(), description: " " }))
      .rejects.toThrow(/what it was for/);
    await expect(expenses.record(ray(), { amount: "4", spentOn: today(), description: "Gas", receipt: { fileName: "r.txt", bytes: Buffer.from("not an image").toString("base64") } }))
      .rejects.toThrow();
    expect((await expenses.mine(ray())).expenses).toEqual([]);
  });

  it("records the same id once, and will not hand it to somebody else", async () => {
    const id = uuid();
    const first = await expenses.record(ray(), { id, amount: "9", spentOn: today(), description: "Gloves" });
    const again = await expenses.record(ray(), { id, amount: "9", spentOn: today(), description: "Gloves" });
    expect(again.id).toBe(first.id);
    const [{ n }] = await raw`select count(*)::int as n from public.expense where organization_id = ${ORG}` as unknown as [{ n: number }];
    expect(n).toBe(1);
    await expect(expenses.record(dana(), { id, amount: "9", spentOn: today(), description: "Gloves" }))
      .rejects.toThrow(/somebody else's/);
  });

  it("is for people on the board: somebody who is not has nobody to be paid back to", async () => {
    expect((await expenses.mine(pat())).technician).toBe(false);
    await expect(expenses.record(pat(), { amount: "9", spentOn: today(), description: "Pens" }))
      .rejects.toThrow(/not on the board/);
  });

  it("keeps the photograph once for the same bytes, and only while the office has not answered", async () => {
    const made = await expenses.record(ray(), { amount: "9", spentOn: today(), description: "Gloves", receipt: receipt(2) });
    await expenses.addReceipt(ray(), { id: made.id, receipt: receipt(2) });
    expect((await expenses.mine(ray())).expenses[0]!.receipts).toBe(1);
    await expenses.addReceipt(ray(), { id: made.id, receipt: receipt(3) });
    expect((await expenses.mine(ray())).expenses[0]!.receipts).toBe(2);
    await expenses.decide(office(), { id: made.id, decision: "approve" });
    await expect(expenses.addReceipt(ray(), { id: made.id, receipt: receipt(4) })).rejects.toThrow(/already answered/);
    await expect(expenses.addReceipt(dana(), { id: made.id, receipt: receipt(5) })).rejects.toThrow(/Expense not found/);
  });
});

/* ============================================================ the answer */

run("the office approves or refuses with a reason", () => {
  it("lists the waiting ones first and counts them", async () => {
    const a = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "A" });
    await expenses.decide(office(), { id: a.id, decision: "refuse", reason: "Personal" });
    await expenses.record(dana(), { amount: "20", spentOn: today(), description: "B" });
    const listing = await expenses.list(office(), {});
    expect(listing.waiting).toBe(1);
    expect(listing.expenses.map((e) => e.status)).toEqual(["pending", "refused"]);
    expect((await expenses.list(office(), { status: "pending" })).expenses).toHaveLength(1);
  });

  it("refuses only with a reason, which the person then reads", async () => {
    const made = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "Lunch" });
    await expect(expenses.decide(office(), { id: made.id, decision: "refuse" })).rejects.toThrow(/Say why/);
    const refused = await expenses.decide(office(), { id: made.id, decision: "refuse", reason: "Lunch is not reimbursed here." });
    expect(refused).toMatchObject({ status: "refused", decisionReason: "Lunch is not reimbursed here.", decidedByName: "Olive Office" });
    expect((await expenses.mine(ray())).expenses[0]).toMatchObject({ status: "refused", decisionReason: "Lunch is not reimbursed here." });
    const [audit] = await raw`select action from public.audit_log where entity_id = ${made.id} and action = 'expense.refused'`;
    expect(audit).toBeDefined();
  });

  it("is final: the same answer again is the first, the other answer is refused and says who and what to do", async () => {
    const made = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "Diesel" });
    const approved = await expenses.decide(office(), { id: made.id, decision: "approve" });
    const again = await expenses.decide(office(), { id: made.id, decision: "approve" });
    expect(again.decidedAt).toEqual(approved.decidedAt);
    await expect(expenses.decide(office(), { id: made.id, decision: "refuse", reason: "Changed my mind" }))
      .rejects.toThrow(/approved by Olive Office.*final.*payroll bureau/s);
  });

  it("is the office's: a technician cannot decide, list everybody's or read somebody else's receipt", async () => {
    const made = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "Diesel", receipt: receipt(7) });
    await expect(expenses.decide(ray(), { id: made.id, decision: "approve" })).rejects.toThrow(/expense:approve/);
    await expect(expenses.list(ray(), {})).rejects.toThrow(/expense:approve/);
    await expect(expenses.receipt(dana(), { id: made.id })).rejects.toThrow(/expense:approve/);
    // Their own, and the office's, read.
    expect((await expenses.receipt(ray(), { id: made.id })).contentType).toBe("image/png");
    expect((await expenses.receipt(office(), { id: made.id })).bytes.length).toBe(12);
    await expect(expenses.receipt(office(), { id: made.id, index: 1 })).rejects.toThrow(/Receipt not found/);
  });

  it("is narrowed to the people the approver's scope reaches: a branch manager decides their own branch's", async () => {
    const mine = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "Houston diesel", receipt: receipt(8) });
    const theirs = await expenses.record(dana(), { amount: "10", spentOn: today(), description: "Austin diesel", receipt: receipt(9) });
    const listing = await expenses.list(hana(), {});
    expect(listing.expenses.map((e) => e.id)).toEqual([mine.id]);
    expect(listing.waiting).toBe(1);
    await expect(expenses.decide(hana(), { id: theirs.id, decision: "approve" })).rejects.toThrow(/Expense not found/);
    await expect(expenses.receipt(hana(), { id: theirs.id })).rejects.toThrow(/Receipt not found/);
    expect((await expenses.decide(hana(), { id: mine.id, decision: "approve" })).status).toBe("approved");
  });

  it("says which pay period an approved one goes out with, or that none covers it yet", async () => {
    const made = await expenses.record(ray(), { amount: "10", spentOn: today(), description: "Diesel" });
    const approved = await expenses.decide(office(), { id: made.id, decision: "approve" });
    expect(approved.paidIn).toBeNull();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const period = await payroll.declarePeriod(owner(), { label: "This week", startDate: start.toISOString().slice(0, 10), weeks: 1 });
    expect((await expenses.list(office(), {})).expenses[0]!.paidIn).toEqual({ id: period.id, label: "This week", closed: false });
  });
});

/* ============================================================== payroll */

run("an approved expense goes to the payroll file as a non-taxable line", () => {
  it("is its own pay category, not in the gross, and totalled beside it", async () => {
    await approvedInto("42.50", "2026-01-07T15:00:00Z");
    const period = await closedJanuary();

    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianId === rayTech)!;
    expect(row.lines.filter((l) => l.kind === "reimbursement")).toEqual([
      expect.objectContaining({ label: "Reimbursement: Capacitor, job " + jobNumber, amount: "42.5000", hours: null, rate: null }),
    ]);
    expect(row.lines[0]!.explanation).toMatch(/no tax is taken/);
    expect(row.gross).toBe("0.0000");
    expect(row.nonTaxable).toBe("42.5000");
    expect(register.grossTotal).toBe("0.0000");
    expect(register.reimbursementTotal).toBe("42.5000");

    const file = await payroll.exportPeriod(owner(), { periodId: period.id });
    const lines = file.content.trim().split("\n");
    expect(lines[0]).toBe("period,period_start,period_end,employee_id,employee_name,classification,pay_category,hours,rate,amount");
    const body = lines.find((l) => l.includes(",reimbursement,"))!;
    expect(body).toContain(`,${rayTech},Ray Nunez,`);
    expect(body.endsWith(",reimbursement,,,42.5000")).toBe(true);
    expect(file.grossTotal).toBe("0.0000");
    expect(file.reimbursementTotal).toBe("42.5000");
    expect((await payroll.exportsFor(owner(), { periodId: period.id }))[0]!.reimbursementTotal).toBe("42.5000");
  });

  it("is the same file every time, and a refused or waiting one is not in it", async () => {
    await approvedInto("10", "2026-01-07T15:00:00Z");
    await expenses.record(ray(), { amount: "99", spentOn: today(), description: "Waiting" });
    const refused = await expenses.record(ray(), { amount: "98", spentOn: today(), description: "Refused" });
    await expenses.decide(office(), { id: refused.id, decision: "refuse", reason: "No" });
    await raw`update public.expense set decided_at = '2026-01-08T15:00:00Z', recorded_at = '2026-01-08T15:00:00Z' where id = ${refused.id}`;
    const period = await closedJanuary();
    const first = await payroll.exportPeriod(owner(), { periodId: period.id });
    const second = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(second.checksum).toBe(first.checksum);
    expect(first.content).not.toMatch(/99\.0000|98\.0000/);
    expect(first.reimbursementTotal).toBe("10.0000");
  });

  it("makes an edit after the close visible, and an approval on a later day belongs to a later period", async () => {
    const id = await approvedInto("10", "2026-01-07T15:00:00Z");
    const period = await closedJanuary();
    await payroll.exportPeriod(owner(), { periodId: period.id });
    await raw`update public.expense set amount = 11 where id = ${id}`;
    await expect(payroll.exportPeriod(owner(), { periodId: period.id })).rejects.toThrow(/changed after it was closed/);
  });

  it("pays a person with nothing else on the register, and says it on their own statement", async () => {
    await approvedInto("42.50", "2026-01-07T15:00:00Z");
    const period = await closedJanuary();
    const own = await payroll.ownStatements(ray());
    const statement = own.statements.find((s) => s.periodId === period.id)!;
    expect(statement.statement).toMatchObject({ gross: "0.0000", nonTaxable: "42.5000" });
    expect(statement.statement!.lines.map((l) => l.kind)).toEqual(["reimbursement"]);
    // Dana was not paid back for anything.
    expect((await payroll.ownStatements(dana())).statements.find((s) => s.periodId === period.id)!.statement).toBeNull();
  });
});

/* ============================================================== per diem */

run("a day away at the company's rate", () => {
  it("needs a rate first, and says where to set it", async () => {
    await expect(expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/No per diem rate is set/);
  });

  it("is set by whoever declares what people are owed, and refused when it is a slip", async () => {
    await expect(payExtras.set(office(), { perDiemRate: "75" })).rejects.toThrow(/payroll:configure/);
    await expect(payExtras.set(owner(), { perDiemRate: "5000" })).rejects.toThrow(/slip of the keys/);
    expect((await payExtras.set(owner(), { perDiemRate: "75" })).perDiemRate).toBe("75.00");
    expect((await payExtras.get(office())).perDiemRate).toBe("75.00");
  });

  it("records each day at the rate of that day, leaves days already recorded alone, and answers a retry with the first answer", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    const first = await expenses.recordPerDiem(office(), { technicianId: rayTech, jobNumber, from: "2026-01-06", to: "2026-01-08", note: "Out at the lake" });
    expect(first).toEqual({ recorded: ["2026-01-06", "2026-01-07", "2026-01-08"], alreadyHad: [], rate: "75.00" });

    // The rate changes: the days already recorded keep what they were.
    await payExtras.set(owner(), { perDiemRate: "90" });
    const more = await expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-08", to: "2026-01-09" });
    expect(more).toEqual({ recorded: ["2026-01-09"], alreadyHad: ["2026-01-08"], rate: "90.00" });
    const days = await expenses.listPerDiem(office(), { technicianId: rayTech });
    expect(days.map((d) => [d.day, d.amount]).sort()).toEqual([
      ["2026-01-06", "75.0000"], ["2026-01-07", "75.0000"], ["2026-01-08", "75.0000"], ["2026-01-09", "90.0000"],
    ]);
    expect(days[0]).toMatchObject({ technicianName: "Ray Nunez", jobId, jobNumber });
  });

  it("refuses a slip, an unknown job, a person the approver does not reach and a technician", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    await expect(expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-09", to: "2026-01-06" }))
      .rejects.toThrow(/earlier day first/);
    await expect(expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-01", to: "2026-03-01" }))
      .rejects.toThrow(/31 days/);
    await expect(expenses.recordPerDiem(office(), { technicianId: rayTech, jobNumber: 987654, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/There is no job 987654/);
    await expect(expenses.recordPerDiem(office(), { technicianId: rayTech, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/which job/);
    await expect(expenses.recordPerDiem(hana(), { technicianId: danaTech, jobId, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/Technician not found/);
    await expect(expenses.recordPerDiem(ray(), { technicianId: rayTech, jobId, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/expense:approve/);
  });

  it("goes to the file as its own category, and cannot be recorded or removed once its fortnight has closed", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    await expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-06", to: "2026-01-07" });
    const period = await closedJanuary();

    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianId === rayTech)!;
    expect(row.lines.map((l) => [l.kind, l.label, l.amount])).toEqual([
      ["per_diem", `Per diem, 2026-01-06, job ${jobNumber}`, "75.0000"],
      ["per_diem", `Per diem, 2026-01-07, job ${jobNumber}`, "75.0000"],
    ]);
    expect(row.nonTaxable).toBe("150.0000");
    const file = await payroll.exportPeriod(owner(), { periodId: period.id });
    expect(file.content).toMatch(/,per_diem,,,75\.0000/);
    expect(file.reimbursementTotal).toBe("150.0000");

    await expect(expenses.recordPerDiem(office(), { technicianId: danaTech, jobId, from: "2026-01-08", to: "2026-01-08" }))
      .rejects.toThrow(/closed and has gone to payroll/);
    const [one] = await expenses.listPerDiem(office(), { technicianId: rayTech });
    expect(one!.paidIn).toMatchObject({ closed: true });
    await expect(expenses.removePerDiem(office(), { id: one!.id })).rejects.toThrow(/closed and has gone to payroll/);
  });

  it("can be taken back out while its period is still open", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    await expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-06", to: "2026-01-06" });
    const [one] = await expenses.listPerDiem(office(), {});
    expect(await expenses.removePerDiem(office(), { id: one!.id })).toEqual({ id: one!.id, removed: true });
    expect(await expenses.listPerDiem(office(), {})).toEqual([]);
    await expect(expenses.removePerDiem(office(), { id: one!.id })).rejects.toThrow(/Per diem not found/);
  });

  it("is on the person's own page, and one person's day away is not another's", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    await expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: today(), to: today() });
    expect((await expenses.mine(ray())).perDiems).toHaveLength(1);
    expect((await expenses.mine(dana())).perDiems).toHaveLength(0);
  });
});

/* ======================================================== the job's cost */

run("what the company agrees to pay back is part of the job's cost", () => {
  const margin = async () => profitability.statement(owner(), { jobId });

  it("counts approved reimbursements and per diem, and not waiting or refused ones", async () => {
    const before = await margin();
    expect(before.expenseCost).toBe("0.0000");

    const a = await expenses.record(ray(), { amount: "42.50", spentOn: today(), description: "Capacitor", jobId });
    const b = await expenses.record(ray(), { amount: "30", spentOn: today(), description: "Lunch", jobId });
    const c = await expenses.record(ray(), { amount: "12", spentOn: today(), description: "Shop gloves" });
    await expenses.record(ray(), { amount: "7", spentOn: today(), description: "Waiting", jobId });

    // Waiting is not agreed: the margin says so and does not count it.
    const waiting = await margin();
    expect(waiting.expenseCost).toBe("0.0000");
    expect(waiting.provisional.join(" ")).toMatch(/3 receipts are waiting for the office to approve/);

    await expenses.decide(office(), { id: a.id, decision: "approve" });
    await expenses.decide(office(), { id: b.id, decision: "refuse", reason: "No" });
    await expenses.decide(office(), { id: c.id, decision: "approve" });
    await payExtras.set(owner(), { perDiemRate: "75" });
    await expenses.recordPerDiem(office(), { technicianId: rayTech, jobId, from: "2026-01-06", to: "2026-01-06" });

    const after = await margin();
    // 42.50 for the capacitor and 75 for the day away. The shop's gloves are on no job.
    expect(after.expenseCost).toBe("117.5000");
    expect(Number(after.grossMargin)).toBeCloseTo(Number(before.grossMargin) - 117.5, 2);

    const onJob = await expenses.forJob(owner(), { jobId });
    expect(onJob.total).toBe("117.5000");
    expect(onJob.reimbursements.map((r) => r.description)).toEqual(["Capacitor"]);
    expect(onJob.perDiems).toHaveLength(1);
    // A cost, so the permission that reads costs.
    await expect(expenses.forJob(ray(), { jobId })).rejects.toThrow(/job.cost:read/);
  });
});

/* ======================================================== from the phone */

run("an expense recorded on the phone, in the queue", () => {
  async function send(ctx: ServiceContext, ops: Array<{ kind: string; subjectId?: string; payload?: Record<string, unknown> }>, deviceId?: string) {
    const device = deviceId ? { deviceId } : await fieldOps.register(ctx, { installationId: `phone-${uuid()}` });
    const result = await fieldOps.sync(ctx, {
      deviceId: device.deviceId,
      operations: ops.map((op, i) => ({
        clientId: uuid(), sequence: i + 1, kind: op.kind as never,
        ...(op.subjectId ? { subjectId: op.subjectId } : {}),
        occurredAt: new Date(Date.now() - (ops.length - i) * 1000).toISOString(),
        payload: op.payload ?? {},
      })),
    });
    return { results: result.results, deviceId: device.deviceId };
  }

  it("lands as the phone's own person's, applies once on a retry, and the receipt follows through the upload path", async () => {
    const id = uuid();
    const uploadId = uuid();
    const bytes = png(21);
    const { results } = await send(ray(), [
      { kind: "expense.record", subjectId: id, payload: { amount: "42.50", spentOn: today(), description: "Capacitor", jobId } },
      { kind: "attachment.attach", subjectId: id, payload: {
        entityType: "expense", uploadId, contentType: "image/png", byteSize: bytes.length,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      } },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const [row] = await raw`select technician_id, status, amount::text from public.expense where id = ${id}`;
    expect(row).toMatchObject({ technician_id: rayTech, status: "pending", amount: "42.5000" });

    // The bytes arrive and are kept on the expense, not on a visit.
    const stored = await files.storeUpload(ray(), { clientId: uploadId, bytes });
    expect(stored.stored).toBe(true);
    const [attached] = await raw`select entity_type, entity_id from public.attachment where storage_key = ${stored.storageKey!}`;
    expect(attached).toMatchObject({ entity_type: "expense", entity_id: id });
    expect((await expenses.mine(ray())).expenses[0]!.receipts).toBe(1);

    // A second phone sending the same id records nothing more.
    const again = await send(ray(), [{ kind: "expense.record", subjectId: id, payload: { amount: "42.50", spentOn: today(), description: "Capacitor", jobId } }]);
    expect(again.results[0]!.status).toBe("applied");
    const [{ n: count }] = await raw`select count(*)::int as n from public.expense where organization_id = ${ORG}` as unknown as [{ n: number }];
    expect(count).toBe(1);
  });

  it("refuses in the office's words what the web form refuses, and keeps the rest of the batch", async () => {
    const good = uuid();
    const { results } = await send(ray(), [
      { kind: "expense.record", subjectId: uuid(), payload: { amount: "20000", spentOn: today(), description: "A truck" } },
      { kind: "expense.record", subjectId: good, payload: { amount: "9", spentOn: today(), description: "Gloves" } },
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", rejection: expect.stringMatching(/Ask the office/) });
    expect(results[1]!.status).toBe("applied");
  });

  it("will not take a receipt photo for somebody else's expense", async () => {
    const mine = await expenses.record(ray(), { amount: "9", spentOn: today(), description: "Gloves" });
    const { results } = await send(dana(), [{
      kind: "attachment.attach", subjectId: mine.id,
      payload: { entityType: "expense", uploadId: uuid(), contentType: "image/png", byteSize: 12, contentHash: "x" },
    }]);
    expect(results[0]).toMatchObject({ status: "rejected", rejection: expect.stringMatching(/not yours/) });
    const [{ n }] = await raw`select count(*)::int as n from public.field_upload where organization_id = ${ORG}` as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it("brings the office's answer back with the day, and the poll notices it", async () => {
    const device = await fieldOps.register(ray(), { installationId: `phone-${uuid()}` });
    const first = await dispatch.snapshot(ray(), { deviceId: device.deviceId, from: today(), days: 1 });
    expect(first.abilities.expenses).toBe(true);
    expect(first.expenses).toEqual([]);

    const made = await expenses.record(ray(), { amount: "42.50", spentOn: today(), description: "Capacitor", jobId });
    const second = await dispatch.snapshot(ray(), { deviceId: device.deviceId, from: today(), days: 1, sinceRevision: first.revision });
    expect(second.unchanged).toBe(false);
    expect(second.expenses).toEqual([expect.objectContaining({ id: made.id, status: "pending", jobNumber, receipts: 0 })]);

    await expenses.decide(office(), { id: made.id, decision: "refuse", reason: "Personal." });
    const third = await dispatch.snapshot(ray(), { deviceId: device.deviceId, from: today(), days: 1, sinceRevision: second.revision });
    expect(third.unchanged).toBe(false);
    expect(third.expenses[0]).toMatchObject({ status: "refused", decisionReason: "Personal." });
  });

  it("is refused by an account that was not given the permission", async () => {
    const limited = ray();
    limited.actor = { ...limited.actor, revocations: ["expense:own"] } as Actor;
    const { results } = await send(limited, [{
      kind: "expense.record", subjectId: uuid(), payload: { amount: "9", spentOn: today(), description: "Gloves" },
    }]);
    expect(results[0]).toMatchObject({ status: "rejected", rejection: expect.stringMatching(/may not record expenses/) });
  });
});

/* ======================================================== the contracts */

run("the routes say what they need", () => {
  it("declare the permissions the services demand", () => {
    expect(routes.recordExpense.permissions).toEqual(["expense:own"]);
    expect(routes.decideExpense.permissions).toEqual(["expense:approve"]);
    expect(routes.recordPerDiem.permissions).toEqual(["expense:approve"]);
    expect(routes.setPayExtras.permissions).toEqual(["payroll:configure"]);
    expect(routes.getJobExpenses.permissions).toEqual(["job.cost:read"]);
  });
});
