import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import {
  resolveMembership, isScope,
  type Actor, type Permission, type RoleId, type Scope, type ScopedResource,
} from "@opentradesos/core";

/**
 * SESSION TO ACTOR
 *
 * This lived in the web app, which meant the only code that built a real
 * actor was the code no test could reach. Every scope test constructed its
 * own actor by hand, filled in `technicianId`, and passed; the signed in path
 * produced an actor without one and a technician saw an empty job list.
 *
 * It lives here now so that the thing under test and the thing in production
 * are the same function. Reading the cookie stays with the host framework,
 * because that genuinely is its job, and everything after the token hash is
 * here.
 */

export interface ResolvedSession {
  actor: Actor;
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationTimezone: string;
  setupCompleted: boolean;
}

interface SessionRow extends Record<string, unknown> {
  user_id: string;
  email: string;
  name: string | null;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  organization_timezone: string | null;
  setup_completed_at: Date | null;
  role: string;
  grants: string[] | null;
  revocations: string[] | null;
  scope_overrides: Record<string, string> | null;
  business_unit_id: string | null;
  location_id: string | null;
  technician_id: string | null;
  crew_ids: string[] | null;
  custom_role_permissions: string[] | null;
  custom_role_scopes: Record<string, string> | null;
}

/**
 * Only the values the scope ladder knows survive.
 *
 * A jsonb column can hold anything, including a typo and including whatever a
 * future migration leaves behind, and an unrecognised scope reaching
 * `effectiveScope` would be compared against the ladder and silently treated
 * as the widest thing that is not narrower. Dropping it is the fail closed
 * choice: the role's own scope applies, which is never wider than the role.
 */
function cleanScopes(
  value: Record<string, string> | null | undefined,
): Partial<Record<ScopedResource, Scope>> {
  const out: Partial<Record<ScopedResource, Scope>> = {};
  for (const [resource, scope] of Object.entries(value ?? {})) {
    if (isScope(scope)) out[resource as ScopedResource] = scope;
  }
  return out;
}

/**
 * Resolve a session token hash to the actor it represents.
 *
 * Goes through `app.resolve_session` rather than a select, because the lookup
 * happens before the tenant is known and so no row level security policy
 * keyed on the current organization can match on that first read. The
 * alternative is connecting as a role that bypasses RLS from a request path,
 * which is never acceptable.
 */
export async function resolveSession(
  db: Database,
  tokenHash: string,
): Promise<ResolvedSession | null> {
  const rows = await db.execute<SessionRow>(
    sql`select * from app.resolve_session(${tokenHash})`,
  );
  const row = rows[0];
  if (!row) return null;

  const role = row.role as RoleId;

  /**
   * A custom role REPLACES the preset. The membership's own grants and
   * revocations still apply on top, so an individual exception does not need
   * a whole new role, and a revocation still beats a grant.
   */
  const resolved = resolveMembership({
    role,
    ...(row.custom_role_permissions
      ? {
          customRole: {
            permissions: row.custom_role_permissions as Permission[],
            scopes: cleanScopes(row.custom_role_scopes),
          },
        }
      : {}),
    grants: (row.grants ?? []) as Permission[],
    revocations: (row.revocations ?? []) as Permission[],
  });

  /**
   * With a custom role the preset contributes nothing, so the resolved set is
   * handed over as grants against an empty role list. With a preset the role
   * is named and the membership's own grants ride on top, which keeps the
   * preset meaningful in an audit rather than flattening it into a list of
   * sixty permissions nobody can read.
   */
  const actor: Actor = row.custom_role_permissions
    ? {
        userId: row.user_id,
        organizationId: row.organization_id,
        roles: [],
        grants: resolved.permissions,
      }
    : {
        userId: row.user_id,
        organizationId: row.organization_id,
        roles: [role],
        grants: (row.grants ?? []) as Permission[],
        revocations: (row.revocations ?? []) as Permission[],
      };

  /**
   * The custom role's scopes and the membership's overrides are different
   * questions and they go in different places.
   *
   * A custom role STATES the scope, because it replaces the preset and there
   * is no role left to narrow. Folding it into the overrides clamped it
   * against the roleless default of `own`, so a branch manager role granting
   * `job: "all"` saw no jobs: the widening half of a custom role silently did
   * nothing, and only the narrowing half worked.
   *
   * An override is a ceiling over whatever the base turned out to be, set by
   * an administrator about one particular person.
   */
  if (row.custom_role_permissions && Object.keys(resolved.scopes).length > 0) {
    actor.scopes = resolved.scopes;
  }
  const overrides = cleanScopes(row.scope_overrides);
  if (Object.keys(overrides).length > 0) actor.scopeOverrides = overrides;

  /**
   * The two fields every `own` and `crew` filter compares against. Absent,
   * those scopes match nothing at all, which is the right way round to fail
   * and still means the person cannot do their job.
   */
  if (row.technician_id) actor.technicianId = row.technician_id;
  if (row.crew_ids && row.crew_ids.length > 0) actor.crewIds = row.crew_ids;
  if (row.business_unit_id) actor.businessUnitId = row.business_unit_id;
  if (row.location_id) actor.locationId = row.location_id;

  return {
    actor,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    // A company created before the column existed has no timezone. Falling
    // back to the server's is wrong in the same way the browser's is, but it
    // is at least stable across a hydration, and setup asks for a real one.
    organizationTimezone: row.organization_timezone ?? "America/Chicago",
    setupCompleted: row.setup_completed_at != null,
  };
}
