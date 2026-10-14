import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, scopeOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { liveBranch } from "./branches";
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
 *
 * A BRANCH KEEPS ITS OWN beside the company's. A reader that knows which
 * branch it is asking about (a job's, a booking's service's) reads that
 * branch's list (`loadHolidays` with the branch), which is the company's and
 * the branch's own; one that does not reads the company's alone. Somebody
 * who sees only their own branch's work sees and changes only the company's
 * list as it stands and their own branch's: they may not change the
 * company's, because it closes every other branch too.
 */

type Row = typeof schema.companyHoliday.$inferSelect;

const asRule = (row: Row): rules.CompanyHoliday => ({
  name: row.name,
  date: row.date,
  repeatsYearly: row.repeatsYearly,
  closed: row.closed,
  openMinute: row.closed ? null : rules.minutesOf(row.opensAt),
  closeMinute: row.closed ? null : rules.minutesOf(row.closesAt),
  rule: row.rule ?? null,
  observed: row.observed,
  branchId: row.businessUnitId,
});

/**
 * One company's list, in core's shape, for a reader: the company's holidays,
 * and the branch's own when the reader knows the branch.
 *
 * Filtered by the organization explicitly, because online booking reads it
 * from a public page with no tenant context; inside a tenant the filter is a
 * backstop to row level security rather than the mechanism.
 */
export async function loadHolidays(
  db: Database, organizationId: string, branchId: string | null = null,
): Promise<rules.CompanyHoliday[]> {
  const rows = await db.select().from(schema.companyHoliday)
    .where(and(
      eq(schema.companyHoliday.organizationId, organizationId),
      branchId
        ? or(isNull(schema.companyHoliday.businessUnitId), eq(schema.companyHoliday.businessUnitId, branchId))
        : isNull(schema.companyHoliday.businessUnitId),
    ));
  return rows.map(asRule);
}

/** The list a job's readers ask: the company's and the job's branch's own. */
export async function holidaysForJob(db: Database, organizationId: string, jobId: string): Promise<rules.CompanyHoliday[]> {
  const [job] = await db.select({ branchId: schema.job.businessUnitId }).from(schema.job)
    .where(and(eq(schema.job.id, jobId), eq(schema.job.organizationId, organizationId))).limit(1);
  return loadHolidays(db, organizationId, job?.branchId ?? null);
}

export interface HolidayView {
  id: string;
  name: string;
  date: string;
  repeatsYearly: boolean;
  /** The day of the week in a month it falls on, for one that moves. */
  rule: rules.WeekdayRule | null;
  observed: rules.Observed;
  /** The branch whose own it is, or null for the whole company's. */
  businessUnitId: string | null;
  branchName: string | null;
  /** When it falls, in words: "Fourth Thursday of November". */
  when: string;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  /** The next date it falls on, from today in the company's zone. Null for one that has passed. */
  nextOn: string | null;
  /** "Closed" or "Open 08:00 to 12:00". */
  hours: string;
}

function view(row: Row, today: string, branchName: string | null): HolidayView {
  const rule = asRule(row);
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    repeatsYearly: row.repeatsYearly,
    rule: row.rule ?? null,
    observed: row.observed,
    businessUnitId: row.businessUnitId,
    branchName,
    when: rules.describeWhen(rule),
    closed: row.closed,
    opensAt: row.closed ? null : row.opensAt?.slice(0, 5) ?? null,
    closesAt: row.closed ? null : row.closesAt?.slice(0, 5) ?? null,
    nextOn: rules.nextDate(rule, today),
    hours: rules.describeDay({ closed: rule.closed, hours: rule.closed ? null : { openMinute: rule.openMinute!, closeMinute: rule.closeMinute! } }),
  };
}

/** Whether this person sees the whole company's work, or only one branch's. */
const ownBranchOnly = (ctx: ServiceContext): string | null | false =>
  scopeOf(ctx, "job") === "all" ? false : ctx.actor.businessUnitId ?? null;

async function branchNames(tx: Database, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
    .from(schema.businessUnit).where(inArray(schema.businessUnit.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The list, coming ones first in the order they come, then the ones that
 * have passed. Somebody who sees one branch sees the company's and that
 * branch's own; another branch's days off are not theirs to read.
 */
export async function list(ctx: ServiceContext): Promise<HolidayView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const own = ownBranchOnly(ctx);
    const rows = (await tx.select().from(schema.companyHoliday).orderBy(asc(schema.companyHoliday.date)))
      .filter((row) => own === false || row.businessUnitId === null || row.businessUnitId === own);
    const names = await branchNames(tx, rows.map((r) => r.businessUnitId));
    const views = rows.map((row) => view(row, today, row.businessUnitId ? names.get(row.businessUnitId) ?? null : null));
    return [
      ...views.filter((v) => v.nextOn !== null).sort((a, b) => a.nextOn!.localeCompare(b.nextOn!)),
      ...views.filter((v) => v.nextOn === null).sort((a, b) => b.date.localeCompare(a.date)),
    ];
  });
}

export interface HolidayInput {
  name: string;
  /** Required for a date; for a rule, left out and worked out as this year's. */
  date?: string | undefined;
  repeatsYearly?: boolean | undefined;
  /** A day of the week in a month, for a holiday that moves. It repeats every year. */
  rule?: rules.WeekdayRule | null | undefined;
  observed?: rules.Observed | undefined;
  /** A branch's own holiday. Absent or null is the whole company's. */
  businessUnitId?: string | null | undefined;
  closed: boolean;
  /** "HH:MM", wall clock in the company's zone, when open. */
  opensAt?: string | null | undefined;
  closesAt?: string | null | undefined;
}

/**
 * Core's check, turned into a refusal in core's own words. A rule always
 * repeats, and its `date` is this year's, kept only so a list can sort it.
 */
function checked(input: HolidayInput, today: string): rules.CompanyHoliday {
  const rule = input.rule ?? null;
  const ruleWrong = rule ? rules.checkRule(rule) : null;
  if (ruleWrong) throw new ConflictError(ruleWrong);
  const date = rule ? rules.weekdayOfMonth(Number(today.slice(0, 4)), rule) : input.date;
  if (!date) throw new ConflictError("Say which date it is, or the day of the week and month it falls on.");
  const holiday: rules.CompanyHoliday = {
    name: input.name.trim(),
    date,
    repeatsYearly: rule ? true : input.repeatsYearly ?? false,
    closed: input.closed,
    openMinute: input.closed ? null : rules.minutesOf(input.opensAt),
    closeMinute: input.closed ? null : rules.minutesOf(input.closesAt),
    rule,
    observed: input.observed ?? "as_is",
    branchId: input.businessUnitId ?? null,
  };
  const verdict = rules.checkHoliday(holiday);
  if (!verdict.ok) throw new ConflictError(verdict.message);
  return holiday;
}

/**
 * Two entries for one date in one list would make the answer depend on which
 * row was read first, so the second is refused in words. A yearly one and a
 * one off on the same day are allowed: the one off is this year's exception,
 * and core reads it first. So are a branch's own and the company's: the
 * branch's is read first. Two that repeat are compared over the next ten
 * years, because a rule and a date can meet only some years (the fourth
 * Thursday of November is the 26th one year in seven).
 */
async function refuseClash(tx: Database, holiday: rules.CompanyHoliday, exceptId: string | null, today: string): Promise<void> {
  const others = (await tx.select().from(schema.companyHoliday)
    .where(eq(schema.companyHoliday.repeatsYearly, holiday.repeatsYearly)))
    .filter((row) => row.id !== exceptId && (row.businessUnitId ?? null) === (holiday.branchId ?? null));
  if (!holiday.repeatsYearly) {
    const clash = others.find((row) => row.date === holiday.date);
    if (clash) throw new ConflictError(`"${clash.name}" is already on the list for ${clash.date}. Change that one instead.`);
    return;
  }
  const plain = (h: rules.CompanyHoliday) => !h.rule && (h.observed ?? "as_is") === "as_is";
  const sameDay = others.find((row) => plain(holiday) && plain(asRule(row)) && row.date.slice(5) === holiday.date.slice(5));
  if (sameDay) throw new ConflictError(`"${sameDay.name}" is already on the list every year on that day. Change that one instead.`);
  const year = Number(today.slice(0, 4));
  for (const row of others) {
    for (let y = year; y < year + 10; y += 1) {
      const mine = rules.occurrenceIn(holiday, y);
      if (mine && rules.fallsOn(asRule(row), mine)) {
        throw new ConflictError(`"${row.name}" is already on the list on ${mine}, the same day as this one that year. Change that one instead.`);
      }
    }
  }
}

/**
 * Whether this person may keep a holiday for this branch, or for the whole
 * company (null). Somebody who sees one branch keeps that branch's own and
 * nothing else; a branch named that is not a live one is refused.
 */
async function mayKeep(tx: Database, ctx: ServiceContext, branchId: string | null): Promise<void> {
  const own = ownBranchOnly(ctx);
  if (own !== false && branchId !== own) {
    throw new ConflictError(own
      ? "You keep your own branch's holidays. The company's list, and other branches', are kept by somebody who sees the whole company."
      : "Holidays are kept by somebody who sees the whole company or a branch's own work.");
  }
  if (branchId) await liveBranch(tx, ctx, branchId);
}

const columns = (holiday: rules.CompanyHoliday) => ({
  name: holiday.name,
  date: holiday.date,
  repeatsYearly: holiday.repeatsYearly,
  rule: holiday.rule ?? null,
  observed: holiday.observed ?? "as_is",
  businessUnitId: holiday.branchId ?? null,
  closed: holiday.closed,
  opensAt: holiday.closed ? null : clockOf(holiday.openMinute!),
  closesAt: holiday.closed ? null : clockOf(holiday.closeMinute!),
});

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A holiday's view with its branch's name. */
async function viewOf(tx: Database, ctx: ServiceContext, row: Row): Promise<HolidayView> {
  const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
  const names = await branchNames(tx, [row.businessUnitId]);
  return view(row, today, row.businessUnitId ? names.get(row.businessUnitId) ?? null : null);
}

export async function create(ctx: ServiceContext, input: HolidayInput): Promise<HolidayView> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const seen = await replayed<HolidayView>(tx, ctx, "company_holiday");
    if (seen) return seen;
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const holiday = checked(input, today);
    await mayKeep(tx, ctx, holiday.branchId ?? null);
    await refuseClash(tx, holiday, null, today);
    /** The branch said here, beside the rest, so the column's one writer is in plain sight. */
    const [row] = await tx.insert(schema.companyHoliday)
      .values({ organizationId: ctx.actor.organizationId, ...columns(holiday), businessUnitId: holiday.branchId ?? null }).returning();
    await audit(tx, ctx, "holiday.added", "company_holiday", row!.id, null, row);
    const answer = await viewOf(tx, ctx, row!);
    await remember(tx, ctx, "company_holiday", row!.id, answer);
    return answer;
  });
}

/** One the person may see, or not found: another branch's reads as not there. */
async function holidayWithin(tx: Database, ctx: ServiceContext, id: string): Promise<Row> {
  const [row] = await tx.select().from(schema.companyHoliday).where(eq(schema.companyHoliday.id, id)).limit(1);
  const own = ownBranchOnly(ctx);
  if (!row || (own !== false && row.businessUnitId !== null && row.businessUnitId !== own)) throw new NotFoundError("Holiday");
  return row;
}

export async function update(ctx: ServiceContext, input: HolidayInput & { id: string }): Promise<HolidayView> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const before = await holidayWithin(tx, ctx, input.id);
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    /** Left out, the branch it already has: a rename does not move a holiday to the whole company. */
    const holiday = checked({ ...input, businessUnitId: input.businessUnitId === undefined ? before.businessUnitId : input.businessUnitId }, today);
    await mayKeep(tx, ctx, before.businessUnitId);
    await mayKeep(tx, ctx, holiday.branchId ?? null);
    await refuseClash(tx, holiday, input.id, today);
    const [after] = await tx.update(schema.companyHoliday)
      .set({ ...columns(holiday), updatedAt: new Date() })
      .where(eq(schema.companyHoliday.id, input.id)).returning();
    await audit(tx, ctx, "holiday.changed", "company_holiday", input.id, before, after);
    return viewOf(tx, ctx, after!);
  });
}

/** Off the list. The audit line keeps what it said. Removing one already gone succeeds. */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ removed: boolean }> {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [existing] = await tx.select().from(schema.companyHoliday).where(eq(schema.companyHoliday.id, input.id)).limit(1);
    if (!existing) return { removed: false };
    await holidayWithin(tx, ctx, input.id);
    await mayKeep(tx, ctx, existing.businessUnitId);
    const [before] = await tx.delete(schema.companyHoliday)
      .where(eq(schema.companyHoliday.id, input.id)).returning();
    if (!before) return { removed: false };
    await audit(tx, ctx, "holiday.removed", "company_holiday", input.id, before, null);
    return { removed: true };
  });
}

/* ------------------------------------------------------------- readers */

/** The dates in `[from, to]` the company, or one branch of it, is shut all day. */
export async function closedDates(
  db: Database, organizationId: string, from: string, to: string, branchId: string | null = null,
): Promise<Set<string>> {
  const list = await loadHolidays(db, organizationId, branchId);
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
