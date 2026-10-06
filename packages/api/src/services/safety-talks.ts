import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, assertCan, can, field, safety as rules, taskRules, time, type Actor,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import { attach } from "./files";

/**
 * THE TALK LIBRARY, TALKS ON A SCHEDULE, AND WHO HAS NOT SIGNED
 *
 * Three things the toolbox talk did not have, on top of `safety.ts`, which
 * still holds the talk itself, the sign in sheet and the signature.
 *
 * A LIBRARY OF THE COMPANY'S OWN TOPICS: a title and the words to cover. It
 * starts empty, and nothing here writes safety content: what a crew is told is
 * the company's to decide and to answer for. A talk held from a topic copies
 * its title and words onto the talk, so a topic edited next year does not
 * change what this year's signed sheet says was covered.
 *
 * TALKS ON A SCHEDULE, per crew or per person, on the same schedules a
 * recurring task uses (core's `tasks` rules). The worker raises the talk on
 * its day in the company's zone, with the crew's members as they are that
 * day, and a unique index on (schedule, day) is what makes it once.
 *
 * SIGNED ON THE PHONE APP, through the field queue, as everything else the
 * phone does: the drawn signature is kept on the phone and sent as an upload,
 * and the operation that signs names it. The line signed is found from the
 * phone's technician, never from the request, as on `/my-day`.
 *
 * And the office sees who has not signed a talk that has been held and whose
 * sheet is still open.
 */

const uploader = (actor: Actor) => (actor.userId === SYSTEM_USER_ID ? null : actor.userId);

/* ---------------------------------------------------------------- topics */

export interface TopicView { id: string; title: string; body: string; retired: boolean; createdAt: string }

const topicView = (row: typeof schema.safetyTopic.$inferSelect): TopicView => ({
  id: row.id, title: row.title, body: row.body, retired: row.retiredAt !== null, createdAt: row.createdAt.toISOString(),
});

export async function listTopics(ctx: ServiceContext, input: { includeRetired?: boolean | undefined } = {}): Promise<TopicView[]> {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const rows = await tx.select().from(schema.safetyTopic)
      .where(input.includeRetired ? undefined : isNull(schema.safetyTopic.retiredAt))
      .orderBy(asc(schema.safetyTopic.title));
    return rows.map(topicView);
  });
}

function checkTopic(title: string, body: string): void {
  if (title.trim() === "") throw new ConflictError("Give the topic a title, like Ladder safety.");
  if (body.trim() === "") throw new ConflictError("Write what the talk covers. It is what each person signs to say they heard.");
}

export async function createTopic(ctx: ServiceContext, input: { title: string; body: string }): Promise<TopicView> {
  assertCan(ctx.actor, "safety:write");
  checkTopic(input.title, input.body);
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const seen = await replayed<TopicView>(tx, ctx, "safety_topic");
    if (seen) return seen;
    const [row] = await tx.insert(schema.safetyTopic).values({
      organizationId: ctx.actor.organizationId, title: input.title.trim(), body: input.body.trim(),
      createdByUserId: uploader(ctx.actor),
    }).returning();
    await audit(tx, ctx, "safety.topic_added", "safety_topic", row!.id, null, row);
    const view = topicView(row!);
    await remember(tx, ctx, "safety_topic", row!.id, view);
    return view;
  });
}

/**
 * Change a topic's words, or retire it. Talks already held keep the words
 * they were held with. A retired topic raises no more scheduled talks.
 */
export async function updateTopic(
  ctx: ServiceContext, input: { id: string; title?: string | undefined; body?: string | undefined; retired?: boolean | undefined },
): Promise<TopicView> {
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const [before] = await tx.select().from(schema.safetyTopic).where(eq(schema.safetyTopic.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Topic");
    const title = input.title ?? before.title;
    const body = input.body ?? before.body;
    checkTopic(title, body);
    const retiredAt = input.retired === undefined ? before.retiredAt
      : input.retired ? (before.retiredAt ?? new Date()) : null;
    const [after] = await tx.update(schema.safetyTopic).set({
      title: title.trim(), body: body.trim(), retiredAt, updatedAt: new Date(),
    }).where(eq(schema.safetyTopic.id, input.id)).returning();
    await audit(tx, ctx, input.retired === true ? "safety.topic_retired" : "safety.topic_changed", "safety_topic", input.id, before, after);
    return topicView(after!);
  });
}

/* ------------------------------------------------------------- schedules */

export interface ScheduleInput {
  topicId: string;
  crewId?: string | null | undefined;
  technicianId?: string | null | undefined;
  frequency: taskRules.TaskFrequency;
  weekday?: number | null | undefined;
  monthDay?: number | null | undefined;
  /** Minutes after the company's midnight. Seven in the morning when not said. */
  heldMinutes?: number | undefined;
  startsOn?: string | undefined;
  location?: string | null | undefined;
  ledBy?: string | null | undefined;
}

export interface ScheduleView {
  id: string;
  topicId: string;
  topicTitle: string;
  topicRetired: boolean;
  crewId: string | null;
  technicianId: string | null;
  /** The crew's name or the person's. */
  who: string;
  frequency: taskRules.TaskFrequency;
  weekday: number | null;
  monthDay: number | null;
  heldMinutes: number;
  startsOn: string;
  location: string | null;
  ledBy: string | null;
  active: boolean;
  lastRaisedOn: string | null;
  /** "Every Monday", from the same function the worker uses. */
  schedule: string;
  /** The next day it raises a talk for. Null when paused or its topic is retired. */
  nextOn: string | null;
}

async function scheduleViews(tx: Database, rows: Array<typeof schema.safetyTalkSchedule.$inferSelect>, today: string): Promise<ScheduleView[]> {
  if (rows.length === 0) return [];
  const topics = await tx.select().from(schema.safetyTopic)
    .where(inArray(schema.safetyTopic.id, [...new Set(rows.map((r) => r.topicId))]));
  const crewIds = rows.map((r) => r.crewId).filter((id): id is string => id !== null);
  const techIds = rows.map((r) => r.technicianId).filter((id): id is string => id !== null);
  const crews = crewIds.length === 0 ? [] : await tx.select({ id: schema.crew.id, name: schema.crew.name })
    .from(schema.crew).where(inArray(schema.crew.id, crewIds));
  const techs = techIds.length === 0 ? [] : await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician).where(inArray(schema.technician.id, techIds));
  return rows.map((row) => {
    const topic = topics.find((t) => t.id === row.topicId);
    const plan = { frequency: row.frequency, weekday: row.weekday, monthDay: row.monthDay, startsOn: row.startsOn };
    const raisedToday = row.lastRaisedOn !== null && row.lastRaisedOn >= today;
    const dueToday = taskRules.occurrenceOnOrBefore(plan, today) === today;
    const live = row.active && !topic?.retiredAt;
    return {
      id: row.id,
      topicId: row.topicId,
      topicTitle: topic?.title ?? "A topic that has gone",
      topicRetired: Boolean(topic?.retiredAt),
      crewId: row.crewId,
      technicianId: row.technicianId,
      who: row.crewId
        ? `${crews.find((c) => c.id === row.crewId)?.name ?? "A crew"} (crew)`
        : techs.find((t) => t.id === row.technicianId)?.name ?? "Somebody",
      frequency: row.frequency,
      weekday: row.weekday,
      monthDay: row.monthDay,
      heldMinutes: row.heldMinutes,
      startsOn: row.startsOn,
      location: row.location,
      ledBy: row.ledBy,
      active: row.active,
      lastRaisedOn: row.lastRaisedOn,
      schedule: taskRules.describeSchedule(plan),
      nextOn: !live ? null : dueToday && !raisedToday ? today : taskRules.occurrenceAfter(plan, today),
    };
  });
}

export async function listSchedules(ctx: ServiceContext): Promise<ScheduleView[]> {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const rows = await tx.select().from(schema.safetyTalkSchedule)
      .orderBy(desc(schema.safetyTalkSchedule.active), asc(schema.safetyTalkSchedule.createdAt));
    return scheduleViews(tx, rows, today);
  });
}

export async function createSchedule(ctx: ServiceContext, input: ScheduleInput): Promise<ScheduleView> {
  assertCan(ctx.actor, "safety:write");
  if (Boolean(input.crewId) === Boolean(input.technicianId)) {
    throw new ConflictError("A scheduled talk is for one crew or one person. Choose one of them.");
  }
  const held = input.heldMinutes ?? 7 * 60;
  if (!Number.isInteger(held) || held < 0 || held >= 24 * 60) throw new ConflictError("The time it is held has to be a time of day.");
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const seen = await replayed<ScheduleView>(tx, ctx, "safety_talk_schedule");
    if (seen) return seen;
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const startsOn = input.startsOn ?? today;
    const verdict = taskRules.checkSchedule({
      frequency: input.frequency, weekday: input.weekday ?? null, monthDay: input.monthDay ?? null, startsOn,
    });
    if (!verdict.ok) throw new ConflictError(verdict.message.replace("task", "talk"));

    const [topic] = await tx.select().from(schema.safetyTopic).where(eq(schema.safetyTopic.id, input.topicId)).limit(1);
    if (!topic) throw new NotFoundError("Topic");
    if (topic.retiredAt) throw new ConflictError(`"${topic.title}" is retired. Put it back in the library first.`);
    if (input.crewId) {
      const [crew] = await tx.select({ id: schema.crew.id }).from(schema.crew).where(eq(schema.crew.id, input.crewId)).limit(1);
      if (!crew) throw new NotFoundError("Crew");
    }
    if (input.technicianId) {
      const [tech] = await tx.select({ id: schema.technician.id }).from(schema.technician)
        .where(eq(schema.technician.id, input.technicianId)).limit(1);
      if (!tech) throw new NotFoundError("Technician");
    }

    const [row] = await tx.insert(schema.safetyTalkSchedule).values({
      organizationId: ctx.actor.organizationId,
      topicId: topic.id,
      crewId: input.crewId ?? null,
      technicianId: input.technicianId ?? null,
      frequency: input.frequency,
      weekday: taskRules.NEEDS_WEEKDAY.includes(input.frequency) ? input.weekday ?? null : null,
      monthDay: input.frequency === "monthly" ? input.monthDay ?? null : null,
      heldMinutes: held,
      startsOn,
      location: input.location?.trim() || null,
      ledBy: input.ledBy?.trim() || null,
      createdByUserId: uploader(ctx.actor),
    }).returning();
    await audit(tx, ctx, "safety.schedule_added", "safety_talk_schedule", row!.id, null, row);
    const [view] = await scheduleViews(tx, [row!], today);
    await remember(tx, ctx, "safety_talk_schedule", row!.id, view!);
    return view!;
  });
}

/** Pause or resume. A change of topic or people is a new schedule. */
export async function setScheduleActive(ctx: ServiceContext, input: { id: string; active: boolean }): Promise<ScheduleView> {
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const [before] = await tx.select().from(schema.safetyTalkSchedule)
      .where(eq(schema.safetyTalkSchedule.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Talk schedule");
    const [after] = await tx.update(schema.safetyTalkSchedule).set({ active: input.active, updatedAt: new Date() })
      .where(eq(schema.safetyTalkSchedule.id, input.id)).returning();
    await audit(tx, ctx, input.active ? "safety.schedule_resumed" : "safety.schedule_paused",
      "safety_talk_schedule", input.id, before, after);
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    return (await scheduleViews(tx, [after!], today))[0]!;
  });
}

/* ------------------------------------------------------------ the worker */

function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["safety:read", "safety:write"], agentId: "safety-talks",
  };
}

/** Who is on the sheet: the crew's members whose accounts are still active, or the one person. */
async function peopleFor(tx: Database, schedule: typeof schema.safetyTalkSchedule.$inferSelect) {
  const rows = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician)
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.membership.active, true),
      schedule.crewId
        ? inArray(schema.technician.id, tx.select({ id: schema.crewMember.technicianId }).from(schema.crewMember)
          .where(eq(schema.crewMember.crewId, schedule.crewId)))
        : eq(schema.technician.id, schedule.technicianId!),
    ))
    .orderBy(asc(schema.technician.displayName));
  return rows;
}

/**
 * Raise the talks this company's schedules owe today, each exactly once.
 *
 * The latest occurrence only, like a recurring task: a worker that was down
 * for a week does not come back and raise six sheets nobody will sign. A
 * schedule whose topic was retired raises nothing.
 */
export async function raiseTalksFor(db: Database, organizationId: string, now: Date = new Date()): Promise<string[]> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, organizationId);
    const today = time.dateIn(now, zone);
    const schedules = await tx.select().from(schema.safetyTalkSchedule).where(eq(schema.safetyTalkSchedule.active, true));
    const raised: string[] = [];
    for (const schedule of schedules) {
      const day = taskRules.occurrenceToRaise(
        { frequency: schedule.frequency, weekday: schedule.weekday, monthDay: schedule.monthDay, startsOn: schedule.startsOn },
        today, schedule.lastRaisedOn,
      );
      if (!day) continue;
      const [topic] = await tx.select().from(schema.safetyTopic).where(eq(schema.safetyTopic.id, schedule.topicId)).limit(1);
      if (!topic || topic.retiredAt) continue;

      const [made] = await tx.insert(schema.safetyMeeting).values({
        organizationId,
        topic: topic.title,
        notes: topic.body,
        heldAt: time.instantOfLocal(day, schedule.heldMinutes, zone),
        location: schedule.location,
        ledBy: schedule.ledBy,
        topicId: topic.id,
        scheduleId: schedule.id,
        occurrenceOn: day,
      }).onConflictDoNothing().returning();

      if (made) {
        const people = await peopleFor(tx, schedule);
        for (const person of people) {
          await tx.insert(schema.safetyMeetingAttendee).values({
            organizationId, meetingId: made.id, technicianId: person.id, name: person.name,
          }).onConflictDoNothing();
        }
        await audit(tx, ctx, "safety.talk_raised", "safety_meeting", made.id, null,
          { scheduleId: schedule.id, occurrenceOn: day, attendees: people.length });
        raised.push(made.id);
      }
      await tx.update(schema.safetyTalkSchedule).set({ lastRaisedOn: day, updatedAt: new Date() })
        .where(eq(schema.safetyTalkSchedule.id, schedule.id));
    }
    return raised;
  });
}

/** The worker's pass over every company with a talk schedule. One company's failure is its own. */
export async function talkPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<Array<{ organizationId: string; raised: string[]; error?: string }>> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.safety_talk_organizations(${options.limit ?? 200})`,
  );
  const results: Array<{ organizationId: string; raised: string[]; error?: string }> = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push({ organizationId: row.organization_id, raised: await raiseTalksFor(db, row.organization_id, options.now) });
    } catch (error) {
      results.push({ organizationId: row.organization_id, raised: [], error: (error as Error).message });
    }
  }
  return results;
}

/* ------------------------------------------------- who has not signed yet */

export interface UnsignedLine {
  meetingId: string;
  topic: string;
  heldAt: string;
  attendeeId: string;
  name: string;
  /** Linked to one of the company's people, who can sign on their own phone. */
  ownPerson: boolean;
}

/**
 * Every line not signed on a talk that has been held and whose sheet is still
 * open, the oldest talk first, because the oldest is the one somebody will
 * have forgotten. A closed sheet is finished whoever signed it.
 */
export async function unsigned(ctx: ServiceContext, now: Date = new Date()): Promise<UnsignedLine[]> {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const rows = await tx.select({ meeting: schema.safetyMeeting, attendee: schema.safetyMeetingAttendee })
      .from(schema.safetyMeetingAttendee)
      .innerJoin(schema.safetyMeeting, eq(schema.safetyMeeting.id, schema.safetyMeetingAttendee.meetingId))
      .where(and(
        isNull(schema.safetyMeetingAttendee.signedAt),
        isNull(schema.safetyMeeting.closedAt),
        lte(schema.safetyMeeting.heldAt, now),
      ))
      .orderBy(asc(schema.safetyMeeting.heldAt), asc(schema.safetyMeetingAttendee.name))
      .limit(500);
    return rows.map(({ meeting, attendee }) => ({
      meetingId: meeting.id, topic: meeting.topic, heldAt: meeting.heldAt.toISOString(),
      attendeeId: attendee.id, name: attendee.name, ownPerson: attendee.technicianId !== null,
    }));
  });
}

/* ------------------------------------------------------------- the phone */

export interface FieldTalk {
  meetingId: string;
  topic: string;
  notes: string | null;
  heldAt: string;
  location: string | null;
  ledBy: string | null;
  signedAt: string | null;
  /** Why it cannot be signed now, or null when it can. */
  cannotSign: string | null;
}

/**
 * The talks on this person's own day for the phone: the ones waiting for
 * their signature, and the last fortnight's signed ones. The person is the
 * one the phone is registered to. Their own lines and
 * nothing about anybody else's, as on `/my-day`.
 */
export async function talksForField(tx: Database, ctx: ServiceContext, technicianId: string | null): Promise<FieldTalk[]> {
  if (!technicianId || !can(ctx.actor, "field:sync")) return [];
  const rows = await tx.select({ meeting: schema.safetyMeeting, attendee: schema.safetyMeetingAttendee })
    .from(schema.safetyMeetingAttendee)
    .innerJoin(schema.safetyMeeting, eq(schema.safetyMeeting.id, schema.safetyMeetingAttendee.meetingId))
    .where(and(
      eq(schema.safetyMeetingAttendee.technicianId, technicianId),
      sql`(${schema.safetyMeetingAttendee.signedAt} is null or ${schema.safetyMeetingAttendee.signedAt} > now() - interval '14 days')`,
    ))
    .orderBy(desc(schema.safetyMeeting.heldAt)).limit(50);
  const now = new Date();
  return rows.map(({ meeting, attendee }) => ({
    meetingId: meeting.id,
    topic: meeting.topic,
    notes: meeting.notes,
    heldAt: meeting.heldAt.toISOString(),
    location: meeting.location,
    ledBy: meeting.ledBy,
    signedAt: attendee.signedAt?.toISOString() ?? null,
    cannotSign: attendee.signedAt ? null : rules.signingRefusal(meeting, attendee, now),
  }));
}

/** The technician a phone belongs to. */
async function deviceTechnician(tx: Database, deviceId: string): Promise<string | null> {
  const [device] = await tx.select({ technicianId: schema.device.technicianId }).from(schema.device)
    .where(eq(schema.device.id, deviceId)).limit(1);
  return device?.technicianId ?? null;
}

/**
 * A toolbox talk signed on the phone, from the queue.
 *
 * The signature came first, as an upload the phone recorded with
 * `signature.capture` for this talk, so its bytes may not have arrived yet:
 * the upload is pointed at this person's line on the sheet, and the bytes
 * become the line's signature when they land (or at once, when they already
 * have). Refused, in the sentence `/my-day` uses, before the talk was held,
 * after the sheet closed, or for somebody not on it; the upload is then
 * written off with that sentence, so nothing is attached to anything.
 */
export async function signOperation(tx: Database, ctx: ServiceContext, op: field.FieldOperation): Promise<string | null> {
  const meetingId = op.subjectId;
  const uploadId = typeof op.payload["signatureUploadId"] === "string" ? op.payload["signatureUploadId"] : null;
  if (!meetingId) return "That signature names no talk.";
  if (!uploadId) return "A toolbox talk is signed by drawing a signature. Sign it again.";
  const technicianId = await deviceTechnician(tx, op.deviceId);
  if (!technicianId) return "Only somebody who works in the field can sign a toolbox talk from the field.";

  const [upload] = await tx.select().from(schema.fieldUpload)
    .where(and(eq(schema.fieldUpload.clientId, uploadId), eq(schema.fieldUpload.subjectType, "talk_signature"))).limit(1);
  if (!upload || upload.subjectId !== meetingId) return "The signature for that talk did not reach the office. Sign it again.";

  const refuse = async (sentence: string) => {
    await tx.update(schema.fieldUpload).set({ status: "abandoned", lastError: sentence, updatedAt: new Date() })
      .where(eq(schema.fieldUpload.id, upload.id));
    return sentence;
  };

  const [meeting] = await tx.select().from(schema.safetyMeeting).where(eq(schema.safetyMeeting.id, meetingId)).limit(1);
  if (!meeting) return refuse("That toolbox talk is not here any more.");
  const [attendee] = await tx.select().from(schema.safetyMeetingAttendee)
    .where(and(
      eq(schema.safetyMeetingAttendee.meetingId, meetingId),
      eq(schema.safetyMeetingAttendee.technicianId, technicianId),
    )).for("update").limit(1);
  /** A replay finds it signed from the field, and that is a success. */
  if (attendee?.signedAt && attendee.signedVia === "field") return null;
  const refusal = rules.signingRefusal(meeting, attendee ?? null, op.occurredAt);
  if (refusal) return refuse(refusal);

  await tx.update(schema.fieldUpload).set({
    subjectType: "safety_meeting_attendee", subjectId: attendee!.id, updatedAt: new Date(),
  }).where(eq(schema.fieldUpload.id, upload.id));
  if (upload.status === "stored" && upload.storageKey) {
    await attach(tx, ctx.actor.organizationId, {
      entityType: "safety_meeting_attendee", entityId: attendee!.id, storageKey: upload.storageKey,
      kind: "signature", fileName: "signature.png", contentType: upload.contentType, sizeBytes: upload.byteSize ?? 0,
      uploadedByUserId: uploader(ctx.actor),
    });
  }
  await tx.update(schema.safetyMeetingAttendee).set({
    signedAt: op.occurredAt, signedVia: "field", signedByUserId: uploader(ctx.actor),
  }).where(eq(schema.safetyMeetingAttendee.id, attendee!.id));
  await audit(tx, ctx, "safety.signed", "safety_meeting", meetingId, null, {
    attendeeId: attendee!.id, name: attendee!.name, via: "field", app: true,
  });
  return null;
}

/* -------------------------------------------------------------- handlers */

export const handlers = {
  listSafetyTopics: async (ctx: ServiceContext, input: { includeRetired?: boolean | undefined }) =>
    ({ topics: await listTopics(ctx, input) }),
  createSafetyTopic: (ctx: ServiceContext, input: { title: string; body: string }) => createTopic(ctx, input),
  updateSafetyTopic: (
    ctx: ServiceContext,
    input: { id: string; title?: string | undefined; body?: string | undefined; retired?: boolean | undefined },
  ) => updateTopic(ctx, input),
  listSafetyTalkSchedules: async (ctx: ServiceContext) => ({ schedules: await listSchedules(ctx) }),
  createSafetyTalkSchedule: (ctx: ServiceContext, input: ScheduleInput) => createSchedule(ctx, input),
  setSafetyTalkScheduleActive: (ctx: ServiceContext, input: { id: string; active: boolean }) => setScheduleActive(ctx, input),
  listUnsignedSafetyLines: async (ctx: ServiceContext) => ({ lines: await unsigned(ctx) }),
} as const;
