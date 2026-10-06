import { sql, type SQL } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import type { Scope } from "@opentradesos/core";

/**
 * TURNING A SCOPE INTO A FILTER
 *
 * A permission answers "may this account read customers at all". A scope
 * answers "which customers". They fail differently, and that difference is
 * the whole reason this file exists.
 *
 * A missing permission throws, loudly, in one place. A scope that is resolved
 * and then not applied returns the entire organization, and every test about
 * permissions still passes. That is precisely what was happening. `jobs.list`
 * knew how to apply `own` and nothing else, so a crew lead read every job in
 * the company. Worse, `customers`, `billing` and `estimates` resolved no
 * scope at all, while the comment on the technician row in `scopes.ts` said
 * customer scope was "what stops a departing technician walking out with the
 * customer list". It was not stopping anything.
 *
 * So the rule here is FAIL CLOSED. A scope this file cannot turn into a
 * filter returns a condition that matches nothing, rather than falling
 * through to no condition at all. An account that sees nothing raises a
 * support ticket within the hour; an account that sees everything is found
 * during an incident, if it is found.
 */

/** Matches no row. What an unsatisfiable scope resolves to. */
const NOTHING: SQL = sql`false`;

export interface ScopeContext {
  /** The person asking, for the people filters' `own`: their own membership. */
  userId?: string | undefined;
  technicianId?: string | undefined;
  crewIds?: readonly string[] | undefined;
  businessUnitId?: string | undefined;
  locationId?: string | undefined;
}

/**
 * Whether a technician can see a given job, as a condition on a job id.
 *
 * Every other filter in this file is expressed in terms of this one, because
 * "which customers" and "which invoices" both reduce to "which jobs did this
 * person actually work". Writing that reduction once means the four filters
 * cannot disagree about what `own` means, which is the way this kind of code
 * usually rots: the job filter gets tightened and the invoice filter does not.
 *
 * Returns `undefined` for `all`, which is the one scope that genuinely means
 * no restriction.
 */
export function jobVisibility(scope: Scope, actor: ScopeContext, jobId: SQL): SQL | undefined {
  switch (scope) {
    case "all":
      return undefined;

    /**
     * The technician's own work: a job they are assigned a visit on. Not
     * "a job at a customer they have visited", which would hand over the
     * customer's whole history from one callout.
     */
    case "own":
      if (!actor.technicianId) return NOTHING;
      return sql`exists (
        select 1 from public.visit v
        join public.visit_assignment va on va.visit_id = v.id
        where v.job_id = ${jobId} and va.technician_id = ${actor.technicianId}
      )`;

    /**
     * A crew lead sees their crew's work, and their own. Both, because a lead
     * is also a technician and can be sent out alone, and a filter that only
     * looked at the crew would hide their own solo calls from them.
     */
    case "crew": {
      const crews = actor.crewIds ?? [];
      if (crews.length === 0) {
        /**
         * A lead with no crew still sees their own work, and that is the
         * definition rather than a kindness: `crew` sits above `own` in the
         * scope ladder, so it is a superset of it. With no crew the superset
         * is just the subset.
         */
        return actor.technicianId ? jobVisibility("own", actor, jobId) ?? NOTHING : NOTHING;
      }
      return sql`exists (
        select 1 from public.visit v
        left join public.visit_assignment va on va.visit_id = v.id
        where v.job_id = ${jobId}
          and (
            v.crew_id in ${crews}
            ${actor.technicianId ? sql`or va.technician_id = ${actor.technicianId}` : sql``}
          )
      )`;
    }

    /**
     * A branch. Read off the job directly: resolving it through the visits
     * would make a job with no visit yet belong to no branch, and an
     * unscheduled job is exactly what a branch manager is looking for.
     */
    case "business_unit":
      if (!actor.businessUnitId) return NOTHING;
      return sql`exists (
        select 1 from public.job bj
        where bj.id = ${jobId} and bj.business_unit_id = ${actor.businessUnitId}
      )`;

    /**
     * A physical shop. That lives on the VISIT rather than the job, because
     * one job can be served from two shops, so this asks whether any of its
     * visits were.
     *
     * A visit is the shop's when it says so: `visit.location_id`, written
     * when it is booked with somebody or assigned (`visit-shop.ts`). Read
     * there and nowhere else once written, so a technician who moves shops
     * does not take the work they did from the old one with them.
     *
     * A visit that carries no shop (one booked before the shop was written,
     * which nothing filled in afterwards, or one nobody has yet) is the
     * shop's when somebody based there is on it: a technician whose day
     * starts there or whose membership is there, or a crew based there.
     */
    case "location": {
      if (!actor.locationId) return NOTHING;
      const shop = actor.locationId;
      return sql`exists (
        select 1 from public.visit v
        where v.job_id = ${jobId}
          and (
            v.location_id = ${shop}
            or (v.location_id is null and (
              exists (select 1 from public.crew lc where lc.id = v.crew_id and lc.home_location_id = ${shop})
              or exists (
                select 1 from public.visit_assignment lva
                join public.technician lt on lt.id = lva.technician_id
                left join public.membership lm on lm.id = lt.membership_id
                where lva.visit_id = v.id
                  and (lt.home_location_id = ${shop} or lm.location_id = ${shop})
              )
            ))
          )
      )`;
    }

    default:
      /**
       * A scope added to the type and not to this switch. It reaches here
       * rather than falling out of the function, which is the difference
       * between an account seeing nothing and an account seeing everything.
       */
      return NOTHING;
  }
}

/** Reading the job table itself. */
export function jobScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  if (scope === "business_unit") {
    // Directly on the row being filtered, rather than through the subquery
    // the generic form would build against itself.
    return actor.businessUnitId
      ? sql`${schema.job.businessUnitId} = ${actor.businessUnitId}`
      : NOTHING;
  }
  return jobVisibility(scope, actor, sql`${schema.job.id}`);
}

/**
 * Reading customers.
 *
 * A customer is visible when the account can see any job of theirs. This is
 * the filter the comment in `scopes.ts` has been promising: a technician sees
 * the people they have been sent to, and leaves with that rather than with
 * the company's book.
 */
export function customerScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  if (scope === "all") return undefined;
  const visible = jobVisibility(scope, actor, sql`cj.id`);
  if (visible === undefined) return undefined;
  return sql`exists (
    select 1 from public.job cj
    where cj.customer_id = ${schema.customer.id}
      and cj.deleted_at is null
      and ${visible}
  )`;
}

/**
 * Reading invoices and estimates.
 *
 * Both hang off a job, and both allow that job to be null: an invoice can be
 * raised against a customer with no job, and an estimate can exist before the
 * work does. A document with no job is NOT visible at a restricted scope,
 * because there is no work to have done on it. That is deliberate and it is
 * the conservative reading: an invoice a technician cannot tie to a job they
 * worked is one they have no reason to see.
 */
function documentFilter(scope: Scope, actor: ScopeContext, jobIdColumn: SQL): SQL | undefined {
  if (scope === "all") return undefined;
  const visible = jobVisibility(scope, actor, jobIdColumn);
  if (visible === undefined) return undefined;
  return sql`(${jobIdColumn} is not null and ${visible})`;
}

export const invoiceScopeFilter = (scope: Scope, actor: ScopeContext): SQL | undefined =>
  documentFilter(scope, actor, sql`${schema.invoice.jobId}`);

export const estimateScopeFilter = (scope: Scope, actor: ScopeContext): SQL | undefined =>
  documentFilter(scope, actor, sql`${schema.estimate.jobId}`);

/**
 * WHICH CONVERSATIONS
 *
 * A conversation reaches a restricted actor two ways, and both have to hold
 * or a technician reads the company's inbox: the thread is attached to a job
 * they can see, or it belongs to a customer they have been sent to.
 *
 * A thread attached to NEITHER is invisible at a restricted scope. An inbound
 * text from a number matching no customer is a lead, and a lead is the office's
 * to answer: a technician has no work it relates to, so there is nothing for
 * them to do with it and no reason for them to read it.
 */
export function conversationScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  if (scope === "all") return undefined;

  const byJob = jobVisibility(scope, actor, sql`${schema.conversation.jobId}`);
  if (byJob === undefined) return undefined;

  return sql`(
    (${schema.conversation.jobId} is not null and ${byJob})
    or exists (
      select 1 from public.job cj
      where cj.customer_id = ${schema.conversation.customerId}
        and cj.deleted_at is null
        and ${jobVisibility(scope, actor, sql`cj.id`) ?? sql`true`}
    )
  )`;
}

/* ---------------------------------------------- a branch chosen on a list */

/**
 * A BRANCH SOMEBODY PICKED, as opposed to a branch somebody is limited to.
 *
 * The office filtering the job list to Houston and a Houston manager whose
 * scope is Houston are asking the same question, and both are answered by
 * the `business_unit` case of the filters above rather than by a second set
 * of conditions. Two definitions of "belongs to Houston" would disagree
 * about invoices with no job, or customers served by both branches, and the
 * filtered list would stop adding up to what the manager sees.
 *
 * These narrow; they never widen. A filter is ANDed with the person's own
 * scope by every caller, so picking Austin while scoped to Houston shows
 * nothing rather than Austin.
 */
const branch = (businessUnitId: string): ScopeContext => ({ businessUnitId });

/** Jobs in one branch, or with none (`null`), which only the office sees. */
export function jobBranchFilter(businessUnitId: string | null): SQL {
  return businessUnitId === null
    ? sql`${schema.job.businessUnitId} is null`
    : jobScopeFilter("business_unit", branch(businessUnitId)) ?? NOTHING;
}

/** Customers the branch has done work for. */
export const customerBranchFilter = (businessUnitId: string): SQL =>
  customerScopeFilter("business_unit", branch(businessUnitId)) ?? NOTHING;

/** Invoices on the branch's jobs. An invoice with no job belongs to no branch. */
export const invoiceBranchFilter = (businessUnitId: string): SQL =>
  invoiceScopeFilter("business_unit", branch(businessUnitId)) ?? NOTHING;

/** Estimates on the branch's jobs, the same way. */
export const estimateBranchFilter = (businessUnitId: string): SQL =>
  estimateScopeFilter("business_unit", branch(businessUnitId)) ?? NOTHING;

/**
 * Any record whose job id is an expression, for the report datasets that are
 * not the job table itself (a visit, a profitability row).
 */
export const branchOfJob = (businessUnitId: string, jobId: SQL): SQL =>
  jobVisibility("business_unit", branch(businessUnitId), jobId) ?? NOTHING;

/* ------------------------------------------------------- which people */

/**
 * WHICH PEOPLE, as a condition on the technician table.
 *
 * The board's columns, the map's vans and a supervisor's timesheets are
 * about people rather than jobs, and "which jobs did this person work" is the
 * wrong question for them: a technician with nothing booked today is still
 * somebody a branch manager has to fill a day for. So people are scoped by
 * where they belong, the same ladder as everything else:
 *
 *   own            themselves
 *   crew           themselves and the people on their crews
 *   business_unit  the people whose branch is this person's branch
 *   location       the people based at this person's shop: their day starts
 *                  there, or their membership names it
 *
 * A technician from another branch working one of this branch's jobs is not
 * matched here, and the callers that draw a day add them back from the
 * visits they can see: a Houston technician on an Austin job is on Austin's
 * board for that job, and their timesheet stays Houston's to approve.
 */
export function technicianScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  switch (scope) {
    case "all":
      return undefined;
    case "own":
      return actor.technicianId ? sql`${schema.technician.id} = ${actor.technicianId}` : NOTHING;
    case "crew": {
      const crews = actor.crewIds ?? [];
      const self = actor.technicianId ? sql`${schema.technician.id} = ${actor.technicianId}` : NOTHING;
      if (crews.length === 0) return self;
      return sql`(${self} or exists (
        select 1 from public.crew_member scm
        where scm.technician_id = ${schema.technician.id} and scm.crew_id in ${crews}
      ))`;
    }
    case "business_unit":
      if (!actor.businessUnitId) return NOTHING;
      return sql`exists (
        select 1 from public.membership sm
        where sm.id = ${schema.technician.membershipId} and sm.business_unit_id = ${actor.businessUnitId}
      )`;
    /** Based at the shop: their day starts there, or their membership says so. */
    case "location":
      if (!actor.locationId) return NOTHING;
      return sql`(${schema.technician.homeLocationId} = ${actor.locationId} or exists (
        select 1 from public.membership sm
        where sm.id = ${schema.technician.membershipId} and sm.location_id = ${actor.locationId}
      ))`;
    default:
      return NOTHING;
  }
}

/**
 * A service report, through its job, the way every other record that hangs
 * off a job is: a technician reads the reports for the work they did, and a
 * branch manager the reports for their branch's jobs.
 */
export const serviceReportScopeFilter = (scope: Scope, actor: ScopeContext): SQL | undefined =>
  jobVisibility(scope, actor, sql`${schema.serviceReport.jobId}`);

/* ------------------------------------------- people records, crews, routes */

/**
 * WHICH PEOPLE, as a condition on the membership table: the Team and People
 * lists, and a person's own record opened by its id.
 *
 * The same ladder as `technicianScopeFilter`, read off the membership
 * because an office person has a membership and no technician row:
 *
 *   own            their own membership
 *   crew           theirs, and the people on their crews
 *   business_unit  the people whose branch is this person's branch
 *   location       the people based at this person's shop: their
 *                  membership names it, or their day starts there
 *
 * Somebody in no branch belongs to nobody's branch, the rule a job with no
 * branch follows: only people who see the whole company see them.
 */
export function membershipScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  switch (scope) {
    case "all":
      return undefined;
    case "own":
      return actor.userId ? sql`${schema.membership.userId} = ${actor.userId}` : NOTHING;
    case "crew": {
      const crews = actor.crewIds ?? [];
      const self = actor.userId ? sql`${schema.membership.userId} = ${actor.userId}` : NOTHING;
      if (crews.length === 0) return self;
      return sql`(${self} or exists (
        select 1 from public.technician mt
        join public.crew_member mcm on mcm.technician_id = mt.id
        where mt.membership_id = ${schema.membership.id} and mcm.crew_id in ${crews}
      ))`;
    }
    case "business_unit":
      return actor.businessUnitId
        ? sql`${schema.membership.businessUnitId} = ${actor.businessUnitId}`
        : NOTHING;
    case "location":
      if (!actor.locationId) return NOTHING;
      return sql`(${schema.membership.locationId} = ${actor.locationId} or exists (
        select 1 from public.technician mt
        where mt.membership_id = ${schema.membership.id} and mt.home_location_id = ${actor.locationId}
      ))`;
    default:
      return NOTHING;
  }
}

/**
 * WHICH CREWS, as a condition on the crew table.
 *
 * A crew is a branch's when it says so (`crew.business_unit_id`), and a
 * shop's when it is based there. Not when some of its people are: a crew
 * with an Austin lead and a Houston helper would then be both branches', and
 * either manager could change who is on it. A crew in no branch is the
 * office's, like a job in no branch, and Settings, Crews puts it in one.
 * Someone limited to their own work or their crew's sees the crews they
 * are on.
 */
export function crewScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  switch (scope) {
    case "all":
      return undefined;
    case "own":
    case "crew": {
      /**
       * The same answer for both: a person's crews are the ones they are on,
       * which is what `crewIds` is read from at sign in. Asked of the table
       * as well, so a crew somebody was put on since they signed in counts.
       */
      const crews = actor.crewIds ?? [];
      const onIt = actor.technicianId
        ? sql`exists (
            select 1 from public.crew_member ccm
            where ccm.crew_id = ${schema.crew.id} and ccm.technician_id = ${actor.technicianId}
          )`
        : NOTHING;
      return crews.length === 0 ? onIt : sql`(${schema.crew.id} in ${crews} or ${onIt})`;
    }
    case "business_unit":
      return actor.businessUnitId ? sql`${schema.crew.businessUnitId} = ${actor.businessUnitId}` : NOTHING;
    case "location":
      return actor.locationId ? sql`${schema.crew.homeLocationId} = ${actor.locationId}` : NOTHING;
    default:
      return NOTHING;
  }
}

/**
 * WHICH ROUTES, as a condition on the route table: a route is whoever runs
 * it, so it is seen by whoever sees its technician or its crew. A route run
 * by nobody yet belongs to no branch, and only the whole company sees it.
 */
export function routeScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
  if (scope === "all") return undefined;
  const person = technicianScopeFilter(scope, actor) ?? NOTHING;
  const crew = crewScopeFilter(scope, actor) ?? NOTHING;
  return sql`(
    exists (select 1 from public.technician where ${schema.technician.id} = ${schema.route.technicianId} and ${person})
    or exists (select 1 from public.crew where ${schema.crew.id} = ${schema.route.crewId} and ${crew})
  )`;
}
