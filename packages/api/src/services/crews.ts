import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";

/**
 * CREWS: THE SECOND CAPACITY MODEL
 *
 * `schema/scheduling.ts` names four structurally different ways a home
 * services company sells capacity. One of them was built. This is the second.
 *
 * A crew is NOT a list of technicians. It carries a production rate and a set
 * of required equipment, because a tree crew without the chipper cannot take
 * the job no matter who is standing in the truck. Three tables, `crew`,
 * `crew_member` and the `visit.crew_id` column, had been in the schema since
 * the first migration and no service had ever written one, which meant a
 * landscape or tree company could install this product and have nowhere to
 * say what a crew is.
 *
 * NOTHING HERE CHANGES TECHNICIAN DISPATCH. `services/dispatch.ts` assigns
 * individuals through `visit_assignment` and is untouched. A visit carries a
 * crew OR an assignment list, which is what the schema comment on
 * `visit.crew_id` already said: "exactly one of these is set, determined by
 * the job type's capacity model". A plumbing company never calls anything in
 * this file.
 *
 * THE QUESTION THIS FILE EXISTS TO ANSWER is `canTake`: can this crew take
 * this job, today. A crew short the equipment the work needs is not
 * available, and saying so at the moment somebody drags the job onto the crew
 * is the whole point. Finding out on site is a truck roll, a disappointed
 * customer and a day of crew time nobody sold.
 *
 * ON PERMISSIONS. There is no `crew:*` permission in the catalogue and
 * inventing one is not an option: `packages/core/src/access/permissions.ts`
 * is the whole of the authorization model and a string that is not in it
 * cannot be granted to anybody. Reads use `visit:read` and writes use
 * `visit:dispatch`, which is the permission that already decides who may say
 * where work goes. `settings:write` was the alternative and is wrong, because
 * the `dispatcher` preset does not hold it and the dispatcher is the person
 * who actually maintains crews.
 */

/* ------------------------------------------------------------------ crews */

export interface CrewInput {
  name: string;
  businessUnitId?: string | null | undefined;
  homeLocationId?: string | null | undefined;
  /** In the trade's own unit: square feet painted, linear feet of fence. */
  productionRatePerDay?: string | null | undefined;
  productionUnit?: string | null | undefined;
  requiredAssetIds?: string[] | undefined;
  skills?: string[] | undefined;
  color?: string | null | undefined;
}

/**
 * Create a crew.
 *
 * A production rate without a unit is refused, and so is a unit without a
 * rate. "Eight hundred a day" is not a number anybody can schedule with: it
 * is eight hundred square feet, or linear feet, or cubic yards, and the three
 * are different jobs. Storing one half of the pair produces a crew whose
 * capacity reads as a figure on every screen and means nothing, which is
 * worse than a crew with no rate at all, because a blank invites somebody to
 * fill it in.
 */
export async function create(ctx: ServiceContext, input: CrewInput) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A crew needs a name.");

    assertRatePair(input.productionRatePerDay, input.productionUnit);

    const [row] = await tx.insert(schema.crew).values({
      organizationId: ctx.actor.organizationId,
      name,
      businessUnitId: input.businessUnitId ?? null,
      homeLocationId: input.homeLocationId ?? null,
      productionRatePerDay: input.productionRatePerDay ?? null,
      productionUnit: input.productionUnit ?? null,
      requiredAssetIds: input.requiredAssetIds ?? [],
      skills: input.skills ?? [],
      color: input.color ?? null,
    }).returning();

    await audit(tx, ctx, "crew.created", "crew", row!.id, null, row!);
    return row!;
  });
}

export interface CrewUpdate {
  id: string;
  name?: string | undefined;
  productionRatePerDay?: string | null | undefined;
  productionUnit?: string | null | undefined;
  requiredAssetIds?: string[] | undefined;
  skills?: string[] | undefined;
  color?: string | null | undefined;
  active?: boolean | undefined;
}

/** Change what a crew is: its rate, its kit, whether it still exists. */
export async function update(ctx: ServiceContext, input: CrewUpdate) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const before = await loadCrew(tx, ctx.actor.organizationId, input.id);

    /**
     * The pair is checked against the RESULT of the edit rather than against
     * what was sent. Clearing the unit on a crew that already has a rate
     * leaves exactly the half-stated capacity `create` refuses, and a check
     * that only looked at the incoming fields would let it through.
     */
    const rate = input.productionRatePerDay === undefined
      ? before.productionRatePerDay : input.productionRatePerDay;
    const unit = input.productionUnit === undefined
      ? before.productionUnit : input.productionUnit;
    assertRatePair(rate, unit);

    const [row] = await tx.update(schema.crew).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.productionRatePerDay !== undefined
        ? { productionRatePerDay: input.productionRatePerDay } : {}),
      ...(input.productionUnit !== undefined ? { productionUnit: input.productionUnit } : {}),
      ...(input.requiredAssetIds !== undefined ? { requiredAssetIds: input.requiredAssetIds } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.crew.id, before.id)).returning();

    await audit(tx, ctx, "crew.updated", "crew", before.id, before, row!);
    return row!;
  });
}

/** Half a production rate is not a production rate. See `create`. */
function assertRatePair(rate: string | null | undefined, unit: string | null | undefined): void {
  const hasRate = rate !== null && rate !== undefined && rate !== "";
  const hasUnit = unit !== null && unit !== undefined && unit.trim() !== "";
  if (hasRate && !hasUnit) {
    throw new ConflictError(
      "A production rate needs its unit. Eight hundred a day is eight hundred square feet, "
      + "or linear feet, or cubic yards, and nobody can schedule against the number alone.",
    );
  }
  if (hasUnit && !hasRate) {
    throw new ConflictError(
      "A production unit needs its rate, otherwise the crew has a unit of measure and no capacity in it.",
    );
  }
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const crews = await tx.select().from(schema.crew)
      .where(and(
        eq(schema.crew.organizationId, ctx.actor.organizationId),
      ))
      .orderBy(asc(schema.crew.name));

    const members = await tx.select({
      crewId: schema.crewMember.crewId,
      technicianId: schema.crewMember.technicianId,
      isLead: schema.crewMember.isLead,
      displayName: schema.technician.displayName,
      active: schema.technician.active,
    }).from(schema.crewMember)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
      .where(eq(schema.crewMember.organizationId, ctx.actor.organizationId));

    return crews.map((crew) => ({
      id: crew.id,
      name: crew.name,
      businessUnitId: crew.businessUnitId,
      productionRatePerDay: crew.productionRatePerDay,
      productionUnit: crew.productionUnit,
      requiredAssetIds: crew.requiredAssetIds,
      skills: crew.skills,
      color: crew.color,
      active: crew.active,
      members: members
        .filter((m) => m.crewId === crew.id)
        .map((m) => ({
          technicianId: m.technicianId,
          displayName: m.displayName,
          isLead: m.isLead,
          active: m.active,
        })),
    }));
  });
}

/* ---------------------------------------------------------------- members */

export interface MemberInput { technicianId: string; isLead?: boolean | undefined }

/**
 * Who is on the crew, set in one call.
 *
 * The whole list rather than add and remove, for the reason
 * `services/dispatch.ts` gives about assignment: the gesture is "these
 * people, on this crew", and an add-only endpoint makes taking somebody off a
 * second call that is easy to forget.
 *
 * AT MOST ONE LEAD. Two leads is not a richer crew, it is a crew where
 * `canTake` cannot say whether the person who answers for the job is there.
 *
 * THIS WRITE MOVES AUTHORIZATION, which is not obvious and is the reason it
 * needs a permission rather than being a convenience. `app.resolve_session`
 * in `packages/db/sql/after.sql` builds an actor's `crew_ids` from this
 * table, and the `crew` scope in `packages/core/src/access/scopes.ts`
 * compares against it. Adding somebody to a crew widens what they can read.
 */
export async function setMembers(
  ctx: ServiceContext, input: { id: string; members: MemberInput[] },
) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const crew = await loadCrew(tx, ctx.actor.organizationId, input.id);

    const ids = input.members.map((m) => m.technicianId);
    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicated.length > 0) {
      // The unique index on (crew_id, technician_id) would refuse this with a
      // message about an index. A person reads this one.
      throw new ConflictError("That list has the same technician on the crew twice.");
    }

    const leads = input.members.filter((m) => m.isLead === true);
    if (leads.length > 1) {
      throw new ConflictError(
        "A crew has one lead. Two means nothing can say whether the person who answers "
        + "for the job is on site today.",
      );
    }

    if (ids.length > 0) {
      const found = await tx.select({ id: schema.technician.id })
        .from(schema.technician)
        .where(and(
          eq(schema.technician.organizationId, ctx.actor.organizationId),
          inArray(schema.technician.id, ids),
          eq(schema.technician.active, true),
        ));
      if (found.length !== ids.length) {
        throw new ConflictError("One of those technicians is not active in this company.");
      }
    }

    await tx.delete(schema.crewMember).where(eq(schema.crewMember.crewId, crew.id));
    if (input.members.length > 0) {
      await tx.insert(schema.crewMember).values(input.members.map((m) => ({
        organizationId: ctx.actor.organizationId,
        crewId: crew.id,
        technicianId: m.technicianId,
        isLead: m.isLead === true,
      })));
    }

    await audit(tx, ctx, "crew.members_set", "crew", crew.id, null, {
      technicianIds: ids, leadTechnicianId: leads[0]?.technicianId ?? null,
    });

    return { id: crew.id, members: input.members.length, leadSet: leads.length === 1 };
  });
}

/* ----------------------------------------------------- can it take the job */

/** Why a crew cannot take a job. Every one of these is actionable today. */
export type Blocker =
  | "crew_inactive"
  | "no_members"
  | "everybody_off"
  | "lead_off"
  | "missing_equipment"
  | "missing_skills"
  | "different_business_unit";

export interface CrewVerdict {
  crewId: string;
  crewName: string;
  jobId: string;
  on: string;
  canTake: boolean;
  blockers: { code: Blocker; explanation: string }[];
  /** The ids the job needs and the crew does not carry. The actionable list. */
  missingEquipment: string[];
  missingSkills: string[];
  headcount: { onCrew: number; availableOn: number; offOn: number };
  leadDesignated: boolean;
  /**
   * WHERE THE EQUIPMENT REQUIREMENT CAME FROM, published with the answer.
   *
   * `job_type` means the job has a type and that type declares what the work
   * needs. `none_declared` means it does not, and then "no missing
   * equipment" is a statement about an empty list rather than a statement
   * about the crew. A caller that cannot tell those apart will read the
   * second as a clearance.
   */
  equipmentBasis: "job_type" | "none_declared";
}

/**
 * Can this crew take this job, on this day.
 *
 * TWO SEPARATE QUESTIONS, and both have to pass. The kit, which is a property
 * of the crew and the work; and the people, which is a property of the day.
 * A crew that is fully equipped and whose three members are all on holiday on
 * Thursday is not available on Thursday.
 *
 * HOW EQUIPMENT IS MATCHED, stated plainly because the shape of the data
 * limits what can be claimed. There is no company asset register in this
 * schema: `crew.required_asset_ids` and `job_type.required_asset_ids` are
 * lists of opaque strings with no table behind them, so this compares them by
 * equality and nothing more. It cannot tell you the chipper is in the shop,
 * because nothing in this product records that. What it can tell you, and
 * what it does, is that this job needs a chipper and this crew does not carry
 * one. That is the answer that prevents the truck roll.
 *
 * TIME OFF IS COUNTED ONLY WHEN APPROVED, matching the dispatch board, which
 * draws an empty column for approved leave only. A requested day that nobody
 * has signed off is not yet a reason to refuse work.
 */
export async function canTake(
  ctx: ServiceContext, input: { id: string; jobId: string; on?: string | undefined },
): Promise<CrewVerdict> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const crew = await loadCrew(tx, ctx.actor.organizationId, input.id);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);
    const job = await loadJob(tx, ctx.actor.organizationId, input.jobId);
    return verdict(tx, ctx.actor.organizationId, crew, job, on, zone);
  });
}

/**
 * Every crew, each with its verdict, for one job.
 *
 * This is the assignment screen. A dispatcher picking a crew wants the list
 * with the refusals on it rather than a list they have to try one at a time,
 * and a crew that cannot take the job is shown WITH ITS REASON rather than
 * hidden, because "the crew I wanted is not in the list" sends somebody
 * hunting through settings for a crew that is sitting right there missing a
 * chipper.
 */
export async function crewsFor(
  ctx: ServiceContext, input: { jobId: string; on?: string | undefined },
): Promise<{ jobId: string; on: string; crews: CrewVerdict[] }> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);
    const job = await loadJob(tx, ctx.actor.organizationId, input.jobId);

    const crews = await tx.select().from(schema.crew)
      .where(and(
        eq(schema.crew.organizationId, ctx.actor.organizationId),
        eq(schema.crew.active, true),
      ))
      .orderBy(asc(schema.crew.name));

    const out: CrewVerdict[] = [];
    for (const crew of crews) {
      out.push(await verdict(tx, ctx.actor.organizationId, crew, job, on, zone));
    }
    return { jobId: job.id, on, crews: out };
  });
}

interface JobFacts {
  id: string;
  businessUnitId: string | null;
  jobTypeId: string | null;
  requiredAssetIds: string[];
  requiredSkills: string[];
}

async function verdict(
  tx: Database, organizationId: string,
  crew: typeof schema.crew.$inferSelect,
  job: JobFacts, on: string, zone: string,
): Promise<CrewVerdict> {
  const blockers: { code: Blocker; explanation: string }[] = [];

  if (!crew.active) {
    blockers.push({
      code: "crew_inactive",
      explanation: `${crew.name} has been retired, so work should not be put on it.`,
    });
  }

  const members = await tx.select({
    technicianId: schema.crewMember.technicianId,
    isLead: schema.crewMember.isLead,
    displayName: schema.technician.displayName,
  }).from(schema.crewMember)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
    .where(and(
      eq(schema.crewMember.crewId, crew.id),
      eq(schema.technician.organizationId, organizationId),
      eq(schema.technician.active, true),
    ));

  /**
   * The same local day the board draws. Bounding this in UTC would put a
   * holiday on the wrong side of midnight for every company west of
   * Greenwich, which is the bug `services/dispatch.ts` documents at length on
   * its own day window.
   */
  const { start: dayStart, end: dayEnd } = time.dayBoundsIn(on, zone);
  const off = members.length === 0 ? [] : await tx.select({
    technicianId: schema.timeOff.technicianId,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId),
      eq(schema.timeOff.approved, true),
      inArray(schema.timeOff.technicianId, members.map((m) => m.technicianId)),
      lte(schema.timeOff.startsAt, dayEnd),
      gte(schema.timeOff.endsAt, dayStart),
    ));
  const offIds = new Set(off.map((o) => o.technicianId));
  const available = members.filter((m) => !offIds.has(m.technicianId));

  if (members.length === 0) {
    blockers.push({
      code: "no_members",
      explanation: `${crew.name} has nobody on it. A crew with no members is a name, not capacity.`,
    });
  } else if (available.length === 0) {
    blockers.push({
      code: "everybody_off",
      explanation: `Everybody on ${crew.name} is on approved time off on ${on}.`,
    });
  }

  /**
   * The lead, when the crew has one. A production crew without the person who
   * answers for the job is a liability rather than a short-handed crew, and
   * the whole reason `crew_member.is_lead` exists is to be able to say so.
   * A crew with no lead designated is NOT refused here: that is a gap in how
   * the crew was set up rather than a fact about today, and refusing it would
   * mean every crew created without one can never be dispatched.
   */
  const leads = members.filter((m) => m.isLead);
  const leadDesignated = leads.length > 0;
  if (leadDesignated && leads.every((m) => offIds.has(m.technicianId))) {
    blockers.push({
      code: "lead_off",
      explanation: `The lead on ${crew.name} is on approved time off on ${on}.`,
    });
  }

  const carried = new Set(crew.requiredAssetIds);
  const missingEquipment = job.requiredAssetIds.filter((id) => !carried.has(id));
  if (missingEquipment.length > 0) {
    blockers.push({
      code: "missing_equipment",
      explanation:
        `${crew.name} does not carry ${missingEquipment.join(", ")}, which this work needs. `
        + "Sending it means a second trip for the kit and a day of crew time nobody sold.",
    });
  }

  const known = new Set(crew.skills);
  const missingSkills = job.requiredSkills.filter((s) => !known.has(s));
  if (missingSkills.length > 0) {
    blockers.push({
      code: "missing_skills",
      explanation: `${crew.name} is not qualified for ${missingSkills.join(", ")}.`,
    });
  }

  if (crew.businessUnitId && job.businessUnitId && crew.businessUnitId !== job.businessUnitId) {
    blockers.push({
      code: "different_business_unit",
      explanation: `${crew.name} belongs to a different business unit from this job.`,
    });
  }

  return {
    crewId: crew.id,
    crewName: crew.name,
    jobId: job.id,
    on,
    canTake: blockers.length === 0,
    blockers,
    missingEquipment,
    missingSkills,
    headcount: {
      onCrew: members.length,
      availableOn: available.length,
      offOn: members.length - available.length,
    },
    leadDesignated,
    equipmentBasis: job.jobTypeId ? "job_type" : "none_declared",
  };
}

/* --------------------------------------------------- putting it on a visit */

/**
 * Put a crew on a visit, and refuse when the crew cannot take it.
 *
 * SEPARATE FROM `services/dispatch.ts` ON PURPOSE. That function assigns
 * individuals through `visit_assignment` and serves the technician_dispatch
 * model, which is built, shipped and working; a company that dispatches
 * individuals must be unaffected by anything in this file. This writes
 * `visit.crew_id`, which the schema reserves for the other three models, and
 * the two paths do not meet.
 *
 * THE REFUSAL IS THE FEATURE. `jobs.addVisit` already accepts a `crewId` and
 * writes it with no check at all, so a tree job can be put on a crew with no
 * chipper, today, through the shipped API. Everything in `canTake` is an
 * answer somebody wants at exactly this moment, and an endpoint that computed
 * it and then assigned anyway would be an opinion rather than a guard.
 */
export async function assign(
  ctx: ServiceContext, input: { id: string; crewId: string },
) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const [visit] = await tx.select().from(schema.visit)
      .where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    // The same three terminal states `services/dispatch.ts` refuses to
    // reassign. A completed visit's crew is a historical fact.
    if (["completed", "cancelled", "completed_after_cancellation"].includes(visit.status)) {
      throw new ConflictError(`This visit is ${visit.status} and cannot be reassigned.`);
    }

    const crew = await loadCrew(tx, ctx.actor.organizationId, input.crewId);
    const job = await loadJob(tx, ctx.actor.organizationId, visit.jobId);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);

    /**
     * Judged on the DAY THE VISIT IS, not today. Assigning Thursday's work on
     * Monday has to ask about Thursday, and a check against today would clear
     * a crew whose only member is on holiday that week.
     */
    const on = visit.windowStart
      ? time.dateIn(visit.windowStart, zone)
      : time.dateIn(new Date(), zone);

    const answer = await verdict(tx, ctx.actor.organizationId, crew, job, on, zone);
    if (!answer.canTake) {
      throw new ConflictError(answer.blockers.map((b) => b.explanation).join(" "));
    }

    /**
     * The same status rule assignment uses for individuals: an unassigned or
     * scheduled visit becomes dispatched, and a visit already moving stays
     * where it is. A crew that is en route does not go back to dispatched
     * because the office corrected which crew is on the job.
     */
    const status = ["unassigned", "scheduled"].includes(visit.status)
      ? "dispatched" as const
      : visit.status;

    await tx.update(schema.visit).set({
      crewId: crew.id,
      status,
      dispatchedAt: visit.dispatchedAt ?? new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.visit.id, visit.id));

    await audit(tx, ctx, "visit.crew_assigned", "visit", visit.id,
      { crewId: visit.crewId, status: visit.status }, { crewId: crew.id, status });

    return { id: visit.id, crewId: crew.id, status, on };
  });
}

/* ----------------------------------------------------------------- loading */

/**
 * NO SOFT DELETE FILTER ON THESE TABLES, AND THAT IS A DECISION.
 *
 * `crew`, `route`, `route_stop` and `on_call_rotation` all carry a
 * `deleted_at` column because every table in this schema does, and nothing in
 * this product sets one. `active` is the retire mechanism here and it is a
 * column something writes: `crews.update`, `routes.setStopActive` and the
 * route's own flag.
 *
 * `test/unwritten-columns.test.ts` makes the argument at length and counts
 * the tables that get it wrong. Its summary is the reason this filter is
 * absent rather than present: a filter on a column nothing sets is
 * decoration, it makes a query look guarded when it is not, and it is
 * indistinguishable in review from one that is doing work. The day one of
 * these tables gets a real delete, the filter goes in beside it.
 */
async function loadCrew(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.crew)
    .where(and(
      eq(schema.crew.id, id),
      eq(schema.crew.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Crew");
  return row;
}

/**
 * The job, plus what its type says the work needs.
 *
 * A left join rather than two reads, and a job with no type is a real state
 * rather than an error: plenty of work is booked as a sentence and a price.
 * The verdict says which case it was in `equipmentBasis` instead of
 * pretending an absent type is an empty requirement.
 */
async function loadJob(tx: Database, organizationId: string, id: string): Promise<JobFacts> {
  const [row] = await tx.select({
    id: schema.job.id,
    businessUnitId: schema.job.businessUnitId,
    jobTypeId: schema.job.jobTypeId,
    requiredAssetIds: schema.jobType.requiredAssetIds,
    requiredSkills: schema.jobType.requiredSkills,
  }).from(schema.job)
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.job.jobTypeId))
    .where(and(
      eq(schema.job.id, id),
      eq(schema.job.organizationId, organizationId),
      isNull(schema.job.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Job");

  return {
    id: row.id,
    businessUnitId: row.businessUnitId,
    jobTypeId: row.jobTypeId,
    requiredAssetIds: row.requiredAssetIds ?? [],
    requiredSkills: row.requiredSkills ?? [],
  };
}

/* --------------------------------------------------------------- handlers */

/**
 * The shapes the route registry wires to, written out rather than inferred.
 *
 * The same pattern `services/reviews.ts` uses: an explicit return type on
 * each one, so a change to a service's shape that breaks the published
 * contract is a compile error here rather than a response that no longer
 * matches the document generated from it.
 */
export const handlers = {
  listCrews: async (ctx: ServiceContext): Promise<{
    crews: {
      id: string; name: string; businessUnitId: string | null;
      productionRatePerDay: string | null; productionUnit: string | null;
      requiredAssetIds: string[]; skills: string[]; color: string | null; active: boolean;
      members: { technicianId: string; displayName: string; isLead: boolean; active: boolean }[];
    }[];
  }> => ({ crews: await list(ctx) }),

  createCrew: async (ctx: ServiceContext, input: {
    name: string;
    businessUnitId?: string | null | undefined;
    homeLocationId?: string | null | undefined;
    productionRatePerDay?: string | null | undefined;
    productionUnit?: string | null | undefined;
    requiredAssetIds?: string[] | undefined;
    skills?: string[] | undefined;
    color?: string | null | undefined;
  }): Promise<{ id: string; name: string; active: boolean }> => {
    const row = await create(ctx, input);
    return { id: row.id, name: row.name, active: row.active };
  },

  updateCrew: async (ctx: ServiceContext, input: {
    id: string;
    name?: string | undefined;
    productionRatePerDay?: string | null | undefined;
    productionUnit?: string | null | undefined;
    requiredAssetIds?: string[] | undefined;
    skills?: string[] | undefined;
    color?: string | null | undefined;
    active?: boolean | undefined;
  }): Promise<{ id: string; name: string; active: boolean }> => {
    const row = await update(ctx, input);
    return { id: row.id, name: row.name, active: row.active };
  },

  setCrewMembers: (ctx: ServiceContext, input: {
    id: string; members: { technicianId: string; isLead?: boolean | undefined }[];
  }): Promise<{ id: string; members: number; leadSet: boolean }> => setMembers(ctx, input),

  getCrewAvailability: (ctx: ServiceContext, input: {
    id: string; jobId: string; on?: string | undefined;
  }): Promise<CrewVerdict> => canTake(ctx, input),

  listCrewsForJob: (ctx: ServiceContext, input: {
    jobId: string; on?: string | undefined;
  }): Promise<{ jobId: string; on: string; crews: CrewVerdict[] }> => crewsFor(ctx, input),

  assignCrewToVisit: (ctx: ServiceContext, input: { id: string; crewId: string }): Promise<{
    id: string; crewId: string; status: string; on: string;
  }> => assign(ctx, input),
} as const;
