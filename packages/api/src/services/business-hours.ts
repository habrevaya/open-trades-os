import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { liveBranch } from "./branches";
import { remember, replayed } from "./once";
import { loadHolidays } from "./holidays";

/**
 * THE WEEK'S HOURS: THE COMPANY'S, AND A BRANCH'S OWN
 *
 * `business_hours` keeps seven rows for the company and, for a branch that
 * opens on other days, seven of its own. A branch with none keeps the
 * company's. Core's `holidays.weekFor` is the rule, so every reader that
 * knows a branch falls back the same way: online booking (the service's
 * branch), the after hours offer and the pricing rule on work outside the
 * hours (the job's), the crew check (the job's), task escalation counting
 * working hours (the task's job's), the multi day rebalance (each visit's
 * job's), a route's density (whoever runs it) and the phones (a number's
 * branch). A reader that knows no branch reads the company's alone, never
 * a branch's.
 *
 * Written with `booking:configure`, the permission the company's week has
 * always been set with, and read with `settings:read`, as the holiday list
 * is: the two are one answer to "when are you open". Somebody who sees only
 * their own branch's work sees the company's week and their own branch's,
 * and changes only their own branch's, because the company's week opens and
 * closes every branch that keeps none.
 *
 * SEASONS. The company or a branch can keep dated weeks over its normal one
 * (summer hours from June 1 to August 31), in `business_hours_season` with
 * their seven rows here. Every reader that asks about a date reads the week
 * in force on it (core's `holidays.weekOn`, `hoursOnDate`, `bookedAt` and
 * the working calendar all take the seasons `loadWeek` hands them). An
 * owner's seasons never overlap: one that would is refused in words.
 */

type Row = typeof schema.businessHours.$inferSelect;
type SeasonRow = typeof schema.businessHoursSeason.$inferSelect;

/**
 * Every week the company keeps, in core's shape. Filtered by the
 * organization explicitly, because online booking reads it from a public page
 * with no tenant context; inside a tenant the filter is a backstop to row
 * level security rather than the mechanism.
 */
export async function weekRows(db: Database, organizationId: string): Promise<Row[]> {
  return db.select().from(schema.businessHours)
    .where(eq(schema.businessHours.organizationId, organizationId));
}

/** Every season the company keeps, its own and its branches', in core's shape. Filtered as `weekRows` is. */
export async function seasonRows(db: Database, organizationId: string): Promise<rules.SeasonDef[]> {
  const rows = await db.select().from(schema.businessHoursSeason)
    .where(eq(schema.businessHoursSeason.organizationId, organizationId))
    .orderBy(asc(schema.businessHoursSeason.startsOn));
  return rows.map(seasonDef);
}

const seasonDef = (row: SeasonRow): rules.SeasonDef => ({
  id: row.id, businessUnitId: row.businessUnitId, name: row.name,
  startsOn: row.startsOn, endsOn: row.endsOn, repeatsYearly: row.repeatsYearly,
});

/**
 * The week a reader that knows a branch reads: the branch's own, or the
 * company's, with the seasons over it. A reader asking about a date reads
 * `rules.weekOn(chosen, date)` or hands `seasons` to core with the week.
 */
export async function loadWeek(
  db: Database, organizationId: string, branchId: string | null = null,
): Promise<rules.ChosenWeek<Row>> {
  return rules.weekFor(await weekRows(db, organizationId), branchId, await seasonRows(db, organizationId));
}

/** The normal week and its seasons, as core's date readers (`bookedAt`, the working calendar) take them. */
export const weekAndSeasons = (chosen: rules.ChosenWeek<Row>) => ({ week: chosen.week, seasons: chosen.seasons });

/**
 * The weeks of several branches from one read, for a reader that asks about
 * many at once (the rebalance, over every visit in a range).
 */
export async function weeksByBranch(
  db: Database, organizationId: string,
): Promise<(branchId: string | null) => rules.ChosenWeek<Row>> {
  const rows = await weekRows(db, organizationId);
  const seasons = await seasonRows(db, organizationId);
  const cache = new Map<string | null, rules.ChosenWeek<Row>>();
  return (branchId) => {
    if (!cache.has(branchId)) cache.set(branchId, rules.weekFor(rows, branchId, seasons));
    return cache.get(branchId)!;
  };
}

/* ------------------------------------------------------------- one date */

/** What a branch (or the company) keeps on one date, for the board. */
export interface DayHoursView {
  /** The branch asked about, or null for the company. */
  branchId: string | null;
  /** "HH:MM" in the company's zone. Null on a closed day or when nobody has said. */
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
  /** False when no week is declared and no holiday says anything: then not known, never closed. */
  known: boolean;
  /** The season in force that date (summer hours), or null for the normal week. */
  season: string | null;
  /** The holiday on that date, when the list says something about it. */
  holiday: string | null;
  /** The day in a sentence: "Open 6:00 AM to 2:00 PM, Summer hours." */
  words: string;
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/** "6:00 AM", as the board writes a time. */
export const clockWords = (minute: number) => {
  if (minute >= 24 * 60) return "midnight";
  const h = Math.floor(minute / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * The hours several branches keep on one date, from one read of the weeks,
 * seasons and holidays: the week in force (a season's where one covers the
 * date), with the holiday list over it.
 */
export async function hoursOnDay(
  db: Database, organizationId: string, date: string,
): Promise<(branchId: string | null) => Promise<DayHoursView>> {
  const weekOf = await weeksByBranch(db, organizationId);
  const cache = new Map<string | null, DayHoursView>();
  return async (branchId) => {
    if (cache.has(branchId)) return cache.get(branchId)!;
    const chosen = weekOf(branchId);
    const inForce = rules.weekOn(chosen, date);
    const kept = rules.hoursOnDate(date, chosen.week, await loadHolidays(db, organizationId, branchId), chosen.seasons);
    const season = kept.holiday ? null : inForce.season?.name ?? null;
    const holiday = kept.holiday?.name ?? null;
    const words = !kept.known ? "No opening hours set."
      : kept.hours === null
        ? holiday ? `Closed for ${holiday}.` : `Closed on ${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}${season ? ` in ${season}` : ""}.`
        : `Open ${clockWords(kept.hours.openMinute)} to ${clockWords(kept.hours.closeMinute)}${holiday ? ` for ${holiday}` : season ? `, ${season}` : ""}.`;
    const view: DayHoursView = {
      branchId,
      opensAt: kept.hours ? hhmm(kept.hours.openMinute) : null,
      closesAt: kept.hours ? hhmm(kept.hours.closeMinute) : null,
      closed: kept.known && kept.hours === null,
      known: kept.known,
      season,
      holiday,
      words,
    };
    cache.set(branchId, view);
    return view;
  };
}

/* ------------------------------------------------------------- the screen */

export interface DayView {
  dayOfWeek: number;
  /** "HH:MM", wall clock in the company's zone. Null on a closed day. */
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
}

export interface BranchWeekView {
  businessUnitId: string;
  name: string;
  /** "branch" when it keeps its own week, "company" when it keeps the company's. */
  source: "branch" | "company";
  /** The week it keeps, its own or the company's: what booking and the rest read for it. */
  days: DayView[];
}

export interface HoursView {
  /** The company's week, empty when nobody has set it. */
  company: DayView[];
  /** Each live branch this person sees, with the week it keeps. */
  branches: BranchWeekView[];
}

export const dayView = (row: Pick<Row, "dayOfWeek" | "opensAt" | "closesAt" | "closed">): DayView => ({
  dayOfWeek: row.dayOfWeek,
  opensAt: row.closed ? null : row.opensAt?.slice(0, 5) ?? null,
  closesAt: row.closed ? null : row.closesAt?.slice(0, 5) ?? null,
  closed: row.closed,
});

export const sorted = (rows: Pick<Row, "dayOfWeek" | "opensAt" | "closesAt" | "closed">[]) => [...rows].sort((a, b) => a.dayOfWeek - b.dayOfWeek).map(dayView);

/** Whether this person sees the whole company's work, or only one branch's. */
const ownBranchOnly = (ctx: ServiceContext): string | null | false =>
  scopeOf(ctx, "job") === "all" ? false : ctx.actor.businessUnitId ?? null;

/**
 * The company's week and each live branch's. Somebody who sees one branch
 * sees the company's and their own branch's; another branch's hours are not
 * theirs to read.
 */
export async function list(ctx: ServiceContext): Promise<HoursView> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await weekRows(tx, ctx.actor.organizationId);
    const own = ownBranchOnly(ctx);
    const units = (await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
      .from(schema.businessUnit)
      .where(and(eq(schema.businessUnit.organizationId, ctx.actor.organizationId), eq(schema.businessUnit.active, true)))
      .orderBy(asc(schema.businessUnit.name)))
      .filter((unit) => own === false || unit.id === own);
    return {
      company: sorted(rules.weekFor(rows, null).rows),
      branches: units.map((unit) => {
        const chosen = rules.weekFor(rows, unit.id);
        return {
          businessUnitId: unit.id,
          name: unit.name,
          source: chosen.source === "branch" ? "branch" as const : "company" as const,
          days: sorted(chosen.rows),
        };
      }),
    };
  });
}

/* ------------------------------------------------------------- writing */

export interface WeekInput {
  days: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
  /** A branch's own week. Absent or null is the company's. */
  businessUnitId?: string | null | undefined;
}

/**
 * Whether this person may set the week of this branch, or the company's
 * (null). Somebody who sees one branch sets that branch's and nothing else;
 * a branch named that is not a live one is refused.
 */
async function mayKeep(tx: Database, ctx: ServiceContext, branchId: string | null): Promise<void> {
  const own = ownBranchOnly(ctx);
  /** Narrowed with no branch to be narrowed to sees no branch's work, so sets nobody's hours. */
  if (own !== false && (own === null || branchId !== own)) {
    throw new ConflictError(own
      ? "You set your own branch's hours. The company's hours, and other branches', are set by somebody who sees the whole company."
      : "Hours are set by somebody who sees the whole company or a branch's own work.");
  }
  if (branchId) await liveBranch(tx, ctx, branchId);
}

/**
 * All seven days every time, because a partial week is ambiguous: a missing
 * Saturday row could mean closed or could mean nobody has said yet, and
 * booking treats an absent row as closed. Requiring the full set makes the
 * answer explicit for every day.
 */
export function checkWeek(days: WeekInput["days"]): void {
  const seen = new Set(days.map((d) => d.dayOfWeek));
  if (seen.size !== 7 || days.length !== 7) {
    throw new ConflictError("Send all seven days. A day left out is a day nobody has answered for.");
  }
  for (const day of days) {
    if (day.closed) continue;
    if (!day.opensAt || !day.closesAt) {
      throw new ConflictError(`Day ${day.dayOfWeek} is open and has no hours. Say when, or mark it closed.`);
    }
    if (day.closesAt <= day.opensAt) {
      throw new ConflictError(`Day ${day.dayOfWeek} closes at ${day.closesAt} and opens at ${day.opensAt}.`);
    }
  }
}

/**
 * Only the owner's own rows: the company's never touch a branch's or a phone
 * number's, and a branch's never the company's.
 */
const ownerIs = (organizationId: string, branchId: string | null) => and(
  eq(schema.businessHours.organizationId, organizationId),
  branchId ? eq(schema.businessHours.businessUnitId, branchId) : isNull(schema.businessHours.businessUnitId),
  isNull(schema.businessHours.phoneNumberId),
  /** A season's rows are the season's, changed with it. */
  isNull(schema.businessHours.seasonId),
);

/**
 * The company's week, or a branch's own. Replaces that owner's seven rows
 * and no other's: setting the company's week leaves a branch that keeps its
 * own as it was.
 */
export async function setWeek(ctx: ServiceContext, input: WeekInput): Promise<{ days: number }> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const branchId = input.businessUnitId ?? null;
    await mayKeep(tx, ctx, branchId);
    checkWeek(input.days);
    const before = await tx.select().from(schema.businessHours).where(ownerIs(ctx.actor.organizationId, branchId));
    await tx.delete(schema.businessHours).where(ownerIs(ctx.actor.organizationId, branchId));
    await tx.insert(schema.businessHours).values(input.days.map((day) => ({
      organizationId: ctx.actor.organizationId,
      businessUnitId: branchId,
      dayOfWeek: day.dayOfWeek,
      opensAt: day.closed ? null : day.opensAt,
      closesAt: day.closed ? null : day.closesAt,
      closed: day.closed,
    })));
    await audit(tx, ctx, "booking.hours.set", branchId ? "business_unit" : "organization",
      branchId ?? ctx.actor.organizationId, before.length > 0 ? { days: sorted(before) } : null,
      { open: input.days.filter((d) => !d.closed).length, ...(branchId ? { businessUnitId: branchId } : {}) });
    return { days: input.days.length };
  });
}

/**
 * A branch back on the company's week: its own rows go, and every reader
 * reads the company's for it from then on. One that keeps none already
 * answers the same, so asking twice is not an error.
 */
export async function followCompany(
  ctx: ServiceContext, input: { businessUnitId: string },
): Promise<{ businessUnitId: string; removed: number }> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const own = ownBranchOnly(ctx);
    if (own !== false && input.businessUnitId !== own) throw new NotFoundError("Branch");
    const [unit] = await tx.select({ id: schema.businessUnit.id }).from(schema.businessUnit)
      .where(and(eq(schema.businessUnit.id, input.businessUnitId), eq(schema.businessUnit.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!unit) throw new NotFoundError("Branch");
    const removed = await tx.delete(schema.businessHours)
      .where(ownerIs(ctx.actor.organizationId, input.businessUnitId)).returning();
    if (removed.length > 0) {
      await audit(tx, ctx, "booking.hours.followed_company", "business_unit", input.businessUnitId,
        { days: sorted(removed) }, null);
    }
    return { businessUnitId: input.businessUnitId, removed: removed.length };
  });
}


/* ------------------------------------------------------------- seasons */

export interface SeasonView {
  id: string;
  /** The branch whose season it is, or null for the company's. */
  businessUnitId: string | null;
  branchName: string | null;
  name: string;
  startsOn: string;
  endsOn: string;
  repeatsYearly: boolean;
  /** When it runs, in words: "June 1 to August 31, every year". */
  when: string;
  /** Its seven days. */
  days: DayView[];
  /** Whether it is in force today, in the company's zone. */
  inForceToday: boolean;
}

export interface SeasonInput {
  name: string;
  /** `YYYY-MM-DD`. For one that repeats, only the month and day are read. */
  startsOn: string;
  endsOn: string;
  repeatsYearly?: boolean | undefined;
  /** A branch's own season. Absent or null is the company's. */
  businessUnitId?: string | null | undefined;
  days: WeekInput["days"];
}

async function seasonViews(tx: Database, ctx: ServiceContext, rows: SeasonRow[]): Promise<SeasonView[]> {
  if (rows.length === 0) return [];
  const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
  const days = await tx.select().from(schema.businessHours)
    .where(inArray(schema.businessHours.seasonId, rows.map((r) => r.id)));
  const branchIds = [...new Set(rows.map((r) => r.businessUnitId).filter((id): id is string => id !== null))];
  const units = branchIds.length === 0 ? [] : await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
    .from(schema.businessUnit).where(inArray(schema.businessUnit.id, branchIds));
  return rows.map((row) => ({
    id: row.id,
    businessUnitId: row.businessUnitId,
    branchName: row.businessUnitId ? units.find((u) => u.id === row.businessUnitId)?.name ?? null : null,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    repeatsYearly: row.repeatsYearly,
    when: rules.describeSeason(row),
    days: sorted(days.filter((d) => d.seasonId === row.id)),
    inForceToday: rules.seasonCovers(row, today),
  }));
}

/**
 * The company's seasons and each branch's, coming first in the order they
 * start. Somebody who sees one branch sees the company's and their own
 * branch's, as with the week.
 */
export async function listSeasons(ctx: ServiceContext): Promise<{ seasons: SeasonView[] }> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const own = ownBranchOnly(ctx);
    const rows = (await tx.select().from(schema.businessHoursSeason)
      .where(eq(schema.businessHoursSeason.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.businessHoursSeason.startsOn), asc(schema.businessHoursSeason.name)))
      .filter((row) => own === false || row.businessUnitId === null || row.businessUnitId === own);
    return { seasons: await seasonViews(tx, ctx, rows) };
  });
}

/** The dates and the week, checked, in words when they are wrong. */
function checkedSeason(input: SeasonInput): { name: string; startsOn: string; endsOn: string; repeatsYearly: boolean } {
  const season = {
    name: input.name.trim(), startsOn: input.startsOn, endsOn: input.endsOn, repeatsYearly: input.repeatsYearly ?? false,
  };
  const check = rules.checkSeason(season);
  if (!check.ok) throw new ConflictError(check.message);
  checkWeek(input.days);
  return season;
}

/**
 * Refuses a season that would be in force on a date another of the same
 * owner's already is, naming it. Under a lock on the owner, so two people
 * saving overlapping seasons at once cannot both get in.
 */
async function refuseOverlap(
  tx: Database, organizationId: string, branchId: string | null, season: rules.SeasonSpan, exceptId: string | null,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hours-season:${organizationId}:${branchId ?? "company"}`}))`);
  const others = (await tx.select().from(schema.businessHoursSeason)
    .where(and(
      eq(schema.businessHoursSeason.organizationId, organizationId),
      branchId ? eq(schema.businessHoursSeason.businessUnitId, branchId) : isNull(schema.businessHoursSeason.businessUnitId),
    )))
    .filter((row) => row.id !== exceptId);
  const clash = rules.seasonClash(season, others);
  if (clash) {
    throw new ConflictError(
      `This season runs ${rules.describeSeason(season)}, which overlaps "${clash.name}" (${rules.describeSeason(clash)}). `
      + "A day can keep only one season's hours. Change the dates of one of them.",
    );
  }
}

/** A season's seven days, with its branch (or none, for the company's) beside its id. */
async function writeSeasonDays(
  tx: Database, organizationId: string, branchId: string | null, seasonId: string, days: WeekInput["days"],
): Promise<void> {
  await tx.insert(schema.businessHours).values(days.map((day) => ({
    organizationId,
    businessUnitId: branchId,
    seasonId,
    dayOfWeek: day.dayOfWeek,
    opensAt: day.closed ? null : day.opensAt,
    closesAt: day.closed ? null : day.closesAt,
    closed: day.closed,
  })));
}

/** A season the person may see, or not found: another branch's reads as not there. */
async function seasonWithin(tx: Database, ctx: ServiceContext, id: string): Promise<SeasonRow> {
  const [row] = await tx.select().from(schema.businessHoursSeason)
    .where(and(eq(schema.businessHoursSeason.id, id), eq(schema.businessHoursSeason.organizationId, ctx.actor.organizationId)))
    .limit(1);
  const own = ownBranchOnly(ctx);
  if (!row || (own !== false && row.businessUnitId !== null && row.businessUnitId !== own)) throw new NotFoundError("Season");
  return row;
}

/**
 * A season for the company or a branch: its dates and its seven days. The
 * same permission and the same branch rule as the week it sits over.
 */
export async function addSeason(ctx: ServiceContext, input: SeasonInput): Promise<SeasonView> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const seen = await replayed<SeasonView>(tx, ctx, "business_hours_season");
    if (seen) return seen;
    const branchId = input.businessUnitId ?? null;
    await mayKeep(tx, ctx, branchId);
    const season = checkedSeason(input);
    await refuseOverlap(tx, ctx.actor.organizationId, branchId, season, null);
    const [row] = await tx.insert(schema.businessHoursSeason)
      .values({ organizationId: ctx.actor.organizationId, businessUnitId: branchId, ...season }).returning();
    await writeSeasonDays(tx, ctx.actor.organizationId, branchId, row!.id, input.days);
    const [answer] = await seasonViews(tx, ctx, [row!]);
    await audit(tx, ctx, "booking.season.added", "business_hours_season", row!.id, null, answer);
    await remember(tx, ctx, "business_hours_season", row!.id, answer!);
    return answer!;
  });
}

/**
 * A season's name, dates or days changed. It stays with its owner: a
 * company's season does not become a branch's, which is a new season.
 */
export async function changeSeason(ctx: ServiceContext, input: Omit<SeasonInput, "businessUnitId"> & { id: string }): Promise<SeasonView> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const before = await seasonWithin(tx, ctx, input.id);
    await mayKeep(tx, ctx, before.businessUnitId);
    const season = checkedSeason(input);
    await refuseOverlap(tx, ctx.actor.organizationId, before.businessUnitId, season, before.id);
    const [beforeView] = await seasonViews(tx, ctx, [before]);
    const [row] = await tx.update(schema.businessHoursSeason)
      .set({ ...season, updatedAt: new Date() })
      .where(eq(schema.businessHoursSeason.id, before.id)).returning();
    await tx.delete(schema.businessHours).where(eq(schema.businessHours.seasonId, before.id));
    await writeSeasonDays(tx, ctx.actor.organizationId, before.businessUnitId, before.id, input.days);
    const [answer] = await seasonViews(tx, ctx, [row!]);
    await audit(tx, ctx, "booking.season.changed", "business_hours_season", before.id, beforeView, answer);
    return answer!;
  });
}

/** A season taken off: its dates keep the normal week again. The audit log keeps what it said. Removing one already gone succeeds. */
export async function removeSeason(ctx: ServiceContext, input: { id: string }): Promise<{ removed: boolean }> {
  assertCan(ctx.actor, "booking:configure");
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [existing] = await tx.select({ id: schema.businessHoursSeason.id }).from(schema.businessHoursSeason)
      .where(and(eq(schema.businessHoursSeason.id, input.id), eq(schema.businessHoursSeason.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!existing) return { removed: false };
    const before = await seasonWithin(tx, ctx, input.id);
    await mayKeep(tx, ctx, before.businessUnitId);
    const [beforeView] = await seasonViews(tx, ctx, [before]);
    await tx.delete(schema.businessHoursSeason).where(eq(schema.businessHoursSeason.id, before.id));
    await audit(tx, ctx, "booking.season.removed", "business_hours_season", before.id, beforeView, null);
    return { removed: true };
  });
}

/* ------------------------------------------------------------- handlers */

export const handlers = {
  listBusinessHours: (ctx: ServiceContext) => list(ctx),
  setBusinessHours: (ctx: ServiceContext, input: WeekInput) => setWeek(ctx, input),
  clearBranchHours: (ctx: ServiceContext, input: { businessUnitId: string }) => followCompany(ctx, input),
  listHoursSeasons: (ctx: ServiceContext) => listSeasons(ctx),
  addHoursSeason: (ctx: ServiceContext, input: SeasonInput) => addSeason(ctx, input),
  changeHoursSeason: (ctx: ServiceContext, input: Omit<SeasonInput, "businessUnitId"> & { id: string }) => changeSeason(ctx, input),
  removeHoursSeason: (ctx: ServiceContext, input: { id: string }) => removeSeason(ctx, input),
} as const;
