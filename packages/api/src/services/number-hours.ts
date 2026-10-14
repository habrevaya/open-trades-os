import { and, asc, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { checkWeek, dayView, sorted, weekRows, type DayView } from "./business-hours";
import {
  checked, columns, loadHolidays, loadNumberHolidays, refuseClash, view as holidayView,
  type HolidayInput, type HolidayView,
} from "./holidays";
import { replayed, remember } from "./once";

/**
 * A PHONE NUMBER'S OWN HOURS AND DAYS OFF
 *
 * What a number set to route by hours (or answered by a phone menu) is routed
 * by: the week and holidays of the branch it answers for, the company's
 * whatever its branch, or a week and a list of days off of its own. An
 * emergency line open around the clock, or a sales line that keeps shorter
 * hours than the office, is the reason for the third.
 *
 * ITS OWN MEANS ITS OWN. A number keeping its own hours reads its own week
 * and its own days off and nothing of the company's: an emergency line that
 * rings on Christmas Day would otherwise be shut by the company's Christmas.
 * A day the company closes that the line closes too is added to the line's
 * own list. A number set to keep its own with no week written is not routed
 * by hours at all (core's `holidays.weekForNumber`), rather than borrowing
 * the company's week nobody chose for it.
 *
 * Its own week and days off are kept when it is switched to follow its
 * branch or the company, and used again if it is switched back: they are
 * what somebody typed, and a switch is not a reason to lose them.
 *
 * Read with `settings:read` and changed with `settings:write`, the
 * permissions a number's routing is read and set with, because this is part
 * of how its calls are answered rather than when the company is open.
 */

type NumberRow = typeof schema.phoneNumber.$inferSelect;

/** Where a number's calls are routed by hours from, as core takes it. */
export interface NumberHours {
  week: rules.WeekHours | null;
  /** The rows of the week chosen, which the phones' hours are built from. */
  rows: (typeof schema.businessHours.$inferSelect)[];
  holidays: rules.CompanyHoliday[];
  source: rules.WeekSource;
}

/**
 * The week and the days off a number's calls are routed by, inside a
 * transaction the caller holds (the voice webhook's).
 */
export async function hoursOfNumber(db: Database, organizationId: string, number: NumberRow): Promise<NumberHours> {
  const chosen = rules.weekForNumber(await weekRows(db, organizationId), {
    id: number.id, businessUnitId: number.businessUnitId, hoursFrom: number.hoursFrom,
  });
  const holidays = number.hoursFrom === "own"
    ? await loadNumberHolidays(db, organizationId, number.id)
    : await loadHolidays(db, organizationId, number.hoursFrom === "branch" ? number.businessUnitId : null);
  return { week: chosen.week, rows: chosen.rows, holidays, source: chosen.source };
}

export interface NumberHoursView {
  id: string;
  e164: string;
  label: string | null;
  /** Whether this product answers its calls at all: bought or answered here. */
  routedHere: boolean;
  /** Whether its calls are routed by hours, or a phone menu answers it. Otherwise its hours are not read. */
  usesHours: boolean;
  businessUnitId: string | null;
  branchName: string | null;
  hoursFrom: rules.NumberHoursFrom;
  /** Its own seven days, empty when none were written. */
  ownWeek: DayView[];
  /** Its own days off, coming first. */
  ownHolidays: HolidayView[];
  /** The week its calls are routed by now, and whose it is. */
  routedBy: { source: rules.WeekSource; whose: string; days: DayView[] };
}

async function numberWithin(tx: Database, organizationId: string, id: string): Promise<NumberRow> {
  const [row] = await tx.select().from(schema.phoneNumber)
    .where(and(eq(schema.phoneNumber.id, id), eq(schema.phoneNumber.organizationId, organizationId))).limit(1);
  if (!row) throw new NotFoundError("Phone number");
  return row;
}

async function viewWithin(tx: Database, organizationId: string, number: NumberRow): Promise<NumberHoursView> {
  const rows = await weekRows(tx, organizationId);
  const own = rows.filter((r) => r.phoneNumberId === number.id);
  const chosen = rules.weekForNumber(rows, { id: number.id, businessUnitId: number.businessUnitId, hoursFrom: number.hoursFrom });
  const [unit] = number.businessUnitId
    ? await tx.select({ name: schema.businessUnit.name }).from(schema.businessUnit)
      .where(eq(schema.businessUnit.id, number.businessUnitId)).limit(1)
    : [];
  const branchName = unit?.name ?? null;
  const today = time.dateIn(new Date(), await timezoneOf(tx, organizationId));
  const holidayRows = await tx.select().from(schema.companyHoliday)
    .where(eq(schema.companyHoliday.phoneNumberId, number.id)).orderBy(asc(schema.companyHoliday.date));
  const ownHolidays = holidayRows.map((row) => holidayView(row, today, null));
  const whose = chosen.source === "number" ? "Its own hours"
    : chosen.source === "branch" ? `${branchName ?? "Its branch"}'s hours`
      : chosen.source === "company" ? "The company's hours"
        : number.hoursFrom === "own" ? "No hours yet: its own week has not been set" : "No hours: the company has not set its week";
  return {
    id: number.id,
    e164: number.e164,
    label: number.label,
    routedHere: number.providerNumberId !== null,
    usesHours: number.routeByHours || number.menuId !== null,
    businessUnitId: number.businessUnitId,
    branchName,
    hoursFrom: number.hoursFrom,
    ownWeek: sorted(own),
    ownHolidays: [
      ...ownHolidays.filter((h) => h.nextOn !== null).sort((a, b) => a.nextOn!.localeCompare(b.nextOn!)),
      ...ownHolidays.filter((h) => h.nextOn === null),
    ],
    routedBy: { source: chosen.source, whose, days: chosen.rows.map(dayView).sort((a, b) => a.dayOfWeek - b.dayOfWeek) },
  };
}

export async function view(ctx: ServiceContext, input: { id: string }): Promise<NumberHoursView> {
  return guardedRead(ctx, "settings:read", async (tx) =>
    viewWithin(tx, ctx.actor.organizationId, await numberWithin(tx, ctx.actor.organizationId, input.id)));
}

export interface SetNumberHoursInput {
  id: string;
  hoursFrom: rules.NumberHoursFrom;
  /** Its own seven days. Only with `hoursFrom: "own"`; left out, the week it already has. */
  days?: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[] | undefined;
}

/**
 * Where a number's hours come from, and its own week when it keeps its own.
 * Choosing its own with no week given and none written before is refused in
 * words, so a number is never left routed by a week nobody set.
 */
export async function setHours(ctx: ServiceContext, input: SetNumberHoursInput): Promise<NumberHoursView> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const number = await numberWithin(tx, org, input.id);
    if (number.releasedAt) throw new ConflictError("That number has been handed back, so its calls are not answered here.");
    if (input.days && input.hoursFrom !== "own") {
      throw new ConflictError("A week of its own is only kept for a number set to keep its own hours.");
    }
    const ownRows = await tx.select().from(schema.businessHours)
      .where(and(eq(schema.businessHours.organizationId, org), eq(schema.businessHours.phoneNumberId, number.id)));
    if (input.hoursFrom === "own" && !input.days && ownRows.length === 0) {
      throw new ConflictError("Say this number's own hours for each day of the week, or let it follow its branch or the company.");
    }
    if (input.days) {
      checkWeek(input.days);
      await tx.delete(schema.businessHours)
        .where(and(eq(schema.businessHours.organizationId, org), eq(schema.businessHours.phoneNumberId, number.id)));
      await tx.insert(schema.businessHours).values(input.days.map((day) => ({
        organizationId: org,
        phoneNumberId: number.id,
        dayOfWeek: day.dayOfWeek,
        opensAt: day.closed ? null : day.opensAt,
        closesAt: day.closed ? null : day.closesAt,
        closed: day.closed,
      })));
    }
    const [after] = await tx.update(schema.phoneNumber)
      .set({ hoursFrom: input.hoursFrom, updatedAt: new Date() })
      .where(eq(schema.phoneNumber.id, number.id)).returning();
    await audit(tx, ctx, "phone_number.hours_set", "phone_number", number.id,
      { hoursFrom: number.hoursFrom, days: ownRows.length > 0 ? sorted(ownRows) : null },
      { hoursFrom: input.hoursFrom, ...(input.days ? { days: input.days } : {}) });
    return viewWithin(tx, org, after!);
  });
}

/**
 * A day off of the number's own. The same rules as the company's list (a
 * date, a yearly date or one that moves, closed or open shorter, and no two
 * on one day), checked against the number's own list alone.
 */
export async function addHoliday(
  ctx: ServiceContext, input: Omit<HolidayInput, "businessUnitId"> & { id: string },
): Promise<HolidayView> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const seen = await replayed<HolidayView>(tx, ctx, "company_holiday");
    if (seen) return seen;
    const org = ctx.actor.organizationId;
    const number = await numberWithin(tx, org, input.id);
    if (number.releasedAt) throw new ConflictError("That number has been handed back, so its calls are not answered here.");
    const today = time.dateIn(new Date(), await timezoneOf(tx, org));
    const { id: _id, ...fields } = input;
    const holiday = checked({ ...fields, businessUnitId: null }, today);
    await refuseClash(tx, holiday, null, today, number.id);
    const [row] = await tx.insert(schema.companyHoliday)
      .values({ organizationId: org, ...columns(holiday), businessUnitId: null, phoneNumberId: number.id }).returning();
    await audit(tx, ctx, "holiday.added", "company_holiday", row!.id, null, row);
    const answer = holidayView(row!, today, null);
    await remember(tx, ctx, "company_holiday", row!.id, answer);
    return answer;
  });
}

/** One of the number's own days off removed. One already gone, or another number's, reads as not there. */
export async function removeHoliday(
  ctx: ServiceContext, input: { id: string; holidayId: string },
): Promise<{ removed: boolean }> {
  assertCan(ctx.actor, "settings:write");
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;
    await numberWithin(tx, org, input.id);
    const [before] = await tx.delete(schema.companyHoliday)
      .where(and(
        eq(schema.companyHoliday.id, input.holidayId),
        eq(schema.companyHoliday.organizationId, org),
        eq(schema.companyHoliday.phoneNumberId, input.id),
      )).returning();
    if (!before) return { removed: false };
    await audit(tx, ctx, "holiday.removed", "company_holiday", input.holidayId, before, null);
    return { removed: true };
  });
}

/* ------------------------------------------------------------- handlers */

export const handlers = {
  getNumberHours: (ctx: ServiceContext, input: { id: string }) => view(ctx, input),
  setNumberHours: (ctx: ServiceContext, input: SetNumberHoursInput) => setHours(ctx, input),
  addNumberHoliday: (ctx: ServiceContext, input: Omit<HolidayInput, "businessUnitId"> & { id: string }) => addHoliday(ctx, input),
  removeNumberHoliday: (ctx: ServiceContext, input: { id: string; holidayId: string }) => removeHoliday(ctx, input),
} as const;
