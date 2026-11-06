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
 * M17. A TIP RULE FOR A KIND OF WORK OR A CREW, A PERSON'S OWN RULE WITH
 * DATES, AND THE RULE ON THE JOB'S OWN PAGE
 *
 * The order: the job's own, the kind of work's, a crew's everybody sharing the
 * tip is on, the people's own covering the day, then the company's. A tip
 * already shared is never shared again, whatever is set afterwards.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("tip-scope:org");
const USER = fixtureId("tip-scope:user");

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
let installs = "";
let number = 700;

async function technician(name: string): Promise<string> {
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${(membership as { id: string }).id}, ${name}) returning id`;
  return (t as { id: string }).id;
}

async function crewOf(name: string, people: string[], active = true): Promise<string> {
  const [c] = await raw`insert into public.crew (organization_id, name, active) values (${ORG}, ${name}, ${active}) returning id`;
  const crewId = (c as { id: string }).id;
  for (const p of people) {
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crewId}, ${p})`;
  }
  return crewId;
}

/** A finished job with one visit: Ray the lead, an hour; Dana three hours. */
async function job(jobTypeId: string | null = null): Promise<string> {
  number += 1;
  const [j] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status, job_type_id)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Water heater', 'completed', ${jobTypeId}) returning id`;
  const jobId = (j as { id: string }).id;
  const [v] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, completed_at)
    values (${ORG}, ${jobId}, 'completed', '2026-10-10T14:00:00Z', '2026-10-10T20:00:00Z', '2026-10-10T20:00:00Z') returning id`;
  const visitId = (v as { id: string }).id;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${visitId}, ${ray}, true), (${ORG}, ${visitId}, ${dana}, false)`;
  for (const [tech, h] of [[ray, 1], [dana, 3]] as const) {
    await raw`insert into public.timeclock_entry (organization_id, technician_id, kind, job_id, visit_id, started_at, ended_at, minutes)
      values (${ORG}, ${tech}, 'on_site', ${jobId}, ${visitId}, '2026-10-10T14:00:00Z', '2026-10-10T19:00:00Z', ${h * 60})`;
  }
  return jobId;
}

/** A tip of `amount` on the job arriving at `at`, as the payment path shares it. */
async function tipOn(jobId: string, amount: string, at = new Date()) {
  const paymentId = randomUUID();
  await raw`insert into public.payment (id, organization_id, customer_id, method, amount, tip_amount, idempotency_key)
    values (${paymentId}, ${ORG}, ${customerId}, 'cash', '100', ${amount}, ${randomUUID()})`;
  await inTenant(owner(), (tx) => tips.writeShares(tx, {
    organizationId: ORG, paymentId, invoiceId: null, jobId, tip: m.money(amount),
    technicianIds: [ray, dana], occurredAt: at,
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tip Scope Co", slug: "tip-scope-co" });
  const [cust] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Ada Byrne') returning id`;
  customerId = (cust as { id: string }).id;
  const [prop] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Elm St', 'Austin', 'TX', '78704') returning id`;
  propertyId = (prop as { id: string }).id;
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  const [type] = await raw`insert into public.job_type (organization_id, name) values (${ORG}, 'Install') returning id`;
  installs = (type as { id: string }).id;
});

run("a rule for a kind of work", () => {
  it("shares a tip on a job of that kind by its rule, and the job's own still comes first", async () => {
    await tipRules.set(owner(), { jobTypeId: installs, rule: "lead", note: "The lead sells installs" });
    const install = await job(installs);
    const byKind = await tipOn(install, "40.00");
    expect(byKind.by).toEqual({ ray: "40.0000" });
    expect(byKind.rows[0]).toMatchObject({ split_rule: "lead", rule_source: "job_type" });

    await tipRules.set(owner(), { jobId: install, rule: "hours" });
    const byJob = await tipOn(install, "40.00");
    expect(byJob.by).toEqual({ ray: "10.0000", dana: "30.0000" });
    expect(byJob.rows[0]).toMatchObject({ rule_source: "job" });

    /** A job of another kind, or of none, is left to the next rule. */
    expect((await tipOn(await job(), "20.00")).rows[0]).toMatchObject({ split_rule: "even", rule_source: "company" });
  });

  it("comes before the people's own", async () => {
    await tipRules.set(owner(), { technicianId: dana, rule: "hours" });
    await tipRules.set(owner(), { jobTypeId: installs, rule: "lead" });
    expect((await tipOn(await job(installs), "10.00")).rows[0]).toMatchObject({ split_rule: "lead", rule_source: "job_type" });
  });
});

run("a rule for a crew", () => {
  it("shares by the crew's rule when everybody on the tip is on the crew, before the people's own", async () => {
    const crew = await crewOf("Install crew", [ray, dana]);
    await tipRules.set(owner(), { technicianId: dana, rule: "lead" });
    await tipRules.set(owner(), { crewId: crew, rule: "hours" });
    const { by, rows } = await tipOn(await job(), "40.00");
    expect(by).toEqual({ ray: "10.0000", dana: "30.0000" });
    expect(rows[0]).toMatchObject({ split_rule: "hours", rule_source: "crew" });
  });

  it("is not read when somebody on the tip is not on the crew, or the crew is out of use", async () => {
    const crew = await crewOf("Ray alone", [ray]);
    await tipRules.set(owner(), { crewId: crew, rule: "lead" });
    expect((await tipOn(await job(), "20.00")).rows[0]).toMatchObject({ rule_source: "company", split_rule: "even" });

    const retired = await crewOf("Old crew", [ray, dana], false);
    await tipRules.set(owner(), { crewId: retired, rule: "lead" });
    expect((await tipOn(await job(), "20.00")).rows[0]).toMatchObject({ rule_source: "company", split_rule: "even" });
  });

  it("passes over two crews that disagree, says so, and reads the people's own next", async () => {
    await tipRules.set(owner(), { crewId: await crewOf("Day crew", [ray, dana]), rule: "lead" });
    await tipRules.set(owner(), { crewId: await crewOf("Night crew", [ray, dana]), rule: "hours" });
    await tipRules.set(owner(), { technicianId: ray, rule: "even" });
    const { rows } = await tipOn(await job(), "20.00");
    expect(rows[0]).toMatchObject({
      split_rule: "even", rule_source: "technician", split_note: expect.stringMatching(/crews with different tip rules/),
    });
  });
});

run("a person's own rule with dates", () => {
  it("is read only on the company days it covers", async () => {
    await tipRules.set(owner(), { technicianId: dana, rule: "hours", startsOn: "2026-03-01", endsOn: "2026-03-31", note: "Apprentice term" });
    const jobId = await job();
    /** 1 April 02:00 UTC is still 31 March in Texas. */
    const lastEvening = await tipOn(jobId, "40.00", new Date("2026-04-01T02:00:00Z"));
    expect(lastEvening.rows[0]).toMatchObject({ split_rule: "hours", rule_source: "technician" });
    const after = await tipOn(jobId, "40.00", new Date("2026-04-01T15:00:00Z"));
    expect(after.rows[0]).toMatchObject({ split_rule: "even", rule_source: "company" });
    const before = await tipOn(jobId, "40.00", new Date("2026-02-28T15:00:00Z"));
    expect(before.rows[0]).toMatchObject({ split_rule: "even", rule_source: "company" });
  });

  it("can follow another without a gap, refuses an overlap, and changes in place on the same days", async () => {
    const march = await tipRules.set(owner(), { technicianId: dana, rule: "hours", startsOn: "2026-03-01", endsOn: "2026-03-31" });
    expect(march).toMatchObject({ kind: "technician", startsOn: "2026-03-01", endsOn: "2026-03-31" });
    const later = await tipRules.set(owner(), { technicianId: dana, rule: "lead", startsOn: "2026-04-01" });
    expect(later.id).not.toBe(march.id);
    await expect(tipRules.set(owner(), { technicianId: dana, rule: "even", endsOn: "2026-03-15" }))
      .rejects.toThrow(/overlap/);
    await expect(tipRules.set(owner(), { technicianId: dana, rule: "even" })).rejects.toThrow(/overlap/);
    const changed = await tipRules.set(owner(), { technicianId: dana, rule: "visit_hours", startsOn: "2026-03-01", endsOn: "2026-03-31" });
    expect(changed.id).toBe(march.id);
    expect(changed.rule).toBe("visit_hours");
    expect((await tipRules.list(owner())).rules.filter((r) => r.technicianId === dana)).toHaveLength(2);

    const jobId = await job();
    expect((await tipOn(jobId, "40.00", new Date("2026-04-02T15:00:00Z"))).rows[0]).toMatchObject({ split_rule: "lead" });
  });

  it("refuses days on anything but a person, and a last day before the first", async () => {
    const jobId = await job();
    await expect(tipRules.set(owner(), { jobId, rule: "lead", startsOn: "2026-03-01" })).rejects.toThrow(/Only a person/);
    await expect(tipRules.set(owner(), { jobTypeId: installs, rule: "lead", endsOn: "2026-03-01" })).rejects.toThrow(/Only a person/);
    await expect(tipRules.set(owner(), { technicianId: ray, rule: "lead", startsOn: "2026-03-10", endsOn: "2026-03-01" }))
      .rejects.toThrow(/before the first/);
    await expect(tipRules.set(owner(), { jobTypeId: installs, crewId: await crewOf("Two", [ray]), rule: "lead" }))
      .rejects.toThrow(/Say who the rule is for/);
  });
});

run("rules already shared, permissions and the audit", () => {
  it("never re-splits a tip already shared when a kind of work's, a crew's or a dated rule is set", async () => {
    const jobId = await job(installs);
    const before = await tipOn(jobId, "20.00", new Date("2026-03-10T15:00:00Z"));
    expect(before.by).toEqual({ ray: "10.0000", dana: "10.0000" });
    await tipRules.set(owner(), { jobTypeId: installs, rule: "lead" });
    await tipRules.set(owner(), { crewId: await crewOf("Both", [ray, dana]), rule: "hours" });
    await tipRules.set(owner(), { technicianId: dana, rule: "hours", startsOn: "2026-03-01" });
    const still = await raw`select amount::text as amount, rule_source from public.tip_share where payment_id = ${before.paymentId} order by amount`;
    expect(still.map((r) => [(r as { amount: string }).amount, (r as { rule_source: string }).rule_source]))
      .toEqual([["10.0000", "company"], ["10.0000", "company"]]);
  });

  it("is set only with payroll:configure, audited, and replayed by its key", async () => {
    const crew = await crewOf("Install crew", [ray, dana]);
    await expect(tipRules.set(as(["office_manager"]), { crewId: crew, rule: "lead" })).rejects.toThrow(/payroll:configure/);
    const first = await tipRules.set(owner({ idempotencyKey: "ts-1" }), { crewId: crew, rule: "lead" });
    expect(first).toMatchObject({ kind: "crew", crewName: "Install crew", startsOn: null, endsOn: null });
    expect((await tipRules.set(owner({ idempotencyKey: "ts-1" }), { crewId: crew, rule: "lead" })).id).toBe(first.id);
    const changed = await tipRules.set(owner(), { crewId: crew, rule: "hours" });
    expect(changed.id).toBe(first.id);
    const kind = await tipRules.set(owner(), { jobTypeId: installs, rule: "lead" });
    expect(kind).toMatchObject({ kind: "job_type", jobTypeName: "Install" });
    const actions = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${first.id} order by created_at`;
    expect(actions.map((a) => (a as { action: string }).action)).toEqual(["tip_rule.set", "tip_rule.changed"]);
  });
});

run("the tip rule on the job's own page", () => {
  it("says the job's own rule and what a tip today would be shared by, and where that comes from", async () => {
    const jobId = await job(installs);
    await payExtras.set(owner(), { tipSplit: "hours" });
    const plain = await tipRules.forJob(as(["office_manager"]), { jobId });
    expect(plain.own).toBeNull();
    expect(plain.today).toMatchObject({ rule: "hours", source: "company", people: ["Dana Pike", "Ray Nunez"] });

    await tipRules.set(owner(), { jobTypeId: installs, rule: "lead" });
    expect((await tipRules.forJob(owner(), { jobId })).today).toMatchObject({
      rule: "lead", source: "job_type", sourceLabel: "the rule for this kind of work",
    });

    await tipRules.set(owner(), { jobId, rule: "visit_hours", note: "Second day crew did the work" });
    const own = await tipRules.forJob(owner(), { jobId });
    expect(own.own).toMatchObject({ kind: "job", rule: "visit_hours", note: "Second day crew did the work" });
    expect(own.today).toMatchObject({ rule: "visit_hours", source: "job" });
  });

  it("is read with timesheet:read, and a job that is not there reads as missing", async () => {
    const jobId = await job();
    await expect(tipRules.forJob(as(["technician"]), { jobId })).rejects.toThrow(/timesheet:read/);
    await expect(tipRules.forJob(owner(), { jobId: fixtureId("tip-scope:elsewhere") })).rejects.toThrow(/Job/);
  });
});
