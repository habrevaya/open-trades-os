import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import {
  assertCan, canDefineRole, isScope, presetDefinition, ALL_PERMISSIONS, SCOPED_RESOURCES,
  type Permission, type RoleDefinition, type RoleId, type Scope, type ScopedResource,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, NotFoundError, ConflictError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";
import { memberWithin } from "./people-scope";
import { refusingDuplicate } from "./duplicates";

/**
 * CUSTOM ROLES
 *
 * The dangerous service in this codebase, and it is worth being explicit
 * about why. A role is a container for permissions, so anybody who can write
 * one can write `owner` into it, hand it to themselves and own the company.
 * `role:write` is handed out as an administrative convenience, which means
 * without a second check it is quietly equivalent to every permission in the
 * catalogue.
 *
 * The second check is `canDefineRole`, and it is deliberately not a check on
 * `role:write`: that answers whether they may touch roles at all, and this
 * answers whether this particular definition is inside what they already
 * hold. Every path that can arrive at "this person now has this permission"
 * goes through it: create, update, and assign.
 */

export interface RoleInput {
  name: string;
  description?: string | undefined;
  basedOn?: string | undefined;
  permissions: string[];
  scopes?: Record<string, string> | undefined;
}

/**
 * Validate the shape before the authority question.
 *
 * A permission key that is not in the catalogue is refused rather than
 * ignored, because a typo that is silently dropped produces a role that looks
 * right in the editor and does less than its author believes. The same
 * argument as an unknown workflow step: refuse, do not skip.
 */
function parse(input: RoleInput): RoleDefinition {
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

/**
 * The refusal, as an error the HTTP layer can turn into a 403 with a body
 * that says which permission or which resource was the problem. "Forbidden"
 * alone sends an office manager to support; naming `payroll:read` tells them
 * what to ask for.
 */
export class RoleEscalationError extends Error {
  constructor(public readonly detail:
    | { reason: "missing_permission"; permissions: Permission[] }
    | { reason: "widens_scope"; resources: ScopedResource[] }) {
    super(detail.reason === "missing_permission"
      ? `You do not hold: ${detail.permissions.join(", ")}`
      : `Wider than your own scope on: ${detail.resources.join(", ")}`);
    this.name = "RoleEscalationError";
  }

  /**
   * The refusal as a person reads it, which the HTTP layer answers a 403
   * with and the roles screen shows: what was wrong, and who can do it
   * instead. One sentence for both, so the API and the screen cannot
   * disagree about why.
   */
  get sentence(): string {
    return this.detail.reason === "missing_permission"
      ? `That role carries permissions you do not hold yourself: ${this.detail.permissions.join(", ")}. `
        + "Start from a smaller preset, or ask somebody who holds them."
      : "That role would see more of the company than you do. Somebody who sees the whole company has to do it.";
  }
}

function assertWithinAuthority(ctx: ServiceContext, definition: RoleDefinition): void {
  const decision = canDefineRole(ctx.actor, definition);
  if (!decision.ok) {
    const { ok: _ok, ...detail } = decision;
    throw new RoleEscalationError(detail);
  }
}

/**
 * `basedOn` is a label saying where the definition started, so an unknown
 * value is dropped rather than refused: it changes nothing about what the
 * role can do, and failing a role creation over a stale preset name would be
 * a worse outcome than losing a note.
 */
type MemberRole = (typeof schema.memberRole.enumValues)[number];

function basedOn(value: string | undefined): MemberRole | null {
  const known = schema.memberRole.enumValues as readonly string[];
  return value && known.includes(value) ? (value as MemberRole) : null;
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "role:write", async (tx) => {
    return tx.select().from(schema.role)
      .where(isNull(schema.role.deletedAt))
      .orderBy(schema.role.name);
  });
}

/**
 * A ROLE THAT NAMES NO SCOPE AT ALL, which is how the roles screen saved
 * "the whole company" before it wrote that choice out. A role that names
 * none sees its holder's own work, the narrowest default, so a role made as
 * "the whole company" in those days has been showing its holders their own
 * jobs only. Nothing can tell that role from one meant to show only their
 * own work, so nothing is changed without somebody saying which it is:
 * `giveWholeCompany` is that click, and this is what the screen lists.
 */
export const namesNoScope = (role: { scopes: Record<string, string> }): boolean =>
  Object.keys(role.scopes ?? {}).length === 0;

/**
 * Give a role the whole company, on every record a scope narrows: the fix
 * for a role saved before "the whole company" was written out. Only on a
 * role that names no scope, so it cannot be used to widen a branch role,
 * and only by somebody who sees the whole company themselves (checked by
 * `canDefineRole`, like every role write). Its holders' access changes the
 * moment it is saved, which is why it is a click somebody confirms and not
 * something done for them.
 */
export async function giveWholeCompany(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "role:write", async (tx) => {
    const seen = await replayed<typeof schema.role.$inferSelect>(tx, ctx, "role_whole_company");
    if (seen) return seen;
    const [before] = await tx.select().from(schema.role)
      .where(and(eq(schema.role.id, input.id), isNull(schema.role.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Role");
    if (!namesNoScope(before)) {
      throw new ConflictError(
        `${before.name} already says what its holders see, so it is not changed here. Make a new role to change that.`,
      );
    }
    const scopes = Object.fromEntries(SCOPED_RESOURCES.map((resource) => [resource, "all"])) as Record<ScopedResource, Scope>;
    assertWithinAuthority(ctx, { permissions: before.permissions as Permission[], scopes });
    const [after] = await tx.update(schema.role)
      .set({ scopes, updatedAt: new Date() })
      .where(eq(schema.role.id, before.id)).returning();
    await audit(tx, ctx, "role.given_whole_company", "role", before.id, { scopes: before.scopes }, { scopes });
    await remember(tx, ctx, "role_whole_company", before.id, after!);
    return after!;
  });
}

export async function create(ctx: ServiceContext, input: RoleInput) {
  const definition = parse(input);
  return guardedWrite(ctx, "role:write", async (tx) => {
    assertWithinAuthority(ctx, definition);

    /**
     * One role per name. Two roles called "Senior tech" is a screen where
     * somebody assigns a person to the wrong set of permissions and cannot see
     * that they did. `services/duplicates.ts`.
     */
    const [created] = await refusingDuplicate(
      "role_name_idx",
      `There is already a role called "${input.name}". Two roles with one name is how somebody `
      + `grants the wrong permissions and cannot see that they did.`,
      () => tx.insert(schema.role).values({
        organizationId: ctx.actor.organizationId,
        name: input.name,
        description: input.description ?? null,
        basedOn: basedOn(input.basedOn),
        permissions: [...definition.permissions],
        scopes: (definition.scopes ?? {}) as Record<string, string>,
        createdByUserId: ctx.actor.userId,
      }).returning(),
    );

    await audit(tx, ctx, "role.created", "role", created!.id, null, created);
    return created!;
  });
}

export async function update(ctx: ServiceContext, input: { id: string } & Partial<RoleInput>) {
  return guardedWrite(ctx, "role:write", async (tx) => {
    const [before] = await tx.select().from(schema.role)
      .where(and(eq(schema.role.id, input.id), isNull(schema.role.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Role");

    /**
     * Checked against the RESULT, not against the change. Editing a role you
     * are allowed to edit into one you are not allowed to define is the same
     * escalation as creating it, and checking only the delta would miss it.
     */
    const definition = parse({
      name: input.name ?? before.name,
      permissions: input.permissions ?? before.permissions,
      ...(input.scopes !== undefined ? { scopes: input.scopes } : { scopes: before.scopes }),
    });
    assertWithinAuthority(ctx, definition);

    const [after] = await tx.update(schema.role).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      permissions: [...definition.permissions],
      scopes: (definition.scopes ?? {}) as Record<string, string>,
      updatedAt: new Date(),
    }).where(eq(schema.role.id, input.id)).returning();

    await audit(tx, ctx, "role.updated", "role", input.id, before, after);
    return after!;
  });
}

/**
 * Assign a role to a membership.
 *
 * Guarded by `membership:write` and by the same authority check, because
 * handing somebody a role is the third way of arriving at "this person now
 * holds this permission". An administrator who may edit memberships but not
 * define roles could otherwise assign one that somebody else minted.
 */
export async function assign(
  ctx: ServiceContext,
  input: {
    membershipId: string;
    roleId: string | null;
    /**
     * WHERE THIS PERSON'S SCOPE POINTS, and until now nothing could set it.
     *
     * Two of the five scopes, `business_unit` and `location`, resolve through
     * `membership.business_unit_id` and `membership.location_id`. Neither
     * column was ever written by anything. `scope.ts` reads them and returns
     * NOTHING when they are null, so an administrator who built a "Branch
     * Manager" role with `job: "business_unit"` and assigned it watched that
     * person open an empty job list. Not an error, not a permission message:
     * an empty screen, which reads as "this branch has no work".
     *
     * `session.ts` already carries a comment about the other half of this
     * exact bug. This is the half that was still open.
     */
    businessUnitId?: string | null;
    locationId?: string | null;
    /**
     * PER PERSON NARROWING, which can only ever take access away.
     *
     * `membership.scope_overrides` was written by nothing, and the settings
     * screen renders a "Scope limits" column from it. So an administrator
     * opened Settings, saw that column blank for everybody, and concluded
     * nobody's access had been narrowed. That was true, and true only because
     * narrowing anybody's access was impossible.
     *
     * `effectiveScope` in core already applies this as a CEILING: a role
     * granting `job: "all"` with an override of `job: "own"` resolves to own.
     * It cannot widen, which is why it needs no authority check of its own
     * beyond the one on the role.
     */
    scopeOverrides?: Partial<Record<ScopedResource, Scope>> | null;
    /**
     * One extra permission for one person, and one taken away.
     *
     * Both columns are read by `permissionsFor` on every request and were
     * written by nothing, so the only way to give somebody a single extra
     * permission was to mint a whole role for them. Revocation beats a grant,
     * which is what makes taking access away unambiguous.
     */
    grants?: Permission[] | null;
    revocations?: Permission[] | null;
  },
) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    /** Somebody whose record this person keeps, or not found (`people-scope.ts`). */
    const before = await memberWithin(tx, ctx, input.membershipId);

    if (input.roleId) {
      const [target] = await tx.select().from(schema.role)
        .where(and(eq(schema.role.id, input.roleId), isNull(schema.role.deletedAt))).limit(1);
      if (!target) throw new NotFoundError("Role");
      const scopes = target.scopes as Partial<Record<ScopedResource, Scope>>;
      assertWithinAuthority(ctx, {
        permissions: target.permissions as Permission[],
        scopes,
      });

      /**
       * A SCOPE THAT POINTS NOWHERE IS REFUSED, LOUDLY.
       *
       * This is the guard that would have caught the bug above. `scope.ts`
       * resolves `business_unit` and `location` through columns on the
       * membership, and returns NOTHING when they are null. Assigning such a
       * role to somebody with no anchor does not fail: it succeeds, and that
       * person opens an empty screen that reads as "there is no work here".
       *
       * A refusal naming the missing anchor is the difference between an
       * administrator fixing it in ten seconds and a technician escalating a
       * blank screen through support.
       */
      const anchored = {
        business_unit: input.businessUnitId !== undefined
          ? input.businessUnitId : before.businessUnitId,
        location: input.locationId !== undefined ? input.locationId : before.locationId,
      };
      for (const [resource, scope] of Object.entries(scopes)) {
        const needed = scope === "business_unit" || scope === "location" ? scope : null;
        if (needed && !anchored[needed]) {
          throw new ConflictError(
            `That role scopes ${resource} to this person's ${needed.replace("_", " ")}, `
            + `and they have none set. Choose one, or they will see nothing at all.`,
          );
        }
      }
    }

    /**
     * The anchors must exist, and these lookups CANNOT be the thing that
     * stops a foreign one. Said plainly, because deleting the organization
     * filter below changes no test and somebody will notice that.
     *
     * Everything in `guardedWrite` runs inside `inTenant`, which sets the
     * `authenticated` role and the organization, so row level security has
     * already made another company's business unit invisible to this select.
     * The row simply is not there, and the refusal below fires for "no such
     * unit" rather than for "not yours".
     *
     * The explicit filter stays because it costs nothing and because this
     * file would otherwise read as though an id from a form were taken on
     * trust. What these lookups genuinely add is the refusal itself: without
     * them a mistyped id would be written into the membership and then used,
     * by `scope.ts`, as the filter deciding what this person sees. Nothing
     * would leak, and they would open an empty screen nobody could explain.
     */
    if (input.businessUnitId) {
      const [unit] = await tx.select({ id: schema.businessUnit.id })
        .from(schema.businessUnit)
        .where(and(
          eq(schema.businessUnit.id, input.businessUnitId),
          eq(schema.businessUnit.organizationId, ctx.actor.organizationId),
        )).limit(1);
      if (!unit) throw new NotFoundError("Business unit");
    }
    if (input.locationId) {
      const [loc] = await tx.select({ id: schema.location.id })
        .from(schema.location)
        .where(and(
          eq(schema.location.id, input.locationId),
          eq(schema.location.organizationId, ctx.actor.organizationId),
        )).limit(1);
      if (!loc) throw new NotFoundError("Location");
    }

    /**
     * YOU CANNOT GRANT WHAT YOU DO NOT HOLD, checked with the same function
     * that governs defining a role rather than a second implementation of
     * the same idea. Two versions of "may you grant this" disagree
     * eventually, and the disagreement is silent.
     *
     * Revocations are NOT checked, deliberately. Taking a permission away
     * from somebody can only ever reduce what they can do, so an
     * administrator who may edit memberships at all may do it, and requiring
     * them to hold a permission before they can remove it is how somebody
     * ends up unable to lock down an account they are worried about.
     */
    if (input.grants && input.grants.length > 0) {
      assertWithinAuthority(ctx, { permissions: input.grants, scopes: {} });
    }

    /**
     * An override may only narrow, and core enforces that when it resolves.
     * Validated here anyway so an administrator who types a widening value
     * is told, rather than saving something that silently does nothing.
     */
    for (const [resource, scope] of Object.entries(input.scopeOverrides ?? {})) {
      if (!isScope(scope)) {
        throw new ConflictError(
          `${String(scope)} is not a scope, so the limit on ${resource} would do nothing.`,
        );
      }
    }

    const [after] = await tx.update(schema.membership)
      .set({
        roleId: input.roleId,
        /**
         * Only written when the caller said something. Omitting the field
         * leaves an existing anchor alone, so changing somebody's role does
         * not silently empty the screen of a branch manager who had one.
         */
        ...(input.businessUnitId !== undefined ? { businessUnitId: input.businessUnitId } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.scopeOverrides !== undefined
          ? { scopeOverrides: input.scopeOverrides ?? {} } : {}),
        ...(input.grants !== undefined ? { grants: input.grants ?? [] } : {}),
        ...(input.revocations !== undefined ? { revocations: input.revocations ?? [] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.membership.id, input.membershipId))
      .returning();

    /**
     * Audited as a role assignment rather than a membership edit. "Who gave
     * this person payroll access" is the question an auditor asks, and a row
     * that says `membership.updated` buries the answer in a diff.
     */
    await audit(tx, ctx, "role.assigned", "membership", input.membershipId, before, after);
    return after!;
  });
}

/**
 * GIVE SOMEBODY ONE OF THE COMPANY'S OWN ROLES, as the Team screen and the
 * API do it: `assign` with the checks a role change makes.
 *
 * `user:write`, the permission for changing what somebody may do, because
 * `assign` alone is guarded by `membership:write`, which the presets give
 * for selling service agreements. Checked in both directions, as a preset
 * change is (`team.setRole`): the caller must hold what the role carries and
 * what the person holds now, so nobody demotes an owner by handing them a
 * smaller role. Nobody changes their own.
 */
export async function assignCustomRole(ctx: ServiceContext, input: { membershipId: string; roleId: string }) {
  assertCan(ctx.actor, "user:write");
  return guardedWrite(ctx, "user:write", async (tx) => {
    const before = await memberWithin(tx, ctx, input.membershipId);
    if (before.userId === ctx.actor.userId) {
      throw new ConflictError("That is your own role. Somebody else has to change it, so nobody locks themselves out.");
    }
    const [current] = before.roleId
      ? await tx.select().from(schema.role).where(eq(schema.role.id, before.roleId)).limit(1)
      : [];
    assertWithinAuthority(ctx, current
      ? { permissions: current.permissions as Permission[], scopes: current.scopes as Partial<Record<ScopedResource, Scope>> }
      : presetDefinition(before.role as RoleId));
    return assign({ ...ctx, db: tx }, { membershipId: input.membershipId, roleId: input.roleId });
  });
}

/**
 * Soft delete, and the memberships holding it fall back to their preset
 * rather than to nothing. A role removed at 4pm must not lock its holders out
 * at 4:01, and `role` on the membership was never cleared precisely so that
 * this fallback exists.
 */
export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "role:write", async (tx) => {
    const [before] = await tx.select().from(schema.role)
      .where(and(eq(schema.role.id, input.id), isNull(schema.role.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Role");

    await tx.update(schema.membership).set({ roleId: null, updatedAt: new Date() })
      .where(eq(schema.membership.roleId, input.id));
    await tx.update(schema.role).set({ deletedAt: new Date() })
      .where(eq(schema.role.id, input.id));

    await audit(tx, ctx, "role.deleted", "role", input.id, before, null);
  });
}

/**
 * OFFBOARD SOMEBODY, OR BRING THEM BACK.
 *
 * `membership.active` decides whether a login succeeds: the sign in path
 * looks for an active membership and refuses when there is none. Nothing
 * could set it to false. An employee who left on Friday kept a working
 * password, their sessions, and every permission their role carried, and the
 * only way to stop them was to delete the user row, which takes the audit
 * trail of everything they did with it.
 *
 * DEACTIVATED, NOT DELETED. Every job they ran, every invoice they took and
 * every timeclock entry they closed points at them, and those have to keep
 * resolving: the question "who was on site" has to have an answer years
 * later. This stops them getting in; it changes nothing about what they did.
 *
 * SESSIONS ARE REVOKED IN THE SAME TRANSACTION. Flipping the flag alone
 * would leave anybody already signed in signed in, for as long as their
 * session lasts, which on this product is days. An offboarding that takes
 * effect on Thursday is not an offboarding.
 */
export async function setMembershipActive(
  ctx: ServiceContext,
  input: { membershipId: string; active: boolean; reason?: string | undefined },
) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const before = await memberWithin(tx, ctx, input.membershipId);

    /**
     * Locking yourself out is refused rather than allowed with a warning.
     * The person doing it is the one who would have to undo it, and the
     * account that can undo it is the one they just disabled.
     */
    if (!input.active && before.userId === ctx.actor.userId) {
      throw new ConflictError(
        "That is your own membership. Deactivating it would lock you out of the company, "
        + "and the account that could undo it is the one you just turned off.",
      );
    }

    /**
     * The last owner is refused for the same reason one layer up: a company
     * with no owner cannot grant anybody the permission to become one.
     */
    if (!input.active && before.role === "owner") {
      const owners = await tx.select({ id: schema.membership.id })
        .from(schema.membership)
        .where(and(
          eq(schema.membership.organizationId, ctx.actor.organizationId),
          eq(schema.membership.role, "owner"),
          eq(schema.membership.active, true),
        ));
      if (owners.length <= 1) {
        throw new ConflictError(
          "That is the only active owner. A company with none cannot grant anybody the permission to become one.",
        );
      }
    }

    if (before.active === input.active) {
      return { id: before.id, active: input.active, sessionsRevoked: 0 };
    }

    await tx.update(schema.membership)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(schema.membership.id, input.membershipId));

    let sessionsRevoked = 0;
    if (!input.active) {
      /**
       * THROUGH A DEFINER FUNCTION, BECAUSE THE POLICY FORBIDS THE DIRECT
       * WRITE AND FORBIDS IT CORRECTLY.
       *
       * `session_self_access` limits the application role to its OWN
       * sessions: a policy letting any authenticated role read that table
       * is a policy letting them read live tokens. The first version of
       * this function updated `session` directly, ran as `authenticated`,
       * matched zero rows, and returned "revoked" while the leaver stayed
       * signed in for the week their session had left.
       *
       * The function re-checks the authority in the database rather than
       * trusting that this code did: the actor must hold an active
       * membership of this organization in a role that edits users, and the
       * target must be a member of it. One that revoked whatever it was
       * asked to would be a way for anybody to sign anybody out.
       */
      const [result] = await tx.execute<{ revoked: number }>(sql`
        select app.revoke_sessions_for(
          ${before.userId}::uuid,
          ${ctx.actor.organizationId}::uuid,
          ${ctx.actor.userId}::uuid
        ) as revoked
      `);
      sessionsRevoked = Number(result?.revoked ?? 0);
    }

    await audit(tx, ctx,
      input.active ? "membership.reactivated" : "membership.deactivated",
      "membership", input.membershipId,
      { active: before.active },
      { active: input.active, reason: input.reason ?? null, sessionsRevoked });

    return { id: before.id, active: input.active, sessionsRevoked };
  });
}

/* --------------------------------------------------------------- handlers */

type RoleRow = typeof schema.role.$inferSelect;

/** A role as the API publishes it, saying when it names no scope and so needs the whole company fix. */
const view = (row: RoleRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  basedOn: row.basedOn,
  permissions: row.permissions,
  scopes: row.scopes,
  namesNoScope: namesNoScope(row),
});

export const handlers = {
  listRoles: async (ctx: ServiceContext) => ({ roles: (await list(ctx)).map(view) }),
  /** A retry gets the role it made rather than a refusal about its own name. */
  createRole: (ctx: ServiceContext, input: RoleInput) => guardedWrite(ctx, "role:write", async (tx) => {
    const seen = await replayed<ReturnType<typeof view>>(tx, ctx, "role_create");
    if (seen) return seen;
    const made = view(await create({ ...ctx, db: tx }, input));
    await remember(tx, ctx, "role_create", made.id, made);
    return made;
  }),
  updateRole: async (ctx: ServiceContext, input: {
    id: string; name?: string | undefined; description?: string | undefined; basedOn?: string | undefined;
    permissions?: string[] | undefined; scopes?: Record<string, string> | undefined;
  }) => view(await update(ctx, {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
  })),
  removeRole: async (ctx: ServiceContext, input: { id: string }) => guardedWrite(ctx, "role:write", async (tx) => {
    const seen = await replayed<{ id: string; removed: true }>(tx, ctx, "role_remove");
    if (seen) return seen;
    await remove({ ...ctx, db: tx }, input);
    const answer = { id: input.id, removed: true as const };
    await remember(tx, ctx, "role_remove", input.id, answer);
    return answer;
  }),
  giveRoleWholeCompany: async (ctx: ServiceContext, input: { id: string }) => view(await giveWholeCompany(ctx, input)),
  assignCustomRole: async (ctx: ServiceContext, input: { membershipId: string; roleId: string }) => {
    const row = await assignCustomRole(ctx, input);
    return { membershipId: row.id, role: row.role, customRoleId: row.roleId };
  },
} as const;
