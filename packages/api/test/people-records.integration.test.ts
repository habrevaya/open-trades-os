import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as records from "../src/services/people-records";
import * as people from "../src/services/people";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M24, THE REST OF THE PERSON, THROUGH A REAL DATABASE
 *
 * Onboarding copied from the role's checklist once, emergency contacts and
 * the employment record behind the roster's permission and not payroll's,
 * continuing education counted from the current licence's issue date, a
 * skill with its evidence put on the list the assignment check reads, and a
 * skill one job asks for beyond its type refusing the board exactly as the
 * type's would.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pr:org");
const USER = fixtureId("pr:user");
const TZ = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
const today = () => time.dateIn(new Date(), TZ);
const daysFromToday = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

let danaMember = "";
let dana = "";
let sam = "";

async function technician(key: string, name: string): Promise<{ membershipId: string; technicianId: string }> {
  const userId = fixtureId(`pr:tech:${key}`);
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`pr-${key}@test.local`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return { membershipId: m!.id, technicianId: t!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "People Co", slug: "people-co" });
  await raw`update public.organization set timezone = ${TZ} where id = ${ORG}`;
  const d = await technician("dana", "Dana Ortiz");
  danaMember = d.membershipId;
  dana = d.technicianId;
  sam = (await technician("sam", "Sam Lee")).technicianId;
});

afterAll(async () => { if (raw) await raw.end(); });

run("onboarding against the role's checklist", () => {
  it("copies the checklist once, ticks lines with who and what, and is done only when every required line is", async () => {
    await expect(records.startOnboarding(owner(), { membershipId: danaMember })).rejects.toThrow(/no onboarding checklist for Technician/);
    await records.addTemplateItem(owner(), { role: "technician", kind: "document", label: "I-9 and ID seen" });
    await records.addTemplateItem(owner(), { role: "technician", kind: "training", label: "Fall protection" });
    await records.addTemplateItem(owner(), { role: "technician", kind: "equipment", label: "Gauges issued", required: false });
    await records.addTemplateItem(owner(), { role: "office_manager", kind: "training", label: "Phones" });

    const started = await records.startOnboarding(owner(), { membershipId: danaMember });
    expect(started.added).toBe(3);
    expect(started.onboarding.progress.sentence).toBe("0 of 2 required lines done, 2 still to do.");
    expect((await records.startOnboarding(owner(), { membershipId: danaMember })).added).toBe(0);

    const [first, second] = started.onboarding.lines;
    await records.setOnboardingLine(owner(), { id: first!.id, done: true, note: "Passport and SS card" });
    const done = await records.setOnboardingLine(owner(), { id: second!.id, done: true });
    expect(done.progress.complete).toBe(true);
    expect(done.lines[0]).toMatchObject({ note: "Passport and SS card", doneBy: "people-co@test.local" });

    // Taking a line off the checklist leaves the copy people already have.
    const template = await records.onboardingTemplate(owner());
    await records.removeTemplateItem(owner(), { id: template.find((t) => t.label === "Fall protection")!.id });
    expect((await records.person(owner(), { membershipId: danaMember })).onboarding.lines).toHaveLength(3);
    const roster = await records.roster(owner());
    expect(roster.find((r) => r.membershipId === danaMember)!.onboarding.complete).toBe(true);
  });

  it("is the roster's to read and change, not anybody's", async () => {
    await expect(records.person(as(["dispatcher"]), { membershipId: danaMember })).rejects.toThrow();
    await expect(records.addTemplateItem(as(["office_manager"]), { role: "csr", kind: "other", label: "x" })).rejects.toThrow();
  });
});

run("emergency contacts and the employment record", () => {
  it("keeps who to ring in order, and the facts of employment with no pay on them", async () => {
    await expect(records.addEmergencyContact(owner(), { membershipId: danaMember, name: "Rosa Ortiz", phone: "" }))
      .rejects.toThrow(/phone number/);
    await records.addEmergencyContact(owner(), { membershipId: danaMember, name: "Rosa Ortiz", relationship: "Mother", phone: "512-555-0101" });
    const contacts = await records.addEmergencyContact(owner(), { membershipId: danaMember, name: "Luis Ortiz", phone: "512-555-0102" });
    expect(contacts.map((c) => [c.name, c.priority])).toEqual([["Rosa Ortiz", 1], ["Luis Ortiz", 2]]);
    const left = await records.removeEmergencyContact(owner(), { id: contacts[0]!.id });
    expect(left.map((c) => c.name)).toEqual(["Luis Ortiz"]);

    await expect(records.setEmployment(owner(), {
      membershipId: danaMember, startedOn: "2026-03-01", endedOn: "2026-02-01", employmentType: "full_time", payType: "hourly",
    })).rejects.toThrow(/before the start date/);
    await records.setEmployment(owner(), {
      membershipId: danaMember, startedOn: "2026-03-01", employmentType: "part_time", payType: "hourly", payrollReference: "GUSTO-118",
    });
    const record = await records.setEmployment(owner(), {
      membershipId: danaMember, jobTitle: "Service technician", startedOn: "2026-03-01", employmentType: "full_time", payType: "hourly",
      payrollReference: "GUSTO-118",
    });
    expect(record).toEqual({
      jobTitle: "Service technician", startedOn: "2026-03-01", endedOn: null,
      employmentType: "full_time", payType: "hourly", payrollReference: "GUSTO-118",
    });
    const columns = await raw<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'employment_record'
        and (column_name like '%rate%' or column_name like '%wage%' or column_name like '%salary%' or column_name like '%amount%')`;
    expect(columns).toEqual([]);
  });
});

run("continuing education toward a renewal", () => {
  it("counts the hours since the current licence was issued against the type's requirement", async () => {
    const type = await people.defineCertificationType(owner(), {
      code: "tdlr_acr", name: "TDLR air conditioning contractor", grantsSkills: [], defaultValidMonths: 12,
      ceHoursRequired: "8",
    });
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, issuedOn: daysFromToday(-100), expiresOn: daysFromToday(265),
    });
    await records.logContinuingEducation(owner(), {
      technicianId: dana, certificationTypeId: type.id, completedOn: daysFromToday(-400), hours: "8", course: "Last cycle's course",
    });
    await records.logContinuingEducation(owner(), {
      technicianId: dana, certificationTypeId: type.id, completedOn: daysFromToday(-20), hours: "2.5", course: "Refrigerant safety", provider: "ACCA",
    });
    await expect(records.logContinuingEducation(owner(), {
      technicianId: dana, certificationTypeId: type.id, completedOn: daysFromToday(10), hours: "1", course: "Next month",
    })).rejects.toThrow(/in the future/);

    const ce = await records.continuingEducation(owner(), { technicianId: dana });
    const progress = ce.progress.find((p) => p.certificationTypeId === type.id)!.progress;
    expect(progress).toMatchObject({ required: "8", logged: "2.5", remaining: "5.5", met: false });
    await expect(records.continuingEducation(as(["office_manager"]), { technicianId: dana })).rejects.toThrow();
  });
});

run("skills with dates and evidence, and a job's own skills", () => {
  it("puts a recorded skill on the checked list, and ending it takes it off and keeps the history", async () => {
    await expect(records.recordSkill(owner(), { technicianId: sam, skill: "brazing", since: today(), evidence: " " }))
      .rejects.toThrow(/Say what showed it/);
    const recorded = await records.recordSkill(owner(), {
      technicianId: sam, skill: "brazing", since: "2026-01-10", evidence: "Three supervised joints signed off by Dana",
    });
    expect(recorded.current).toEqual([{ skill: "brazing", record: expect.objectContaining({ since: "2026-01-10" }) }]);
    await expect(records.recordSkill(owner(), { technicianId: sam, skill: "brazing", since: today(), evidence: "again" }))
      .rejects.toThrow(/already has brazing recorded/);
    const [tech] = await raw<{ skills: string[] }[]>`select skills from public.technician where id = ${sam}`;
    expect(tech!.skills).toEqual(["brazing"]);

    const ended = await records.endSkill(owner(), { id: recorded.current[0]!.record!.id, reason: "Failed the leak test" });
    expect(ended.current).toEqual([]);
    expect(ended.ended[0]).toMatchObject({ skill: "brazing", endedReason: "Failed the leak test" });
  });

  it("refuses sending somebody to a job that asks for a skill its type does not, as the type's own would", async () => {
    const customer = await customers.create(owner(), {
      type: "residential", name: "Pat Gray", phone: "+15125550190", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const property = await properties.create(owner(), {
      address: { line1: "3 Ash Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const start = new Date(Date.now() + 2 * 864e5);
    const job = await jobs.create(owner(), {
      customerId: customer.id, propertyId: property.id, summary: "Rooftop unit, needs a lift", tags: [], customFields: {},
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3600e3).toISOString(), estimatedDurationMinutes: 60, technicianIds: [] },
    });
    const visitId = job.visits[0]!.id;

    // Somebody in the company is recorded with it, so its absence on Sam means something.
    await records.recordSkill(owner(), { technicianId: dana, skill: "aerial_lift", since: "2025-06-01", evidence: "OSHA lift card 4471" });
    const set = await records.setJobSkills(owner(), { id: job.id, skills: ["aerial_lift", " aerial_lift "] });
    expect(set.skills).toEqual(["aerial_lift"]);

    await expect(dispatch.assign(owner(), { id: visitId, technicianIds: [sam] })).rejects.toThrow(/Sam Lee cannot be sent: this work needs aerial_lift/);
    await dispatch.assign(owner(), { id: visitId, technicianIds: [dana] });

    // And booking another visit on the job with Sam named is refused the same way.
    await expect(jobs.addVisit(owner(), {
      id: job.id, windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3600e3).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [sam],
    })).rejects.toThrow(/aerial_lift/);
  });
});
