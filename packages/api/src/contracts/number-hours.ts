import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { Holiday, HolidayFields } from "./holidays";

/**
 * A PHONE NUMBER'S OWN HOURS AND DAYS OFF
 *
 * What a number routed by hours (or answered by a phone menu) is routed by:
 * the branch it answers for (the company's week where the branch keeps none,
 * and the company's holidays with the branch's own), the company's whatever
 * its branch, or a week and days off of its own, without the company's.
 * `settings:read` to look and `settings:write` to change, as the number's
 * routing is.
 */

const Day = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  closed: z.boolean(),
});

const HoursFrom = z.enum(["branch", "company", "own"]);

const NumberHours = z.object({
  id: Uuid,
  e164: z.string(),
  label: z.string().nullable(),
  /** Whether this product answers its calls at all. */
  routedHere: z.boolean(),
  /** Whether its calls are routed by hours or answered by a menu; otherwise its hours are not read. */
  usesHours: z.boolean(),
  businessUnitId: Uuid.nullable(),
  branchName: z.string().nullable(),
  hoursFrom: HoursFrom,
  /** Its own seven days, empty when none were written. Kept when it follows its branch or the company. */
  ownWeek: z.array(Day),
  /** Its own days off, read only while it keeps its own hours. */
  ownHolidays: z.array(Holiday),
  /** The week its calls are routed by now: `number`, `branch`, `company`, or `none` when there is no week to go by. */
  routedBy: z.object({
    source: z.enum(["number", "branch", "company", "none"]),
    whose: z.string(),
    days: z.array(Day),
  }),
});

export const getNumberHours = defineRoute({
  method: "get",
  path: "/v1/phone-numbers/{id}/hours",
  summary: "The hours and days off a number's calls are routed by",
  description:
    "Where they come from (`hoursFrom`), the number's own week and days off, and the week its calls are routed by now, with whose it is.",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({ id: Uuid }),
  output: NumberHours,
});

export const setNumberHours = defineRoute({
  method: "put",
  path: "/v1/phone-numbers/{id}/hours",
  summary: "Where a number's hours come from, and its own week",
  description:
    "`branch` follows the branch it answers for (the company's for a number in no branch, or a branch that keeps no week), with the company's holidays and the branch's own. `company` follows the company's whatever its branch. `own` routes by its own week and its own days off, and none of the company's: `days` sets all seven, and choosing `own` with no week given and none written before is refused. Its own week and days off are kept when it is switched away, and used again when it is switched back.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, hoursFrom: HoursFrom, days: z.array(Day).length(7).optional() }),
  output: NumberHours,
});

export const addNumberHoliday = defineRoute({
  method: "post",
  path: "/v1/phone-numbers/{id}/holidays",
  summary: "Add a day off of the number's own",
  description:
    "The same fields as a company holiday, without a branch: a date, a yearly date or a day of the week in a month, closed or open shorter. Checked against the number's own list alone. Read only while the number keeps its own hours.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: HolidayFields.omit({ businessUnitId: true }).extend({ id: Uuid }),
  output: Holiday,
});

export const removeNumberHoliday = defineRoute({
  method: "delete",
  path: "/v1/phone-numbers/{id}/holidays/{holidayId}",
  summary: "Take a day off the number's own list",
  description: "One already gone, or another number's, answers with nothing removed.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, holidayId: Uuid }),
  output: z.object({ removed: z.boolean() }),
});

export const numberHoursRoutes = { getNumberHours, setNumberHours, addNumberHoliday, removeNumberHoliday } as const;
