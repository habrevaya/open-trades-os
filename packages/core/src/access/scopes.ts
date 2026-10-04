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
export type ScopedResource =
  | "job" | "visit" | "customer" | "estimate" | "invoice" | "timesheet" | "servicereport"
  /**
   * A conversation is not a property of a customer record: it contains what
   * somebody said, which is a different and more sensitive thing than their
   * address. A technician holds `message:read` because they text from the
   * field, and without this that permission was the whole company's inbox.
   */
  | "conversation";

/**
 * Every scoped resource, as a value. Written as a record so that adding a
 * resource to the type above without adding it here is a build error rather
 * than a resource some reader quietly never reports.
 */
const SCOPED: Record<ScopedResource, true> = {
  job: true, visit: true, customer: true, estimate: true, invoice: true,
  timesheet: true, servicereport: true, conversation: true,
};
export const SCOPED_RESOURCES = Object.keys(SCOPED) as readonly ScopedResource[];

export const DEFAULT_SCOPES: Record<RoleId, Partial<Record<ScopedResource, Scope>>> = {
  owner: {},
  admin: {},
  office_manager: {},
  /**
   * Every scoped resource limited to their branch, not some of them. A
   * branch manager who sees Houston's jobs and every branch's conversations,
   * board or timesheets is not a branch manager, and that half built role is
   * what companies made by hand before this preset existed.
   */
  branch_manager: {
    job: "business_unit", visit: "business_unit", customer: "business_unit",
    estimate: "business_unit", invoice: "business_unit", timesheet: "business_unit",
    servicereport: "business_unit", conversation: "business_unit",
  },
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
    conversation: "own",
  },
  crew_lead: {
    job: "crew", visit: "crew", customer: "crew",
    estimate: "crew", invoice: "crew", timesheet: "crew", servicereport: "crew",
    conversation: "crew",
  },
  accountant: {},
  readonly: {},
};

export function scopeFor(role: RoleId, resource: ScopedResource): Scope {
  return DEFAULT_SCOPES[role][resource] ?? "all";
}

export const SCOPES: readonly Scope[] = ORDER;

export const isScope = (value: string): value is Scope =>
  (ORDER as readonly string[]).includes(value);

/**
 * The NARROWER of two scopes. The counterpart to `widest`.
 *
 * Roles combine by widening, because holding two roles means holding both
 * sets. An override narrows, because an administrator setting one is taking
 * access away from a particular person, and an override that could widen
 * would be a way to grant yourself scope your role never had.
 */
export const narrowest = (a: Scope, b: Scope): Scope =>
  ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;
