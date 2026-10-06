import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { createHash, randomUUID as uuid } from "node:crypto";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as talks from "../src/services/safety-talks";
import * as safety from "../src/services/safety";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import * as files from "../src/services/files";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TOOLBOX TALKS: THE LIBRARY, THE SCHEDULE, THE PHONE AND WHO HAS NOT SIGNED
 *
 * The library holds only the company's own topics. A schedule raises a talk
 * for a crew, with its members on the sheet, once a day whatever the worker
 * does. A technician signs from the phone through the field queue: the
 * drawn signature first, as an upload, then the operation that signs; a
 * sheet closed while the phone was offline refuses it in words, and the
 * upload is attached to nothing. The office sees who has not signed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("talks:org");
const OWNER = fixtureId("talks:owner");
const RAY = fixtureId("talks:ray");
const DANA = fixtureId("talks:dana");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], technicianId?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...(technicianId ? { technicianId } : {}) }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let rayTech = "";
let danaTech = "";
let crewId = "";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b3f5d90000000049454e44ae426082", "hex");

async function person(userId: string, email: string, name: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Talks Co", slug: "talks-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  rayTech = await person(RAY, "ray@talks.test", "Ray Ortiz");
  danaTech = await person(DANA, "dana@talks.test", "Dana Lee");
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Roof crew') returning id`;
  crewId = crew!.id;
  await raw`insert into public.crew_member (organization_id, crew_id, technician_id, is_lead)
    values (${ORG}, ${crewId}, ${rayTech}, true), (${ORG}, ${crewId}, ${danaTech}, false)`;
});

run("the library", () => {
  it("starts empty, holds the company's own words, and retires rather than deletes", async () => {
    expect(await talks.listTopics(owner())).toEqual([]);
    const topic = await talks.createTopic(owner(), { title: "Ladder safety", body: "Three points of contact." });
    expect(topic).toMatchObject({ title: "Ladder safety", retired: false });
    await talks.updateTopic(owner(), { id: topic.id, retired: true });
    expect(await talks.listTopics(owner())).toEqual([]);
    expect(await talks.listTopics(owner(), { includeRetired: true })).toHaveLength(1);
  });

  it("refuses a topic with no words, and anybody who does not run safety", async () => {
    await expect(talks.createTopic(owner(), { title: "Heat", body: " " })).rejects.toThrow(ConflictError);
    await expect(talks.createTopic(as(RAY, ["technician"]), { title: "Heat", body: "Water." })).rejects.toThrow(PermissionError);
  });
});

run("talks on a schedule", () => {
  it("refuses a schedule for a crew and a person at once, and one from a retired topic", async () => {
    const topic = await talks.createTopic(owner(), { title: "Trenching", body: "Shore it." });
    await expect(talks.createSchedule(owner(), { topicId: topic.id, crewId, technicianId: rayTech, frequency: "daily" }))
      .rejects.toThrow(/one crew or one person/);
    await talks.updateTopic(owner(), { id: topic.id, retired: true });
    await expect(talks.createSchedule(owner(), { topicId: topic.id, crewId, frequency: "daily" })).rejects.toThrow(/retired/);
  });

  it("raises the talk on its day with the crew on the sheet, once, at the time held", async () => {
    const topic = await talks.createTopic(owner(), { title: "Fall protection", body: "Harness on above six feet." });
    const schedule = await talks.createSchedule(owner(), {
      topicId: topic.id, crewId, frequency: "weekly", weekday: 1, heldMinutes: 7 * 60, startsOn: "2026-01-01", location: "The yard",
    });
    expect(schedule).toMatchObject({ who: "Roof crew (crew)", schedule: "Every Monday" });

    // Monday 5 October 2026, six in the morning in Chicago.
    const monday = new Date("2026-10-05T11:00:00Z");
    const first = await talks.raiseTalksFor(db(), ORG, monday);
    const again = await talks.raiseTalksFor(db(), ORG, monday);
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);

    const meeting = await safety.getMeeting(owner(), { id: first[0]! });
    expect(meeting).toMatchObject({ topic: "Fall protection", notes: "Harness on above six feet.", location: "The yard" });
    expect(meeting.heldAt).toBe("2026-10-05T12:00:00.000Z");
    expect(meeting.attendees.map((a) => a.name)).toEqual(["Dana Lee", "Ray Ortiz"]);

    // Editing the topic later does not change the sheet already raised.
    await talks.updateTopic(owner(), { id: topic.id, body: "Something else." });
    expect((await safety.getMeeting(owner(), { id: first[0]! })).notes).toBe("Harness on above six feet.");
  });

  it("raises nothing while paused or once its topic is retired", async () => {
    const topic = await talks.createTopic(owner(), { title: "Heat", body: "Water, rest, shade." });
    const schedule = await talks.createSchedule(owner(), { topicId: topic.id, technicianId: rayTech, frequency: "daily", startsOn: "2026-01-01" });
    await talks.setScheduleActive(owner(), { id: schedule.id, active: false });
    expect(await talks.raiseTalksFor(db(), ORG, new Date("2026-10-05T15:00:00Z"))).toEqual([]);
    await talks.setScheduleActive(owner(), { id: schedule.id, active: true });
    await talks.updateTopic(owner(), { id: topic.id, retired: true });
    expect(await talks.raiseTalksFor(db(), ORG, new Date("2026-10-06T15:00:00Z"))).toEqual([]);
    expect((await talks.listSchedules(owner()))[0]).toMatchObject({ topicRetired: true, nextOn: null });
  });
});

run("signing on the phone, and who has not", () => {
  async function talkHeldAnHourAgo(): Promise<string> {
    const { id } = await safety.createMeeting(owner(), {
      topic: "Ladder safety", heldAt: new Date(Date.now() - 3_600_000).toISOString(),
      attendees: [{ technicianId: rayTech }, { technicianId: danaTech }, { name: "A supplier's rep" }],
    });
    return id;
  }

  /** The two operations the phone sends: the signature as an upload for the talk, then the signing naming it. */
  async function signFromPhone(meetingId: string) {
    const ray = as(RAY, ["technician"]);
    const device = await fieldOps.register(ray, { installationId: `talk-${uuid()}` });
    const uploadId = uuid();
    const result = await fieldOps.sync(ray, {
      deviceId: device.deviceId,
      operations: [
        {
          clientId: uuid(), sequence: 1, kind: "signature.capture", subjectId: meetingId, occurredAt: new Date().toISOString(),
          payload: { uploadId, contentType: "image/png", byteSize: PNG.length, contentHash: createHash("sha256").update(PNG).digest("hex"), for: "safety_meeting" },
        },
        {
          clientId: uuid(), sequence: 2, kind: "safety.sign", subjectId: meetingId, occurredAt: new Date().toISOString(),
          payload: { signatureUploadId: uploadId },
        },
      ],
    });
    return { result, uploadId, device: device.deviceId, ray };
  }

  it("sends the talks on the person's own sheet with their day, and only theirs", async () => {
    const meetingId = await talkHeldAnHourAgo();
    const ray = as(RAY, ["technician"]);
    const device = await fieldOps.register(ray, { installationId: `day-${uuid()}` });
    const day = await dispatch.snapshot(ray, { deviceId: device.deviceId, from: "2026-10-05", days: 1 });
    expect(day.talks).toEqual([expect.objectContaining({ meetingId, topic: "Ladder safety", signedAt: null, cannotSign: null })]);
  });

  it("signs the person's own line, and the signature lands on the line when its bytes arrive", async () => {
    const meetingId = await talkHeldAnHourAgo();
    const { result, uploadId, ray } = await signFromPhone(meetingId);
    expect(result.results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const sheet = await safety.getMeeting(owner(), { id: meetingId });
    expect(sheet.attendees.find((a) => a.name === "Ray Ortiz")).toMatchObject({ signedVia: "field", hasSignature: true });
    expect(sheet.attendees.find((a) => a.name === "Dana Lee")!.signedAt).toBeNull();

    const stored = await files.storeUpload(ray, { clientId: uploadId, bytes: new Uint8Array(PNG) });
    expect(stored.stored).toBe(true);
    const line = sheet.attendees.find((a) => a.name === "Ray Ortiz")!;
    const [signature] = await raw<{ kind: string }[]>`select kind from public.attachment
      where entity_type = 'safety_meeting_attendee' and entity_id = ${line.id} and deleted_at is null`;
    expect(signature).toMatchObject({ kind: "signature" });

    const waiting = await talks.unsigned(owner());
    expect(waiting.map((l) => l.name)).toEqual(["A supplier's rep", "Dana Lee"]);
    expect(waiting.find((l) => l.name === "A supplier's rep")).toMatchObject({ ownPerson: false });
  });

  it("refuses a signature on a sheet the office closed while the phone was offline, and attaches it to nothing", async () => {
    const meetingId = await talkHeldAnHourAgo();
    await safety.closeMeeting(owner(), { id: meetingId });
    const { result, uploadId, ray, device } = await signFromPhone(meetingId);
    expect(result.results[1]).toMatchObject({ status: "rejected", rejection: expect.stringMatching(/closed/) });

    const [upload] = await raw<{ status: string; last_error: string }[]>`
      select status, last_error from public.field_upload where organization_id = ${ORG} and client_id = ${uploadId}`;
    expect(upload).toMatchObject({ status: "abandoned", last_error: expect.stringMatching(/closed/) });
    // The phone is no longer owed the bytes, and nothing is attached.
    const owed = await files.pendingFor(ray, device);
    expect(owed.map((o) => o.clientId)).not.toContain(uploadId);
    const attached = await raw`select 1 from public.attachment where organization_id = ${ORG} and entity_type in ('safety_meeting_attendee', 'visit', 'talk_signature')`;
    expect(attached).toHaveLength(0);
    // A closed sheet is finished whoever signed it, so nobody is chased for it.
    expect(await talks.unsigned(owner())).toEqual([]);
  });

  it("refuses somebody not on the sheet", async () => {
    const { id } = await safety.createMeeting(owner(), {
      topic: "Heat", heldAt: new Date(Date.now() - 3_600_000).toISOString(), attendees: [{ technicianId: danaTech }],
    });
    const { result } = await signFromPhone(id);
    expect(result.results[1]).toMatchObject({ status: "rejected", rejection: expect.stringMatching(/not on the list/) });
  });

  it("lets only somebody who reads the register see who has not signed", async () => {
    await expect(talks.unsigned(as(RAY, ["technician"]))).rejects.toThrow(PermissionError);
  });
});
