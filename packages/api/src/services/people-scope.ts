import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { narrowest, type Scope } from "@opentradesos/core";
import { NotFoundError, scopeOf, type ServiceContext } from "./context";
import {
  crewScopeFilter, membershipScopeFilter, routeScopeFilter, technicianScopeFilter,
} from "./scope";

/**
 * WHICH PEOPLE, CREWS AND ROUTES SOMEBODY IS SHOWN
 *
 * A branch manager's board and timesheets were their branch's while the
 * lists behind them were the company's: the technicians screen, the crews,
 * the routes, Team and People. Not their work, but who works where, and a
 * handle to change it by id. These read the same filters `services/scope.ts`
 * already applies to the board, so "who is in Houston" has one answer.
 *
 * TWO SCOPES, BECAUSE THERE ARE TWO PRECEDENTS. The dispatch side (the
 * technicians list, crews and routes, all `visit:read` to read) is narrowed
 * by the visit scope, as the board's columns are. A person's own record
 * (Team, People, a person opened by id, their skills and phones, all
 * `user:read`) is narrowed by the timesheet scope, as their timesheets and
 * time off are. Every preset and every role made on the roles screen sets
 * both the same, so the two only differ for a role written by hand through
 * the API that says so.
 *
 * OUT OF SCOPE READS AS NOT FOUND, the rule every other read here follows:
 * "you may not" confirms there is somebody there.
 */

/**
 * The scope people are read with. The resource's own, except for an actor
 * whose authority STATES its scopes (a connected app, a custom role) and
 * names none for this one: a migration app granted `user:read` with scopes
 * for customers, jobs and invoices was given before people were scoped, and
 * reading its people as `own`, the default for a resource nothing names,
 * would show it nobody. It reads them at the narrowest scope it does state,
 * so it sees no more of the company's people than of its work; an actor that
 * states nothing at all still sees nobody (`effectiveScope` in core). A limit
 * set on the person still narrows it.
 */
export function peopleScopeOf(ctx: ServiceContext, resource: "visit" | "timesheet"): Scope {
  const { actor } = ctx;
  const stated = actor.roles.length === 0 && actor.scopes ? Object.values(actor.scopes) as Scope[] : [];
  if (stated.length === 0 || actor.scopes?.[resource] !== undefined) return scopeOf(ctx, resource);
  const base = stated.reduce((a, b) => narrowest(a, b));
  const limit = actor.scopeOverrides?.[resource];
  return limit ? narrowest(base, limit) : base;
}

/** People on the dispatch side, as a condition on `technician`. */
export const dispatchPeople = (ctx: ServiceContext) =>
  technicianScopeFilter(peopleScopeOf(ctx, "visit"), ctx.actor);

/** People's records, as a condition on `technician`. */
export const recordPeople = (ctx: ServiceContext) =>
  technicianScopeFilter(peopleScopeOf(ctx, "timesheet"), ctx.actor);

/** People's records, as a condition on `membership`. */
export const members = (ctx: ServiceContext) =>
  membershipScopeFilter(peopleScopeOf(ctx, "timesheet"), ctx.actor);

/** Crews, as a condition on `crew`. */
export const crews = (ctx: ServiceContext) =>
  crewScopeFilter(peopleScopeOf(ctx, "visit"), ctx.actor);

/** Routes, as a condition on `route`. */
export const routes = (ctx: ServiceContext) =>
  routeScopeFilter(peopleScopeOf(ctx, "visit"), ctx.actor);

/** Whether this person sees the whole company's people, which the screens use to offer moving them. */
export const seesEverybody = (ctx: ServiceContext) =>
  peopleScopeOf(ctx, "timesheet") === "all" && peopleScopeOf(ctx, "visit") === "all";

/**
 * A technician by id, from the dispatch side or the records side, or not
 * found. Inside the caller's transaction, whose guard has already decided
 * they may read or change technicians at all.
 */
export async function technicianWithin(
  tx: Database, ctx: ServiceContext, technicianId: string, side: "dispatch" | "records",
) {
  const [row] = await tx.select().from(schema.technician)
    .where(and(
      eq(schema.technician.id, technicianId),
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      side === "dispatch" ? dispatchPeople(ctx) : recordPeople(ctx),
    )).limit(1);
  if (!row) throw new NotFoundError("Technician");
  return row;
}

/** A membership by id, or not found. */
export async function memberWithin(tx: Database, ctx: ServiceContext, membershipId: string) {
  const [row] = await tx.select().from(schema.membership)
    .where(and(
      eq(schema.membership.id, membershipId),
      eq(schema.membership.organizationId, ctx.actor.organizationId),
      members(ctx),
    )).limit(1);
  if (!row) throw new NotFoundError("Person");
  return row;
}

/**
 * A crew by id, or not found.
 *
 * NO SOFT DELETE FILTER ON CREWS OR ROUTES, AND THAT IS A DECISION. Both
 * carry a `deleted_at` column because every table in this schema does, and
 * nothing in this product sets one: `active` is the retire mechanism, and it
 * is a column something writes (`crews.update`, the route's own flag).
 * `test/unwritten-columns.test.ts` makes the argument: a filter on a column
 * nothing sets makes a query look guarded when it is not. The day one of
 * these tables gets a real delete, the filter goes in beside it.
 */
export async function crewWithin(tx: Database, ctx: ServiceContext, crewId: string) {
  const [row] = await tx.select().from(schema.crew)
    .where(and(
      eq(schema.crew.id, crewId),
      eq(schema.crew.organizationId, ctx.actor.organizationId),
      crews(ctx),
    )).limit(1);
  if (!row) throw new NotFoundError("Crew");
  return row;
}

/** A route by id, or not found. */
export async function routeWithin(tx: Database, ctx: ServiceContext, routeId: string) {
  const [row] = await tx.select().from(schema.route)
    .where(and(
      eq(schema.route.id, routeId),
      eq(schema.route.organizationId, ctx.actor.organizationId),
      routes(ctx),
    )).limit(1);
  if (!row) throw new NotFoundError("Route");
  return row;
}
