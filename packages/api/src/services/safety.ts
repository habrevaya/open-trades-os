import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, isSystem, safety as rules, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, UnprocessableError,
  type ServiceContext,
} from "./context";
import { attach, decode, put } from "./files";

/**
 * TOOLBOX TALKS AND INCIDENT REPORTS
 *
 * M23 was named for documents, compliance and safety and held the first two.
 * This is the third: the two safety records a trades company is asked for
 * after something goes wrong, by an insurer, an inspector or a lawyer.
 *
 * A TOOLBOX TALK is a topic, a time, who led it and who was there, and each
 * person's own signature, given on their own phone, usually the next morning.
 * The sheet is closed by the office once everybody has signed, and a closed
 * sheet takes no more names: a sign in sheet that keeps growing for a month
 * proves nothing about who was in the room.
 *
 * AN INCIDENT REPORT is what happened, in the words of whoever reported it,
 * who was there and how, where, the photographs, and what was done about it
 * afterwards, as tasks in the office queue so the follow up is tracked by the
 * same queue as everything else rather than by a field on a form nobody
 * opens. It closes when somebody says what was learned, and not while a
 * follow up is still open.
 *
 * WHO MAY DO WHAT. Reading the register is `safety:read`, running talks and
 * following up is `safety:write`. Reporting is `safety:report`, held by almost
 * everybody, and a reporter who cannot read the register still sees their own
 * reports: a form that takes a report and then refuses to show it back is a
 * form that teaches people not to use it.
 */

/* --------------------------------------------------------------- helpers */

async function replayed(tx: Database, ctx: ServiceContext, eventType: string): Promise<string | null> {
  if (!ctx.idempotencyKey) return null;
  const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.eventType, eventType),
    )).limit(1);
  return seen?.entityId ?? null;
}

async function remember(
  tx: Database, ctx: ServiceContext, eventType: string, entityType: string, entityId: string,
): Promise<void> {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    direction: "inbound", provider: "api", eventType,
    idempotencyKey: ctx.idempotencyKey, status: "succeeded",
    entityType, entityId,
  });
}

/** The person behind an action, or null for the system, which is not a row in `user`. */
const uploader = (actor: Actor) => (isSystem(actor) ? null : actor.userId);

export interface Photo { fileName: string; contentType?: string | undefined; bytes: string }

/** Keep a photograph and point a safety record at it, in the caller's transaction. */
async function keepPhoto(
  tx: Database, ctx: ServiceContext, entityType: "safety_meeting" | "incident_report", entityId: string, photo: Photo,
): Promise<string> {
  const { file } = await put(tx, ctx.actor.organizationId, {
    bytes: decode(photo.bytes), claimedType: photo.contentType, uploadedByUserId: uploader(ctx.actor),
  });
  const [already] = await tx.select({ id: schema.attachment.id }).from(schema.attachment)
    .where(and(
      eq(schema.attachment.entityType, entityType),
      eq(schema.attachment.entityId, entityId),
      eq(schema.attachment.storageKey, file.storageKey),
      isNull(schema.attachment.deletedAt),
    )).limit(1);
  if (already) return already.id;
  const { id } = await attach(tx, ctx.actor.organizationId, {
    entityType, entityId, storageKey: file.storageKey,
    kind: file.contentType.startsWith("image/") ? "photo" : "document",
    fileName: photo.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes,
    uploadedByUserId: uploader(ctx.actor),
  });
  await audit(tx, ctx, "attachment.uploaded", "attachment", id, null, {
    entityType, entityId, storageKey: file.storageKey, fileName: photo.fileName,
  });
  return id;
}

async function photosOf(tx: Database, entityType: string, entityId: string) {
  const rows = await tx.select().from(schema.attachment)
    .where(and(
      eq(schema.attachment.entityType, entityType),
      eq(schema.attachment.entityId, entityId),
      isNull(schema.attachment.deletedAt),
    )).orderBy(asc(schema.attachment.createdAt));
  return rows.map((row) => ({
    id: row.id, kind: row.kind, storageKey: row.storageKey, fileName: row.fileName,
    contentType: row.contentType, createdAt: row.createdAt.toISOString(),
  }));
}

/** Technicians named on a list must be this company's, and the names are taken from their rows. */
async function technicianNames(tx: Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician).where(inArray(schema.technician.id, ids));
  const found = new Map(rows.map((row) => [row.id, row.name]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new NotFoundError("Technician");
  return found;
}

/* ---------------------------------------------------------- toolbox talks */

export interface AttendeeInput { technicianId?: string | undefined; name?: string | undefined }

export interface MeetingInput {
  topic: string;
  notes?: string | undefined;
  heldAt: string;
  location?: string | undefined;
  jobId?: string | undefined;
  ledBy?: string | undefined;
  attendees?: AttendeeInput[] | undefined;
}

function cleanAttendees(input: AttendeeInput[]): Array<{ technicianId: string | null; name: string | null }> {
  return input.map((a, index) => {
    const name = a.name?.trim() || null;
    if (!a.technicianId && !name) {
      throw new UnprocessableError("Each person on the list needs a name.", [
        { path: `attendees.${index}`, message: "Name somebody, or pick one of your people." },
      ]);
    }
    return { technicianId: a.technicianId ?? null, name };
  });
}

async function addPeople(
  tx: Database, ctx: ServiceContext, meetingId: string, people: Array<{ technicianId: string | null; name: string | null }>,
): Promise<number> {
  const techIds = [...new Set(people.map((p) => p.technicianId).filter((id): id is string => id !== null))];
  const names = await technicianNames(tx, techIds);
  const existing = await tx.select({ technicianId: schema.safetyMeetingAttendee.technicianId })
    .from(schema.safetyMeetingAttendee).where(eq(schema.safetyMeetingAttendee.meetingId, meetingId));
  const onList = new Set(existing.map((row) => row.technicianId).filter(Boolean));
  const dupes = techIds.filter((id) => onList.has(id));
  if (dupes.length > 0) {
    throw new ConflictError(`${dupes.map((id) => names.get(id)).join(", ")} is already on the list for this talk.`);
  }
  const seen = new Set<string>();
  let added = 0;
  for (const person of people) {
    if (person.technicianId) {
      if (seen.has(person.technicianId)) continue;
      seen.add(person.technicianId);
    }
    await tx.insert(schema.safetyMeetingAttendee).values({
      organizationId: ctx.actor.organizationId,
      meetingId,
      technicianId: person.technicianId,
      name: person.name ?? names.get(person.technicianId!)!,
    });
    added += 1;
  }
  return added;
}

export async function createMeeting(ctx: ServiceContext, input: MeetingInput) {
  const topic = input.topic.trim();
  if (topic === "") throw new UnprocessableError("Say what the talk was about.", [{ path: "topic", message: "Required." }]);
  const heldAt = new Date(input.heldAt);
  if (Number.isNaN(heldAt.getTime())) {
    throw new UnprocessableError("That is not a time.", [{ path: "heldAt", message: "Not a date and time." }]);
  }
  const people = cleanAttendees(input.attendees ?? []);

  return guardedWrite(ctx, "safety:write", async (tx) => {
    const prior = await replayed(tx, ctx, "safety.meeting_created");
    if (prior) return { id: prior };

    const [row] = await tx.insert(schema.safetyMeeting).values({
      organizationId: ctx.actor.organizationId,
      topic,
      notes: input.notes?.trim() || null,
      heldAt,
      location: input.location?.trim() || null,
      jobId: input.jobId ?? null,
      ledBy: input.ledBy?.trim() || null,
      createdByUserId: uploader(ctx.actor),
    }).returning();
    await addPeople(tx, ctx, row!.id, people);
    await remember(tx, ctx, "safety.meeting_created", "safety_meeting", row!.id);
    await audit(tx, ctx, "safety.meeting_created", "safety_meeting", row!.id, null, row);
    return { id: row!.id };
  });
}

export async function addAttendees(ctx: ServiceContext, input: { id: string; attendees: AttendeeInput[] }) {
  const people = cleanAttendees(input.attendees);
  return guardedWrite(ctx, "safety:write", async (tx) => {
    /** A retry after a lost response would otherwise be refused as already on the list. */
    if (await replayed(tx, ctx, "safety.attendees_added")) return { added: 0 };
    const meeting = await loadMeeting(tx, input.id);
    if (meeting.closedAt) throw new ConflictError("This sign in sheet has been closed, so nobody can be added.");
    const added = await addPeople(tx, ctx, input.id, people);
    await remember(tx, ctx, "safety.attendees_added", "safety_meeting", input.id);
    await audit(tx, ctx, "safety.attendees_added", "safety_meeting", input.id, null, { attendees: people });
    return { added };
  });
}

async function loadMeeting(tx: Database, id: string) {
  const [meeting] = await tx.select().from(schema.safetyMeeting).where(eq(schema.safetyMeeting.id, id)).limit(1);
  if (!meeting) throw new NotFoundError("Toolbox talk");
  return meeting;
}

function meetingView(
  meeting: typeof schema.safetyMeeting.$inferSelect,
  attendees: Array<typeof schema.safetyMeetingAttendee.$inferSelect>,
) {
  return {
    id: meeting.id,
    topic: meeting.topic,
    notes: meeting.notes,
    heldAt: meeting.heldAt.toISOString(),
    location: meeting.location,
    jobId: meeting.jobId,
    ledBy: meeting.ledBy,
    closedAt: meeting.closedAt?.toISOString() ?? null,
    attendees: attendees.map((a) => ({
      id: a.id,
      technicianId: a.technicianId,
      name: a.name,
      signedAt: a.signedAt?.toISOString() ?? null,
      signedVia: a.signedVia,
      hasSignature: a.signatureStorageKey !== null,
    })),
    signed: attendees.filter((a) => a.signedAt !== null).length,
  };
}

export async function listMeetings(ctx: ServiceContext, input: { limit?: number | undefined } = {}) {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const meetings = await tx.select().from(schema.safetyMeeting)
      .orderBy(desc(schema.safetyMeeting.heldAt)).limit(input.limit ?? 100);
    if (meetings.length === 0) return [];
    const attendees = await tx.select().from(schema.safetyMeetingAttendee)
      .where(inArray(schema.safetyMeetingAttendee.meetingId, meetings.map((m) => m.id)))
      .orderBy(asc(schema.safetyMeetingAttendee.name));
    return meetings.map((meeting) =>
      meetingView(meeting, attendees.filter((a) => a.meetingId === meeting.id)));
  });
}

export async function getMeeting(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const meeting = await loadMeeting(tx, input.id);
    const attendees = await tx.select().from(schema.safetyMeetingAttendee)
      .where(eq(schema.safetyMeetingAttendee.meetingId, input.id))
      .orderBy(asc(schema.safetyMeetingAttendee.name));
    return { ...meetingView(meeting, attendees), photos: await photosOf(tx, "safety_meeting", input.id) };
  });
}

/**
 * The talks a technician is on, for their own day: the ones waiting for their
 * signature first, then the last few they signed.
 *
 * `field:sync` rather than `safety:read`, because this is their own line on
 * each sheet and nothing about anybody else's: who else was there, and
 * whether they signed, is the register, and the register is not theirs.
 */
export async function mine(ctx: ServiceContext) {
  assertCan(ctx.actor, "field:sync");
  const technicianId = ctx.actor.technicianId;
  if (!technicianId) return [];
  return inTenant(ctx, async (tx) => {
    const rows = await tx.select({ meeting: schema.safetyMeeting, attendee: schema.safetyMeetingAttendee })
      .from(schema.safetyMeetingAttendee)
      .innerJoin(schema.safetyMeeting, eq(schema.safetyMeeting.id, schema.safetyMeetingAttendee.meetingId))
      .where(and(
        eq(schema.safetyMeetingAttendee.technicianId, technicianId),
        or(isNull(schema.safetyMeetingAttendee.signedAt),
          sql`${schema.safetyMeetingAttendee.signedAt} > now() - interval '14 days'`),
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
      /** Why it cannot be signed right now, or null when it can. */
      cannotSign: attendee.signedAt ? null : rules.signingRefusal(meeting, attendee, now),
    }));
  });
}

/**
 * A technician signs, from their own phone, for themselves.
 *
 * The line on the sheet is found from who is signed in, never from an id in
 * the request: a signature is a statement by the person holding the phone,
 * and letting the request say whose line it was would let anybody sign for
 * anybody.
 */
export async function sign(ctx: ServiceContext, input: { id: string; signature: string }) {
  assertCan(ctx.actor, "field:sync");
  const technicianId = ctx.actor.technicianId;
  if (!technicianId) throw new ConflictError("Only somebody who works in the field can sign a toolbox talk from the field.");
  const bytes = decode(input.signature);
  if (bytes.length > rules.MAX_SIGNATURE_BYTES) {
    throw new ConflictError("That signature is far larger than a drawn one. Draw it again.");
  }
  return inTenant(ctx, async (tx) => {
    const meeting = await loadMeeting(tx, input.id);
    const [attendee] = await tx.select().from(schema.safetyMeetingAttendee)
      .where(and(
        eq(schema.safetyMeetingAttendee.meetingId, input.id),
        eq(schema.safetyMeetingAttendee.technicianId, technicianId),
      )).for("update").limit(1);
    /** A retry after a lost response finds it signed, and that is a success. */
    if (attendee?.signedAt && attendee.signedVia === "field") {
      return { signedAt: attendee.signedAt.toISOString() };
    }
    const refusal = rules.signingRefusal(meeting, attendee ?? null, new Date());
    if (refusal) throw new ConflictError(refusal);

    const { file } = await put(tx, ctx.actor.organizationId, {
      bytes, claimedType: "image/png", uploadedByUserId: uploader(ctx.actor),
    });
    if (!file.contentType.startsWith("image/")) throw new ConflictError("A signature has to be a picture.");
    await attach(tx, ctx.actor.organizationId, {
      entityType: "safety_meeting_attendee", entityId: attendee!.id, storageKey: file.storageKey,
      kind: "signature", fileName: "signature.png", contentType: file.contentType, sizeBytes: file.sizeBytes,
      uploadedByUserId: uploader(ctx.actor),
    });
    const now = new Date();
    await tx.update(schema.safetyMeetingAttendee).set({
      signedAt: now, signatureStorageKey: file.storageKey, signedVia: "field", signedByUserId: uploader(ctx.actor),
    }).where(eq(schema.safetyMeetingAttendee.id, attendee!.id));
    await audit(tx, ctx, "safety.signed", "safety_meeting", input.id, null, {
      attendeeId: attendee!.id, name: attendee!.name, via: "field",
    });
    return { signedAt: now.toISOString() };
  });
}

/**
 * The office marks somebody as signed on the paper sheet. Says `office` on
 * the line, so nobody later mistakes it for a signature the person gave on
 * their own phone; the photograph of the paper sheet is the evidence.
 */
export async function markSigned(ctx: ServiceContext, input: { id: string; attendeeId: string }) {
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const meeting = await loadMeeting(tx, input.id);
    if (meeting.closedAt) throw new ConflictError("This sign in sheet has been closed.");
    const [attendee] = await tx.select().from(schema.safetyMeetingAttendee)
      .where(and(
        eq(schema.safetyMeetingAttendee.id, input.attendeeId),
        eq(schema.safetyMeetingAttendee.meetingId, input.id),
      )).limit(1);
    if (!attendee) throw new NotFoundError("Attendee");
    if (attendee.signedAt) return { signedAt: attendee.signedAt.toISOString() };
    const now = new Date();
    await tx.update(schema.safetyMeetingAttendee).set({
      signedAt: now, signedVia: "office", signedByUserId: uploader(ctx.actor),
    }).where(eq(schema.safetyMeetingAttendee.id, attendee.id));
    await audit(tx, ctx, "safety.signed", "safety_meeting", input.id, null, {
      attendeeId: attendee.id, name: attendee.name, via: "office",
    });
    return { signedAt: now.toISOString() };
  });
}

export async function closeMeeting(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const meeting = await loadMeeting(tx, input.id);
    if (meeting.closedAt) return { closedAt: meeting.closedAt.toISOString() };
    const now = new Date();
    await tx.update(schema.safetyMeeting).set({ closedAt: now, closedByUserId: uploader(ctx.actor), updatedAt: now })
      .where(eq(schema.safetyMeeting.id, input.id));
    await audit(tx, ctx, "safety.meeting_closed", "safety_meeting", input.id, null, { closedAt: now });
    return { closedAt: now.toISOString() };
  });
}

export async function addMeetingPhoto(ctx: ServiceContext, input: { id: string } & Photo) {
  return guardedWrite(ctx, "safety:write", async (tx) => {
    await loadMeeting(tx, input.id);
    return { id: await keepPhoto(tx, ctx, "safety_meeting", input.id, input) };
  });
}

/* ------------------------------------------------------- incident reports */

export interface IncidentInput {
  kind: rules.IncidentKind;
  occurredAt: string;
  location?: string | undefined;
  propertyId?: string | undefined;
  jobId?: string | undefined;
  description: string;
  immediateAction?: string | undefined;
  people?: Array<{
    technicianId?: string | undefined; name?: string | undefined;
    role: rules.PersonRole; injury?: string | undefined;
  }> | undefined;
  photos?: Photo[] | undefined;
}

/**
 * Report something that went wrong.
 *
 * The office hears about it as a task in its queue, in the same transaction,
 * because a report nobody is told about is a report that waits until the
 * insurer asks.
 */
export async function report(ctx: ServiceContext, input: IncidentInput) {
  if (!can(ctx.actor, "safety:report") && !can(ctx.actor, "safety:write")) assertCan(ctx.actor, "safety:report");
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new UnprocessableError("That is not a time.", [{ path: "occurredAt", message: "Not a date and time." }]);
  }

  return inTenant(ctx, async (tx) => {
    const prior = await replayed(tx, ctx, "safety.incident_reported");
    if (prior) return { id: prior };

    const techIds = [...new Set((input.people ?? []).map((p) => p.technicianId).filter((id): id is string => !!id))];
    const names = await technicianNames(tx, techIds);
    const people = (input.people ?? []).map((p) => ({
      technicianId: p.technicianId ?? null,
      name: p.name?.trim() || (p.technicianId ? names.get(p.technicianId)! : ""),
      role: p.role,
      injury: p.injury?.trim() || null,
    }));
    const problems = rules.incidentProblems(
      { kind: input.kind, occurredAt, description: input.description, people }, new Date(),
    );
    if (problems.length > 0) throw new UnprocessableError(problems[0]!.message, problems);

    const [row] = await tx.insert(schema.incidentReport).values({
      organizationId: ctx.actor.organizationId,
      kind: input.kind,
      occurredAt,
      location: input.location?.trim() || null,
      propertyId: input.propertyId ?? null,
      jobId: input.jobId ?? null,
      description: input.description.trim(),
      immediateAction: input.immediateAction?.trim() || null,
      reportedByUserId: uploader(ctx.actor),
    }).returning();
    for (const person of people) {
      await tx.insert(schema.incidentPerson).values({
        organizationId: ctx.actor.organizationId, incidentId: row!.id, ...person,
      });
    }
    for (const photo of input.photos ?? []) await keepPhoto(tx, ctx, "incident_report", row!.id, photo);

    const [task] = await tx.insert(schema.task).values({
      organizationId: ctx.actor.organizationId,
      title: `Review the incident report: ${rules.INCIDENT_KIND_WORDS[input.kind].split(":")[0]}`,
      body: input.description.trim().slice(0, 500),
      priority: input.kind === "injury" ? "urgent" : "high",
      entityType: "incident_report",
      entityId: row!.id,
      queue: "safety",
      createdByUserId: uploader(ctx.actor),
    }).returning({ id: schema.task.id });
    await remember(tx, ctx, "safety.incident_reported", "incident_report", row!.id);
    await audit(tx, ctx, "safety.incident_reported", "incident_report", row!.id, null, { ...row, people, reviewTaskId: task!.id });
    return { id: row!.id };
  });
}

/** Reading one: the register, or your own report. */
async function readable(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.incidentReport).where(eq(schema.incidentReport.id, id)).limit(1);
  if (!row) throw new NotFoundError("Incident report");
  if (!can(ctx.actor, "safety:read") && row.reportedByUserId !== ctx.actor.userId) {
    throw new NotFoundError("Incident report");
  }
  return row;
}

export async function listIncidents(
  ctx: ServiceContext, input: { status?: "open" | "closed" | undefined; limit?: number | undefined } = {},
) {
  const register = can(ctx.actor, "safety:read");
  if (!register) assertCan(ctx.actor, "safety:report");
  return inTenant(ctx, async (tx) => {
    const rows = await tx.select().from(schema.incidentReport)
      .where(and(
        input.status ? eq(schema.incidentReport.status, input.status) : undefined,
        register ? undefined : eq(schema.incidentReport.reportedByUserId, ctx.actor.userId),
      ))
      .orderBy(desc(schema.incidentReport.occurredAt)).limit(input.limit ?? 100);
    const people = rows.length === 0 ? [] : await tx.select().from(schema.incidentPerson)
      .where(inArray(schema.incidentPerson.incidentId, rows.map((r) => r.id)));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurredAt.toISOString(),
      location: row.location,
      description: row.description,
      status: row.status,
      people: people.filter((p) => p.incidentId === row.id).map((p) => ({ name: p.name, role: p.role })),
    }));
  });
}

export async function getIncident(ctx: ServiceContext, input: { id: string }) {
  if (!can(ctx.actor, "safety:read")) assertCan(ctx.actor, "safety:report");
  return inTenant(ctx, async (tx) => {
    const row = await readable(tx, ctx, input.id);
    const people = await tx.select().from(schema.incidentPerson)
      .where(eq(schema.incidentPerson.incidentId, input.id)).orderBy(asc(schema.incidentPerson.createdAt));
    const followUps = await tx.select().from(schema.task)
      .where(and(eq(schema.task.entityType, "incident_report"), eq(schema.task.entityId, input.id)))
      .orderBy(asc(schema.task.createdAt));
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurredAt.toISOString(),
      location: row.location,
      propertyId: row.propertyId,
      jobId: row.jobId,
      description: row.description,
      immediateAction: row.immediateAction,
      status: row.status,
      reportedByUserId: row.reportedByUserId,
      closedAt: row.closedAt?.toISOString() ?? null,
      closingNote: row.closingNote,
      createdAt: row.createdAt.toISOString(),
      people: people.map((p) => ({
        id: p.id, technicianId: p.technicianId, name: p.name, role: p.role, injury: p.injury,
      })),
      followUps: followUps.map((t) => ({
        id: t.id, title: t.title, status: t.status,
        dueAt: t.dueAt?.toISOString() ?? null, assigneeUserId: t.assigneeUserId,
      })),
      photos: await photosOf(tx, "incident_report", input.id),
    };
  });
}

/**
 * Something to do because of it, as a task in the office queue.
 *
 * `safety:write` and not `task:write`: following up an incident is the job of
 * whoever runs safety, and a crew lead who does is not thereby somebody who
 * may put work in everybody's queue.
 */
export async function addFollowUp(
  ctx: ServiceContext,
  input: { id: string; title: string; assigneeUserId?: string | undefined; dueAt?: string | undefined },
) {
  const title = input.title.trim();
  if (title === "") throw new UnprocessableError("Say what needs doing.", [{ path: "title", message: "Required." }]);
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const prior = await replayed(tx, ctx, "safety.follow_up_added");
    if (prior) return { taskId: prior };
    const row = await readable(tx, ctx, input.id);
    if (row.status === "closed") throw new ConflictError("This report is closed. Reopen it by reporting again if something new came up.");
    const [task] = await tx.insert(schema.task).values({
      organizationId: ctx.actor.organizationId,
      title,
      body: `Follow up from the incident on ${row.occurredAt.toISOString().slice(0, 10)}.`,
      entityType: "incident_report",
      entityId: input.id,
      queue: "safety",
      assigneeUserId: input.assigneeUserId ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      createdByUserId: uploader(ctx.actor),
    }).returning();
    await remember(tx, ctx, "safety.follow_up_added", "task", task!.id);
    await audit(tx, ctx, "task.created", "task", task!.id, null, task);
    return { taskId: task!.id };
  });
}

/**
 * Close it, saying what was learned. Refused while a follow up is open: a
 * report closed with the guard rail still unordered is a report that says the
 * company dealt with something it had not.
 */
export async function closeIncident(ctx: ServiceContext, input: { id: string; closingNote: string }) {
  const note = input.closingNote.trim();
  if (note === "") {
    throw new UnprocessableError("Say what was learned or changed.", [{ path: "closingNote", message: "Required." }]);
  }
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const row = await readable(tx, ctx, input.id);
    if (row.status === "closed") return { closedAt: row.closedAt!.toISOString() };
    const open = await tx.select({ id: schema.task.id }).from(schema.task)
      .where(and(
        eq(schema.task.entityType, "incident_report"),
        eq(schema.task.entityId, input.id),
        inArray(schema.task.status, ["open", "in_progress"]),
      ));
    /** The review task raised with the report is a follow up like any other. */
    if (open.length > 0) {
      throw new ConflictError(
        `${open.length === 1 ? "One follow up is" : `${open.length} follow ups are`} still open. Finish or close them first.`,
      );
    }
    const now = new Date();
    await tx.update(schema.incidentReport).set({
      status: "closed", closedAt: now, closedByUserId: uploader(ctx.actor), closingNote: note, updatedAt: now,
    }).where(eq(schema.incidentReport.id, input.id));
    await audit(tx, ctx, "safety.incident_closed", "incident_report", input.id, { status: row.status }, { status: "closed", closingNote: note });
    return { closedAt: now.toISOString() };
  });
}

/** A photograph added later: by the reporter on their own report, or by whoever follows it up. */
export async function addIncidentPhoto(ctx: ServiceContext, input: { id: string } & Photo) {
  if (!can(ctx.actor, "safety:write")) assertCan(ctx.actor, "safety:report");
  return inTenant(ctx, async (tx) => {
    const row = await readable(tx, ctx, input.id);
    if (!can(ctx.actor, "safety:write") && row.reportedByUserId !== ctx.actor.userId) throw new NotFoundError("Incident report");
    return { id: await keepPhoto(tx, ctx, "incident_report", input.id, input) };
  });
}

/**
 * The company's own people, for the "who was there" boxes on a talk and an
 * incident report. Names only, and only to somebody who runs safety or can
 * report: the people on a crew already know each other's names.
 */
export async function people(ctx: ServiceContext): Promise<Array<{ value: string; label: string }>> {
  if (!can(ctx.actor, "safety:write")) assertCan(ctx.actor, "safety:report");
  return inTenant(ctx, async (tx) => {
    const rows = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
      .from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(eq(schema.membership.active, true))
      .orderBy(asc(schema.technician.displayName));
    return rows.map((row) => ({ value: row.id, label: row.name }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listSafetyMeetings: async (ctx: ServiceContext, input: { limit?: number | undefined }) =>
    ({ meetings: await listMeetings(ctx, input) }),
  getSafetyMeeting: (ctx: ServiceContext, input: { id: string }) => getMeeting(ctx, input),
  createSafetyMeeting: (ctx: ServiceContext, input: MeetingInput) => createMeeting(ctx, input),
  addSafetyMeetingAttendees: (ctx: ServiceContext, input: { id: string; attendees: AttendeeInput[] }) =>
    addAttendees(ctx, input),
  markSafetyMeetingSigned: (ctx: ServiceContext, input: { id: string; attendeeId: string }) => markSigned(ctx, input),
  closeSafetyMeeting: (ctx: ServiceContext, input: { id: string }) => closeMeeting(ctx, input),
  addSafetyMeetingPhoto: (ctx: ServiceContext, input: { id: string } & Photo) => addMeetingPhoto(ctx, input),
  listMySafetyMeetings: async (ctx: ServiceContext) => ({ meetings: await mine(ctx) }),
  signSafetyMeeting: (ctx: ServiceContext, input: { id: string; signature: string }) => sign(ctx, input),
  reportIncident: (ctx: ServiceContext, input: IncidentInput) => report(ctx, input),
  listIncidents: async (
    ctx: ServiceContext, input: { status?: "open" | "closed" | undefined; limit?: number | undefined },
  ) => ({ incidents: await listIncidents(ctx, input) }),
  getIncident: (ctx: ServiceContext, input: { id: string }) => getIncident(ctx, input),
  addIncidentFollowUp: (
    ctx: ServiceContext,
    input: { id: string; title: string; assigneeUserId?: string | undefined; dueAt?: string | undefined },
  ) => addFollowUp(ctx, input),
  closeIncident: (ctx: ServiceContext, input: { id: string; closingNote: string }) => closeIncident(ctx, input),
  addIncidentPhoto: (ctx: ServiceContext, input: { id: string } & Photo) => addIncidentPhoto(ctx, input),
} as const;
