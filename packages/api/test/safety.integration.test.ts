import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as safety from "../src/services/safety";
import * as tasks from "../src/services/tasks";
import { ConflictError, NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TOOLBOX TALKS AND INCIDENT REPORTS
 *
 * What the records must hold to be worth keeping, and who may touch them: a
 * technician signs their own line from the field and nobody else's, a sheet
 * closes and stays closed, an injury report says who was hurt, the office is
 * told about every report, a reporter sees their own reports and not the
 * register, and a report does not close while a follow up is open.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("safety:org");
const OWNER = fixtureId("safety:owner");
const TECH_USER = fixtureId("safety:tech-user");
const OTHER_USER = fixtureId("safety:other-user");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let raw: postgres.Sql;
let techId = "";
let otherTechId = "";
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const tech = (): ServiceContext => ({
  actor: { userId: TECH_USER, organizationId: ORG, roles: ["technician"], technicianId: techId }, db: db(),
});
const otherTech = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: ORG, roles: ["technician"], technicianId: otherTechId }, db: db(),
});

async function person(userId: string, email: string, name: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email) values (${userId}, ${email})`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Safety Co", slug: "safety-co" });
  techId = await person(TECH_USER, "safety-tech@test.local", "Tess Tech");
  otherTechId = await person(OTHER_USER, "safety-other@test.local", "Otto Other");
});

afterAll(async () => {
  if (raw) await raw.end();
});

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();

run("toolbox talks", () => {
  it("records a talk with the company's own people and a visitor, and a technician signs their own line from the field", async () => {
    const { id } = await safety.createMeeting(owner(), {
      topic: "Ladder safety", notes: "Three points of contact.", heldAt: yesterday(), location: "The shop",
      ledBy: "Sam Supplier", attendees: [{ technicianId: techId }, { technicianId: otherTechId }, { name: "Val Visitor" }],
    });
    const mine = await safety.mine(tech());
    expect(mine.find((m) => m.meetingId === id)).toMatchObject({ topic: "Ladder safety", signedAt: null, cannotSign: null });

    const signed = await safety.sign(tech(), { id, signature: PNG });
    expect(signed.signedAt).toBeTruthy();
    // A retry after it worked answers with the same time.
    expect((await safety.sign(tech(), { id, signature: PNG })).signedAt).toBe(signed.signedAt);

    const meeting = await safety.getMeeting(owner(), { id });
    expect(meeting.signed).toBe(1);
    const tess = meeting.attendees.find((a) => a.technicianId === techId)!;
    expect(tess).toMatchObject({ name: "Tess Tech", signedVia: "field", hasSignature: true });
    const [attachment] = await raw<{ kind: string }[]>`
      select kind from public.attachment where entity_type = 'safety_meeting_attendee' and entity_id = ${tess.id}`;
    expect(attachment!.kind).toBe("signature");
  });

  it("will not let somebody sign a talk they are not on, or one not held yet", async () => {
    const notOn = await safety.createMeeting(owner(), { topic: "Heat", heldAt: yesterday(), attendees: [{ technicianId: otherTechId }] });
    await expect(safety.sign(tech(), { id: notOn.id, signature: PNG })).rejects.toThrow(/not on the list/);
    const later = await safety.createMeeting(owner(), {
      topic: "Next week", heldAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), attendees: [{ technicianId: techId }],
    });
    await expect(safety.sign(tech(), { id: later.id, signature: PNG })).rejects.toThrow(/not happened yet/);
  });

  it("closes the sheet, after which nobody signs and nobody is added", async () => {
    const { id } = await safety.createMeeting(owner(), { topic: "Trenching", heldAt: yesterday(), attendees: [{ technicianId: techId }] });
    await safety.closeMeeting(owner(), { id });
    await expect(safety.sign(tech(), { id, signature: PNG })).rejects.toThrow(/closed/);
    await expect(safety.addAttendees(owner(), { id, attendees: [{ name: "Late Larry" }] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses the same technician twice on one sheet, in words", async () => {
    const { id } = await safety.createMeeting(owner(), { topic: "PPE", heldAt: yesterday(), attendees: [{ technicianId: techId }] });
    await expect(safety.addAttendees(owner(), { id, attendees: [{ technicianId: techId }] }))
      .rejects.toThrow(/Tess Tech is already on the list/);
  });

  it("marks a paper signature as recorded in the office, never as given in the field", async () => {
    const { id } = await safety.createMeeting(owner(), { topic: "Lockout", heldAt: yesterday(), attendees: [{ name: "Val Visitor" }] });
    const meeting = await safety.getMeeting(owner(), { id });
    await safety.markSigned(owner(), { id, attendeeId: meeting.attendees[0]!.id });
    expect((await safety.getMeeting(owner(), { id })).attendees[0]).toMatchObject({ signedVia: "office", hasSignature: false });
  });

  it("is a replay, not a second talk, on a retry with the same key", async () => {
    const a = await safety.createMeeting(owner("talk-key-1"), { topic: "Replay", heldAt: yesterday() });
    const b = await safety.createMeeting(owner("talk-key-1"), { topic: "Replay", heldAt: yesterday() });
    expect(b.id).toBe(a.id);
  });

  it("keeps the register from a technician", async () => {
    await expect(safety.listMeetings(tech())).rejects.toBeInstanceOf(PermissionError);
  });
});

run("incident reports", () => {
  it("takes a report from a technician, with people and a photograph, and tells the office", async () => {
    const { id } = await safety.report(tech(), {
      kind: "injury", occurredAt: yesterday(), location: "12 Elm St, the attic",
      description: "Cut my hand on a duct edge.", immediateAction: "First aid kit from the van.",
      people: [{ technicianId: techId, role: "injured", injury: "Cut to the left palm" }, { name: "Homeowner", role: "witness" }],
      photos: [{ fileName: "duct.png", bytes: PNG }],
    });
    const report = await safety.getIncident(owner(), { id });
    expect(report.people.map((p) => p.name)).toEqual(["Tess Tech", "Homeowner"]);
    expect(report.photos).toHaveLength(1);
    expect(report.followUps).toHaveLength(1);
    expect(report.followUps[0]!.title).toMatch(/Review the incident report/);
    const [task] = await raw<{ priority: string; queue: string }[]>`
      select priority, queue from public.task where id = ${report.followUps[0]!.id}`;
    expect(task).toMatchObject({ priority: "urgent", queue: "safety" });
  });

  it("refuses an injury report that does not say who was hurt", async () => {
    await expect(safety.report(tech(), {
      kind: "injury", occurredAt: yesterday(), description: "Somebody hurt", people: [{ name: "Bob", role: "witness" }],
    })).rejects.toBeInstanceOf(UnprocessableError);
  });

  it("shows a reporter their own reports and nobody else's", async () => {
    const mine = await safety.report(tech(), { kind: "near_miss", occurredAt: yesterday(), description: "Ladder slipped, nobody hurt." });
    const theirs = await safety.report(otherTech(), { kind: "vehicle", occurredAt: yesterday(), description: "Backed into a post." });
    const listed = await safety.listIncidents(tech());
    expect(listed.some((i) => i.id === mine.id)).toBe(true);
    expect(listed.some((i) => i.id === theirs.id)).toBe(false);
    await expect(safety.getIncident(tech(), { id: theirs.id })).rejects.toBeInstanceOf(NotFoundError);
    const register = await safety.listIncidents(owner());
    expect(register.some((i) => i.id === theirs.id)).toBe(true);
  });

  it("adds follow ups as tasks, and will not close while one is open", async () => {
    const { id } = await safety.report(tech(), { kind: "property_damage", occurredAt: yesterday(), description: "Scratched a floor." });
    const { taskId } = await safety.addFollowUp(owner(), { id, title: "Buy floor protection runners" });
    await expect(safety.closeIncident(owner(), { id, closingNote: "Runners now on every van." }))
      .rejects.toThrow(/still open/);

    for (const followUp of (await safety.getIncident(owner(), { id })).followUps) {
      await tasks.close(owner(), { id: followUp.id, outcome: "done" });
    }
    expect(taskId).toBeTruthy();
    const closed = await safety.closeIncident(owner(), { id, closingNote: "Runners now on every van." });
    expect(closed.closedAt).toBeTruthy();
    await expect(safety.addFollowUp(owner(), { id, title: "Too late" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not let a technician follow up or close a report", async () => {
    const { id } = await safety.report(tech(), { kind: "other", occurredAt: yesterday(), description: "Something odd." });
    await expect(safety.addFollowUp(tech(), { id, title: "x" })).rejects.toBeInstanceOf(PermissionError);
    await expect(safety.closeIncident(tech(), { id, closingNote: "x" })).rejects.toBeInstanceOf(PermissionError);
  });
});
