import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * TOOLBOX TALKS: THE COMPANY'S TOPICS, TALKS ON A SCHEDULE, WHO HAS NOT SIGNED
 *
 * The library starts empty and holds only the company's own topics: nothing
 * here ships safety content. A schedule raises a talk from a topic for a crew
 * or a person on the same schedules a recurring task uses, and each person
 * signs their own line on `/my-day` or on the phone app. `safety:read` to
 * look, `safety:write` to change.
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

const Schedule = z.object({
  id: Uuid,
  topicId: Uuid,
  topicTitle: z.string(),
  topicRetired: z.boolean(),
  crewId: Uuid.nullable(),
  technicianId: Uuid.nullable(),
  /** The crew's name or the person's. */
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
  lastRaisedOn: IsoDate.nullable(),
  /** "Every Monday". */
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
  summary: "Toolbox talks that come round, per crew or per person",
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
    "For one crew (`crewId`) or one person (`technicianId`), never both. `frequency` is the same as a recurring task's. The worker raises the talk on its day in the company's zone at `heldMinutes`, with the crew's members as they are that day, once per day whatever it does, and only the latest occurrence after it was down.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({
    topicId: Uuid,
    crewId: Uuid.nullable().optional(),
    technicianId: Uuid.nullable().optional(),
    frequency: Frequency,
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    monthDay: z.number().int().min(1).max(31).nullable().optional(),
    heldMinutes: z.number().int().min(0).max(1439).optional(),
    startsOn: IsoDate.optional(),
    location: z.string().max(300).nullable().optional(),
    ledBy: z.string().max(200).nullable().optional(),
  }),
  output: Schedule,
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
  listSafetyTalkSchedules, createSafetyTalkSchedule, setSafetyTalkScheduleActive,
  listUnsignedSafetyLines,
} as const;
