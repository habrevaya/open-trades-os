import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as cashTips from "../src/services/cash-tips";
import * as payExtras from "../src/services/pay-extras";
import * as payroll from "../src/services/payroll";
import * as laborSettings from "../src/services/labor-settings";
import * as fieldOps from "../src/services/field";
import * as portalSettings from "../src/services/portal-settings";
import * as customers from "../src/services/customers";
import { routes } from "../src/contracts";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * TIPS: THE OFFICE'S HAND IN A CASH TIP, AND HOW A TIP IS SHARED
 *
 * A customer hands a technician a twenty. The technician records it on the
 * phone; when they did not, or got it wrong, the office records or corrects it
 * with a reason, audited, and the technician sees every change. A tip a
 * customer leaves with a payment is shared between the people on the job by the
 * company's rule: evenly, by the hours each was clocked in on the job, or all to
 * the lead, from the next tip on.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cash-tips:org");
const OWNER = fixtureId("cash-tips:owner");
const RAY = fixtureId("cash-tips:ray");
const DANA = fixtureId("cash-tips:dana");
const OFFICE = fixtureId("cash-tips:office");
const HANA = fixtureId("cash-tips:hana");

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
const hana = (): ServiceContext => ({
  actor: { userId: HANA, organizationId: ORG, roles: ["branch_manager"] as Actor["roles"], businessUnitId: houston }, db: db(),
});

let rayTech = "";
let danaTech = "";
let houston = "";
let austin = "";
let customerId = "";
let propertyId = "";

const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

async function person(userId: string, name: string, role: string, businessUnitId: string | null): Promise<string | null> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@cash-tips.test`;
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
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Cash Tips Co", slug: "cash-tips-co" });
  const [h] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  const [a] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  houston = h!.id as string;
  austin = a!.id as string;
  rayTech = (await person(RAY, "Ray Nunez", "technician", houston))!;
  danaTech = (await person(DANA, "Dana Pike", "technician", austin))!;
  await person(OFFICE, "Olive Office", "office_manager", null);
  await person(HANA, "Hana Branch", "branch_manager", houston);

  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;

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
  await portalSettings.set(owner(), { tipping: { enabled: true, presets: [15, 20, 25] } });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.payroll_export where organization_id = ${ORG}`;
  await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
  await raw`delete from public.pay_period where organization_id = ${ORG}`;
  await raw`delete from public.cash_tip_correction where organization_id = ${ORG}`;
  await raw`delete from public.cash_tip where organization_id = ${ORG}`;
  await payExtras.set(owner(), { tipSplit: "even" });
});

/* ===================================================== the office's hand */

run("the office records a cash tip for a technician", () => {
  it("puts it on their pay with the reason, and they see who recorded it", async () => {
    const made = await cashTips.recordFor(office(), {
      technicianId: rayTech, amount: "20", receivedOn: today(),
      reason: "Mrs Delacroix rang to say she gave Ray twenty dollars on Tuesday.",
    });
    expect(made).toMatchObject({
      technicianName: "Ray Nunez", amount: "20.0000", recordedBy: "office", recordedByName: "Olive Office",
      note: "Mrs Delacroix rang to say she gave Ray twenty dollars on Tuesday.", corrections: [],
    });
    const mine = await cashTips.mine(ray());
    expect(mine.technician).toBe(true);
    expect(mine.tips.map((t) => [t.id, t.recordedBy])).toEqual([[made.id, "office"]]);
    expect((await cashTips.mine(dana())).tips).toEqual([]);
    const [audit] = await raw`select action from public.audit_log where entity_id = ${made.id} and action = 'tip.cash_recorded_by_office'`;
    expect(audit).toBeDefined();
  });

  it("needs a reason, an amount in dollars and cents, and a day that has happened", async () => {
    const base = { technicianId: rayTech, amount: "20", reason: "Said so" };
    await expect(cashTips.recordFor(office(), { ...base, reason: " " })).rejects.toThrow(/Say why you are recording/);
    await expect(cashTips.recordFor(office(), { ...base, amount: "twenty" })).rejects.toThrow(/dollars and cents/);
    await expect(cashTips.recordFor(office(), { ...base, amount: "0" })).rejects.toThrow(/more than nothing/);
    await expect(cashTips.recordFor(office(), { ...base, amount: "10000.01" })).rejects.toThrow(/Record it as a payment/);
    await expect(cashTips.recordFor(office(), { ...base, receivedOn: "2999-01-01" })).rejects.toThrow(/not happened/);
    await expect(cashTips.recordFor(office(), { ...base, receivedOn: "2020-01-01" })).rejects.toThrow(/more than a year/);
    await expect(cashTips.recordFor(office(), { ...base, jobNumber: 987654 })).rejects.toThrow(/There is no job 987654/);
  });

  it("refuses what looks like the same tip twice, and says how to record a second one", async () => {
    await cashTips.recordFor(office(), { technicianId: rayTech, amount: "20", receivedOn: today(), reason: "First" });
    await expect(cashTips.recordFor(office(), { technicianId: rayTech, amount: "20.00", receivedOn: today(), reason: "Again" }))
      .rejects.toThrow(/already have a tip of that amount on that day/);
    expect((await cashTips.recordFor(office(), { technicianId: rayTech, amount: "25", receivedOn: today(), reason: "A second one" })).amount)
      .toBe("25.0000");
  });

  it("is the office's: a technician cannot record one for themselves or anybody, and a branch manager only their own branch's", async () => {
    await expect(cashTips.recordFor(ray(), { technicianId: rayTech, amount: "20", reason: "Mine" })).rejects.toThrow(/tip:record/);
    await expect(cashTips.list(ray())).rejects.toThrow(/tip:record/);
    await expect(cashTips.recordFor(hana(), { technicianId: danaTech, amount: "20", reason: "Austin" })).rejects.toThrow(/Technician not found/);
    expect((await cashTips.recordFor(hana(), { technicianId: rayTech, amount: "20", reason: "Houston" })).technicianId).toBe(rayTech);
    const mine = await cashTips.recordFor(office(), { technicianId: danaTech, amount: "15", reason: "Austin tip" });
    expect((await cashTips.list(hana())).map((t) => t.technicianId)).toEqual([rayTech]);
    expect((await cashTips.list(office())).map((t) => t.id)).toContain(mine.id);
  });

  it("answers a retry with the first answer rather than recording it twice", async () => {
    const ctx = { ...office(), idempotencyKey: `tip-${uuid()}` };
    const first = await cashTips.recordFor(ctx, { technicianId: rayTech, amount: "12", reason: "Retried" });
    const second = await cashTips.recordFor(ctx, { technicianId: rayTech, amount: "12", reason: "Retried" });
    expect(second.id).toBe(first.id);
    const [{ n }] = await raw`select count(*)::int as n from public.cash_tip where organization_id = ${ORG}` as unknown as [{ n: number }];
    expect(n).toBe(1);
  });
});

run("the office corrects a cash tip", () => {
  it("changes the amount with a reason, keeps what it was and who changed it, and shows the technician", async () => {
    const made = await cashTips.recordFor(office(), { technicianId: rayTech, amount: "20", receivedOn: today(), reason: "Customer said twenty" });
    const fixed = await cashTips.correct(office(), { id: made.id, amount: "25", reason: "She meant twenty five" });
    expect(fixed.amount).toBe("25.0000");
    expect(fixed.corrections).toEqual([expect.objectContaining({
      previousAmount: "20.0000", newAmount: "25.0000", reason: "She meant twenty five", correctedByName: "Olive Office",
    })]);
    const again = await cashTips.correct(office(), { id: made.id, amount: "0", reason: "It turned out to be a loan repaid" });
    expect(again.amount).toBe("0.0000");
    expect(again.corrections.map((c) => c.newAmount)).toEqual(["25.0000", "0.0000"]);
    // The technician reads both changes beside the tip.
    expect((await cashTips.mine(ray())).tips[0]!.corrections).toHaveLength(2);
    const [audit] = await raw`select action from public.audit_log where entity_id = ${made.id} and action = 'tip.cash_corrected'`;
    expect(audit).toBeDefined();
  });

  it("can change one the technician recorded from the phone", async () => {
    const id = uuid();
    await raw`insert into public.cash_tip (id, organization_id, technician_id, amount, received_at, note)
      values (${id}, ${ORG}, ${rayTech}, 20, now(), 'For you, thanks')`;
    const fixed = await cashTips.correct(office(), { id, amount: "10", reason: "He typed the wrong amount" });
    expect(fixed).toMatchObject({ amount: "10.0000", recordedBy: "technician", note: "For you, thanks" });
  });

  it("needs a reason, a different amount and somebody the reader answers for", async () => {
    const made = await cashTips.recordFor(office(), { technicianId: danaTech, amount: "20", reason: "Austin" });
    await expect(cashTips.correct(office(), { id: made.id, amount: "20", reason: "Same" })).rejects.toThrow(/already the amount/);
    await expect(cashTips.correct(office(), { id: made.id, amount: "21", reason: " " })).rejects.toThrow(/Say why the tip is being changed/);
    await expect(cashTips.correct(office(), { id: made.id, amount: "-1", reason: "No" })).rejects.toThrow(/dollars and cents/);
    await expect(cashTips.correct(hana(), { id: made.id, amount: "21", reason: "Not Houston's" })).rejects.toThrow(/Cash tip not found/);
    await expect(cashTips.correct(ray(), { id: made.id, amount: "21", reason: "Mine?" })).rejects.toThrow(/tip:record/);
  });

  it("moves the payroll fingerprint, so a change after the export is visible", async () => {
    const made = await cashTips.recordFor(office(), { technicianId: rayTech, amount: "20", receivedOn: "2026-01-07", reason: "January" });
    const period = await payroll.declarePeriod(owner(), { label: "Fortnight", startDate: "2026-01-05", weeks: 2 });
    // Closed periods refuse changes, which is what keeps the file the one that was sent...
    await payroll.closePeriod(owner(), { periodId: period.id });
    await expect(cashTips.correct(office(), { id: made.id, amount: "30", reason: "Late" })).rejects.toThrow(/closed and has gone to payroll/);
    await expect(cashTips.recordFor(office(), { technicianId: danaTech, amount: "20", receivedOn: "2026-01-08", reason: "Late" }))
      .rejects.toThrow(/closed and has gone to payroll/);
    // ...and reopening is how it is done on purpose.
    await payroll.reopenPeriod(owner(), { periodId: period.id, reason: "A tip was wrong" });
    await cashTips.correct(office(), { id: made.id, amount: "30", reason: "Late" });
    await payroll.closePeriod(owner(), { periodId: period.id });
    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianId === rayTech)!;
    expect(row.lines.filter((l) => l.kind === "cash_tip").map((l) => l.amount)).toEqual(["30.0000"]);
    // And a tip corrected to nothing is not on the file at all.
    await payroll.reopenPeriod(owner(), { periodId: period.id, reason: "Not given after all" });
    await cashTips.correct(office(), { id: made.id, amount: "0", reason: "Never given" });
    await payroll.closePeriod(owner(), { periodId: period.id });
    expect((await payroll.register(owner(), { periodId: period.id })).rows.find((r) => r.technicianId === rayTech)?.lines ?? [])
      .toEqual([]);
  });
});

/* =========================================================== how it is shared */

run("a tip left with a payment is shared by the company's rule", () => {
  /** A job Ray, the lead, went out on with Dana, with hours clocked on it: one for Ray and three for Dana. */
  async function jobWithCrew(noLead = false, noHours = false) {
    const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId}, 'scheduled', 'Water heater') returning id`;
    const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'working', now(), now() + interval '2 hours') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${visit!.id}, ${rayTech}, ${!noLead}), (${ORG}, ${visit!.id}, ${danaTech}, false)`;
    if (!noHours) {
      for (const [tech, minutes] of [[rayTech, 60], [danaTech, 180]] as const) {
        await raw`insert into public.timeclock_entry (organization_id, technician_id, kind, job_id, started_at, ended_at, minutes)
          values (${ORG}, ${tech}, 'on_site', ${job!.id}, now() - interval '5 hours', now() - interval '1 hour', ${minutes})`;
      }
    }
    return { jobId: job!.id as string, visitId: visit!.id as string };
  }

  /** The tip, taken with cash on the phone: the way a tip reaches `tips.writeShares` with a job's crew behind it. */
  async function tipped(visitId: string, tip: string) {
    const ctx = ray();
    const device = await fieldOps.register(ctx, { installationId: `phone-${uuid()}` });
    const result = await fieldOps.sync(ctx, {
      deviceId: device.deviceId,
      operations: [{
        clientId: uuid(), sequence: 1, kind: "payment.collect", subjectId: visitId,
        occurredAt: new Date().toISOString(), payload: { method: "cash", amount: "100.00", tipAmount: tip },
      }],
    });
    expect(result.results[0]!.status).toBe("applied");
    const shares = await raw<{ technician_id: string; amount: string; split_rule: string; split_note: string | null }[]>`
      select s.technician_id, s.amount::text, s.split_rule, s.split_note from public.tip_share s
        join public.payment p on p.id = s.payment_id where p.tip_amount = ${tip}::numeric order by s.created_at desc, s.technician_id`;
    return shares;
  }

  const byPerson = (rows: { technician_id: string; amount: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.technician_id === rayTech ? "ray" : "dana", r.amount]));

  it("shares evenly when the company never chose, as it always did", async () => {
    const { visitId } = await jobWithCrew();
    const shares = await tipped(visitId, "20.00");
    expect(byPerson(shares)).toEqual({ ray: "10.0000", dana: "10.0000" });
    expect(shares.every((s) => s.split_rule === "even" && s.split_note === null)).toBe(true);
  });

  it("shares by the hours each was clocked in on the job: a quarter and three quarters", async () => {
    await payExtras.set(owner(), { tipSplit: "hours" });
    const { visitId } = await jobWithCrew();
    const shares = await tipped(visitId, "40.00");
    expect(byPerson(shares)).toEqual({ ray: "10.0000", dana: "30.0000" });
    expect(shares.every((s) => s.split_rule === "hours")).toBe(true);
  });

  it("gives the lead all of it", async () => {
    await payExtras.set(owner(), { tipSplit: "lead" });
    const { visitId } = await jobWithCrew();
    const shares = await tipped(visitId, "30.00");
    expect(byPerson(shares)).toEqual({ ray: "30.0000" });
    expect(shares[0]!.split_rule).toBe("lead");
  });

  it("shares evenly and says why when the rule has nothing to go on", async () => {
    await payExtras.set(owner(), { tipSplit: "lead" });
    const noLead = await jobWithCrew(true, false);
    const a = await tipped(noLead.visitId, "12.00");
    expect(byPerson(a)).toEqual({ ray: "6.0000", dana: "6.0000" });
    expect(a[0]).toMatchObject({ split_rule: "even", split_note: expect.stringMatching(/No lead is marked/) });

    await payExtras.set(owner(), { tipSplit: "hours" });
    const noHours = await jobWithCrew(false, true);
    const b = await tipped(noHours.visitId, "14.00");
    expect(byPerson(b)).toEqual({ ray: "7.0000", dana: "7.0000" });
    expect(b[0]).toMatchObject({ split_rule: "even", split_note: expect.stringMatching(/No hours were recorded/) });
  });

  it("applies a change of rule from the next tip on, and never re-splits one already shared", async () => {
    const { visitId } = await jobWithCrew();
    const before = await tipped(visitId, "20.00");
    await payExtras.set(owner(), { tipSplit: "lead" });
    const after = await tipped(visitId, "22.00");
    expect(byPerson(after)).toEqual({ ray: "22.0000" });
    const [stillThere] = await raw`select count(*)::int as n from public.tip_share s join public.payment p on p.id = s.payment_id
      where p.tip_amount = 20 and s.split_rule = 'even'`;
    expect((stillThere as { n: number }).n).toBe(before.length);
  });

  it("keeps the odd cent with a stable person, and the shares add back to the tip", async () => {
    await payExtras.set(owner(), { tipSplit: "hours" });
    const { visitId } = await jobWithCrew();
    const shares = await tipped(visitId, "10.01");
    expect(shares.reduce((total, s) => total + Number(s.amount), 0)).toBeCloseTo(10.01, 4);
    expect(byPerson(shares)).toEqual({ ray: "2.5000", dana: "7.5100" });
  });

  it("is chosen by whoever declares what people are owed", async () => {
    await expect(payExtras.set(office(), { tipSplit: "lead" })).rejects.toThrow(/payroll:configure/);
    expect((await payExtras.set(owner(), { tipSplit: "hours" })).tipSplit).toBe("hours");
    expect((await payExtras.get(office())).rules.map((r) => r.rule)).toEqual(["even", "hours", "lead"]);
  });
});

run("the routes say what they need", () => {
  it("declare the permissions the services demand", () => {
    expect(routes.recordCashTipFor.permissions).toEqual(["tip:record"]);
    expect(routes.correctCashTip.permissions).toEqual(["tip:record"]);
    expect(routes.listMyCashTips.permissions).toEqual(["payroll:own"]);
  });
});
