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
 * week's hours are set with.
 */

const Clock = z.string().regex(/^\d{2}:\d{2}$/);

const Holiday = z.object({
  id: Uuid,
  name: z.string(),
  /** `YYYY-MM-DD`. For a yearly one, only the month and day are read. */
  date: z.string(),
  repeatsYearly: z.boolean(),
  closed: z.boolean(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  /** The next date it falls on, from today in the company's zone. Null for one that has passed. */
  nextOn: z.string().nullable(),
  /** "Closed" or "Open 08:00 to 12:00". */
  hours: z.string(),
});

const HolidayFields = z.object({
  name: z.string().min(1).max(80),
  date: z.string().date(),
  repeatsYearly: z.boolean().optional(),
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
    "A date the company is closed, or open with hours of its own. `repeatsYearly` keeps a fixed date holiday every year; one that moves is added for the year it falls in. A second entry for the same date (or the same day every year) is refused; a one off date on the day of a yearly one is allowed and wins that year.",
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
