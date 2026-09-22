import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and, gt, isNull } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
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
  const rows = await db
    .select({
      userId: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
      organizationId: schema.organization.id,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      setupCompletedAt: schema.organization.setupCompletedAt,
      role: schema.membership.role,
      grants: schema.membership.grants,
      revocations: schema.membership.revocations,
      businessUnitId: schema.membership.businessUnitId,
      locationId: schema.membership.locationId,
      membershipActive: schema.membership.active,
    })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.session.activeOrganizationId))
    .innerJoin(
      schema.membership,
      and(
        eq(schema.membership.userId, schema.session.userId),
        eq(schema.membership.organizationId, schema.session.activeOrganizationId),
      ),
    )
    .where(
      and(
        eq(schema.session.tokenHash, hashToken(token)),
        gt(schema.session.expiresAt, new Date()),
        isNull(schema.session.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.membershipActive) return null;

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    setupCompleted: row.setupCompletedAt != null,
    actor: {
      userId: row.userId,
      organizationId: row.organizationId,
      roles: [row.role as RoleId],
      grants: (row.grants ?? []) as Actor["grants"],
      revocations: (row.revocations ?? []) as Actor["revocations"],
      ...(row.businessUnitId ? { businessUnitId: row.businessUnitId } : {}),
      ...(row.locationId ? { locationId: row.locationId } : {}),
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
