import { type Permission, SENSITIVE_PERMISSIONS } from "./permissions";
import { ROLE_PRESETS, type RoleId } from "./roles";
import { type Scope, type ScopedResource, scopeFor, widest } from "./scopes";

export * from "./permissions";
export * from "./roles";
export * from "./scopes";

/**
 * An actor is whoever is making the request: a signed in user, an API key, or
 * an AI agent. Deliberately one type, because an agent must never be able to do
 * something the credential behind it could not do in the UI. There is no
 * separate agent permission path to get wrong.
 */
export interface Actor {
  userId: string;
  organizationId: string;
  roles: RoleId[];
  /** Added on top of the role presets. */
  grants?: Permission[];
  /** Removed from the role presets. Revocation beats a grant. */
  revocations?: Permission[];
  technicianId?: string;
  crewIds?: string[];
  businessUnitId?: string;
  locationId?: string;
  /** Set when an AI agent is acting. Recorded on every audit entry. */
  agentId?: string;
}

/** Resolve an actor's full permission set. Revocation always wins. */
export function permissionsFor(actor: Actor): Set<Permission> {
  const set = new Set<Permission>();
  for (const role of actor.roles) {
    for (const p of ROLE_PRESETS[role]?.permissions ?? []) set.add(p);
  }
  for (const p of actor.grants ?? []) set.add(p);
  for (const p of actor.revocations ?? []) set.delete(p);
  return set;
}

export function can(actor: Actor, permission: Permission): boolean {
  return permissionsFor(actor).has(permission);
}

export function canAll(actor: Actor, permissions: Permission[]): boolean {
  const set = permissionsFor(actor);
  return permissions.every((p) => set.has(p));
}

/** Multiple roles widen the scope, matching how permissions combine. */
export function effectiveScope(actor: Actor, resource: ScopedResource): Scope {
  if (actor.roles.length === 0) return "own";
  return actor.roles
    .map((r) => scopeFor(r, resource))
    .reduce((a, b) => widest(a, b));
}

/**
 * FIELD REDACTION
 *
 * Maps a sensitive field to the permission that reveals it. This is the
 * mechanism behind the universal requirement in this industry: a technician
 * opens a job, sees the price, and does not see the cost or the margin.
 *
 * Redaction happens once, at the API boundary, over the serialized record.
 * Doing it in the UI means the data already crossed the wire, which is not a
 * permission, it is a suggestion.
 */
/**
 * The field names redaction can ever remove.
 *
 * Declared as a type so `redact` can return something honest. Returning
 * `Partial<T>` was the first version and it was over-broad in a way that
 * spreads: every caller then has to assert that `id` might be missing, when
 * `id` is never redacted and never could be. Widening a type to cover a case
 * that cannot happen pushes noise into every consumer.
 */
export type RedactableField =
  | "cost" | "unitCost" | "margin" | "grossMargin" | "laborCost" | "materialCost"
  | "creditLimit" | "balance" | "discountRate"
  | "payRate" | "loadedRate" | "commissionRate"
  | "productionRatePerDay" | "payoutExpected" | "purchaseCost";

/** What survives redaction: everything, with the redactable fields optional. */
export type Redacted<T> = Omit<T, RedactableField> &
  Partial<Pick<T, Extract<keyof T, RedactableField>>>;

export const FIELD_PERMISSIONS: Record<string, Permission> = {
  "priceBookItemVersion.cost": "pricebook.cost:read",
  "priceBookItemVersion.commissionRate": "commission:read",
  "invoiceLine.unitCost": "pricebook.cost:read",
  // An option's cost and margin are the whole reason a technician must not see
  // the estimate's cost side: they quote in the driveway and the customer can
  // read their screen.
  "estimateOption.cost": "job.cost:read",
  "estimateOption.margin": "job.cost:read",
  "estimateLine.unitCost": "pricebook.cost:read",
  "job.cost": "job.cost:read",
  "job.grossMargin": "job.cost:read",
  "job.laborCost": "job.cost:read",
  "job.materialCost": "job.cost:read",
  "customer.creditLimit": "customer.financials:read",
  "customer.balance": "customer.financials:read",
  "customer.discountRate": "customer.financials:read",
  "technician.payRate": "payroll:read",
  "technician.loadedRate": "payroll:read",
  "crew.productionRatePerDay": "job.cost:read",
  "leadOffer.payoutExpected": "customer.financials:read",
  "rentableAsset.purchaseCost": "job.cost:read",
};

/**
 * Strip fields the actor may not see. Returns a new object; never mutates.
 * `entity` is the schema table name, so the caller says redact(actor, "job", row).
 */
export function redact<T extends Record<string, unknown>>(
  actor: Actor,
  entity: string,
  record: T,
): Redacted<T> {
  const held = permissionsFor(actor);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const required = FIELD_PERMISSIONS[`${entity}.${key}`];
    if (required && !held.has(required)) continue;
    out[key] = value;
  }
  return out as Redacted<T>;
}

export function redactMany<T extends Record<string, unknown>>(
  actor: Actor,
  entity: string,
  records: T[],
): Redacted<T>[] {
  return records.map((r) => redact(actor, entity, r));
}

/** Everything sensitive this actor can currently see. For the role editor UI. */
export function sensitiveAccess(actor: Actor): Permission[] {
  const held = permissionsFor(actor);
  return SENSITIVE_PERMISSIONS.filter((p) => held.has(p));
}

export class PermissionError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new PermissionError(permission);
}
