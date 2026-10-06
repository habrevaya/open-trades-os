import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as records from "../src/services/people-records";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M10. A JOB CAN DROP ONE OF ITS TYPE'S SKILLS, with the reason.
 *
 * Dropped, it is not asked of whoever is sent on that job: on the board when
 * somebody is assigned, and when a visit is booked with somebody named. The
 * reason is kept and read back wherever the job's skills are, and the
 * assignment says it was not checked. Dropping is the override's permission,
 * putting it back is the job's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m10drop:org");
const USER = fixtureId("m10drop:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let dana = "";
let sam = "";
let jobId = "";
let visitId = "";
let start = new Date();

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`m10drop:tech:${key}`);
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`m10drop-${key}@test.local`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Drop Co", slug: "drop-co" });
  dana = await technician("dana", "Dana Ortiz");
  sam = await technician("sam", "Sam Lee");
  /** Somebody is recorded with both, so their absence on Sam means something. */
  await records.recordSkill(owner(), { technicianId: dana, skill: "epa_608", since: "2025-06-01", evidence: "Card 1" });
  await records.recordSkill(owner(), { technicianId: dana, skill: "gas_fitter", since: "2025-06-01", evidence: "Card 2" });
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, required_skills)
    values (${ORG}, 'Furnace swap', 'FURN', ${raw.json(["epa_608", "gas_fitter"])}) returning id`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Pat Gray", phone: "+15125550191", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "3 Ash Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  start = new Date(Date.now() + 3 * 864e5);
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, jobTypeId: type!.id, summary: "Swap a furnace the gas is already off for",
    tags: [], customFields: {},
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3600e3).toISOString(), estimatedDurationMinutes: 60, technicianIds: [] },
  });
  jobId = job.id;
  visitId = job.visits[0]!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

const book = (technicianId: string) => jobs.addVisit(owner(), {
  id: jobId, windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3600e3).toISOString(),
  estimatedDurationMinutes: 60, technicianIds: [technicianId],
});

run("dropping one of the job type's skills for one job", () => {
  it("is asked of everybody until it is dropped, then not, on the board and at booking", async () => {
    await expect(dispatch.assign(owner(), { id: visitId, technicianIds: [sam] })).rejects.toThrow(/Sam Lee cannot be sent/);
    await expect(book(sam)).rejects.toThrow(/epa_608/);

    const dropped = await records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason: "The refrigerant side was done last week" });
    expect(dropped.dropped).toHaveLength(1);
    expect(dropped.dropped[0]).toMatchObject({ skill: "epa_608", reason: "The refrigerant side was done last week" });
    expect(dropped.typeSkills).toEqual(["epa_608", "gas_fitter"]);
    expect(dropped.checked).toEqual(["gas_fitter"]);

    /** One skill is still asked. */
    await expect(dispatch.assign(owner(), { id: visitId, technicianIds: [sam] })).rejects.toThrow(/gas_fitter/);
    await expect(book(sam)).rejects.toThrow(/gas_fitter/);

    await records.dropSkill(owner(), { id: jobId, skill: "gas_fitter", reason: "Gas is capped and a fitter signs off on Friday" });
    const sent = await dispatch.assign(owner(), { id: visitId, technicianIds: [sam] });
    expect(sent.overridden).toBe(false);
    /** The answer says what was not asked of them, and why. */
    expect(sent.droppedSkills).toEqual([
      { skill: "epa_608", reason: "The refrigerant side was done last week" },
      { skill: "gas_fitter", reason: "Gas is capped and a fitter signs off on Friday" },
    ]);
    const [entry] = await raw<{ after: { droppedSkills: { skill: string }[] } }[]>`
      select after from public.audit_log where action = 'visit.assigned' and entity_id = ${visitId} order by created_at desc limit 1`;
    expect(entry!.after.droppedSkills.map((d) => d.skill)).toEqual(["epa_608", "gas_fitter"]);
    await expect(book(sam)).resolves.toBeDefined();

    /** Read back with the reason, who and when. */
    const view = await records.jobSkills(owner(), { id: jobId });
    expect(view.dropped.map((d) => d.skill)).toEqual(["epa_608", "gas_fitter"]);
    expect(view.dropped[0]!.droppedBy).toBe("drop-co@test.local");
    expect(view.checked).toEqual([]);
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where action = 'job.skill_dropped' and entity_id = ${jobId}`;
    expect(audit!.n).toBe(2);
  });

  it("puts it back when asked, and the check returns", async () => {
    await records.restoreSkill(as(["dispatcher"]), { id: jobId, skill: "gas_fitter" });
    const view = await records.jobSkills(owner(), { id: jobId });
    expect(view.dropped.map((d) => d.skill)).toEqual(["epa_608"]);
    expect(view.checked).toEqual(["gas_fitter"]);
    await expect(book(sam)).rejects.toThrow(/gas_fitter/);
    /** Putting back what is not dropped changes nothing. */
    await records.restoreSkill(owner(), { id: jobId, skill: "gas_fitter" });
    expect((await records.jobSkills(owner(), { id: jobId })).dropped).toHaveLength(1);
  });

  it("keeps the first reason when dropped twice, and refuses a skill the type does not ask for and a thin reason", async () => {
    const again = await records.dropSkill(owner(), { id: jobId, skill: "epa_608", reason: "A different reason entirely" });
    expect(again.dropped).toHaveLength(1);
    expect(again.dropped[0]!.reason).toBe("The refrigerant side was done last week");

    await expect(records.dropSkill(owner(), { id: jobId, skill: "confined_space", reason: "Not in a crawlspace" }))
      .rejects.toThrow(/not one of this job type's skills/);
    await expect(records.dropSkill(owner(), { id: jobId, skill: "gas_fitter", reason: "no" }))
      .rejects.toThrow(/Say why/);
    expect((await records.jobSkills(owner(), { id: jobId })).dropped).toHaveLength(1);
  });

  it("is the override's permission to drop: a dispatcher may not, and may put one back", async () => {
    await expect(records.dropSkill(as(["dispatcher"]), { id: jobId, skill: "gas_fitter", reason: "Because I said so" }))
      .rejects.toBeInstanceOf(PermissionError);
    const manager = await records.dropSkill(as(["office_manager"]), { id: jobId, skill: "gas_fitter", reason: "Fitter signs off Friday" });
    expect(manager.dropped.map((d) => d.skill)).toContain("gas_fitter");
    await expect(records.restoreSkill(as(["accountant"]), { id: jobId, skill: "gas_fitter" }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("leaves another job of the same type asking for both", async () => {
    const [other] = await raw<{ job_type_id: string; customer_id: string; property_id: string }[]>`
      select job_type_id, customer_id, property_id from public.job where id = ${jobId}`;
    const second = await jobs.create(owner(), {
      customerId: other!.customer_id, propertyId: other!.property_id, jobTypeId: other!.job_type_id,
      summary: "A normal furnace swap", tags: [], customFields: {},
    });
    const view = await records.jobSkills(owner(), { id: second.id });
    expect(view.dropped).toEqual([]);
    expect(view.checked).toEqual(["epa_608", "gas_fitter"]);
  });
});
