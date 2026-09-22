import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import type { Actor, RoleId } from "@opentradesos/core";
import { SESSION_COOKIE, hashToken } from "./session";

/**
 * Resolving the current actor.
 *
 * Three things matter here and all three are easy to get subtly wrong:
 *
 * 1. The tenant comes from the SESSION, never from anything the client sends.
 *    A header or a query parameter naming an organization is an invitation to
 *    walk the tenant boundary.
 * 2. The session is looked up, not merely verified. That is what makes
 *    revocation immediate, which matters when the thing being revoked is a
 *    fired technician's access to the customer list.
 * 3. The result is an Actor, the same type an AI agent gets. There is no
 *    separate path with different rules.
 */
export interface CurrentUser {
  actor: Actor;
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  setupCompleted: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = createClient();

  /**
   * Resolution goes through app.resolve_session rather than a select.
   *
   * Session lookup happens before we know who the user is, which is the point
   * of the lookup, so a row level security policy keyed on the current user id
   * can never match on that first read. The alternative would be connecting as
   * a role that bypasses RLS, and the service role is never reachable from a
   * request path. So a SECURITY DEFINER function takes the token hash, which
   * the caller must already hold, and returns one row or none.
   */
  const rows = await db.execute<{
    user_id: string;
    email: string;
    name: string | null;
    organization_id: string;
    organization_name: string;
    organization_slug: string;
    setup_completed_at: Date | null;
    role: string;
    grants: string[] | null;
    revocations: string[] | null;
    business_unit_id: string | null;
    location_id: string | null;
  }>(sql`select * from app.resolve_session(${hashToken(token)})`);

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    setupCompleted: row.setup_completed_at != null,
    actor: {
      userId: row.user_id,
      organizationId: row.organization_id,
      roles: [row.role as RoleId],
      grants: (row.grants ?? []) as Actor["grants"],
      revocations: (row.revocations ?? []) as Actor["revocations"],
      ...(row.business_unit_id ? { businessUnitId: row.business_unit_id } : {}),
      ...(row.location_id ? { locationId: row.location_id } : {}),
    },
  };
}

/** For a page that must not render to a signed out visitor. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const path = (await headers()).get("x-pathname") ?? "/";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return user;
}

/** For a page inside the app shell, which also requires setup to be finished. */
export async function requireSetupUser(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.setupCompleted) redirect("/setup");
  return user;
}
