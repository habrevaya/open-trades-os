import { type Permission, SENSITIVE_PERMISSIONS } from "./permissions";
import { ROLE_PRESETS, type RoleId } from "./roles";
import { type Scope, type ScopedResource, scopeFor, widest, narrowest, DEFAULT_SCOPES } from "./scopes";

export * from "./permissions";
export * from "./roles";
export * from "./scopes";

/**
 * An actor is whoever is making the request: a signed in user, an API key, or
 * an AI agent. Deliberately one type, because an agent must never be able to do
 * something the credential behind it could not do in the UI. There is no
 * separate agent permission path to get wrong.
 */
/**
 * THE ACTOR THAT IS NOT A PERSON
 *
 * The worker, the scheduler, the outbox, an inbound webhook and a workflow
 * run all act as somebody, and none of them is a user. They were each
 * writing this uuid out by hand, which is fine until something tries to
 * store it: `domain_event.actor_user_id` has a foreign key, and the nil uuid
 * is not a row in the user table, so the first event a scheduled workflow
 * emitted failed on a constraint five layers below where it could be read.
 *
 * Named here so the places that record an actor can ask whether there is a
 * person behind it, rather than comparing against a literal.
 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Whether this actor is the system rather than somebody. */
export const isSystem = (actor: { userId: string }) => actor.userId === SYSTEM_USER_ID;

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
  /**
   * The scope this actor's authority STATES, for an actor whose authority
   * does not come from a role: a connected application, a membership on a
   * custom role, anything else granted a permission set directly.
   *
   * Distinct from `scopeOverrides` because the two do opposite things, and
   * conflating them was a bug. An override narrows and only narrows, so
   * putting an app's grant there clamped it against the roleless default of
   * `own`, and an app is not a technician: `own` matches nothing, so an app
   * granted `customer:read` with scope `all` read zero customers. Fail
   * closed, and useless.
   *
   * It cannot be used to exceed whoever granted it: `canDefineRole` refuses a
   * scope wider than the granter's own, and every path that writes one goes
   * through it.
   */
  scopes?: Partial<Record<ScopedResource, Scope>>;
  /**
   * Per resource narrowing, set on the membership by an administrator.
   *
   * It can only ever take access away. The column existed for a while,
   * carrying a comment that said it "narrows WHICH records", and nothing
   * wrote it and nothing read it: an administrator who set one believed they
   * had restricted somebody and had not. Same failure as a scope resolved and
   * never applied, one layer up.
   */
  scopeOverrides?: Partial<Record<ScopedResource, Scope>>;
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

/**
 * Multiple roles widen the scope, matching how permissions combine. An
 * explicit override then narrows it, and can only narrow.
 *
 * The order matters and it is the whole security property: roles are combined
 * first, then the override is applied as a ceiling. Applying the override
 * inside the combination would let a second role widen back past it, and an
 * administrator who restricted somebody to their own jobs would find that
 * adding a dispatcher role quietly undid it.
 */
export function effectiveScope(actor: Actor, resource: ScopedResource): Scope {
  /**
   * Where the base comes from, in order.
   *
   * Roles decide when the actor has any. An actor with none has its scope
   * STATED (`scopes`), which is how a connected app and a custom role work,
   * and `own` is the fallback when nothing says otherwise, because the
   * narrowest default is the only safe one.
   *
   * `scopes` is deliberately consulted only when `roles` is empty rather than
   * merged with them. Merging by widening would make it a way to add reach to
   * a role, which is the opposite of everything else here; merging by
   * narrowing would duplicate `scopeOverrides`. Every path that sets both
   * today sets `roles: []`, and the precedence is asserted in the tests so it
   * is stated rather than discovered.
   */
  const base = actor.roles.length === 0
    ? actor.scopes?.[resource] ?? "own"
    : actor.roles.map((r) => scopeFor(r, resource)).reduce((a, b) => widest(a, b));

  const override = actor.scopeOverrides?.[resource];
  return override ? narrowest(base, override) : base;
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
  | "baseRate" | "fringeRate"
  | "appliedBaseRate" | "appliedFringeRate" | "appliedLoadedRate"
  | "payRate" | "loadedRate" | "commissionRate"
  | "productionRatePerDay" | "payoutExpected" | "purchaseCost";

/** What survives redaction: everything, with the redactable fields optional. */
export type Redacted<T> = Omit<T, RedactableField> &
  Partial<Pick<T, Extract<keyof T, RedactableField>>>;

/**
 * Every key here must name a field that exists, or the rule does nothing.
 *
 * `redact` walks the record's own keys, so a rule for a column the table does
 * not have never fires. Eight of these named fields that had never been
 * added: `job.cost`, `job.grossMargin`, `job.laborCost`, `job.materialCost`,
 * `customer.balance`, `customer.creditLimit`, `technician.payRate` and
 * `technician.loadedRate`. They read in review as protection that was in
 * place, and `job.cost:read` and `payroll:read` were guarding nothing at all.
 *
 * Nothing leaked, because no service returned those rows, which is luck
 * rather than design: the columns that DO hold cost had no rules. `jobLine`
 * carries `unitCost` and exists for exactly that purpose, `wageScale` carries
 * the wage, and `timeclockEntry` carries the rate as applied. All three are
 * written today and would have been readable the first time anybody wrote a
 * screen for them.
 *
 * The roll-ups (a job's total cost, a customer's balance) are not here
 * because nothing computes them yet. They go back with the service that does,
 * and test/redaction.test.ts fails if a rule ever gets ahead of a field
 * again.
 */
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
  /**
   * What the work actually cost, per line. `job_line` exists for this, and it
   * is the field `job.cost:read` was always meant to be protecting.
   */
  "jobLine.unitCost": "job.cost:read",
  "customer.discountRate": "customer.financials:read",
  /**
   * What they owe. Computed from the open invoices on every read rather
   * than stored, so it is redacted here like any other field on the row
   * instead of being attached after the redaction pass, which would have
   * sent it to everybody.
   */
  "customer.balance": "customer.financials:read",
  /**
   * Wages, at both ends. The scale is what a class of worker is paid; the
   * timeclock entry is what was actually applied to a shift, which is the
   * same fact about a named person on a named day and is if anything more
   * sensitive.
   */
  "wageScale.baseRate": "payroll:read",
  "wageScale.fringeRate": "payroll:read",
  "timeclockEntry.appliedBaseRate": "payroll:read",
  "timeclockEntry.appliedFringeRate": "payroll:read",
  "timeclockEntry.appliedLoadedRate": "payroll:read",
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

/**
 * CUSTOM ROLES, AND THE ONE RULE THAT MAKES THEM SAFE
 *
 * A company defines its own roles: a branch manager scoped to one business
 * unit, a warehouse lead who may read inventory and nothing else. The moment
 * that is possible, `role:write` becomes the most dangerous permission in the
 * system, because a role is a container for permissions and anyone who can
 * write one can write `owner` into it.
 *
 * So: YOU CANNOT GRANT WHAT YOU DO NOT HOLD. An office manager creating a
 * role can only put permissions in it that they hold themselves, and can only
 * set scopes at least as narrow as their own. Without that, `role:write` is
 * silently equivalent to every permission in the catalogue, and it is handed
 * out as an administrative convenience.
 *
 * The same rule covers editing an existing role and assigning one, because
 * all three are ways of arriving at the same place.
 */

export interface RoleDefinition {
  permissions: readonly Permission[];
  scopes?: Partial<Record<ScopedResource, Scope>> | undefined;
}

export type RoleChangeRefusal =
  | { ok: false; reason: "missing_permission"; permissions: Permission[] }
  | { ok: false; reason: "widens_scope"; resources: ScopedResource[] };

export type RoleChangeDecision = { ok: true } | RoleChangeRefusal;

/**
 * Whether `actor` may create, edit or assign a role with this definition.
 *
 * Deliberately NOT a check on `role:write`. That answers whether they may
 * touch roles at all and is the caller's job; this answers whether this
 * particular definition is within what they already hold, which is the part
 * that stops the escalation.
 */
export function canDefineRole(actor: Actor, definition: RoleDefinition): RoleChangeDecision {
  const held = permissionsFor(actor);

  const missing = definition.permissions.filter((p) => !held.has(p));
  if (missing.length > 0) {
    return { ok: false, reason: "missing_permission", permissions: missing };
  }

  /**
   * Scope is checked in the same direction. An actor scoped to their own jobs
   * must not be able to mint a role with `all`, hand it to themselves, and
   * read the company. Being able to define something NARROWER than your own
   * scope is fine and is the normal case.
   */
  const widened: ScopedResource[] = [];
  for (const [resource, scope] of Object.entries(definition.scopes ?? {}) as [ScopedResource, Scope][]) {
    const own = effectiveScope(actor, resource);
    if (narrowest(own, scope) !== scope) widened.push(resource);
  }
  if (widened.length > 0) {
    return { ok: false, reason: "widens_scope", resources: widened };
  }

  return { ok: true };
}

/**
 * The permissions and scopes a membership resolves to.
 *
 * A custom role REPLACES the preset rather than adding to it, because a
 * company that has defined its own role means that role and not a preset with
 * unexplained extras. The per-membership grants and revocations still apply
 * on top, so an individual exception does not require a whole new role.
 */
export function resolveMembership(input: {
  role: RoleId;
  customRole?: RoleDefinition | undefined;
  grants?: readonly Permission[] | undefined;
  revocations?: readonly Permission[] | undefined;
}): { permissions: Permission[]; scopes: Partial<Record<ScopedResource, Scope>> } {
  const set = new Set<Permission>(
    input.customRole
      ? input.customRole.permissions
      : ROLE_PRESETS[input.role]?.permissions ?? [],
  );
  for (const p of input.grants ?? []) set.add(p);
  // Revocation always beats a grant, so taking access away is never ambiguous.
  for (const p of input.revocations ?? []) set.delete(p);

  return {
    permissions: [...set],
    scopes: input.customRole?.scopes ?? DEFAULT_SCOPES[input.role] ?? {},
  };
}
