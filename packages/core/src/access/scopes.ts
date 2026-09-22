import type { RoleId } from "./roles";

/**
 * RECORD SCOPING
 *
 * Permissions answer "can this person do the thing". Scopes answer "to which
 * records". Both are needed and conflating them is how platforms end up with a
 * technician who can technically only read jobs, and can read all ten thousand
 * of them.
 *
 *   own            records assigned to this person
 *   crew           records assigned to any crew this person is on
 *   business_unit  records in this person's business unit
 *   location       records at this person's location
 *   all            everything in the organization
 *
 * Scope is resolved into a SQL predicate that composes with the row level
 * security policy rather than replacing it. RLS guarantees the tenant boundary
 * unconditionally; scope narrows within it. A bug in scope is a privacy problem
 * inside one company. A bug in RLS is a cross tenant leak. They are deliberately
 * two separate mechanisms so the catastrophic one stays simple.
 */
export type Scope = "own" | "crew" | "business_unit" | "location" | "all";

const ORDER: Scope[] = ["own", "crew", "location", "business_unit", "all"];

export const widest = (a: Scope, b: Scope): Scope =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

/** Resources that are meaningfully scopable. Everything else is all-or-nothing. */
export type ScopedResource = "job" | "visit" | "customer" | "estimate" | "invoice" | "timesheet" | "servicereport";

export const DEFAULT_SCOPES: Record<RoleId, Partial<Record<ScopedResource, Scope>>> = {
  owner: {},
  admin: {},
  office_manager: {},
  dispatcher: {},
  csr: {},
  /**
   * The important row. A technician reads their own work, not the company's.
   * Customer stays scoped to customers they have actually been sent to, which
   * is what stops a departing technician walking out with the customer list.
   */
  technician: {
    job: "own", visit: "own", customer: "own",
    estimate: "own", invoice: "own", timesheet: "own", servicereport: "own",
  },
  crew_lead: {
    job: "crew", visit: "crew", customer: "crew",
    estimate: "crew", invoice: "crew", timesheet: "crew", servicereport: "crew",
  },
  accountant: {},
  readonly: {},
};

export function scopeFor(role: RoleId, resource: ScopedResource): Scope {
  return DEFAULT_SCOPES[role][resource] ?? "all";
}
