import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assets as assetCore, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, scopeOf,
  type ServiceContext,
} from "./context";
import { skillStanding } from "./people";
import { workSkills } from "./qualification";
import { announce, sideOf } from "./visit-notices";
import { jobVisibility } from "./scope";
import { crewWithin, crews as crewsInView, dispatchPeople, peopleScopeOf, seesEverybody } from "./people-scope";
import { shopOfCrew } from "./visit-shop";
import { liveBranch } from "./branches";

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
    assertCrewPlaceable(ctx, input.businessUnitId ?? null);
    if (input.businessUnitId) await liveBranch(tx, ctx, input.businessUnitId);

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
  /** The branch and the shop it belongs to. Moving a crew between branches is for the whole company. */
  businessUnitId?: string | null | undefined;
  homeLocationId?: string | null | undefined;
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
    const before = await crewWithin(tx, ctx, input.id);
    if (input.businessUnitId !== undefined && input.businessUnitId !== before.businessUnitId) {
      if (!seesEverybody(ctx)) {
        throw new ConflictError(
          "Moving a crew between branches is for somebody who sees the whole company, "
          + "because you would not see the crew afterwards.",
        );
      }
      if (input.businessUnitId) await liveBranch(tx, ctx, input.businessUnitId);
    }
    if (input.homeLocationId) {
      const [shop] = await tx.select({ id: schema.location.id }).from(schema.location)
        .where(and(eq(schema.location.id, input.homeLocationId), eq(schema.location.organizationId, ctx.actor.organizationId)))
        .limit(1);
      if (!shop) throw new NotFoundError("Shop");
    }

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
      ...(input.businessUnitId !== undefined ? { businessUnitId: input.businessUnitId } : {}),
      ...(input.homeLocationId !== undefined ? { homeLocationId: input.homeLocationId } : {}),
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

/**
 * WHICH BRANCH A NEW CREW GOES IN. Anybody who sees the whole company puts
 * it where they like, or in none. Anybody narrower puts it in their own
 * branch, the rule a job follows (`branches.assertPlaceable`): a crew made
 * somewhere else, or nowhere, is one they could not see again.
 */
function assertCrewPlaceable(ctx: ServiceContext, businessUnitId: string | null): void {
  if (peopleScopeOf(ctx, "visit") === "all") return;
  if (businessUnitId === null || businessUnitId !== ctx.actor.businessUnitId) {
    throw new ConflictError(
      "You can only make a crew in your own branch. Choose your branch, so you can see the crew afterwards.",
    );
  }
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
    /** A branch manager's crews are their branch's (`people-scope.ts`). */
    const crews = await tx.select().from(schema.crew)
      .where(and(
        eq(schema.crew.organizationId, ctx.actor.organizationId),
        crewsInView(ctx),
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
      homeLocationId: crew.homeLocationId,
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
    const crew = await crewWithin(tx, ctx, input.id);

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
      /**
       * Only this person's own people. Putting somebody on a crew widens what
       * they read (the `crew` scope), so a branch manager drafting another
       * branch's technician onto theirs is refused, in the same words as an
       * id that is not there, so the refusal says nothing about who exists.
       */
      const found = await tx.select({ id: schema.technician.id })
        .from(schema.technician)
        .where(and(
          eq(schema.technician.organizationId, ctx.actor.organizationId),
          inArray(schema.technician.id, ids),
          eq(schema.technician.active, true),
          dispatchPeople(ctx),
        ));
      if (found.length !== ids.length) {
        throw new ConflictError("One of those technicians is not active in this company.");
      }
    }

    await tx.delete(schema.crewMember).where(eq(schema.crewMember.crewId, crew.id));
    if (input.members.length > 0) {
      /**
       * No duplicate guard here, deliberately. The check above already refuses a
       * list with the same technician in it twice, with a comment saying exactly
       * why: "the unique index would refuse this with a message about an index,
       * a person reads this one". Wrapping the insert as well would be an
       * unreachable guard, which reads as the reason the insert is safe and is
       * worse than nothing.
       */
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
  | "equipment_unavailable"
  | "missing_skills"
  | "different_business_unit";

export interface CrewVerdict {
  crewId: string;
  crewName: string;
  jobId: string;
  on: string;
  canTake: boolean;
  blockers: { code: Blocker; explanation: string }[];
  /** The codes the job needs and the crew does not carry. The actionable list. */
  missingEquipment: string[];
  /**
   * The kit the crew DOES carry and the register says cannot go out today.
   *
   * A separate list from `missingEquipment` because the two are different
   * conversations. Missing kit is a question for whoever decides which crew
   * takes the job; a grounded chipper is a question for whoever renews the
   * inspection, and collapsing them into one list sends the wrong person to
   * fix it.
   */
  unavailableEquipment: {
    code: string; assetId: string; assetLabel: string;
    reason: "retired" | "grounded"; explanation: string;
  }[];
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
  /**
   * Which of the codes this job requires the asset register has ever heard
   * of, published for the same reason as `equipmentBasis`.
   *
   * A code with nothing behind it is still compared by equality against what
   * the crew carries, which is all this could do before the register existed,
   * and an empty `unavailableEquipment` for such a code is a statement about
   * an empty register rather than about a working chipper.
   */
  registeredEquipment: string[];
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
 * limits what can be claimed.
 *
 * `crew.required_asset_ids` and `job_type.required_asset_ids` are still
 * compared to each other by equality, and that comparison is still what
 * prevents the truck roll: this job needs a chipper, this crew does not carry
 * one. What changed is that the strings are no longer opaque. Each one is a
 * `company_asset.requirement_code`, so the register can say what the company
 * actually owns under that name and whether any of it can go out today.
 *
 * MATCHED BY CODE AND NOT BY ID, which is the part worth arguing about. This
 * comment used to say the two columns should become foreign keys to a uuid
 * the day a register landed. That turns out to be wrong: a job type saying
 * tree removal needs a chipper is talking about a CLASS of machine, and
 * pinning it to one row ties every tree removal in the company to one
 * physical chipper, so buying a second or retiring the first silently breaks
 * the job type. Two chippers carry the same code and either satisfies it.
 *
 * WHAT THE REGISTER ADDS, exactly. A missing item is named with its real
 * label rather than its code when the company owns one. And a crew that
 * carries the code is refused anyway when every unit behind it is retired or
 * grounded by an expired obligation that `packages/core/src/assets` says
 * stops the asset being used: an expired inspection on the only chipper is
 * the same lost day as not owning one, and it was invisible here before.
 * A code the register has never heard of makes no claim either way, and
 * `registeredEquipment` says which codes those were.
 *
 * TIME OFF IS COUNTED ONLY WHEN APPROVED, matching the dispatch board, which
 * draws an empty column for approved leave only. A requested day that nobody
 * has signed off is not yet a reason to refuse work.
 */
export async function canTake(
  ctx: ServiceContext, input: { id: string; jobId: string; on?: string | undefined },
): Promise<CrewVerdict> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const crew = await crewWithin(tx, ctx, input.id);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);
    const job = await loadJob(tx, ctx.actor.organizationId, input.jobId, ctx);
    const register = await registerFor(tx, ctx.actor.organizationId, job.requiredAssetIds, on);
    return verdict(tx, ctx.actor.organizationId, crew, job, on, zone, register);
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
    const job = await loadJob(tx, ctx.actor.organizationId, input.jobId, ctx);

    /** The crews this person may send, and no other branch's (`people-scope.ts`). */
    const crews = await tx.select().from(schema.crew)
      .where(and(
        eq(schema.crew.organizationId, ctx.actor.organizationId),
        eq(schema.crew.active, true),
        crewsInView(ctx),
      ))
      .orderBy(asc(schema.crew.name));

    /**
     * The register is read ONCE for the whole board rather than once per
     * crew. Every crew on this screen is being asked about the same job, so
     * the kit the work needs is the same list, and a query per crew turns one
     * read into one per crew on a screen that already does a time off read
     * each.
     */
    const register = await registerFor(tx, ctx.actor.organizationId, job.requiredAssetIds, on);

    const out: CrewVerdict[] = [];
    for (const crew of crews) {
      out.push(await verdict(tx, ctx.actor.organizationId, crew, job, on, zone, register));
    }
    return { jobId: job.id, on, crews: out };
  });
}

/**
 * Which crews may take which jobs on which days, for a planner asking many
 * at once (the multi day rebalance): the same verdict a drag onto a crew
 * gets, as the sentence it would refuse with, or null when the crew may.
 * Inside the caller's transaction; its guard authorizes the read. The
 * register is read once per job and day, not per crew.
 */
export async function crewRefusals(
  tx: Database, organizationId: string,
  input: { crewIds: string[]; asks: { jobId: string; date: string }[] },
): Promise<(crewId: string, jobId: string, date: string) => string | null> {
  const answers = new Map<string, string | null>();
  if (input.crewIds.length === 0 || input.asks.length === 0) return () => null;
  const zone = await timezoneOf(tx, organizationId);
  const crews = await tx.select().from(schema.crew)
    .where(and(eq(schema.crew.organizationId, organizationId), inArray(schema.crew.id, input.crewIds)));
  const jobs = new Map<string, JobFacts>();
  const seen = new Set<string>();
  for (const ask of input.asks) {
    const key = `${ask.jobId}|${ask.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!jobs.has(ask.jobId)) jobs.set(ask.jobId, await loadJob(tx, organizationId, ask.jobId));
    const job = jobs.get(ask.jobId)!;
    const register = await registerFor(tx, organizationId, job.requiredAssetIds, ask.date);
    for (const crew of crews) {
      const answer = await verdict(tx, organizationId, crew, job, ask.date, zone, register);
      answers.set(`${crew.id}|${key}`, answer.canTake ? null : answer.blockers.map((b) => b.explanation).join(" "));
    }
  }
  return (crewId, jobId, date) => {
    const key = `${crewId}|${jobId}|${date}`;
    /** A question nobody asked is not a clearance. */
    return answers.has(key) ? answers.get(key)! : "Not checked for that day.";
  };
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
  register: Register,
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
  const missingEquipment = job.requiredAssetIds.filter((code) => !carried.has(code));
  if (missingEquipment.length > 0) {
    blockers.push({
      code: "missing_equipment",
      explanation:
        `${crew.name} does not carry ${missingEquipment.map((code) => describe(register, code)).join(", ")}, `
        + "which this work needs. Sending it means a second trip for the kit and a day of crew "
        + "time nobody sold.",
    });
  }

  /**
   * THE KIT THE CREW HAS AND CANNOT USE.
   *
   * Only asked about codes the crew DOES carry, because a code it is already
   * refused for being short of does not also need a second reason. A code the
   * register has never heard of is skipped entirely rather than treated as
   * unavailable: before this table existed every code was in that state, and
   * refusing them all would stop every crew in every company that has not
   * filled the register in.
   */
  const unavailableEquipment: CrewVerdict["unavailableEquipment"] = [];
  for (const code of job.requiredAssetIds) {
    if (!carried.has(code)) continue;
    const units = register.get(code);
    if (!units || units.length === 0) continue;
    if (units.some((unit) => unit.reason === null)) continue;

    /**
     * Grounded before retired when both exist, because they are different
     * jobs for different people. A grounded chipper is an inspection somebody
     * can book this afternoon; a retired one means the company does not have
     * the machine and somebody has to hire one.
     */
    const named = units.find((unit) => unit.reason === "grounded") ?? units[0]!;
    unavailableEquipment.push({
      code,
      assetId: named.id,
      assetLabel: named.label,
      reason: named.reason ?? "retired",
      explanation: named.explanation ?? "",
    });
  }
  if (unavailableEquipment.length > 0) {
    blockers.push({
      code: "equipment_unavailable",
      explanation:
        `${crew.name} carries ${unavailableEquipment.map((u) => u.assetLabel).join(", ")} and the `
        + `register says it cannot go out on ${on}. `
        + unavailableEquipment.map((u) => u.explanation).join(" "),
    });
  }

  /**
   * SKILLS, FROM TWO SOURCES THAT ANSWER DIFFERENT QUESTIONS.
   *
   * `crew.skills` is a list somebody typed onto the crew record. It was the
   * only source this file had, and "not qualified for epa_608" is the whole
   * of what it can say: true, and useless to the person deciding what to do
   * with this job this morning. They cannot tell from it whether nobody ever
   * held it, whether the person who held it left, or whether it ran out last
   * month, and those have three different answers before the truck goes.
   *
   * `people.skillStanding` answers from recorded certifications, so it can
   * name whose, why and when. It only speaks for skills this company has
   * declared a certification type for; for anything else it returns
   * `uncertified`, which is NOT a clearance, and the typed list stays the
   * only thing that knows anything about that skill.
   *
   * So the refusal fires on either source, and the certification sentence is
   * preferred wherever there is one:
   *
   *   lapsed, absent  refuse, naming the person and the date.
   *   covered         clear it, even where the typed list omits the skill. A
   *                   recorded live certification is harder evidence than a
   *                   string somebody did or did not remember to type, and
   *                   gating real capacity behind that omission is a crew
   *                   sitting in the yard on a job it can do.
   *   uncertified     fall back to the typed list, unchanged.
   *
   * Asked only about the people actually working that day, because a crew
   * whose only EPA holder is on approved time off cannot do EPA work on that
   * date, and that date is what `canTake` is being asked about. When nobody
   * is available it is not asked at all: `no_members` and `everybody_off`
   * already say so, and "nobody here holds a certification" when nobody is
   * here is not a second fact to act on.
   */
  const known = new Set(crew.skills);
  const standing = available.length === 0 || job.requiredSkills.length === 0
    ? []
    : await skillStanding(tx, organizationId, {
      technicianIds: available.map((m) => m.technicianId),
      skills: job.requiredSkills,
      on,
    });
  const stated = new Map(standing.map((s) => [s.skill, s]));

  const missingSkills: string[] = [];
  const skillRefusals: string[] = [];
  for (const skill of job.requiredSkills) {
    const said = stated.get(skill.trim());
    if (said && said.state !== "uncertified") {
      if (said.state === "covered") continue;
      missingSkills.push(skill);
      skillRefusals.push(said.explanation);
      continue;
    }
    if (!known.has(skill)) {
      missingSkills.push(skill);
      skillRefusals.push(`${crew.name} is not qualified for ${skill}.`);
    }
  }
  if (missingSkills.length > 0) {
    blockers.push({ code: "missing_skills", explanation: skillRefusals.join(" ") });
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
    unavailableEquipment,
    missingSkills,
    headcount: {
      onCrew: members.length,
      availableOn: available.length,
      offOn: members.length - available.length,
    },
    leadDesignated,
    equipmentBasis: job.jobTypeId ? "job_type" : "none_declared",
    registeredEquipment: job.requiredAssetIds.filter((code) => (register.get(code)?.length ?? 0) > 0),
  };
}

/* ------------------------------------------------- the company's own tools */

/**
 * WHAT THE COMPANY ACTUALLY OWNS UNDER EACH OF THESE NAMES.
 *
 * `company_asset.requirement_code` is what a crew and a job type name when
 * they say they need a chipper. It is not unique and it is not a row id: see
 * the long note on `canTake` for why pointing a job type at one physical
 * machine would be the wrong reference.
 *
 * `reason` is null for a unit that can go out, and names the problem
 * otherwise. The grounding decision is NOT made here: `packages/core/src/assets`
 * owns it, and `COMPLIANCE[kind].groundsTheAsset` is what says that an
 * expired inspection stops a van leaving the yard while an expired
 * calibration, which is worse in a different way, does not.
 */
interface RegisteredUnit {
  id: string;
  label: string;
  reason: "retired" | "grounded" | null;
  explanation: string | null;
}
type Register = Map<string, RegisteredUnit[]>;

async function registerFor(
  tx: Database, organizationId: string, codes: readonly string[], on: string,
): Promise<Register> {
  const register: Register = new Map();
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return register;

  const rows = await tx.select({
    id: schema.companyAsset.id,
    label: schema.companyAsset.label,
    requirementCode: schema.companyAsset.requirementCode,
    retiredOn: schema.companyAsset.retiredOn,
  }).from(schema.companyAsset)
    .where(and(
      eq(schema.companyAsset.organizationId, organizationId),
      inArray(schema.companyAsset.requirementCode, wanted),
    ));
  if (rows.length === 0) return register;

  const obligations = await tx.select().from(schema.assetCompliance)
    .where(and(
      eq(schema.assetCompliance.organizationId, organizationId),
      inArray(schema.assetCompliance.assetId, rows.map((r) => r.id)),
    ));

  /**
   * Asked AS OF THE DAY THE WORK IS, not as of today, for the same reason
   * `assign` judges the people on the day of the visit: an inspection that
   * expires on Wednesday does not stop Tuesday's job and does stop Thursday's.
   */
  const alerts = assetCore.complianceOutlook(
    obligations.map((o) => ({
      assetId: o.assetId,
      kind: o.kind,
      expiresOn: o.expiresOn,
      ...(o.reference === null ? {} : { reference: o.reference }),
      ...(o.lastCertifiedOn === null ? {} : { lastCertifiedOn: o.lastCertifiedOn }),
    })),
    on,
  );
  const grounded = new Map<string, string>();
  for (const alert of alerts) {
    if (alert.status !== "expired" || !alert.groundsTheAsset) continue;
    if (!grounded.has(alert.obligation.assetId)) {
      grounded.set(alert.obligation.assetId, assetCore.explainAlert(alert));
    }
  }

  for (const row of rows) {
    if (row.requirementCode === null) continue;
    const list = register.get(row.requirementCode) ?? [];
    const groundedBy = grounded.get(row.id);
    list.push({
      id: row.id,
      label: row.label,
      reason: row.retiredOn !== null ? "retired" : groundedBy ? "grounded" : null,
      explanation: row.retiredOn !== null
        ? `${row.label} was retired on ${row.retiredOn}, so the company no longer has it.`
        : groundedBy ?? null,
    });
    register.set(row.requirementCode, list);
  }
  return register;
}

/**
 * A required code in the words somebody would use for it.
 *
 * The code itself when the register has never heard of it, which is what this
 * said for every code before the register existed and is still the honest
 * answer for a company that has not filled it in.
 */
function describe(register: Register, code: string): string {
  const units = register.get(code);
  const first = units?.[0];
  return first ? `${first.label} (${code})` : code;
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
    /** A visit on this person's board, and nobody else's: the rule `dispatch.assign` follows. */
    const [visit] = await tx.select().from(schema.visit)
      .where(and(
        eq(schema.visit.id, input.id),
        jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.visit.jobId}`),
      )).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    // The same three terminal states `services/dispatch.ts` refuses to
    // reassign. A completed visit's crew is a historical fact.
    if (["completed", "cancelled", "completed_after_cancellation"].includes(visit.status)) {
      throw new ConflictError(`This visit is ${visit.status} and cannot be reassigned.`);
    }

    const crew = await crewWithin(tx, ctx, input.crewId);
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

    const register = await registerFor(tx, ctx.actor.organizationId, job.requiredAssetIds, on);
    const answer = await verdict(tx, ctx.actor.organizationId, crew, job, on, zone, register);
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

    /** Who was on it before, so the members added and anybody taken off each hear about it. */
    const before = (await sideOf(tx, visit.id))!;

    /**
     * EXACTLY ONE OF A CREW OR PEOPLE. Sending a visit to a crew takes it
     * off whoever had it on their own day, which is what the schema says of
     * `visit.crew_id` and what the board draws: a card in the crew's lane
     * that is also in somebody's column is two vans at one house.
     */
    const handedOver = await tx.delete(schema.visitAssignment)
      .where(eq(schema.visitAssignment.visitId, visit.id))
      .returning({ technicianId: schema.visitAssignment.technicianId });

    await tx.update(schema.visit).set({
      crewId: crew.id,
      /** The crew's shop (`visit-shop.ts`). */
      locationId: await shopOfCrew(tx, crew.id),
      status,
      dispatchedAt: visit.dispatchedAt ?? new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.visit.id, visit.id));

    await audit(tx, ctx, "visit.crew_assigned", "visit", visit.id,
      { crewId: visit.crewId, status: visit.status, technicianIds: handedOver.map((h) => h.technicianId) },
      { crewId: crew.id, status });
    await announce(tx, ctx, visit.id, before);

    return { id: visit.id, crewId: crew.id, status, on };
  });
}

/* ----------------------------------------------------------------- loading */

/**
 * The job, plus what its type says the work needs.
 *
 * A left join rather than two reads, and a job with no type is a real state
 * rather than an error: plenty of work is booked as a sentence and a price.
 * The verdict says which case it was in `equipmentBasis` instead of
 * pretending an absent type is an empty requirement.
 */
async function loadJob(tx: Database, organizationId: string, id: string, ctx?: ServiceContext): Promise<JobFacts> {
  const [row] = await tx.select({
    id: schema.job.id,
    businessUnitId: schema.job.businessUnitId,
    jobTypeId: schema.job.jobTypeId,
    requiredAssetIds: schema.jobType.requiredAssetIds,
    requiredSkills: schema.jobType.requiredSkills,
    jobSkills: schema.job.requiredSkills,
    droppedSkills: schema.job.droppedSkills,
  }).from(schema.job)
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.job.jobTypeId))
    .where(and(
      eq(schema.job.id, id),
      eq(schema.job.organizationId, organizationId),
      isNull(schema.job.deletedAt),
      /** Asked by a person, a job on their board; asked inside a planner, its guard decided. */
      ctx ? jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.job.id}`) : undefined,
    )).limit(1);
  if (!row) throw new NotFoundError("Job");

  return {
    id: row.id,
    businessUnitId: row.businessUnitId,
    jobTypeId: row.jobTypeId,
    requiredAssetIds: row.requiredAssetIds ?? [],
    /** The type's skills and the job's own, checked together like everywhere else. */
    requiredSkills: workSkills(row.requiredSkills, row.jobSkills, row.droppedSkills),
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
      id: string; name: string; businessUnitId: string | null; homeLocationId: string | null;
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
    businessUnitId?: string | null | undefined;
    homeLocationId?: string | null | undefined;
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
