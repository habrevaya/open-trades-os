import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { money as m, type Actor } from "@opentradesos/core";
import * as tips from "../src/services/tips";
import * as tipRules from "../src/services/tip-rules";
import * as payExtras from "../src/services/pay-extras";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M17. A TIP RULE FOR ONE JOB OR ONE PERSON, AND HOURS ON THE VISIT
 *
 * The job's own rule is read first, then the people's own when they agree,
 * then the company's. Sharing by the hours on the visit reads the visit the tip
 * was taken on, or else the job's visit finished most recently. A tip already
 * shared is never shared again, whatever changes afterwards.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("tip-rules:org");
const USER = fixtureId("tip-rules:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...extra,
});
const owner = (extra: Partial<ServiceContext> = {}) => as(["owner"], extra);

let customerId = "";
let propertyId = "";
let ray = "";
let dana = "";
let number = 900;

async function technician(name: string): Promise<string> {
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${(membership as { id: string }).id}, ${name}) returning id`;
  return (t as { id: string }).id;
}

/**
 * A job with two visits. The first, finished on the 10th: Ray an hour, Dana
 * three. The second, finished on the 12th: Ray three hours, Dana one. Ray is
 * the lead on both. Over the job each worked four hours.
 */
async function twoVisitJob(): Promise<{ jobId: string; first: string; second: string }> {
  number += 1;
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Two day install', 'completed') returning id`;
  const jobId = (job as { id: string }).id;
  const visit = async (day: string, hours: [number, number]) => {
    const [v] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, completed_at)
      values (${ORG}, ${jobId}, 'completed', ${`${day}T14:00:00Z`}, ${`${day}T20:00:00Z`}, ${`${day}T20:00:00Z`}) returning id`;
    const visitId = (v as { id: string }).id;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${visitId}, ${ray}, true), (${ORG}, ${visitId}, ${dana}, false)`;
    for (const [tech, h] of [[ray, hours[0]], [dana, hours[1]]] as const) {
      await raw`insert into public.timeclock_entry (organization_id, technician_id, kind, job_id, visit_id, started_at, ended_at, minutes)
        values (${ORG}, ${tech}, 'on_site', ${jobId}, ${visitId}, ${`${day}T14:00:00Z`}, ${`${day}T19:00:00Z`}, ${h * 60})`;
    }
    return visitId;
  };
  const first = await visit("2026-10-10", [1, 3]);
  const second = await visit("2026-10-12", [3, 1]);
  return { jobId, first, second };
}

/** A tip of `amount` on the job, as the payment path shares it, and the shares it wrote. */
async function tipOn(jobId: string, amount: string, visitId: string | null = null) {
  const paymentId = randomUUID();
  await raw`insert into public.payment (id, organization_id, customer_id, method, amount, tip_amount, idempotency_key)
    values (${paymentId}, ${ORG}, ${customerId}, 'cash', '100', ${amount}, ${randomUUID()})`;
  await inTenant(owner(), (tx) => tips.writeShares(tx, {
    organizationId: ORG, paymentId, invoiceId: null, jobId, tip: m.money(amount),
    technicianIds: [ray, dana], occurredAt: new Date(), visitId,
  }));
  const rows = await raw<{ technician_id: string; amount: string; split_rule: string; split_note: string | null; rule_source: string }[]>`
    select technician_id, amount::text, split_rule, split_note, rule_source from public.tip_share where payment_id = ${paymentId}`;
  const by = Object.fromEntries(rows.map((r) => [r.technician_id === ray ? "ray" : "dana", r.amount]));
  return { by, rows, paymentId };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tip Rules Co", slug: "tip-rules-co" });
  const [cust] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Lou Grant') returning id`;
  customerId = (cust as { id: string }).id;
  const [prop] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Pine St', 'Austin', 'TX', '78703') returning id`;
  propertyId = (prop as { id: string }).id;
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
});

run("hours on the visit as a basis", () => {
  it("shares by the hours on the visit the tip was taken on", async () => {
    await payExtras.set(owner(), { tipSplit: "visit_hours" });
    const { jobId, first } = await twoVisitJob();
    const { by, rows } = await tipOn(jobId, "40.00", first);
    expect(by).toEqual({ ray: "10.0000", dana: "30.0000" });
    expect(rows.every((r) => r.split_rule === "visit_hours" && r.rule_source === "company")).toBe(true);
  });

  it("takes the job's visit finished most recently when the tip came with no visit", async () => {
    await payExtras.set(owner(), { tipSplit: "visit_hours" });
    const { jobId } = await twoVisitJob();
    expect((await tipOn(jobId, "40.00")).by).toEqual({ ray: "30.0000", dana: "10.0000" });
  });

  it("shares evenly and says why when nobody clocked in on that visit", async () => {
    await payExtras.set(owner(), { tipSplit: "visit_hours" });
    const { jobId, first } = await twoVisitJob();
    await raw`delete from public.timeclock_entry where visit_id = ${first}`;
    const { by, rows } = await tipOn(jobId, "20.00", first);
    expect(by).toEqual({ ray: "10.0000", dana: "10.0000" });
    expect(rows[0]).toMatchObject({ split_rule: "even", split_note: expect.stringMatching(/visit this tip was for/) });
  });
});

run("a rule for one job or one person", () => {
  it("reads the job's own rule before the people's and the company's", async () => {
    const { jobId } = await twoVisitJob();
    await tipRules.set(owner(), { technicianId: dana, rule: "hours" });
    await tipRules.set(owner(), { jobId, rule: "lead", note: "Ray sold it" });
    const { by, rows } = await tipOn(jobId, "30.00");
    expect(by).toEqual({ ray: "30.0000" });
    expect(rows[0]).toMatchObject({ split_rule: "lead", rule_source: "job" });
  });

  it("reads the people's own rule when everybody who has one agrees, and the company's when they do not", async () => {
    const { jobId, second } = await twoVisitJob();
    await tipRules.set(owner(), { technicianId: dana, rule: "visit_hours" });
    const agreed = await tipOn(jobId, "40.00", second);
    expect(agreed.by).toEqual({ ray: "30.0000", dana: "10.0000" });
    expect(agreed.rows[0]).toMatchObject({ split_rule: "visit_hours", rule_source: "technician" });

    await tipRules.set(owner(), { technicianId: ray, rule: "lead" });
    const disagreed = await tipOn(jobId, "20.00", second);
    expect(disagreed.by).toEqual({ ray: "10.0000", dana: "10.0000" });
    expect(disagreed.rows[0]).toMatchObject({
      split_rule: "even", rule_source: "company", split_note: expect.stringMatching(/different tip rules of their own/),
    });
  });

  it("never re-splits a tip already shared, when a rule is set, changed or taken off", async () => {
    const { jobId } = await twoVisitJob();
    const before = await tipOn(jobId, "20.00");
    expect(before.by).toEqual({ ray: "10.0000", dana: "10.0000" });
    const rule = await tipRules.set(owner(), { jobId, rule: "lead" });
    await tipRules.set(owner(), { jobId, rule: "hours" });
    await tipRules.remove(owner(), { id: rule.id });
    const still = await raw`select technician_id, amount::text as amount, split_rule from public.tip_share where payment_id = ${before.paymentId}`;
    expect(still.map((r) => (r as { amount: string }).amount)).toEqual(["10.0000", "10.0000"]);
    /** Writing the shares again for the same payment writes nothing. */
    await inTenant(owner(), (tx) => tips.writeShares(tx, {
      organizationId: ORG, paymentId: before.paymentId, invoiceId: null, jobId, tip: m.money("20"),
      technicianIds: [ray, dana], occurredAt: new Date(),
    }));
    const [count] = await raw`select count(*)::int as n from public.tip_share where payment_id = ${before.paymentId}`;
    expect((count as { n: number }).n).toBe(2);
  });

  it("is one rule per job and per person, changed in place, audited, and replayed by its key", async () => {
    const { jobId } = await twoVisitJob();
    const first = await tipRules.set(owner({ idempotencyKey: "tr-1" }), { jobId, rule: "lead", note: "Ray sold it" });
    expect(first).toMatchObject({ kind: "job", jobId, rule: "lead", note: "Ray sold it", ruleLabel: "All to the lead on the job" });
    expect((await tipRules.set(owner({ idempotencyKey: "tr-1" }), { jobId, rule: "lead", note: "Ray sold it" })).id).toBe(first.id);
    const changed = await tipRules.set(owner(), { jobId, rule: "visit_hours" });
    expect(changed.id).toBe(first.id);
    expect(changed.rule).toBe("visit_hours");
    const listed = await tipRules.list(as(["office_manager"]));
    expect(listed.rules).toHaveLength(1);

    const actions = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${first.id} order by created_at`;
    expect(actions.map((a) => (a as { action: string }).action)).toEqual(["tip_rule.set", "tip_rule.changed"]);
    await tipRules.remove(owner(), { id: first.id });
    const after = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${first.id} order by created_at`;
    expect(after.map((a) => (a as { action: string }).action)).toContain("tip_rule.removed");
    expect((await tipRules.list(owner())).rules).toEqual([]);
  });

  it("is set by whoever declares what people are owed, for one job or one person", async () => {
    const { jobId } = await twoVisitJob();
    await expect(tipRules.set(as(["office_manager"]), { jobId, rule: "lead" })).rejects.toThrow(/payroll:configure/);
    await expect(tipRules.set(as(["admin"]), { jobId, rule: "lead" })).rejects.toThrow(/payroll:configure/);
    await expect(tipRules.set(owner(), { jobId, technicianId: ray, rule: "lead" })).rejects.toThrow(/Say who the rule is for/);
    await expect(tipRules.set(owner(), { rule: "lead" })).rejects.toThrow(/Say who the rule is for/);
    await expect(tipRules.set(owner(), { jobId, rule: "lottery" })).rejects.toThrow(/cannot be used/);
    await expect(tipRules.set(owner(), { jobNumber: 99999, rule: "lead" })).rejects.toThrow(/No such job/);
    const byNumber = await tipRules.set(owner(), { jobNumber: number, rule: "even" });
    expect(byNumber.jobId).toBe(jobId);
    await expect(tipRules.set(owner(), { jobId: fixtureId("tip-rules:elsewhere"), rule: "lead" })).rejects.toThrow(/Job/);
  });
});
