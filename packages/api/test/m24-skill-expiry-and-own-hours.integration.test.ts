import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as records from "../src/services/people-records";
import * as people from "../src/services/people";
import * as me from "../src/services/me";
import * as dispatch from "../src/services/dispatch";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M24. A SKILL RECORD'S OWN EXPIRY, AND HOURS A PERSON LOGS THEMSELVES.
 *
 * A skill with an expiry is warned like a certification and, once it has run
 * out, stops clearing the assignment check, from the day after. A person's own
 * continuing education hours wait for the office and count toward a renewal
 * only once the office has approved them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m24own:org");
const USER = fixtureId("m24own:user");
const TZ = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], userId = USER, key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = () => as(["owner"]);
const today = () => time.dateIn(new Date(), TZ);
const inDays = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

const png = (marker: number) =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, marker]);
const certificate = (marker: number) => ({ fileName: "certificate.png", bytes: png(marker).toString("base64") });

let dana = "";
let danaUser = "";
let sam = "";

async function technician(key: string, name: string): Promise<{ technicianId: string; userId: string }> {
  const userId = fixtureId(`m24own:tech:${key}`);
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`m24own-${key}@test.local`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return { technicianId: t!.id, userId };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Own Hours Co", slug: "own-hours-co" });
  await raw`update public.organization set timezone = ${TZ} where id = ${ORG}`;
  const d = await technician("dana", "Dana Ortiz");
  dana = d.technicianId;
  danaUser = d.userId;
  sam = (await technician("sam", "Sam Lee")).technicianId;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a skill record with its own expiry", () => {
  it("is warned from its notice period and kept on the list once it has run out", async () => {
    await expect(records.recordSkill(owner(), {
      technicianId: dana, skill: "forklift", since: "2026-01-02", evidence: "Course", expiresOn: "2026-01-01",
    })).rejects.toThrow(/cannot run out before the day it was shown/);
    await expect(records.recordSkill(owner(), {
      technicianId: dana, skill: "forklift", since: "2026-01-02", evidence: "Course", expiresOn: inDays(-1),
    })).rejects.toThrow(/already passed/);

    const recorded = await records.recordSkill(owner(), {
      technicianId: dana, skill: "forklift", since: "2026-01-02", evidence: "Operator course, card 77", expiresOn: inDays(10),
    });
    const record = recorded.current[0]!.record!;
    expect(record).toMatchObject({ expiresOn: inDays(10), renewalLeadDays: 30 });
    expect(record.expiry).toMatchObject({ state: "expiring", daysRemaining: 10 });

    const listed = await records.expiringSkills(as(["office_manager"]), {});
    expect(listed).toEqual([expect.objectContaining({
      technicianName: "Dana Ortiz", skill: "forklift", daysRemaining: 10, current: true,
      sentence: `Dana Ortiz: forklift runs out on ${inDays(10)}, in 10 days.`,
    })]);
    /** Outside its notice period it is not listed, until somebody asks further ahead. */
    await records.setSkillExpiry(owner(), { id: record.id, expiresOn: inDays(90), renewalLeadDays: 14 });
    expect(await records.expiringSkills(owner(), {})).toEqual([]);
    expect((await records.expiringSkills(owner(), { within: 100 })).map((e) => e.skill)).toEqual(["forklift"]);
  });

  it("stops clearing the assignment check from the day after, and clears again when it is renewed", async () => {
    const customer = await customers.create(owner(), {
      type: "residential", name: "Pat Gray", phone: "+15125550193", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const property = await properties.create(owner(), {
      address: { line1: "9 Oak Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const [type] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, code, required_skills)
      values (${ORG}, 'Forklift work', 'FORK', ${raw.json(["forklift"])}) returning id`;
    const at = (daysAhead: number) => new Date(Date.now() + daysAhead * 864e5);
    const book = async (daysAhead: number) => {
      const start = at(daysAhead);
      return jobs.create(owner(), {
        customerId: customer.id, propertyId: property.id, jobTypeId: type!.id, summary: `Move pallets in ${daysAhead} days`,
        tags: [], customFields: {},
        visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3600e3).toISOString(), estimatedDurationMinutes: 60, technicianIds: [] },
      });
    };
    const [{ id: recordId } = { id: "" }] = await raw<{ id: string }[]>`
      select id from public.technician_skill where technician_id = ${dana} and skill = 'forklift' and ended_on is null`;
    await records.setSkillExpiry(owner(), { id: recordId, expiresOn: inDays(5) });

    const before = await book(3);
    await expect(dispatch.assign(owner(), { id: before.visits[0]!.id, technicianIds: [dana] })).resolves.toMatchObject({ ok: true });
    const after = await book(8);
    await expect(dispatch.assign(owner(), { id: after.visits[0]!.id, technicianIds: [dana] }))
      .rejects.toThrow(new RegExp(`Dana Ortiz's record of forklift ran out on ${inDays(5)}`));
    /** Booking with her named is refused the same way. */
    await expect(jobs.addVisit(owner(), {
      id: after.id, windowStart: at(9).toISOString(), windowEnd: new Date(at(9).getTime() + 3600e3).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [dana],
    })).rejects.toThrow(/ran out on/);

    /** Shown again: the day moves and she clears it. */
    await records.setSkillExpiry(owner(), { id: recordId, expiresOn: inDays(400) });
    await expect(dispatch.assign(owner(), { id: after.visits[0]!.id, technicianIds: [dana] })).resolves.toMatchObject({ ok: true });
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where action = 'technician.skill_expiry_set' and entity_id = ${dana}`;
    expect(audit!.n).toBe(3);

    /** A record already past its day is still listed, flagged as no longer current. */
    await raw`update public.technician_skill set expires_on = ${inDays(-3)} where id = ${recordId}`;
    const [lapsed] = await records.expiringSkills(owner(), {});
    expect(lapsed).toMatchObject({ skill: "forklift", daysRemaining: -3, current: false });
    expect(lapsed!.sentence).toBe(`Dana Ortiz: forklift ran out on ${inDays(-3)}, 3 days ago.`);

    await expect(records.setSkillExpiry(as(["dispatcher"]), { id: recordId, expiresOn: inDays(30) }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(records.setSkillExpiry(owner(), { id: recordId, expiresOn: inDays(-1) })).rejects.toThrow(/already passed/);
    /** Not expiring at all. */
    const open = await records.setSkillExpiry(owner(), { id: recordId, expiresOn: null });
    expect(open.current[0]!.record!.expiry.state).toBe("none");
    expect(await records.expiringSkills(owner(), {})).toEqual([]);
  });

  it("is on the person's own record, soonest first", async () => {
    await records.recordSkill(owner(), { technicianId: dana, skill: "rigging", since: "2026-02-01", evidence: "Card 9", expiresOn: inDays(20) });
    const mine = await me.record(as(["technician"], danaUser));
    expect(mine.skills.map((s) => [s.skill, s.expiry.state])).toEqual([["rigging", "expiring"]]);
    expect((await me.record(as(["technician"], fixtureId("m24own:tech:sam")))).skills).toEqual([]);
  });
});

run("hours a person logs themselves", () => {
  let typeId = "";
  it("wait for the office, with the certificate, and count only once approved", async () => {
    const type = await people.defineCertificationType(owner(), {
      code: "tdlr_own", name: "TDLR contractor", grantsSkills: [], defaultValidMonths: 12, ceHoursRequired: "8",
    });
    typeId = type.id;
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: typeId, issuedOn: inDays(-100), expiresOn: inDays(265),
    });
    await records.logContinuingEducation(owner(), {
      technicianId: dana, certificationTypeId: typeId, completedOn: inDays(-30), hours: "2", course: "Office entered course",
    });

    const mine = as(["technician"], danaUser, "own-ce-1");
    const logged = await me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-5), hours: "4", course: "Refrigerant safety", provider: "ACCA",
      certificate: certificate(1),
    });
    const entry = logged.entries.find((e) => e.course === "Refrigerant safety")!;
    expect(entry).toMatchObject({ status: "pending", selfLogged: true, certificates: 1, hours: "4" });
    /** Waiting hours are shown, not counted. */
    const progress = logged.progress.find((p) => p.certificationTypeId === typeId)!;
    expect(progress.progress).toMatchObject({ logged: "2", remaining: "6", met: false });
    expect(progress.pendingHours).toBe("4");

    /** The same call under the same key is the first answer, not a second entry. */
    await me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-5), hours: "4", course: "Refrigerant safety", certificate: certificate(1),
    });
    expect((await records.continuingEducation(owner(), { technicianId: dana })).entries.filter((e) => e.selfLogged)).toHaveLength(1);

    const [waiting] = await records.pendingContinuingEducation(as(["owner"]));
    expect(waiting).toMatchObject({ technicianName: "Dana Ortiz", certificationName: "TDLR contractor", hours: "4", certificates: 1 });
    await expect(records.pendingContinuingEducation(as(["office_manager"]))).rejects.toBeInstanceOf(PermissionError);

    /** The certificate is the person's own, and the register reader's. Nobody else's. */
    expect((await records.ceCertificate(mine, { id: entry.id })).contentType).toBe("image/png");
    expect((await records.ceCertificate(owner(), { id: entry.id })).bytes.length).toBe(12);
    await expect(records.ceCertificate(as(["technician"], fixtureId("m24own:tech:sam")), { id: entry.id }))
      .rejects.toBeInstanceOf(PermissionError);

    await expect(records.approveContinuingEducation(as(["technician"], danaUser), { id: entry.id }))
      .rejects.toBeInstanceOf(PermissionError);
    const approved = await records.approveContinuingEducation(owner(), { id: entry.id });
    expect(approved.progress.find((p) => p.certificationTypeId === typeId)!.progress).toMatchObject({ logged: "6", remaining: "2" });
    expect(approved.entries.find((e) => e.id === entry.id)!.status).toBe("approved");
    expect(await records.pendingContinuingEducation(owner())).toEqual([]);
    /** Approving again changes nothing. */
    await records.approveContinuingEducation(owner(), { id: entry.id });
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where action = 'continuing_education.approved' and entity_id = ${dana}`;
    expect(audit!.n).toBe(1);
    await expect(records.declineContinuingEducation(owner(), { id: entry.id, reason: "Too late" })).rejects.toThrow(/already counted/);
  });

  it("can be declined with a reason the person reads, never counts, and cannot be approved afterwards", async () => {
    const logged = await me.logOwnContinuingEducation(as(["technician"], danaUser), {
      certificationTypeId: typeId, completedOn: inDays(-2), hours: "40", course: "Something long", certificate: certificate(2),
    });
    const entry = logged.entries.find((e) => e.course === "Something long")!;
    await expect(records.declineContinuingEducation(owner(), { id: entry.id, reason: "  " })).rejects.toThrow(/Say why/);
    const declined = await records.declineContinuingEducation(owner(), { id: entry.id, reason: "The certificate says 4 hours, not 40" });
    expect(declined.entries.find((e) => e.id === entry.id)).toMatchObject({
      status: "declined", declineReason: "The certificate says 4 hours, not 40",
    });
    expect(declined.progress.find((p) => p.certificationTypeId === typeId)!.progress).toMatchObject({ logged: "6" });
    await expect(records.approveContinuingEducation(owner(), { id: entry.id })).rejects.toThrow(/was declined/);
    const mine = await me.record(as(["technician"], danaUser));
    expect(mine.continuingEducation!.entries.find((e) => e.id === entry.id)!.declineReason).toMatch(/not 40/);
    await expect(me.withdrawOwnContinuingEducation(as(["technician"], danaUser), { id: entry.id })).rejects.toThrow(/already answered/);
  });

  it("can be taken back while it waits, and refuses what is not a course or is somebody else's", async () => {
    const mine = as(["technician"], danaUser);
    await expect(me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(3), hours: "1", course: "Next week",
    })).rejects.toThrow(/in the future/);
    await expect(me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-1), hours: "0", course: "Nothing",
    })).rejects.toThrow(/more than no hours/);
    await expect(me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-1), hours: "2", course: " ",
    })).rejects.toThrow(/Name the course/);
    await expect(me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-1), hours: "2", course: "Bad file",
      certificate: { fileName: "x.png", bytes: Buffer.from("not an image at all").toString("base64") },
    })).rejects.toThrow();
    /** An office manager who is not on the board has no certifications of their own. */
    await expect(me.logOwnContinuingEducation(as(["office_manager"]), {
      certificationTypeId: typeId, completedOn: inDays(-1), hours: "2", course: "Not mine",
    })).rejects.toThrow(/not on the board/);

    const logged = await me.logOwnContinuingEducation(mine, {
      certificationTypeId: typeId, completedOn: inDays(-1), hours: "1.5", course: "Taken back",
    });
    const entry = logged.entries.find((e) => e.course === "Taken back")!;
    await expect(me.withdrawOwnContinuingEducation(as(["technician"], fixtureId("m24own:tech:sam")), { id: entry.id }))
      .rejects.toThrow(/Course not found|not found/i);
    const after = await me.withdrawOwnContinuingEducation(mine, { id: entry.id });
    expect(after.entries.some((e) => e.id === entry.id)).toBe(false);
  });

  it("are the office's own entries approved as they are logged, so nothing already counted changes", async () => {
    const view = await records.logContinuingEducation(owner(), {
      technicianId: sam, certificationTypeId: typeId, completedOn: inDays(-1), hours: "3", course: "Logged by the office",
    });
    expect(view.entries[0]).toMatchObject({ status: "approved", selfLogged: false });
    const [row] = await raw<{ status: string }[]>`select status from public.continuing_education where technician_id = ${sam}`;
    expect(row!.status).toBe("approved");
  });
});
