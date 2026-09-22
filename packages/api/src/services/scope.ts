import { sql, type SQL } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import type { Scope } from "@opentradesos/core";

/**
 * TURNING A SCOPE INTO A FILTER
 *
 * A permission answers "may this account read jobs at all". A scope answers
 * "which jobs". They fail differently, and that difference is the whole
 * reason this file exists.
 *
 * A missing permission throws, loudly, in one place. A scope that is resolved
 * and then not applied returns the entire organization, and every test about
 * permissions still passes. That is precisely what was happening: `jobs.list`
 * computed the scope and only knew how to apply `own`, so a crew lead, whose
 * role explicitly says `job: "crew"`, was reading every job in the company.
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
 * The filter for reading JOBS at a given scope.
 *
 * Returns `undefined` only for `all`, which is the one scope that genuinely
 * means no restriction. Every other outcome is a condition, including the
 * ones that match nothing.
 */
export function jobScopeFilter(scope: Scope, actor: ScopeContext): SQL | undefined {
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
        where v.job_id = ${schema.job.id} and va.technician_id = ${actor.technicianId}
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
         *
         * With no technician record either there is nothing to resolve, and
         * that is where it fails closed.
         */
        return actor.technicianId ? jobScopeFilter("own", actor) ?? NOTHING : NOTHING;
      }
      return sql`exists (
        select 1 from public.visit v
        left join public.visit_assignment va on va.visit_id = v.id
        where v.job_id = ${schema.job.id}
          and (
            v.crew_id in ${crews}
            ${actor.technicianId ? sql`or va.technician_id = ${actor.technicianId}` : sql``}
          )
      )`;
    }

    /**
     * A branch. The job carries the business unit directly, which matters:
     * resolving it through the visits would make a job with no visit yet
     * belong to nobody, and an unscheduled job is exactly what a branch
     * manager is looking for.
     */
    case "business_unit":
      if (!actor.businessUnitId) return NOTHING;
      return sql`${schema.job.businessUnitId} = ${actor.businessUnitId}`;

    /**
     * A physical location: the shop the work is dispatched out of. That lives
     * on the VISIT rather than the job, because one job can be served from
     * two shops, so this asks whether any of its visits were.
     */
    case "location":
      if (!actor.locationId) return NOTHING;
      return sql`exists (
        select 1 from public.visit v
        where v.job_id = ${schema.job.id} and v.location_id = ${actor.locationId}
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
