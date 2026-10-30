import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, ROLE_IDS, ROLE_PRESETS, assertCan, can, field, holidays as holidayRules, safety as rules, taskRules, time,
  type Actor, type RoleId,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import { attach } from "./files";
import { loadHolidays } from "./holidays";

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
 * TALKS ON A SCHEDULE, for a crew, a person, everybody who holds a role,
 * everybody in a branch or the whole company, on the same schedules a
 * recurring task uses (core's `tasks` rules). The worker raises the talk on
 * its day in the company's zone, with the audience as it is that day, and a
 * unique index on (schedule, day) is what makes it once. A schedule can be
 * told to skip the company's holidays, as a recurring task can.
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
  /**
   * Who it is for: exactly one of these. A crew, a person, a role (a preset
   * by name, or one the company defined by id), a branch, or everybody.
   */
  crewId?: string | null | undefined;
  technicianId?: string | null | undefined;
  role?: RoleId | null | undefined;
  roleId?: string | null | undefined;
  branchId?: string | null | undefined;
  everybody?: boolean | undefined;
  frequency: taskRules.TaskFrequency;
  weekday?: number | null | undefined;
  monthDay?: number | null | undefined;
  /** Minutes after the company's midnight. Seven in the morning when not said. */
  heldMinutes?: number | undefined;
  startsOn?: string | undefined;
  location?: string | null | undefined;
  ledBy?: string | null | undefined;
  /** Raise nothing on a day the company is closed all day. Off when not said. */
  skipHolidays?: boolean | undefined;
}

export type Audience = typeof schema.safetyTalkAudience.enumValues[number];

export interface ScheduleView {
  id: string;
  topicId: string;
  topicTitle: string;
  topicRetired: boolean;
  audience: Audience;
  crewId: string | null;
  technicianId: string | null;
  /** The preset role, for a role audience that names one. */
  role: string | null;
  /** The role the company defined, for a role audience that names one. */
  roleId: string | null;
  branchId: string | null;
  /** The crew's name, the person's, the role's, the branch's, or "Everybody". */
  who: string;
  frequency: taskRules.TaskFrequency;
  weekday: number | null;
  monthDay: number | null;
  heldMinutes: number;
  startsOn: string;
  location: string | null;
  ledBy: string | null;
  active: boolean;
  skipHolidays: boolean;
  lastRaisedOn: string | null;
  /** "Every Monday", from the same function the worker uses; ", not on a holiday" when it skips them. */
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
  const roleIds = rows.map((r) => r.audienceRoleId).filter((id): id is string => id !== null);
  const branchIds = rows.map((r) => r.audienceBusinessUnitId).filter((id): id is string => id !== null);
  const crews = crewIds.length === 0 ? [] : await tx.select({ id: schema.crew.id, name: schema.crew.name })
    .from(schema.crew).where(inArray(schema.crew.id, crewIds));
  const techs = techIds.length === 0 ? [] : await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician).where(inArray(schema.technician.id, techIds));
  const roles = roleIds.length === 0 ? [] : await tx.select({ id: schema.role.id, name: schema.role.name })
    .from(schema.role).where(inArray(schema.role.id, roleIds));
  const branches = branchIds.length === 0 ? [] : await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
    .from(schema.businessUnit).where(inArray(schema.businessUnit.id, branchIds));
  return rows.map((row) => {
    const topic = topics.find((t) => t.id === row.topicId);
    const plan = { frequency: row.frequency, weekday: row.weekday, monthDay: row.monthDay, startsOn: row.startsOn };
    const raisedToday = row.lastRaisedOn !== null && row.lastRaisedOn >= today;
    const dueToday = taskRules.occurrenceOnOrBefore(plan, today) === today;
    const live = row.active && !topic?.retiredAt;
    const who = row.audience === "crew" ? `${crews.find((c) => c.id === row.crewId)?.name ?? "A crew"} (crew)`
      : row.audience === "person" ? techs.find((t) => t.id === row.technicianId)?.name ?? "Somebody"
        : row.audience === "role"
          ? `Everybody with the ${row.audienceRoleId
            ? roles.find((r) => r.id === row.audienceRoleId)?.name ?? "role that has gone"
            : ROLE_PRESETS[row.audienceRole as RoleId]?.label ?? "role"} role`
          : row.audience === "branch" ? `Everybody in ${branches.find((b) => b.id === row.audienceBusinessUnitId)?.name ?? "a branch that has gone"}`
            : "Everybody";
    return {
      id: row.id,
      topicId: row.topicId,
      topicTitle: topic?.title ?? "A topic that has gone",
      topicRetired: Boolean(topic?.retiredAt),
      audience: row.audience,
      crewId: row.crewId,
      technicianId: row.technicianId,
      role: row.audienceRole,
      roleId: row.audienceRoleId,
      branchId: row.audienceBusinessUnitId,
      who,
      frequency: row.frequency,
      weekday: row.weekday,
      monthDay: row.monthDay,
      heldMinutes: row.heldMinutes,
      startsOn: row.startsOn,
      location: row.location,
      ledBy: row.ledBy,
      active: row.active,
      skipHolidays: row.skipHolidays,
      lastRaisedOn: row.lastRaisedOn,
      schedule: `${taskRules.describeSchedule(plan)}${row.skipHolidays ? ", not on a holiday" : ""}`,
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

/** The audience a request names: exactly one of them, or a refusal in words. Null when it names none. */
function chosenAudience(input: AudienceInput): Audience | null {
  const chosen = [
    input.crewId ? "crew" : null, input.technicianId ? "person" : null,
    input.role || input.roleId ? "role" : null, input.branchId ? "branch" : null, input.everybody ? "company" : null,
  ].filter((a): a is Audience => a !== null);
  if (chosen.length > 1) {
    throw new ConflictError("A scheduled talk is for one crew or one person, one role, one branch, or everybody. Choose only one of them.");
  }
  if (input.role && input.roleId) {
    throw new ConflictError("Choose a role from the list, either one the company defined or one that came with it, not both.");
  }
  if (input.role && !ROLE_IDS.includes(input.role)) throw new ConflictError("That is not a role.");
  return chosen[0] ?? null;
}

type AudienceInput = Pick<ScheduleInput, "crewId" | "technicianId" | "role" | "roleId" | "branchId" | "everybody">;

/** The people an audience names have to be here: a crew, a person, a role, an open branch. */
async function mustExist(tx: Database, input: AudienceInput): Promise<void> {
  if (input.crewId) {
    const [crew] = await tx.select({ id: schema.crew.id }).from(schema.crew).where(eq(schema.crew.id, input.crewId)).limit(1);
    if (!crew) throw new NotFoundError("Crew");
  }
  if (input.technicianId) {
    const [tech] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(eq(schema.technician.id, input.technicianId)).limit(1);
    if (!tech) throw new NotFoundError("Technician");
  }
  if (input.roleId) {
    const [found] = await tx.select({ id: schema.role.id }).from(schema.role)
      .where(and(eq(schema.role.id, input.roleId), isNull(schema.role.deletedAt))).limit(1);
    if (!found) throw new NotFoundError("Role");
  }
  if (input.branchId) {
    const [found] = await tx.select({ id: schema.businessUnit.id, active: schema.businessUnit.active }).from(schema.businessUnit)
      .where(eq(schema.businessUnit.id, input.branchId)).limit(1);
    if (!found) throw new NotFoundError("Branch");
    if (!found.active) throw new ConflictError("That branch has been closed, so nobody works in it to hold a talk for.");
  }
}

/** The columns that name an audience, and no others, as the table's own check wants them. */
function audienceColumns(audience: Audience, input: AudienceInput) {
  return {
    audience,
    crewId: audience === "crew" ? input.crewId ?? null : null,
    technicianId: audience === "person" ? input.technicianId ?? null : null,
    audienceRole: audience === "role" ? input.role ?? null : null,
    audienceRoleId: audience === "role" ? input.roleId ?? null : null,
    audienceBusinessUnitId: audience === "branch" ? input.branchId ?? null : null,
  };
}

export async function createSchedule(ctx: ServiceContext, input: ScheduleInput): Promise<ScheduleView> {
  assertCan(ctx.actor, "safety:write");
  const audience = chosenAudience(input);
  if (!audience) {
    throw new ConflictError("Choose who the talk is for: a crew, a person, a role, a branch, or everybody.");
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
    await mustExist(tx, input);

    const [row] = await tx.insert(schema.safetyTalkSchedule).values({
      organizationId: ctx.actor.organizationId,
      topicId: topic.id,
      ...audienceColumns(audience, input),
      skipHolidays: input.skipHolidays ?? false,
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

export interface ScheduleChange extends AudienceInput {
  topicId?: string | undefined;
  heldMinutes?: number | undefined;
  location?: string | null | undefined;
  ledBy?: string | null | undefined;
  skipHolidays?: boolean | undefined;
}

/**
 * CHANGE A SCHEDULED TALK: ITS TOPIC, ITS AUDIENCE, ITS TIME, WHERE, WHO LEADS
 * IT, AND WHETHER IT SKIPS HOLIDAYS.
 *
 * It applies from the next talk raised. A talk the worker already raised keeps
 * what it was given: its title and words are copies of the topic's, its sheet
 * is the people who were put on it, its time is the time it was held at, and
 * none of it is touched here. What is not yet raised, today's included when the
 * worker has not come round to it, takes the new settings. The audit log holds
 * the schedule before and after.
 *
 * The audience is replaced whole when the request names one (a crew, a
 * person, a role, a branch or everybody), and is left alone when it names
 * none. The days it comes round on (how often, which weekday, which date, and
 * the day it starts) are not changed: counting from the first occurrence is
 * what says which week is the on week, and moving it is a new schedule, with
 * the old one paused.
 */
export async function updateSchedule(ctx: ServiceContext, input: ScheduleChange & { id: string }): Promise<ScheduleView> {
  assertCan(ctx.actor, "safety:write");
  const audience = chosenAudience(input);
  if (input.heldMinutes !== undefined && (!Number.isInteger(input.heldMinutes) || input.heldMinutes < 0 || input.heldMinutes >= 24 * 60)) {
    throw new ConflictError("The time it is held has to be a time of day.");
  }
  const changing = audience !== null || input.topicId !== undefined || input.heldMinutes !== undefined
    || input.location !== undefined || input.ledBy !== undefined || input.skipHolidays !== undefined;
  if (!changing) throw new ConflictError("Say what to change: the topic, who it is for, the time, where, who leads it, or whether it skips holidays.");
  return guardedWrite(ctx, "safety:write", async (tx) => {
    const seen = await replayed<ScheduleView>(tx, ctx, "safety_talk_schedule_changed");
    if (seen) return seen;
    const [before] = await tx.select().from(schema.safetyTalkSchedule)
      .where(eq(schema.safetyTalkSchedule.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Talk schedule");
    if (input.topicId !== undefined && input.topicId !== before.topicId) {
      const [topic] = await tx.select().from(schema.safetyTopic).where(eq(schema.safetyTopic.id, input.topicId)).limit(1);
      if (!topic) throw new NotFoundError("Topic");
      if (topic.retiredAt) throw new ConflictError(`"${topic.title}" is retired. Put it back in the library first.`);
    }
    if (audience) await mustExist(tx, input);
    const [after] = await tx.update(schema.safetyTalkSchedule).set({
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
      ...(audience ? audienceColumns(audience, input) : {}),
      ...(input.heldMinutes !== undefined ? { heldMinutes: input.heldMinutes } : {}),
      ...(input.location !== undefined ? { location: input.location?.trim() || null } : {}),
      ...(input.ledBy !== undefined ? { ledBy: input.ledBy?.trim() || null } : {}),
      ...(input.skipHolidays !== undefined ? { skipHolidays: input.skipHolidays } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.safetyTalkSchedule.id, input.id)).returning();
    await audit(tx, ctx, "safety.schedule_changed", "safety_talk_schedule", input.id, before, after);
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const [view] = await scheduleViews(tx, [after!], today);
    await remember(tx, ctx, "safety_talk_schedule_changed", input.id, view!);
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

/**
 * Who is on the sheet, as they are today.
 *
 * A crew's members or the one person, as it always was (their account
 * active). A role, a branch or the company is everybody in the field who is
 * active on the day: an active account AND an active technician profile,
 * because the sheet is signed from My day and a person with no technician
 * profile has no place to sign it. A custom role REPLACES the preset on a
 * membership, so a preset audience is the people on that preset with no
 * custom role, and a custom role is the people who hold that one.
 */
async function peopleFor(tx: Database, schedule: typeof schema.safetyTalkSchedule.$inferSelect) {
  const m = schema.membership;
  const audience = schedule.audience === "crew"
    ? inArray(schema.technician.id, tx.select({ id: schema.crewMember.technicianId }).from(schema.crewMember)
      .where(eq(schema.crewMember.crewId, schedule.crewId!)))
    : schedule.audience === "person"
      ? eq(schema.technician.id, schedule.technicianId!)
      : and(
        eq(schema.technician.active, true),
        schedule.audience === "role"
          ? schedule.audienceRoleId
            ? eq(m.roleId, schedule.audienceRoleId)
            : and(eq(m.role, schedule.audienceRole!), isNull(m.roleId))
          : schedule.audience === "branch"
            ? eq(m.businessUnitId, schedule.audienceBusinessUnitId!)
            : undefined,
      );
  return tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician)
    .innerJoin(m, eq(m.id, schema.technician.membershipId))
    .where(and(eq(m.active, true), audience))
    .orderBy(asc(schema.technician.displayName));
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
    /** The company's list, and a branch's own beside it for a talk held for that branch. Read once per list wanted. */
    const lists = new Map<string, holidayRules.CompanyHoliday[]>();
    for (const schedule of schedules) {
      const day = taskRules.occurrenceToRaise(
        { frequency: schedule.frequency, weekday: schedule.weekday, monthDay: schedule.monthDay, startsOn: schedule.startsOn },
        today, schedule.lastRaisedOn,
      );
      if (!day) continue;
      const [topic] = await tx.select().from(schema.safetyTopic).where(eq(schema.safetyTopic.id, schedule.topicId)).limit(1);
      if (!topic || topic.retiredAt) continue;

      /**
       * A schedule told to skip holidays raises nothing on a day the company
       * is closed all day, and the day is written down as dealt with, so the
       * next pass does not look again and the talk is not raised the day
       * after instead. Skipped, not moved. A short day is a working day. A
       * branch's talk also honours the branch's own days off; every other
       * audience only the company's, since a crew or a person may span
       * branches and one branch's day off is not theirs.
       */
      if (schedule.skipHolidays) {
        const branchId = schedule.audience === "branch" ? schedule.audienceBusinessUnitId : null;
        const key = branchId ?? "";
        if (!lists.has(key)) lists.set(key, await loadHolidays(tx, organizationId, branchId));
        const holiday = holidayRules.holidayOn(lists.get(key)!, day);
        if (holiday?.closed) {
          await tx.update(schema.safetyTalkSchedule).set({ lastRaisedOn: day, updatedAt: new Date() })
            .where(eq(schema.safetyTalkSchedule.id, schedule.id));
          await audit(tx, ctx, "safety.talk_skipped_holiday", "safety_talk_schedule", schedule.id, null,
            { occurrenceOn: day, holiday: holiday.name });
          continue;
        }
      }

      /**
       * A talk for a role, a branch or the company that finds nobody to put on
       * the sheet today is not raised: a sheet nobody can sign shows up on no
       * list and teaches the office to ignore the lists. Said in the audit
       * log. A crew or one person keeps the older behaviour of a sheet raised
       * as it was, so the office can add whoever is there by hand.
       */
      if (schedule.audience !== "crew" && schedule.audience !== "person") {
        if ((await peopleFor(tx, schedule)).length === 0) {
          await tx.update(schema.safetyTalkSchedule).set({ lastRaisedOn: day, updatedAt: new Date() })
            .where(eq(schema.safetyTalkSchedule.id, schedule.id));
          await audit(tx, ctx, "safety.talk_skipped_nobody", "safety_talk_schedule", schedule.id, null, { occurrenceOn: day });
          continue;
        }
      }

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

/* ------------------------------------------- who a talk can be held for */

export interface AudienceChoices {
  /** Presets and roles the company defined: the role's own name, and whether the company defined it. */
  roles: { value: string; label: string; own: boolean }[];
  /** Branches still open. */
  branches: { id: string; name: string }[];
}

/**
 * The roles and branches a schedule can be for, by name. A role is
 * `preset:{id}` for one that came with the product and `custom:{uuid}` for
 * one the company defined. Read with `safety:read`: names of the company's own
 * roles and branches, nothing about who holds them.
 */
export async function audienceChoices(ctx: ServiceContext): Promise<AudienceChoices> {
  return guardedRead(ctx, "safety:read", async (tx) => {
    const custom = await tx.select({ id: schema.role.id, name: schema.role.name }).from(schema.role)
      .where(isNull(schema.role.deletedAt)).orderBy(asc(schema.role.name));
    const branches = await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name }).from(schema.businessUnit)
      .where(eq(schema.businessUnit.active, true)).orderBy(asc(schema.businessUnit.name));
    return {
      roles: [
        ...ROLE_IDS.map((id) => ({ value: `preset:${id}`, label: ROLE_PRESETS[id].label, own: false })),
        ...custom.map((r) => ({ value: `custom:${r.id}`, label: r.name, own: true })),
      ],
      branches,
    };
  });
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
  listSafetyTalkAudiences: (ctx: ServiceContext) => audienceChoices(ctx),
  createSafetyTalkSchedule: (ctx: ServiceContext, input: ScheduleInput) => createSchedule(ctx, input),
  setSafetyTalkScheduleActive: (ctx: ServiceContext, input: { id: string; active: boolean }) => setScheduleActive(ctx, input),
  updateSafetyTalkSchedule: (ctx: ServiceContext, input: Parameters<typeof updateSchedule>[1]) => updateSchedule(ctx, input),
  listUnsignedSafetyLines: async (ctx: ServiceContext) => ({ lines: await unsigned(ctx) }),
} as const;
