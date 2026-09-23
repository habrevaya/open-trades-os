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
     */
    case "location":
      if (!actor.locationId) return NOTHING;
      return sql`exists (
        select 1 from public.visit v
        where v.job_id = ${jobId} and v.location_id = ${actor.locationId}
      )`;

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
