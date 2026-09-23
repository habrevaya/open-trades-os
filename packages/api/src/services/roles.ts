import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import {
  canDefineRole, isScope, ALL_PERMISSIONS,
  type Permission, type RoleDefinition, type Scope, type ScopedResource,
} from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

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

export async function create(ctx: ServiceContext, input: RoleInput) {
  const definition = parse(input);
  return guardedWrite(ctx, "role:write", async (tx) => {
    assertWithinAuthority(ctx, definition);

    const [created] = await tx.insert(schema.role).values({
      organizationId: ctx.actor.organizationId,
      name: input.name,
      description: input.description ?? null,
      basedOn: basedOn(input.basedOn),
      permissions: [...definition.permissions],
      scopes: (definition.scopes ?? {}) as Record<string, string>,
      createdByUserId: ctx.actor.userId,
    }).returning();

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
  input: { membershipId: string; roleId: string | null },
) {
  return guardedWrite(ctx, "membership:write", async (tx) => {
    if (input.roleId) {
      const [target] = await tx.select().from(schema.role)
        .where(and(eq(schema.role.id, input.roleId), isNull(schema.role.deletedAt))).limit(1);
      if (!target) throw new NotFoundError("Role");
      assertWithinAuthority(ctx, {
        permissions: target.permissions as Permission[],
        scopes: target.scopes as Partial<Record<ScopedResource, Scope>>,
      });
    }

    const [before] = await tx.select().from(schema.membership)
      .where(eq(schema.membership.id, input.membershipId)).limit(1);
    if (!before) throw new NotFoundError("Membership");

    const [after] = await tx.update(schema.membership)
      .set({ roleId: input.roleId, updatedAt: new Date() })
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
