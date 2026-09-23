import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  canDefineRole, isScope, ALL_PERMISSIONS,
  type Actor, type Permission, type RoleDefinition, type Scope, type ScopedResource,
} from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * CONNECTED APPLICATIONS
 *
 * A third party acting against one company's instance, with the company in
 * control of exactly what it may touch.
 *
 * The actor model does not branch on what the caller is, which is why this is
 * a small service rather than a parallel authorization system: an app gets an
 * `Actor` and every existing permission check and scope filter applies to it
 * unchanged. Nothing downstream knows or cares that a request came from an
 * app rather than a person.
 *
 * Two rules do the work.
 *
 * YOU CANNOT GRANT WHAT YOU DO NOT HOLD. Approving an app goes through
 * `canDefineRole`, the same function that governs custom roles, because two
 * implementations of "may you grant this" disagree eventually and the
 * disagreement is silent. An office manager installing an app cannot give it
 * the ledger.
 *
 * REVOCATION IS IMMEDIATE. Every revocation path is a condition in the SQL
 * that resolves a token, not a check in this file. An operator who revokes at
 * 4pm means 4pm.
 */

export interface AppInput {
  name: string;
  publisher?: string | undefined;
  description?: string | undefined;
  homepageUrl?: string | undefined;
  permissions: string[];
  scopes?: Record<string, string> | undefined;
}

export class AppEscalationError extends Error {
  constructor(public readonly detail:
    | { reason: "missing_permission"; permissions: Permission[] }
    | { reason: "widens_scope"; resources: ScopedResource[] }) {
    super(detail.reason === "missing_permission"
      ? `You cannot give an app: ${detail.permissions.join(", ")}`
      : `Wider than your own scope on: ${detail.resources.join(", ")}`);
    this.name = "AppEscalationError";
  }
}

/**
 * Validate the shape before the authority question.
 *
 * An unknown permission key is refused rather than dropped. Silently ignoring
 * it produces an app that looks correctly limited in the consent screen and
 * is limited by accident, and the next release that adds the permission turns
 * it on without anybody approving it.
 */
function parse(input: AppInput): RoleDefinition {
  const known = new Set<string>(ALL_PERMISSIONS);
  const unknown = input.permissions.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    throw new ConflictError(`Unknown permissions: ${unknown.join(", ")}`);
  }

  const scopes: Partial<Record<ScopedResource, Scope>> = {};
  for (const [resource, scope] of Object.entries(input.scopes ?? {})) {
    if (!isScope(scope)) throw new ConflictError(`Unknown scope: ${scope}`);
    scopes[resource as ScopedResource] = scope;
  }
  return { permissions: input.permissions as Permission[], scopes };
}

function assertWithinAuthority(ctx: ServiceContext, definition: RoleDefinition): void {
  const decision = canDefineRole(ctx.actor, definition);
  if (!decision.ok) {
    const { ok: _ok, ...detail } = decision;
    throw new AppEscalationError(detail);
  }
}

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) =>
    tx.select().from(schema.connectedApp).orderBy(schema.connectedApp.name));
}

/**
 * Install an app, approved in the same call.
 *
 * `integration:write` is the permission to touch integrations at all, and the
 * authority check is what decides whether THIS grant is inside what the
 * installer already holds. Both, because they answer different questions.
 */
export async function install(ctx: ServiceContext, input: AppInput) {
  const definition = parse(input);
  return guardedWrite(ctx, "integration:write", async (tx) => {
    assertWithinAuthority(ctx, definition);

    const [app] = await tx.insert(schema.connectedApp).values({
      organizationId: ctx.actor.organizationId,
      name: input.name,
      publisher: input.publisher ?? null,
      description: input.description ?? null,
      homepageUrl: input.homepageUrl ?? null,
      status: "active",
      permissions: [...definition.permissions],
      scopes: (definition.scopes ?? {}) as Record<string, string>,
      requestedByUserId: ctx.actor.userId,
      approvedByUserId: ctx.actor.userId,
      approvedAt: new Date(),
    }).returning();

    await audit(tx, ctx, "app.installed", "connectedApp", app!.id, null, app);
    return app!;
  });
}

/**
 * Change what an installed app may do.
 *
 * Checked against the RESULT, not the change. Editing an app you may edit
 * into one you may not have installed is the same escalation, and checking
 * only the delta would miss it.
 */
export async function update(ctx: ServiceContext, input: { id: string } & Partial<AppInput>) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const [before] = await tx.select().from(schema.connectedApp)
      .where(eq(schema.connectedApp.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("App");

    const definition = parse({
      name: input.name ?? before.name,
      permissions: input.permissions ?? before.permissions,
      scopes: input.scopes ?? before.scopes,
    });
    assertWithinAuthority(ctx, definition);

    const [after] = await tx.update(schema.connectedApp).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      permissions: [...definition.permissions],
      scopes: (definition.scopes ?? {}) as Record<string, string>,
      updatedAt: new Date(),
    }).where(eq(schema.connectedApp.id, input.id)).returning();

    await audit(tx, ctx, "app.updated", "connectedApp", input.id, before, after);
    return after!;
  });
}

/**
 * Turn an app off, permanently.
 *
 * Not a delete: what the app did stays attributable, and an operator asking
 * "what was this thing reading" after the fact needs the row. A reinstall is
 * a new row with a new approval, because trusting it again is a new decision.
 *
 * The tokens are revoked in the same transaction. The app's status alone
 * would be enough, since the resolver checks both, and revoking the tokens
 * too means a credential that leaked is dead even if somebody later flips the
 * app back to active by hand.
 */
export async function revoke(ctx: ServiceContext, input: { id: string; reason?: string }) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const [before] = await tx.select().from(schema.connectedApp)
      .where(eq(schema.connectedApp.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("App");

    const now = new Date();
    await tx.update(schema.appToken).set({ revokedAt: now })
      .where(and(eq(schema.appToken.appId, input.id), isNull(schema.appToken.revokedAt)));

    const [after] = await tx.update(schema.connectedApp).set({
      status: "revoked",
      revokedAt: now,
      revokedByUserId: ctx.actor.userId,
      revokedReason: input.reason ?? null,
      updatedAt: now,
    }).where(eq(schema.connectedApp.id, input.id)).returning();

    await audit(tx, ctx, "app.revoked", "connectedApp", input.id, before, after);
    return after!;
  });
}

/** How long a token lasts unless the caller says otherwise. */
const DEFAULT_TTL_DAYS = 90;

/**
 * Issue a credential.
 *
 * Returned once and never again: only the hash is stored, so a token a
 * support engineer could read out of a table does not exist. An operator who
 * loses it issues another, which is the same action they would take if it
 * leaked.
 */
export async function issueToken(
  ctx: ServiceContext,
  input: { appId: string; label?: string; expiresInDays?: number },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const [app] = await tx.select().from(schema.connectedApp)
      .where(eq(schema.connectedApp.id, input.appId)).limit(1);
    if (!app) throw new NotFoundError("App");
    if (app.status !== "active") throw new ConflictError("That app is not active");

    /**
     * Issuing is granting, so it goes through the same check as installing.
     * Otherwise somebody who may create tokens but not approve apps could
     * mint a credential for an app somebody else approved with powers they
     * do not hold.
     */
    assertWithinAuthority(ctx, {
      permissions: app.permissions as Permission[],
      scopes: app.scopes as Partial<Record<ScopedResource, Scope>>,
    });

    // 256 bits. The whole security of the integration is this string.
    const token = `ots_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(
      Date.now() + (input.expiresInDays ?? DEFAULT_TTL_DAYS) * 86_400_000,
    );

    const [row] = await tx.insert(schema.appToken).values({
      organizationId: ctx.actor.organizationId,
      appId: input.appId,
      tokenHash: hashToken(token),
      label: input.label ?? null,
      hint: token.slice(-4),
      expiresAt,
      createdByUserId: ctx.actor.userId,
    }).returning({ id: schema.appToken.id });

    await audit(tx, ctx, "app.token_issued", "appToken", row!.id, null, {
      appId: input.appId, label: input.label ?? null, expiresAt,
    });

    return { token, id: row!.id, expiresAt };
  });
}

export async function revokeToken(ctx: ServiceContext, input: { tokenId: string }) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const revoked = await tx.update(schema.appToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.appToken.id, input.tokenId), isNull(schema.appToken.revokedAt)))
      .returning({ id: schema.appToken.id });
    if (revoked.length === 0) throw new NotFoundError("Token");
    await audit(tx, ctx, "app.token_revoked", "appToken", input.tokenId, null, null);
  });
}

export interface ResolvedApp {
  actor: Actor;
  appId: string;
  appName: string;
  organizationId: string;
  tokenId: string;
}

/**
 * The actor behind an app token.
 *
 * Resolved before the tenant is known, so it goes through a SECURITY DEFINER
 * function exactly as a session does. Every revocation path is a condition in
 * that function rather than a check here, because a check in this file is one
 * a future caller can forget to make.
 */
export async function resolveToken(db: Database, token: string): Promise<ResolvedApp | null> {
  const rows = await db.execute<{
    app_id: string;
    organization_id: string;
    app_name: string;
    permissions: string[];
    scopes: Record<string, string>;
    token_id: string;
  }>(sql`select * from app.resolve_app_token(${hashToken(token)})`);

  const row = rows[0];
  if (!row) return null;

  const scopes: Partial<Record<ScopedResource, Scope>> = {};
  for (const [resource, scope] of Object.entries(row.scopes ?? {})) {
    // An unrecognised scope is dropped rather than compared against the
    // ladder, where it would be treated as the widest thing that is not
    // narrower. Fail closed.
    if (isScope(scope)) scopes[resource as ScopedResource] = scope;
  }

  /**
   * No roles, so `permissionsFor` contributes nothing and the grants ARE the
   * permission set. An app cannot inherit anything from the person who
   * installed it, and `technicianId` and the rest are absent, so every scope
   * that depends on being a person resolves to its narrowest form.
   */
  const actor: Actor = {
    userId: "00000000-0000-0000-0000-000000000000",
    organizationId: row.organization_id,
    roles: [],
    grants: row.permissions as Permission[],
    agentId: `app:${row.app_id}`,
  };
  /**
   * `scopes`, not `scopeOverrides`. An app's grant is the scope it HAS, not a
   * narrowing of one it got from somewhere else: an override is clamped
   * against the roleless default of `own`, and an app is not a technician, so
   * putting the grant there made every app read nothing at all.
   */
  if (Object.keys(scopes).length > 0) actor.scopes = scopes;

  return {
    actor,
    appId: row.app_id,
    appName: row.app_name,
    organizationId: row.organization_id,
    tokenId: row.token_id,
  };
}

/** Best effort, and never on the critical path of the request. */
export async function touch(db: Database, tokenId: string): Promise<void> {
  await db.execute(sql`select app.touch_app_token(${tokenId}::uuid)`)
    .catch(() => undefined);
}
