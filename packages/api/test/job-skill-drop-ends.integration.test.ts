import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as records from "../src/services/people-records";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as crews from "../src/services/crews";
import { inTenant, type ServiceContext } from "../src/services/context";
import { qualifyDaysForWork } from "../src/services/qualification";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M10. A DROP THAT ENDS.
 *
 * A job can drop one of its type's skills through a last day. Each visit is
 * judged on its own day: before the end the skill is not asked, from the day
 * after it is, on the board, at booking, for a crew and in a booking calendar.
 * The drop stays on the job once it has ended, as the record of why.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m10dropends:org");
const USER = fixtureId("m10dropends:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

/** Noon in Austin on a company day, so no zone arithmetic can move it to another date. */
const noon = (day: string) => new Date(`${day}T18:00:00Z`);
const windowOn = (day: string) => ({
  windowStart: noon(day).toISOString(), windowEnd: new Date(noon(day).getTime() + 3600e3).toISOString(),
});

let sam = "";
let jobId = "";
let nearVisit = "";
let farVisit = "";
let crewId = "";
const NEAR = companyToday(3);
const END = companyToday(5);
const FAR = companyToday(9);

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`m10dropends:tech:${key}`);
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`m10dropends-${key}@test.local`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Drop Ends Co", slug: "dropends-co" });
  sam = await technician("sam", "Sam Lee");
  const dana = await technician("dana", "Dana Ortiz");
  /** Somebody is recorded with the skill, so Sam's absence on it means something. */
  await records.recordSkill(owner(), { technicianId: dana, skill: "epa_608", since: "2025-06-01", evidence: "Card 1" });
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, required_skills)
    values (${ORG}, 'Coil swap', 'COIL', ${raw.json(["epa_608"])}) returning id`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Lee Park", phone: "+15125550192", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "9 Oak Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, jobTypeId: type!.id, summary: "Swap a coil on a system already isolated",
    tags: [], customFields: {},
    visit: { ...windowOn(NEAR), estimatedDurationMinutes: 60, technicianIds: [] },
  });
  jobId = job.id;
  nearVisit = job.visits[0]!.id;
  const far = await jobs.addVisit(owner(), { id: jobId, ...windowOn(FAR), estimatedDurationMinutes: 60, technicianIds: [] });
  farVisit = far.id;
  const [crew] = await raw<{ id: string }[]>`
    insert into public.crew (organization_id, name, skills) values (${ORG}, 'No skill crew', ${raw.json([])}) returning id`;
  crewId = crew!.id;
  await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crewId}, ${sam})`;
});

afterAll(async () => { if (raw) await raw.end(); });

const reason = "The refrigerant side was done last week";

run("a drop with an end", () => {
  it("is refused when its last day has already passed, and accepted for today", async () => {
    await expect(records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason, through: companyToday(-1) }))
      .rejects.toThrow(/already passed/);
    expect((await records.jobSkills(owner(), { id: jobId })).dropped).toEqual([]);
  });

  it("is judged on the day of each visit: not asked before the end, asked again after it", async () => {
    await expect(dispatch.assign(owner(), { id: nearVisit, technicianIds: [sam] })).rejects.toThrow(/epa_608/);

    const view = await records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason, through: END });
    expect(view.dropped).toEqual([expect.objectContaining({ skill: "epa_608", reason, through: END, ended: false })]);
    /** Today is before the end, so today it is not asked. */
    expect(view.checked).toEqual([]);

    const sent = await dispatch.assign(owner(), { id: nearVisit, technicianIds: [sam] });
    expect(sent.droppedSkills).toEqual([{ skill: "epa_608", reason, through: END }]);
    const [entry] = await raw<{ after: { droppedSkills: { skill: string; through?: string }[] } }[]>`
      select after from public.audit_log where action = 'visit.assigned' and entity_id = ${nearVisit} order by created_at desc limit 1`;
    expect(entry!.after.droppedSkills).toEqual([{ skill: "epa_608", reason, through: END }]);

    /** The visit after the end is asked for it, and the refusal says why a skill the office dropped is back. */
    await expect(dispatch.assign(owner(), { id: farVisit, technicianIds: [sam] }))
      .rejects.toThrow(new RegExp(`epa_608 through ${END}, and that has ended`));
    /** The same at booking, which has no override. */
    await expect(jobs.addVisit(owner(), { id: jobId, ...windowOn(FAR), estimatedDurationMinutes: 60, technicianIds: [sam] }))
      .rejects.toThrow(/epa_608/);
    await expect(jobs.addVisit(owner(), { id: jobId, ...windowOn(END), estimatedDurationMinutes: 60, technicianIds: [sam] }))
      .resolves.toBeDefined();
  });

  it("is asked of a crew on the day after the end and not on the end", async () => {
    const on = await crews.canTake(owner(), { id: crewId, jobId, on: END });
    expect(on.blockers.map((b) => b.code)).not.toContain("missing_skills");
    const after = await crews.canTake(owner(), { id: crewId, jobId, on: companyToday(6) });
    expect(after.blockers.map((b) => b.code)).toContain("missing_skills");
  });

  it("cuts a booking calendar where the drop ends", async () => {
    const answer = await inTenant(owner(), (tx) => qualifyDaysForWork(tx, ORG, {
      technicianIds: [sam], typeSkills: ["epa_608"], jobSkills: [],
      dropped: [{ skill: "epa_608", through: END }], from: companyToday(2), until: companyToday(9),
    }));
    expect(answer(companyToday(2)).get(sam)!.qualified).toBe(true);
    expect(answer(END).get(sam)!.qualified).toBe(true);
    expect(answer(companyToday(6)).get(sam)!.qualified).toBe(false);
    expect(answer(companyToday(9)).get(sam)!.qualified).toBe(false);
    /** A drop with no end is one answer for the whole range, as before. */
    const forever = await inTenant(owner(), (tx) => qualifyDaysForWork(tx, ORG, {
      technicianIds: [sam], typeSkills: ["epa_608"], jobSkills: [],
      dropped: [{ skill: "epa_608" }], from: companyToday(2), until: companyToday(9),
    }));
    expect(forever(companyToday(9)).get(sam)!.qualified).toBe(true);
  });

  it("keeps its first reason and its first end when dropped again while it stands", async () => {
    const again = await records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason: "Another reason entirely", through: companyToday(20) });
    expect(again.dropped).toHaveLength(1);
    expect(again.dropped[0]).toMatchObject({ reason, through: END });
  });

  it("stays on the job once it has ended, asks for the skill again, and can be dropped again", async () => {
    /** Time passing: the last day moved to yesterday, as it will be on the day after it. */
    await raw`
      update public.job set dropped_skills = jsonb_set(dropped_skills, '{0,through}', to_jsonb(${companyToday(-1)}::text))
      where id = ${jobId}`;
    const ended = await records.jobSkills(owner(), { id: jobId });
    expect(ended.dropped).toEqual([expect.objectContaining({ skill: "epa_608", reason, through: companyToday(-1), ended: true })]);
    expect(ended.checked).toEqual(["epa_608"]);
    await expect(dispatch.assign(owner(), { id: nearVisit, technicianIds: [sam] })).rejects.toThrow(/epa_608/);

    const renewed = await records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason: "Signed off again by the fitter", through: companyToday(2) });
    expect(renewed.dropped).toHaveLength(1);
    expect(renewed.dropped[0]).toMatchObject({ reason: "Signed off again by the fitter", through: companyToday(2), ended: false });
    expect(renewed.checked).toEqual([]);
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where action = 'job.skill_dropped' and entity_id = ${jobId}`;
    expect(audit!.n).toBe(2);
  });

  it("is put back like any drop, and a dispatcher still may not make one", async () => {
    await expect(records.dropSkill(as(["dispatcher"]), { id: jobId, skill: "epa_608", reason: "Because I said so", through: END }))
      .rejects.toBeInstanceOf(PermissionError);
    await records.restoreSkill(as(["dispatcher"]), { id: jobId, skill: "epa_608" });
    const view = await records.jobSkills(owner(), { id: jobId });
    expect(view.dropped).toEqual([]);
    expect(view.checked).toEqual(["epa_608"]);
  });
});
