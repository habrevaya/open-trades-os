import { and, asc, eq, ne } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";

/**
 * THE COMPANY'S HOLIDAY LIST
 *
 * The dates the week's hours do not apply to: closed, or open with hours of
 * their own. The rules are core's (`holidays`); this keeps the list and hands
 * it to the readers in the shape each needs, so a holiday added here is a
 * closed day on the booking page, an after hours call on the phones, a day
 * the reviews clock does not count and a day a recurring task can skip, all
 * at once.
 *
 * Written with `booking:configure`, the permission the week's hours are
 * written with, because the two are one answer to "when are you open".
 */

type Row = typeof schema.companyHoliday.$inferSelect;

const asRule = (row: Row): rules.CompanyHoliday => ({
  name: row.name,
  date: row.date,
  repeatsYearly: row.repeatsYearly,
  closed: row.closed,
  openMinute: row.closed ? null : rules.minutesOf(row.opensAt),
  closeMinute: row.closed ? null : rules.minutesOf(row.closesAt),
});

/**
 * One company's list, in core's shape, for a reader.
 *
 * Filtered by the organization explicitly, because online booking reads it
 * from a public page with no tenant context; inside a tenant the filter is a
 * backstop to row level security rather than the mechanism.
 */
export async function loadHolidays(db: Database, organizationId: string): Promise<rules.CompanyHoliday[]> {
  const rows = await db.select().from(schema.companyHoliday)
    .where(eq(schema.companyHoliday.organizationId, organizationId));
  return rows.map(asRule);
}

export interface HolidayView {
  id: string;
  name: string;
  date: string;
  repeatsYearly: boolean;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  /** The next date it falls on, from today in the company's zone. Null for one that has passed. */
  nextOn: string | null;
  /** "Closed" or "Open 08:00 to 12:00". */
  hours: string;
}

function view(row: Row, today: string): HolidayView {
  const rule = asRule(row);
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    repeatsYearly: row.repeatsYearly,
    closed: row.closed,
    opensAt: row.closed ? null : row.opensAt?.slice(0, 5) ?? null,
    closesAt: row.closed ? null : row.closesAt?.slice(0, 5) ?? null,
    nextOn: rules.nextDate(rule, today),
    hours: rules.describeDay({ closed: rule.closed, hours: rule.closed ? null : { openMinute: rule.openMinute!, closeMinute: rule.closeMinute! } }),
  };
}

/** The list, coming ones first in the order they come, then the ones that have passed. */
export async function list(ctx: ServiceContext): Promise<HolidayView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const rows = await tx.select().from(schema.companyHoliday).orderBy(asc(schema.companyHoliday.date));
    const views = rows.map((row) => view(row, today));
    return [
      ...views.filter((v) => v.nextOn !== null).sort((a, b) => a.nextOn!.localeCompare(b.nextOn!)),
      ...views.filter((v) => v.nextOn === null).sort((a, b) => b.date.localeCompare(a.date)),
    ];
  });
}

export interface HolidayInput {
  name: string;
  date: string;
  repeatsYearly?: boolean | undefined;
  closed: boolean;
  /** "HH:MM", wall clock in the company's zone, when open. */
  opensAt?: string | null | undefined;
  closesAt?: string | null | undefined;
}

/** Core's check, turned into a refusal in core's own words. */
function checked(input: HolidayInput): rules.CompanyHoliday {
  const holiday: rules.CompanyHoliday = {
    name: input.name.trim(),
    date: input.date,
    repeatsYearly: input.repeatsYearly ?? false,
    closed: input.closed,
    openMinute: input.closed ? null : rules.minutesOf(input.opensAt),
    closeMinute: input.closed ? null : rules.minutesOf(input.closesAt),
  };
  const verdict = rules.checkHoliday(holiday);
  if (!verdict.ok) throw new ConflictError(verdict.message);
  return holiday;
}

/**
 * Two entries for one date would make the answer depend on which row was
 * read first, so the second is refused in words. A yearly one and a one off
 * on the same day are allowed: the one off is this year's exception, and
 * core reads it first.
 */
async function refuseClash(tx: Database, holiday: rules.CompanyHoliday, exceptId: string | null): Promise<void> {
  const others = await tx.select().from(schema.companyHoliday)
    .where(and(
      eq(schema.companyHoliday.repeatsYearly, holiday.repeatsYearly),
      exceptId ? ne(schema.companyHoliday.id, exceptId) : undefined,
    ));
  const clash = others.find((row) => (holiday.repeatsYearly
    ? row.date.slice(5) === holiday.date.slice(5)
    : row.date === holiday.date));
  if (clash) {
    throw new ConflictError(holiday.repeatsYearly
      ? `"${clash.name}" is already on the list every year on that day. Change that one instead.`
      : `"${clash.name}" is already on the list for ${clash.date}. Change that one instead.`);
  }
}

const columns = (holiday: rules.CompanyHoliday) => ({
  name: holiday.name,
  date: holiday.date,
  repeatsYearly: holiday.repeatsYearly,
  closed: holiday.closed,
  opensAt: holiday.closed ? null : clockOf(holiday.openMinute!),
  closesAt: holiday.closed ? null : clockOf(holiday.closeMinute!),
});

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export async function create(ctx: ServiceContext, input: HolidayInput): Promise<HolidayView> {
  assertCan(ctx.actor, "booking:configure");
  const holiday = checked(input);
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const seen = await replayed<HolidayView>(tx, ctx, "company_holiday");
    if (seen) return seen;
    await refuseClash(tx, holiday, null);
    const [row] = await tx.insert(schema.companyHoliday)
      .values({ organizationId: ctx.actor.organizationId, ...columns(holiday) }).returning();
    await audit(tx, ctx, "holiday.added", "company_holiday", row!.id, null, row);
    const answer = view(row!, time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId)));
    await remember(tx, ctx, "company_holiday", row!.id, answer);
    return answer;
  });
}

export async function update(ctx: ServiceContext, input: HolidayInput & { id: string }): Promise<HolidayView> {
  assertCan(ctx.actor, "booking:configure");
  const holiday = checked(input);
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [before] = await tx.select().from(schema.companyHoliday)
      .where(eq(schema.companyHoliday.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Holiday");
    await refuseClash(tx, holiday, input.id);
    const [after] = await tx.update(schema.companyHoliday)
      .set({ ...columns(holiday), updatedAt: new Date() })
      .where(eq(schema.companyHoliday.id, input.id)).returning();
    await audit(tx, ctx, "holiday.changed", "company_holiday", input.id, before, after);
    return view(after!, time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId)));
  });
}

/** Off the list. The audit line keeps what it said. Removing one already gone succeeds. */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ removed: boolean }> {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [before] = await tx.delete(schema.companyHoliday)
      .where(eq(schema.companyHoliday.id, input.id)).returning();
    if (!before) return { removed: false };
    await audit(tx, ctx, "holiday.removed", "company_holiday", input.id, before, null);
    return { removed: true };
  });
}

/* ------------------------------------------------------------- readers */

/** The dates in `[from, to]` the company is shut all day. */
export async function closedDates(db: Database, organizationId: string, from: string, to: string): Promise<Set<string>> {
  const list = await loadHolidays(db, organizationId);
  return new Set(rules.holidaysBetween(list, from, to).filter((day) => day.closed).map((day) => day.date));
}

/**
 * The holidays from today for some weeks, as sentences, for the phone
 * assistant: what a caller asking "are you open on Friday" needs.
 */
export async function upcomingSentences(db: Database, organizationId: string, days = 60): Promise<string[]> {
  const list = await loadHolidays(db, organizationId);
  if (list.length === 0) return [];
  const today = time.dateIn(new Date(), await timezoneOf(db, organizationId));
  return rules.holidaysBetween(list, today, time.addDays(today, days))
    .map((day) => `${day.date} (${day.name}): ${rules.describeDay(day).toLowerCase()}`);
}

/* ------------------------------------------------------------- handlers */

export const handlers = {
  listHolidays: async (ctx: ServiceContext) => ({ holidays: await list(ctx) }),
  createHoliday: (ctx: ServiceContext, input: HolidayInput) => create(ctx, input),
  updateHoliday: (ctx: ServiceContext, input: HolidayInput & { id: string }) => update(ctx, input),
  removeHoliday: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
