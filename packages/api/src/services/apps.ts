import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  canDefineRole, isScope, ALL_PERMISSIONS, SCOPED_RESOURCES, effectiveScope, permissionsFor,
  type Actor, type Permission, type RoleDefinition, type Scope, type ScopedResource,
  SYSTEM_USER_ID,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

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

export interface TokenView {
  id: string;
  label: string | null;
  /** The last four characters. Enough to tell two apart, not enough to use. */
  hint: string | null;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Computed against the clock, never stored. See `AppView.live`. */
  expired: boolean;
}

export interface AppView {
  id: string;
  name: string;
  publisher: string | null;
  description: string | null;
  homepageUrl: string | null;
  status: string;
  permissions: string[];
  scopes: Record<string, string>;
  approvedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  tokens: TokenView[];
  /**
   * Whether anything can actually call us as this app right now.
   *
   * DERIVED, and the alternative is the failure this answer exists to prevent.
   * An app is reachable when its status is active AND it holds a token that is
   * neither revoked nor past its expiry, and expiry moves on its own: a screen
   * reading `status = 'active'` would tell an operator an integration is
   * connected on the morning its last token lapsed, which is the morning
   * somebody's nightly sync stopped and nobody was told.
   */
  live: boolean;
}

const asDay = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Every app, with its credentials.
 *
 * One query per table rather than a join, because an app with four tokens would
 * otherwise arrive as four rows the caller has to fold, and the fold is where a
 * screen loses a token.
 */
export async function list(ctx: ServiceContext): Promise<AppView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const apps = await tx.select().from(schema.connectedApp)
      .orderBy(schema.connectedApp.name);
    if (apps.length === 0) return [];

    const tokens = await tx.select().from(schema.appToken)
      .where(inArray(schema.appToken.appId, apps.map((app) => app.id)))
      .orderBy(desc(schema.appToken.createdAt));

    const now = Date.now();
    const byApp = new Map<string, TokenView[]>();
    for (const token of tokens) {
      const view: TokenView = {
        id: token.id,
        label: token.label,
        hint: token.hint,
        expiresAt: token.expiresAt.toISOString(),
        lastUsedAt: asDay(token.lastUsedAt),
        revokedAt: asDay(token.revokedAt),
        expired: token.expiresAt.getTime() <= now,
      };
      const held = byApp.get(token.appId);
      if (held) held.push(view); else byApp.set(token.appId, [view]);
    }

    return apps.map((app) => {
      const held = byApp.get(app.id) ?? [];
      return {
        id: app.id,
        name: app.name,
        publisher: app.publisher,
        description: app.description,
        homepageUrl: app.homepageUrl,
        status: app.status,
        permissions: [...app.permissions],
        scopes: { ...(app.scopes as Record<string, string>) },
        approvedAt: asDay(app.approvedAt),
        revokedAt: asDay(app.revokedAt),
        revokedReason: app.revokedReason,
        tokens: held,
        live: app.status === "active"
          && held.some((token) => token.revokedAt === null && !token.expired),
      };
    });
  });
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
    /**
     * A RETRY INSTALLS NOTHING, which is what the route's `idempotent` flag
     * claims and what a client on a bad connection does.
     *
     * The same shape `billing.create` uses, deliberately rather than a second
     * invention: a succeeded `integration_event` carrying the key names the row
     * the first attempt produced, and the replay hands that back. Two answers in
     * this codebase to "have I already done this" is two chances to get it
     * wrong, and a duplicate here is a second app with a second grant that an
     * operator approved once.
     */
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "connectedApp"),
        )).limit(1);
      if (seen?.entityId) {
        const [already] = await tx.select().from(schema.connectedApp)
          .where(eq(schema.connectedApp.id, seen.entityId)).limit(1);
        if (already) return already;
      }
    }

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

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "app.install",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "connectedApp", entityId: app!.id,
      });
    }

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

    /**
     * ALREADY OFF IS A SUCCESS, NOT A CONFLICT.
     *
     * A retry after a lost response is the common case, and refusing it reports
     * a failure for something that worked, which is how an operator ends up
     * believing an app they revoked is still live. The second call changes
     * nothing, writes no audit line and does not move `revoked_at`, so the record
     * keeps saying when it was actually turned off and by whom.
     */
    if (before.status === "revoked") return before;

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

    if (revoked.length === 0) {
      /**
       * NOTHING UPDATED MEANS ONE OF TWO THINGS and they are not the same answer.
       *
       * The row does not exist, which is a 404. Or it exists and was already
       * revoked, which is a retry after a lost response and has to succeed: a
       * second call reporting failure is how somebody concludes a leaked
       * credential is still live. The first version of this threw on both,
       * because the `where` clause could not tell them apart.
       */
      const [exists] = await tx.select({ id: schema.appToken.id })
        .from(schema.appToken).where(eq(schema.appToken.id, input.tokenId)).limit(1);
      if (!exists) throw new NotFoundError("Token");
      return;
    }

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
    userId: SYSTEM_USER_ID,
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

/* ------------------------------------------------------------ the app itself */

/**
 * What the calling app token may do, asked by the app.
 *
 * Guarded by nothing but being an app, because it answers only about the
 * caller and everything in it is already in the caller's hands: an app
 * learning its own grant from a read is strictly safer than learning it by
 * trying a write and reading which error came back, which is what the
 * migration loader had to do to find out whether it held `data:import`.
 *
 * The permissions are the actor's own resolved set rather than the stored
 * row, so this says what the request it is part of was actually allowed,
 * and the scopes are what `effectiveScope` resolves for every scoped
 * resource, including the ones the install never named.
 */
export async function me(ctx: ServiceContext) {
  const agent = ctx.actor.agentId ?? ctx.agentId ?? "";
  if (!agent.startsWith("app:") || ctx.actor.roles.length > 0) {
    throw new NotFoundError("App behind this credential");
  }
  const appId = agent.slice("app:".length);

  const [app] = await inTenant(ctx, (tx) => tx.select({
    id: schema.connectedApp.id,
    name: schema.connectedApp.name,
    publisher: schema.connectedApp.publisher,
    organizationId: schema.connectedApp.organizationId,
  }).from(schema.connectedApp)
    .where(eq(schema.connectedApp.id, appId))
    .limit(1));
  if (!app) throw new NotFoundError("App behind this credential");

  const scopes: Partial<Record<ScopedResource, Scope>> = {};
  for (const resource of SCOPED_RESOURCES) scopes[resource] = effectiveScope(ctx.actor, resource);

  return {
    appId: app.id,
    name: app.name,
    publisher: app.publisher,
    organizationId: app.organizationId,
    permissions: [...permissionsFor(ctx.actor)].sort(),
    scopes: scopes as Record<string, Scope>,
  };
}

export const handlers = {
  getAppSelf: (ctx: ServiceContext) => me(ctx),

  listApps: async (ctx: ServiceContext) => ({ apps: await list(ctx) }),

  installApp: async (ctx: ServiceContext, input: AppInput) => ({
    app: (await install(ctx, input)).id,
  }),

  updateApp: async (
    ctx: ServiceContext,
    input: { id: string; name?: string | undefined; permissions?: string[] | undefined; scopes?: Record<string, string> | undefined },
  ) => ({
    app: (await update(ctx, {
      id: input.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    })).id,
  }),

  revokeApp: async (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) => {
    const after = await revoke(ctx, { id: input.id, ...(input.reason ? { reason: input.reason } : {}) });
    return { app: after.id, status: after.status };
  },

  /**
   * The one route in this module whose response is a secret.
   *
   * It is returned here and nowhere else, because only the hash is stored. The
   * contract names it `token` rather than something coy, so nobody writes it to
   * a log believing it is an identifier.
   */
  issueAppToken: (
    ctx: ServiceContext,
    input: { appId: string; label?: string | undefined; expiresInDays?: number | undefined },
  ) => issueToken(ctx, {
    appId: input.appId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.expiresInDays ? { expiresInDays: input.expiresInDays } : {}),
  }).then(({ token, id, expiresAt }) => ({
    token, id, expiresAt: expiresAt.toISOString(),
  })),

  revokeAppToken: async (ctx: ServiceContext, input: { tokenId: string }) => {
    await revokeToken(ctx, input);
    return { revoked: true as const };
  },
} as const;
