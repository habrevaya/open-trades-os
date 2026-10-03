import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, type Permission, type Scope, type ScopedResource } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";

/**
 * BRANCHES
 *
 * A company with a shop in Austin and a shop in Houston, run by two managers
 * who should each see their own work. The schema has carried this for a long
 * time (`business_unit`, `job.business_unit_id`, a `business_unit` scope that
 * `services/scope.ts` turns into a filter) and nothing in the product asked a
 * company to divide itself up, so the filter had nothing to filter on.
 *
 * A BRANCH IS A BUSINESS UNIT. The schema keeps two words for two things: a
 * business unit is a P&L, a location is a building, and `tenancy.ts` explains
 * why collapsing them costs a company the first time it has two shops inside
 * one set of books. What an owner means by "branch" is the P&L, the thing a
 * manager is measured on and the thing the job carries, so that is what the
 * screens call a branch. A location stays a building, used for where stock
 * sits and where a technician's day starts.
 *
 * THE DECISIONS `docs/concepts/multi-location.md` LEFT OPEN, MADE HERE:
 *
 * Where a job's branch comes from. Whoever books it, unless they choose
 * another: the branch of the person saving it, then the branch its job type
 * belongs to, and otherwise none. That default is a trigger
 * (`app.default_job_branch` in `sql/after.sql`) because eight services insert
 * jobs and a default in one of them is a default in one of eight.
 *
 * What a job with no branch means. It belongs to nobody's branch, so only the
 * people who see the whole company see it, and the branches screen counts
 * them and moves them in bulk. It does not mean "every branch", which would
 * make the unsorted pile the one thing every manager could read.
 *
 * Who moves work between branches. Somebody whose own job scope is the whole
 * company. A branch scoped manager can only put work in their own branch, so
 * they cannot hand a job to a branch whose work they cannot then see.
 *
 * Numbering stays per company, the price book stays company wide, and one job
 * carries one branch. Those are documented as such rather than built.
 */

export interface BranchOption {
  id: string;
  name: string;
  code: string | null;
}

export interface BranchOptions {
  branches: BranchOption[];
  /** The caller's own branch, if they have one. */
  yours: string | null;
  /**
   * The caller's job scope is narrower than the whole company. A branch
   * filter on their screens would only ever narrow what is already narrowed,
   * so the screens leave it off rather than offer choices that show nothing.
   */
  narrowed: boolean;
}

/**
 * The permissions that can see something a branch filter narrows. Any one of
 * them is enough to read the list of branch NAMES, which is all this returns:
 * a dispatcher filtering the job list needs the names and has no business in
 * Settings.
 */
const LIST_READERS: Permission[] = [
  "job:read", "customer:read", "invoice:read", "estimate:read", "report:read",
];

export async function options(ctx: ServiceContext): Promise<BranchOptions> {
  const reader = LIST_READERS.find((p) => can(ctx.actor, p));
  // Asserted rather than returned empty, so a caller with none of them is
  // refused in the same words as everywhere else.
  assertCan(ctx.actor, reader ?? "job:read");
  return inTenant(ctx, async (tx) => {
    const rows = await tx.select({
      id: schema.businessUnit.id, name: schema.businessUnit.name, code: schema.businessUnit.code,
    }).from(schema.businessUnit)
      .where(and(
        eq(schema.businessUnit.organizationId, ctx.actor.organizationId),
        eq(schema.businessUnit.active, true),
      ))
      .orderBy(asc(schema.businessUnit.name));
    return {
      branches: rows,
      yours: ctx.actor.businessUnitId ?? null,
      narrowed: scopeOf(ctx, "job") !== "all",
    };
  });
}

export interface BranchSummary {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
  /** Active people whose branch this is. */
  people: number;
  /** Jobs not finished or cancelled. */
  openJobs: number;
  jobs: number;
}

export interface BranchOverview {
  branches: BranchSummary[];
  /** Jobs with no branch: seen by the office only, until somebody sorts them. */
  unassigned: { jobs: number; openJobs: number };
  /** People with no branch. Fine for an owner; a branch scoped role needs one. */
  peopleWithoutBranch: number;
}

/** A job that is still somebody's problem. */
const CLOSED_STATUSES = ["completed", "invoiced", "paid", "cancelled"] as const;

export async function overview(ctx: ServiceContext): Promise<BranchOverview> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const units = await tx.select().from(schema.businessUnit)
      .where(eq(schema.businessUnit.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.businessUnit.name));

    const jobCounts = await tx.select({
      unit: schema.job.businessUnitId,
      jobs: sql<number>`count(*)::int`,
      open: sql<number>`(count(*) filter (where ${notInArray(schema.job.status, [...CLOSED_STATUSES])}))::int`,
    }).from(schema.job)
      .where(and(eq(schema.job.organizationId, ctx.actor.organizationId), isNull(schema.job.deletedAt)))
      .groupBy(schema.job.businessUnitId);

    const peopleCounts = await tx.select({
      unit: schema.membership.businessUnitId,
      people: sql<number>`count(*)::int`,
    }).from(schema.membership)
      .where(and(eq(schema.membership.organizationId, ctx.actor.organizationId), eq(schema.membership.active, true)))
      .groupBy(schema.membership.businessUnitId);

    const jobsOf = new Map(jobCounts.map((row) => [row.unit, row]));
    const peopleOf = new Map(peopleCounts.map((row) => [row.unit, row.people]));

    return {
      branches: units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        code: unit.code,
        active: unit.active,
        people: peopleOf.get(unit.id) ?? 0,
        openJobs: jobsOf.get(unit.id)?.open ?? 0,
        jobs: jobsOf.get(unit.id)?.jobs ?? 0,
      })),
      unassigned: { jobs: jobsOf.get(null)?.jobs ?? 0, openJobs: jobsOf.get(null)?.open ?? 0 },
      peopleWithoutBranch: peopleOf.get(null) ?? 0,
    };
  });
}

/** A live branch of this company, or the refusal saying why not. */
export async function liveBranch(tx: Database, ctx: ServiceContext, businessUnitId: string) {
  /**
   * Row level security already hides another company's branch, so a foreign
   * id is simply not found. The organization filter is said anyway, as in
   * `roles.assign`, so this does not read as an id taken on trust.
   */
  const [unit] = await tx.select().from(schema.businessUnit)
    .where(and(
      eq(schema.businessUnit.id, businessUnitId),
      eq(schema.businessUnit.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!unit) throw new NotFoundError("Branch");
  if (!unit.active) {
    throw new ConflictError(
      `${unit.name} has been retired, so nothing new is put in it. Bring it back under Settings, Branches, or choose another.`,
    );
  }
  return unit;
}

/**
 * Whether this person may put a job in this branch (or in none).
 *
 * Exported for `jobs.ts`, which asks it whenever a branch is named on a job.
 * A person who sees the whole company may put work anywhere. Anybody narrower
 * may only put it in their own branch, because a job they place somewhere
 * else is a job they can no longer see, and that is a hand off rather than an
 * edit.
 */
export async function assertPlaceable(
  tx: Database, ctx: ServiceContext, businessUnitId: string | null,
): Promise<void> {
  const scope: Scope = scopeOf(ctx, "job");
  if (scope !== "all" && (businessUnitId === null || businessUnitId !== ctx.actor.businessUnitId)) {
    throw new ConflictError(
      "You can only put work in your own branch. Moving work between branches, or out of one, "
      + "is for somebody who sees the whole company, because you would not be able to see it afterwards.",
    );
  }
  if (businessUnitId !== null) await liveBranch(tx, ctx, businessUnitId);
}

/**
 * Put jobs in a branch, or take them out of one. The bulk half of the
 * branches screen: a company dividing itself up has a few hundred jobs that
 * belong to nobody, and sorting them one job page at a time is the job
 * nobody finishes.
 */
export async function assignJobs(
  ctx: ServiceContext, input: { jobIds: string[]; businessUnitId: string | null },
): Promise<{ moved: number; businessUnitId: string | null }> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const seen = await replayed<{ moved: number; businessUnitId: string | null }>(tx, ctx, "branch_assignment");
    if (seen) return seen;

    if (scopeOf(ctx, "job") !== "all") {
      throw new ConflictError(
        "Moving work between branches is for somebody who sees the whole company. "
        + "Ask an owner or an administrator to do it.",
      );
    }
    const ids = [...new Set(input.jobIds)];
    if (ids.length === 0) throw new ConflictError("Choose at least one job to move.");
    if (ids.length > 500) throw new ConflictError("Move up to five hundred jobs at a time.");
    if (input.businessUnitId !== null) await liveBranch(tx, ctx, input.businessUnitId);

    const found = await tx.select({ id: schema.job.id, businessUnitId: schema.job.businessUnitId })
      .from(schema.job)
      .where(and(inArray(schema.job.id, ids), isNull(schema.job.deletedAt)));
    if (found.length !== ids.length) throw new NotFoundError("One of those jobs");

    const moving = found.filter((job) => job.businessUnitId !== input.businessUnitId);
    if (moving.length > 0) {
      await tx.update(schema.job)
        .set({ businessUnitId: input.businessUnitId, updatedAt: new Date() })
        .where(inArray(schema.job.id, moving.map((job) => job.id)));
      /**
       * One audit row per job, because the question is asked about a job
       * ("why is this in Houston") and has to be answered from that job's
       * own history rather than from a batch somebody would have to find.
       */
      for (const job of moving) {
        await audit(tx, ctx, "job.branch_changed", "job", job.id,
          { businessUnitId: job.businessUnitId }, { businessUnitId: input.businessUnitId });
      }
    }

    const answer = { moved: moving.length, businessUnitId: input.businessUnitId };
    await remember(tx, ctx, "branch_assignment", input.businessUnitId, answer);
    return answer;
  });
}

/** The resources a custom role can scope to a branch. */
const SCOPED: ScopedResource[] = [
  "job", "visit", "customer", "estimate", "invoice", "timesheet", "servicereport", "conversation",
];

/**
 * Which branch a person belongs to. The anchor a branch scope reads, and the
 * branch a job they book lands in.
 *
 * Taking somebody's branch away while their role limits them to it is
 * refused, for the reason `roles.assign` refuses giving them that role with
 * no branch: they would open every list and find it empty, and an empty list
 * reads as "there is no work" rather than as a setting.
 */
export async function setMemberBranch(
  ctx: ServiceContext, input: { membershipId: string; businessUnitId: string | null },
) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    const [before] = await tx.select().from(schema.membership)
      .where(and(
        eq(schema.membership.id, input.membershipId),
        eq(schema.membership.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Person");

    if (input.businessUnitId !== null) await liveBranch(tx, ctx, input.businessUnitId);

    if (input.businessUnitId === null && before.roleId) {
      const [role] = await tx.select({ name: schema.role.name, scopes: schema.role.scopes })
        .from(schema.role)
        .where(and(eq(schema.role.id, before.roleId), isNull(schema.role.deletedAt))).limit(1);
      const limited = role && SCOPED.some((resource) => role.scopes[resource] === "business_unit");
      if (limited) {
        throw new ConflictError(
          `Their role, ${role.name}, shows them their branch's work only. With no branch they would see nothing at all. `
          + "Give them a different role first, or choose a branch.",
        );
      }
    }
    const overrides = before.scopeOverrides as Record<string, string>;
    if (input.businessUnitId === null && SCOPED.some((resource) => overrides[resource] === "business_unit")) {
      throw new ConflictError(
        "This person is limited to their branch's work. With no branch they would see nothing at all. "
        + "Lift that limit first, or choose a branch.",
      );
    }

    if (before.businessUnitId === input.businessUnitId) return before;

    const [after] = await tx.update(schema.membership)
      .set({ businessUnitId: input.businessUnitId, updatedAt: new Date() })
      .where(eq(schema.membership.id, input.membershipId))
      .returning();
    await audit(tx, ctx, "membership.branch_changed", "membership", input.membershipId,
      { businessUnitId: before.businessUnitId }, { businessUnitId: input.businessUnitId });
    return after!;
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listBranchOptions: (ctx: ServiceContext) => options(ctx),
  getBranchOverview: (ctx: ServiceContext) => overview(ctx),
  assignJobsToBranch: (ctx: ServiceContext, input: { jobIds: string[]; businessUnitId: string | null }) =>
    assignJobs(ctx, input),
  setMemberBranch: async (ctx: ServiceContext, input: { membershipId: string; businessUnitId: string | null }) => {
    const row = await setMemberBranch(ctx, input);
    return { membershipId: row.id, businessUnitId: row.businessUnitId };
  },
} as const;
