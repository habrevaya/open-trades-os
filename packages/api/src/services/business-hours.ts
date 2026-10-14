import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, holidays as rules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { liveBranch } from "./branches";

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
 */

type Row = typeof schema.businessHours.$inferSelect;

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

/** The week a reader that knows a branch reads: the branch's own, or the company's. */
export async function loadWeek(
  db: Database, organizationId: string, branchId: string | null = null,
): Promise<rules.ChosenWeek<Row>> {
  return rules.weekFor(await weekRows(db, organizationId), branchId);
}

/**
 * The weeks of several branches from one read, for a reader that asks about
 * many at once (the rebalance, over every visit in a range).
 */
export async function weeksByBranch(
  db: Database, organizationId: string,
): Promise<(branchId: string | null) => rules.ChosenWeek<Row>> {
  const rows = await weekRows(db, organizationId);
  const cache = new Map<string | null, rules.ChosenWeek<Row>>();
  return (branchId) => {
    if (!cache.has(branchId)) cache.set(branchId, rules.weekFor(rows, branchId));
    return cache.get(branchId)!;
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

/* ------------------------------------------------------------- handlers */

export const handlers = {
  listBusinessHours: (ctx: ServiceContext) => list(ctx),
  setBusinessHours: (ctx: ServiceContext, input: WeekInput) => setWeek(ctx, input),
  clearBranchHours: (ctx: ServiceContext, input: { businessUnitId: string }) => followCompany(ctx, input),
} as const;
