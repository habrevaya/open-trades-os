import { z } from "zod";
import { ROLE_IDS, type RoleId } from "@opentradesos/core";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * TOOLBOX TALKS: THE COMPANY'S TOPICS, TALKS ON A SCHEDULE, WHO HAS NOT SIGNED
 *
 * The library starts empty and holds only the company's own topics: nothing
 * here ships safety content. A schedule raises a talk from a topic for a crew,
 * a person, a role, a branch or the whole company on the same schedules a
 * recurring task uses, optionally skipping the company's holidays, and each
 * person signs their own line on `/my-day` or on the phone app. `safety:read`
 * to look, `safety:write` to change.
 */

const Topic = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string(),
  retired: z.boolean(),
  createdAt: z.string(),
});

const Frequency = z.enum(["daily", "weekdays", "weekly", "every_other_week", "monthly", "last_weekday_of_month"]);
const IsoDate = z.string().date();

const Audience = z.enum(["crew", "person", "role", "branch", "company"]);
const PresetRole = z.enum(ROLE_IDS as [RoleId, ...RoleId[]]);

const Schedule = z.object({
  id: Uuid,
  topicId: Uuid,
  topicTitle: z.string(),
  topicRetired: z.boolean(),
  /** Who it is for; the one field beside it that names them is set. */
  audience: Audience,
  crewId: Uuid.nullable(),
  technicianId: Uuid.nullable(),
  /** The preset role, for a role audience that names one. */
  role: z.string().nullable(),
  /** The role the company defined, for a role audience that names one. */
  roleId: Uuid.nullable(),
  branchId: Uuid.nullable(),
  /** The crew's name, the person's, the role's, the branch's, or "Everybody". */
  who: z.string(),
  frequency: Frequency,
  weekday: z.number().int().nullable(),
  monthDay: z.number().int().nullable(),
  /** Minutes after the company's midnight. */
  heldMinutes: z.number().int(),
  startsOn: IsoDate,
  location: z.string().nullable(),
  ledBy: z.string().nullable(),
  active: z.boolean(),
  /** Whether a day the company is closed all day is skipped. */
  skipHolidays: z.boolean(),
  lastRaisedOn: IsoDate.nullable(),
  /** "Every Monday", with ", not on a holiday" when it skips them. */
  schedule: z.string(),
  /** The next day it raises a talk for. Null when paused or its topic is retired. */
  nextOn: IsoDate.nullable(),
});

export const listSafetyTopics = defineRoute({
  method: "get",
  path: "/v1/safety/topics",
  summary: "The company's own library of toolbox talk topics",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({ includeRetired: z.boolean().optional() }),
  output: z.object({ topics: z.array(Topic) }),
});

export const createSafetyTopic = defineRoute({
  method: "post",
  path: "/v1/safety/topics",
  summary: "Add a topic to the library",
  description: "A title and the words the talk covers, in the company's own words. A talk held from it copies both.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(20_000) }),
  output: Topic,
});

export const updateSafetyTopic = defineRoute({
  method: "patch",
  path: "/v1/safety/topics/{id}",
  summary: "Change a topic's words, or retire it",
  description: "Talks already held keep the words they were held with. A retired topic raises no more scheduled talks.",
  module: "M23",
  permissions: ["safety:write"],
  input: z.object({
    id: Uuid,
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
    retired: z.boolean().optional(),
  }),
  output: Topic,
});

export const listSafetyTalkSchedules = defineRoute({
  method: "get",
  path: "/v1/safety/schedules",
  summary: "Toolbox talks that come round, for a crew, a person, a role, a branch or everybody",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({}),
  output: z.object({ schedules: z.array(Schedule) }),
});

export const createSafetyTalkSchedule = defineRoute({
  method: "post",
  path: "/v1/safety/schedules",
  summary: "Hold a talk from the library on a schedule",
  description:
    "For exactly one audience: a crew (`crewId`), a person (`technicianId`), everybody who holds a role (`role`, a preset by name, or `roleId`, one the company defined), everybody in a branch (`branchId`), or the whole company (`everybody: true`). A role, a branch or the company means the people who work in the field and have an active account on the day, because the sheet is signed from My day on the phone; a role the company defined replaces the preset on whoever holds it. `frequency` is the same as a recurring task's. The worker raises the talk on its day in the company's zone at `heldMinutes`, with the audience as it is that day, once per day whatever it does, and only the latest occurrence after it was down. A talk for a role, a branch or the company with nobody to put on the sheet that day is not raised, and the audit log says so. `skipHolidays` raises nothing on a day the company is closed all day (a branch's talk also honours the branch's own days off) and does not move the talk to another day; a short day is a working day.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({
    topicId: Uuid,
    crewId: Uuid.nullable().optional(),
    technicianId: Uuid.nullable().optional(),
    role: PresetRole.nullable().optional(),
    roleId: Uuid.nullable().optional(),
    branchId: Uuid.nullable().optional(),
    everybody: z.boolean().optional(),
    frequency: Frequency,
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    monthDay: z.number().int().min(1).max(31).nullable().optional(),
    heldMinutes: z.number().int().min(0).max(1439).optional(),
    startsOn: IsoDate.optional(),
    location: z.string().max(300).nullable().optional(),
    ledBy: z.string().max(200).nullable().optional(),
    skipHolidays: z.boolean().optional(),
  }),
  output: Schedule,
});

export const listSafetyTalkAudiences = defineRoute({
  method: "get",
  path: "/v1/safety/schedule-audiences",
  summary: "The roles and branches a talk can be held for",
  description: "Roles by name (`preset:{id}` for one that came with the product, `custom:{uuid}` for one the company defined, with `own` true) and the branches still open. Names only; nothing about who holds them.",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({}),
  output: z.object({
    roles: z.array(z.object({ value: z.string(), label: z.string(), own: z.boolean() })),
    branches: z.array(z.object({ id: Uuid, name: z.string() })),
  }),
});

export const setSafetyTalkScheduleActive = defineRoute({
  method: "post",
  path: "/v1/safety/schedules/{id}/active",
  summary: "Pause or resume a scheduled talk",
  description: "Setting it to what it already is changes nothing.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ id: Uuid, active: z.boolean() }),
  output: Schedule,
});

export const listUnsignedSafetyLines = defineRoute({
  method: "get",
  path: "/v1/safety/unsigned",
  summary: "Who has not signed a talk that has been held",
  description: "Every line not signed on a talk held by now whose sheet is still open, the oldest talk first.",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({}),
  output: z.object({
    lines: z.array(z.object({
      meetingId: Uuid,
      topic: z.string(),
      heldAt: z.string(),
      attendeeId: Uuid,
      name: z.string(),
      /** One of the company's own people, who can sign on their own phone. */
      ownPerson: z.boolean(),
    })),
  }),
});

export const safetyTalkRoutes = {
  listSafetyTopics, createSafetyTopic, updateSafetyTopic,
  listSafetyTalkSchedules, createSafetyTalkSchedule, setSafetyTalkScheduleActive, listSafetyTalkAudiences,
  listUnsignedSafetyLines,
} as const;
