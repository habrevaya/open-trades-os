import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { checkWeek, dayView, seasonRows, sorted, weekRows, type DayView } from "./business-hours";
import {
  checked, columns, loadHolidays, loadMenuHolidays, refuseClash, view as holidayView,
  type HolidayInput, type HolidayView,
} from "./holidays";
import { replayed, remember } from "./once";

/**
 * A PHONE MENU'S OWN HOURS
 *
 * A phone menu goes by the hours of the number the call came in on, as it
 * always has, unless it is told otherwise. A Sales menu behind the main menu
 * that shuts at five while the line stays open for emergencies, or a menu on
 * a branch's number that keeps the branch's summer hours, is the reason to
 * tell it otherwise: it can follow a branch's hours (the company's where the
 * branch keeps none), the company's, or a week and days off of its own.
 *
 * SEASON AWARE LIKE THE REST. A menu following a branch or the company goes
 * by the week in force on the day, a season's (summer hours, M02) on its
 * dates, and by that branch's or the company's holidays. A menu keeping its
 * own week has no seasons and reads its own days off and none of the
 * company's, exactly as a number keeping its own does.
 *
 * CHECKED WHEREVER THE CALL COMES FROM. A menu keeping hours of its own looks
 * at them when a number answers with it and when another menu, a ring group
 * or a waiting line sends a caller to it, and outside them sends the caller
 * where its after hours setting says. So it must have one: choosing hours of
 * its own for a menu with nowhere to send a closed call is refused, and so is
 * clearing that setting while it keeps them (core's `checkMenu`).
 *
 * Read with `settings:read` and changed with `settings:write`, as the menu is.
 */

type MenuRow = typeof schema.phoneMenu.$inferSelect;

/** What a menu keeping hours apart from the number's goes by on a date. */
export interface MenuHours {
  rows: (typeof schema.businessHours.$inferSelect)[];
  holidays: rules.CompanyHoliday[];
  source: rules.WeekSource;
  season: string | null;
}

/**
 * The week and days off a menu is routed by on a date (the company's today,
 * for a call), inside the caller's transaction. Null for a menu following the
 * number, which the caller already has.
 */
export async function hoursOfMenu(db: Database, organizationId: string, menu: MenuRow, on: string): Promise<MenuHours | null> {
  if (menu.hoursFrom === "number") return null;
  const chosen = rules.weekForMenu(await weekRows(db, organizationId),
    { id: menu.id, businessUnitId: menu.businessUnitId, hoursFrom: menu.hoursFrom }, await seasonRows(db, organizationId));
  const inForce = rules.weekOn(chosen, on);
  const holidays = menu.hoursFrom === "own"
    ? await loadMenuHolidays(db, organizationId, menu.id)
    : await loadHolidays(db, organizationId, menu.hoursFrom === "branch" ? menu.businessUnitId : null);
  return { rows: inForce.rows, holidays, source: chosen.source, season: inForce.season?.name ?? null };
}

export interface MenuHoursView {
  id: string;
  name: string;
  hoursFrom: rules.MenuHoursFrom;
  /** The branch it follows with `branch`; kept when it is switched away. */
  businessUnitId: string | null;
  branchName: string | null;
  /** Whether it has somewhere to send calls when it is closed. Hours of its own need it. */
  hasAfterHours: boolean;
  /** The numbers it answers directly. A menu reached only from another menu answers none. */
  numbers: { id: string; e164: string; label: string | null }[];
  /** Its own seven days, empty when none were written. */
  ownWeek: DayView[];
  /** Its own days off, coming first. */
  ownHolidays: HolidayView[];
  /** What it goes by today, and whose it is. `follows_number` when it follows the number each call came in on. */
  goesBy: { source: rules.WeekSource | "follows_number"; whose: string; days: DayView[] };
}

async function menuWithin(tx: Database, organizationId: string, id: string): Promise<MenuRow> {
  const [row] = await tx.select().from(schema.phoneMenu)
    .where(and(eq(schema.phoneMenu.id, id), eq(schema.phoneMenu.organizationId, organizationId))).limit(1);
  if (!row) throw new NotFoundError("Phone menu");
  return row;
}

async function viewWithin(tx: Database, organizationId: string, menu: MenuRow): Promise<MenuHoursView> {
  const rows = await weekRows(tx, organizationId);
  const own = rows.filter((r) => r.phoneMenuId === menu.id);
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const [unit] = menu.businessUnitId
    ? await tx.select({ name: schema.businessUnit.name }).from(schema.businessUnit)
      .where(eq(schema.businessUnit.id, menu.businessUnitId)).limit(1)
    : [];
  const branchName = unit?.name ?? null;
  const holidayRows = await tx.select().from(schema.companyHoliday)
    .where(eq(schema.companyHoliday.phoneMenuId, menu.id)).orderBy(asc(schema.companyHoliday.date));
  const ownHolidays = holidayRows.map((row) => holidayView(row, today, null));
  const numbers = await tx.select({ id: schema.phoneNumber.id, e164: schema.phoneNumber.e164, label: schema.phoneNumber.label })
    .from(schema.phoneNumber)
    .where(and(eq(schema.phoneNumber.menuId, menu.id), isNull(schema.phoneNumber.releasedAt)))
    .orderBy(asc(schema.phoneNumber.e164));

  let goesBy: MenuHoursView["goesBy"];
  if (menu.hoursFrom === "number") {
    goesBy = { source: "follows_number", whose: "The hours of the number each call came in on", days: [] };
  } else {
    const chosen = rules.weekForMenu(rows, { id: menu.id, businessUnitId: menu.businessUnitId, hoursFrom: menu.hoursFrom },
      await seasonRows(tx, organizationId));
    const inForce = rules.weekOn(chosen, today);
    const owner = inForce.season?.businessUnitId ? `${branchName ?? "The branch"}'s` : "The company's";
    const whose = inForce.season ? `${owner} ${inForce.season.name}, ${rules.describeSeason(inForce.season)}`
      : chosen.source === "menu" ? "Its own hours"
        : chosen.source === "branch" ? `${branchName ?? "The branch"}'s hours`
          : chosen.source === "company" ? "The company's hours"
            : menu.hoursFrom === "own" ? "No hours yet: its own week has not been set" : "No hours: the company has not set its week";
    goesBy = { source: chosen.source, whose, days: inForce.rows.map(dayView).sort((a, b) => a.dayOfWeek - b.dayOfWeek) };
  }
  return {
    id: menu.id,
    name: menu.name,
    hoursFrom: menu.hoursFrom,
    businessUnitId: menu.businessUnitId,
    branchName,
    hasAfterHours: menu.afterHoursTo !== null,
    numbers,
    ownWeek: sorted(own),
    ownHolidays: [
      ...ownHolidays.filter((h) => h.nextOn !== null).sort((a, b) => a.nextOn!.localeCompare(b.nextOn!)),
      ...ownHolidays.filter((h) => h.nextOn === null),
    ],
    goesBy,
  };
}

export async function view(ctx: ServiceContext, input: { id: string }): Promise<MenuHoursView> {
  return guardedRead(ctx, "settings:read", async (tx) =>
    viewWithin(tx, ctx.actor.organizationId, await menuWithin(tx, ctx.actor.organizationId, input.id)));
}

export interface SetMenuHoursInput {
  id: string;
  hoursFrom: rules.MenuHoursFrom;
  /** The branch to follow with `branch`; left out, the one it already has. */
  businessUnitId?: string | undefined;
  /** Its own seven days. Only with `hoursFrom: "own"`; left out, the week it already has. */
  days?: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[] | undefined;
}

/**
 * Where a menu's hours come from, and its own week when it keeps its own.
 * Refused in words: hours of its own for a menu with nowhere to send a closed
 * call, its own with no week given and none written before, a branch with no
 * branch named, and a branch that is not the company's.
 */
export async function setHours(ctx: ServiceContext, input: SetMenuHoursInput): Promise<MenuHoursView> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const menu = await menuWithin(tx, org, input.id);
    if (input.days && input.hoursFrom !== "own") {
      throw new ConflictError("A week of its own is only kept for a menu set to keep its own hours.");
    }
    if (input.businessUnitId !== undefined && input.hoursFrom !== "branch") {
      throw new ConflictError("A branch is only chosen for a menu set to follow a branch's hours.");
    }
    if (input.hoursFrom !== "number" && menu.afterHoursTo === null) {
      throw new ConflictError(
        "Choose where this menu sends calls when it is closed (After hours, on the menu) before giving it hours of its own.",
      );
    }
    const branchId = input.hoursFrom === "branch" ? input.businessUnitId ?? menu.businessUnitId : menu.businessUnitId;
    if (input.hoursFrom === "branch") {
      if (!branchId) throw new ConflictError("Choose the branch whose hours this menu follows.");
      const [unit] = await tx.select({ id: schema.businessUnit.id }).from(schema.businessUnit)
        .where(and(eq(schema.businessUnit.id, branchId), eq(schema.businessUnit.organizationId, org))).limit(1);
      if (!unit) throw new NotFoundError("Branch");
    }
    const ownRows = await tx.select().from(schema.businessHours)
      .where(and(eq(schema.businessHours.organizationId, org), eq(schema.businessHours.phoneMenuId, menu.id)));
    if (input.hoursFrom === "own" && !input.days && ownRows.length === 0) {
      throw new ConflictError("Say this menu's own hours for each day of the week, or let it follow other hours.");
    }
    if (input.days) {
      checkWeek(input.days);
      await tx.delete(schema.businessHours)
        .where(and(eq(schema.businessHours.organizationId, org), eq(schema.businessHours.phoneMenuId, menu.id)));
      await tx.insert(schema.businessHours).values(input.days.map((day) => ({
        organizationId: org,
        phoneMenuId: menu.id,
        dayOfWeek: day.dayOfWeek,
        opensAt: day.closed ? null : day.opensAt,
        closesAt: day.closed ? null : day.closesAt,
        closed: day.closed,
      })));
    }
    const [after] = await tx.update(schema.phoneMenu)
      .set({ hoursFrom: input.hoursFrom, businessUnitId: branchId, updatedAt: new Date() })
      .where(eq(schema.phoneMenu.id, menu.id)).returning();
    await audit(tx, ctx, "phone_menu.hours_set", "phone_menu", menu.id,
      { hoursFrom: menu.hoursFrom, businessUnitId: menu.businessUnitId, days: ownRows.length > 0 ? sorted(ownRows) : null },
      { hoursFrom: input.hoursFrom, businessUnitId: branchId, ...(input.days ? { days: input.days } : {}) });
    return viewWithin(tx, org, after!);
  });
}

/**
 * A day off of the menu's own: the same rules as the company's list,
 * checked against the menu's own list alone.
 */
export async function addHoliday(
  ctx: ServiceContext, input: Omit<HolidayInput, "businessUnitId"> & { id: string },
): Promise<HolidayView> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const seen = await replayed<HolidayView>(tx, ctx, "company_holiday");
    if (seen) return seen;
    const org = ctx.actor.organizationId;
    const menu = await menuWithin(tx, org, input.id);
    const today = time.dateIn(new Date(), await timezoneOf(tx, org));
    const { id: _id, ...fields } = input;
    const holiday = checked({ ...fields, businessUnitId: null }, today);
    await refuseClash(tx, holiday, null, today, null, menu.id);
    const [row] = await tx.insert(schema.companyHoliday)
      .values({ organizationId: org, ...columns(holiday), businessUnitId: null, phoneMenuId: menu.id }).returning();
    await audit(tx, ctx, "holiday.added", "company_holiday", row!.id, null, row);
    const answer = holidayView(row!, today, null);
    await remember(tx, ctx, "company_holiday", row!.id, answer);
    return answer;
  });
}

/** One of the menu's own days off removed. One already gone, or another menu's, reads as not there. */
export async function removeHoliday(
  ctx: ServiceContext, input: { id: string; holidayId: string },
): Promise<{ removed: boolean }> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    await menuWithin(tx, org, input.id);
    const [before] = await tx.delete(schema.companyHoliday)
      .where(and(
        eq(schema.companyHoliday.id, input.holidayId),
        eq(schema.companyHoliday.organizationId, org),
        eq(schema.companyHoliday.phoneMenuId, input.id),
      )).returning();
    if (!before) return { removed: false };
    await audit(tx, ctx, "holiday.removed", "company_holiday", input.holidayId, before, null);
    return { removed: true };
  });
}

/* ------------------------------------------------------------- handlers */

export const handlers = {
  getMenuHours: (ctx: ServiceContext, input: { id: string }) => view(ctx, input),
  setMenuHours: (ctx: ServiceContext, input: SetMenuHoursInput) => setHours(ctx, input),
  addMenuHoliday: (ctx: ServiceContext, input: Omit<HolidayInput, "businessUnitId"> & { id: string }) => addHoliday(ctx, input),
  removeMenuHoliday: (ctx: ServiceContext, input: { id: string; holidayId: string }) => removeHoliday(ctx, input),
} as const;
