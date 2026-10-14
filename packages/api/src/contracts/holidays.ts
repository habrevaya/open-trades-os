import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE COMPANY'S HOLIDAYS
 *
 * Dates the week's hours do not apply to: closed all day, or open with hours
 * of their own. Read by online booking (no windows on a closed date, only
 * windows inside a short day's hours), by the phones (a call on a closed date
 * routes as after hours), by the reviews response clock, by the multi day
 * rebalance and by recurring tasks set to skip holidays.
 *
 * `settings:read` to look, `booking:configure` to change, the permission the
 * week's hours are set with. A holiday can be a rule that moves each year
 * (`rule`, `observed`), and a branch can keep its own (`businessUnitId`),
 * read beside the company's by every reader that knows the branch.
 */

const Rule = z.object({
  month: z.number().int().min(1).max(12),
  /** 0 for Sunday through 6 for Saturday. */
  weekday: z.number().int().min(0).max(6),
  /** The first to fourth such weekday of the month, or the last. */
  week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal("last")]),
});
const Observed = z.enum(["as_is", "sunday_to_monday", "weekend_to_weekday"]);

const Clock = z.string().regex(/^\d{2}:\d{2}$/);

export const Holiday = z.object({
  id: Uuid,
  name: z.string(),
  /** `YYYY-MM-DD`. For a yearly one, only the month and day are read. */
  date: z.string(),
  repeatsYearly: z.boolean(),
  /** The day of the week in a month it falls on, for one that moves. */
  rule: Rule.nullable(),
  /** Where a repeating one is kept when it lands on a weekend. */
  observed: Observed,
  /** The branch whose own it is, or null for the whole company's. */
  businessUnitId: Uuid.nullable(),
  branchName: z.string().nullable(),
  /** When it falls, in words: "Fourth Thursday of November". */
  when: z.string(),
  closed: z.boolean(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  /** The next date it falls on, from today in the company's zone. Null for one that has passed. */
  nextOn: z.string().nullable(),
  /** "Closed" or "Open 08:00 to 12:00". */
  hours: z.string(),
});

export const HolidayFields = z.object({
  name: z.string().min(1).max(80),
  /** Required for a date. Left out for a rule, which is worked out each year. */
  date: z.string().date().optional(),
  repeatsYearly: z.boolean().optional(),
  /** A day of the week in a month, for a holiday that moves ("fourth Thursday of November"). It repeats every year. */
  rule: Rule.nullable().optional(),
  /** For one that repeats: kept on the day itself, on the Monday after a Sunday, or on the nearest weekday. */
  observed: Observed.optional(),
  /** A branch's own holiday, read by that branch's readers beside the company's. Null or absent is the company's. */
  businessUnitId: Uuid.nullable().optional(),
  /** Shut all day. False means open, with `opensAt` and `closesAt`. */
  closed: z.boolean(),
  /** Wall clock in the company's zone. */
  opensAt: Clock.nullable().optional(),
  closesAt: Clock.nullable().optional(),
});

export const listHolidays = defineRoute({
  method: "get",
  path: "/v1/holidays",
  summary: "The company's holidays: dates it is closed, or open with other hours",
  description: "Coming ones first, in the order they come, then the ones that have passed.",
  module: "M02",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ holidays: z.array(Holiday) }),
});

export const createHoliday = defineRoute({
  method: "post",
  path: "/v1/holidays",
  summary: "Add a holiday",
  description:
    "A date the company is closed, or open with hours of its own. `repeatsYearly` keeps a fixed date holiday every year, and `observed` keeps it off a weekend (the Monday after a Sunday, or the nearest weekday). One that moves is a `rule`: a day of the week in a month, the first to fourth or the last, worked out each year. `businessUnitId` makes it one branch's own, read by that branch's readers beside the company's list; somebody who sees only their branch keeps only its own. A second entry for the same date in the same list (or two repeating ones that meet on a day in the next ten years) is refused; a one off date on the day of a yearly one is allowed and wins that year, and a branch's own wins over the company's.",
  module: "M02",
  permissions: ["booking:configure"],
  idempotent: true,
  input: HolidayFields,
  output: Holiday,
});

export const updateHoliday = defineRoute({
  method: "patch",
  path: "/v1/holidays/{id}",
  summary: "Change a holiday",
  module: "M02",
  permissions: ["booking:configure"],
  input: HolidayFields.extend({ id: Uuid }),
  output: Holiday,
});

export const removeHoliday = defineRoute({
  method: "delete",
  path: "/v1/holidays/{id}",
  summary: "Take a holiday off the list",
  description: "The audit log keeps what it said. Removing one already gone succeeds and says so.",
  module: "M02",
  permissions: ["booking:configure"],
  input: z.object({ id: Uuid }),
  output: z.object({ removed: z.boolean() }),
});

export const holidayRoutes = { listHolidays, createHoliday, updateHoliday, removeHoliday } as const;
