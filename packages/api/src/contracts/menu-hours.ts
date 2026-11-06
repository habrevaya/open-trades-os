import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { Holiday, HolidayFields } from "./holidays";

/**
 * A PHONE MENU'S OWN HOURS AND DAYS OFF
 *
 * A menu goes by the hours of the number each call came in on (`number`,
 * the default) or by hours of its own choosing: a branch's (the company's
 * where the branch keeps none, with that branch's seasons and holidays), the
 * company's (with its seasons and holidays), or a week and days off of its
 * own, without the company's. A menu keeping hours of its own checks them
 * whenever a call reaches it, from a number or from another menu, and sends
 * a closed call where its after hours setting says. `settings:read` to look
 * and `settings:write` to change, as the menu is.
 */

const Day = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  closed: z.boolean(),
});

const HoursFrom = z.enum(["number", "branch", "company", "own"]);

const MenuHours = z.object({
  id: Uuid,
  name: z.string(),
  hoursFrom: HoursFrom,
  /** The branch it follows with `branch`, kept when it is switched away. */
  businessUnitId: Uuid.nullable(),
  branchName: z.string().nullable(),
  /** Whether it has somewhere to send calls when it is closed. Hours of its own need it. */
  hasAfterHours: z.boolean(),
  /** The numbers it answers directly. */
  numbers: z.array(z.object({ id: Uuid, e164: z.string(), label: z.string().nullable() })),
  /** Its own seven days, empty when none were written. Kept when it follows other hours. */
  ownWeek: z.array(Day),
  /** Its own days off, read only while it keeps its own hours. */
  ownHolidays: z.array(Holiday),
  /**
   * What it goes by today: `follows_number` (the number each call came in on), `menu` (its own week),
   * `branch`, `company`, or `none` when there is no week to go by.
   */
  goesBy: z.object({
    source: z.enum(["follows_number", "menu", "number", "branch", "company", "none"]),
    whose: z.string(),
    days: z.array(Day),
  }),
});

export const getMenuHours = defineRoute({
  method: "get",
  path: "/v1/phone-menus/{id}/hours",
  summary: "The hours and days off a phone menu goes by",
  description:
    "Where they come from (`hoursFrom`), the menu's own week and days off, and what it goes by today, with whose it is: a season's on the season's dates.",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({ id: Uuid }),
  output: MenuHours,
});

export const setMenuHours = defineRoute({
  method: "put",
  path: "/v1/phone-menus/{id}/hours",
  summary: "Where a phone menu's hours come from, and its own week",
  description:
    "`number` follows the hours of the number each call came in on, as every menu did before. `branch` follows `businessUnitId`'s hours (the company's for a branch keeping none) with its seasons and holidays, `company` the company's with its seasons and holidays, and `own` its own week and days off and none of the company's: `days` sets all seven, and choosing `own` with no week given and none written before is refused. Anything but `number` is refused for a menu with no after hours setting, because a closed menu needs somewhere to send the caller. Its own week and days off are kept when it is switched away.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({
    id: Uuid, hoursFrom: HoursFrom, businessUnitId: Uuid.optional(), days: z.array(Day).length(7).optional(),
  }),
  output: MenuHours,
});

export const addMenuHoliday = defineRoute({
  method: "post",
  path: "/v1/phone-menus/{id}/holidays",
  summary: "Add a day off of the menu's own",
  description:
    "The same fields as a company holiday, without a branch: a date, a yearly date or a day of the week in a month, closed or open shorter. Checked against the menu's own list alone. Read only while the menu keeps its own hours.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: HolidayFields.omit({ businessUnitId: true }).extend({ id: Uuid }),
  output: Holiday,
});

export const removeMenuHoliday = defineRoute({
  method: "delete",
  path: "/v1/phone-menus/{id}/holidays/{holidayId}",
  summary: "Take a day off the menu's own list",
  description: "One already gone, or another menu's, answers with nothing removed.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, holidayId: Uuid }),
  output: z.object({ removed: z.boolean() }),
});

export const menuHoursRoutes = { getMenuHours, setMenuHours, addMenuHoliday, removeMenuHoliday } as const;
