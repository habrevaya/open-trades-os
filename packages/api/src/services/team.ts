import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  canDefineRole, ROLE_PRESETS, ROLE_IDS, DEFAULT_SCOPES, type RoleId,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { liveBranch } from "./branches";
import { replayed, remember } from "./once";
import { publicBaseUrl, SETUP_TOKEN_TTL_DAYS } from "./setup-tokens";

/**
 * WHO WORKS HERE, AND GETTING THE NEXT PERSON IN
 *
 * Until this existed a company was one person with a login. `user:invite` was
 * in the catalogue and in the office manager's preset and nothing checked it,
 * because nothing invited anybody: a second person got in through the
 * operator API or a row somebody typed into the database. The setup wizard's
 * team step pointed at a settings page that listed people and could not add
 * one.
 *
 * AN INVITE IS A PERSON AND A LINK. The person is created with the role they
 * were invited as, in the branch they were put in, and (when they go out to
 * jobs) with the technician record the board and the phone app need. The
 * link is the same one-time "choose your password" link the operator hands a
 * new owner, shown once to the person inviting, who sends it however they
 * talk to their team. It is never emailed by this product yet; that is in the
 * module doc's list of what is not built.
 *
 * AN ADDRESS WITH AN ACCOUNT ELSEWHERE IS REFUSED. `app.invite_member` says
 * why at length: adding an existing account to this company would hand the
 * company to whoever controls that account, and nothing here proves it is the
 * person the address belongs to.
 *
 * NOBODY HANDS OUT MORE THAN THEY HOLD. The role an invite or a role change
 * gives is checked with `canDefineRole`, the same function a custom role is
 * checked with, so an office manager may invite a technician and may not
 * invite an owner.
 */

export interface TeamMember {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  /** The preset. A custom role, when there is one, replaces it. */
  role: RoleId;
  roleLabel: string;
  customRoleId: string | null;
  customRoleName: string | null;
  businessUnitId: string | null;
  branchName: string | null;
  technicianId: string | null;
  active: boolean;
  /** Invited and has not chosen a password yet. */
  waiting: boolean;
  isYou: boolean;
}

export async function roster(ctx: ServiceContext): Promise<TeamMember[]> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const directory = await tx.execute<{ membership_id: string; name: string | null; email: string }>(
      sql`select membership_id, name, email from app.organization_people()`,
    );
    const waiting = new Set((await tx.execute<{ membership_id: string }>(
      sql`select membership_id from app.organization_people_waiting()`,
    )).map((row) => row.membership_id));
    const byMembership = new Map(directory.map((row) => [row.membership_id, row]));

    const rows = await tx.select({
      membership: schema.membership,
      roleName: schema.role.name,
      branchName: schema.businessUnit.name,
      technicianId: schema.technician.id,
    }).from(schema.membership)
      .leftJoin(schema.role, and(eq(schema.role.id, schema.membership.roleId), isNull(schema.role.deletedAt)))
      .leftJoin(schema.businessUnit, eq(schema.businessUnit.id, schema.membership.businessUnitId))
      .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
      .where(eq(schema.membership.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.membership.createdAt));

    return rows.map(({ membership, roleName, branchName, technicianId }) => ({
      membershipId: membership.id,
      userId: membership.userId,
      name: byMembership.get(membership.id)?.name ?? null,
      email: byMembership.get(membership.id)?.email ?? "",
      role: membership.role,
      roleLabel: ROLE_PRESETS[membership.role]?.label ?? membership.role,
      customRoleId: roleName ? membership.roleId : null,
      customRoleName: roleName,
      businessUnitId: membership.businessUnitId,
      branchName,
      technicianId,
      active: membership.active,
      waiting: waiting.has(membership.id),
      isYou: membership.userId === ctx.actor.userId,
    }));
  });
}

/** A preset somebody may hand out, or the refusal naming what they do not hold. */
function assertMayHandOut(ctx: ServiceContext, role: string): RoleId {
  if (!(ROLE_IDS as string[]).includes(role)) {
    throw new ConflictError(`"${role}" is not a role. One of: ${ROLE_IDS.map((r) => ROLE_PRESETS[r].label).join(", ")}.`);
  }
  const id = role as RoleId;
  const decision = canDefineRole(ctx.actor, {
    permissions: ROLE_PRESETS[id].permissions,
    scopes: DEFAULT_SCOPES[id],
  });
  if (!decision.ok) {
    /**
     * A refusal in words rather than `RoleEscalationError`, which the HTTP
     * layer has no mapping for and a screen cannot read. The sentence names
     * what is missing, because "ask somebody who holds payroll" is the thing
     * the person can act on.
     */
    throw new ConflictError(
      decision.reason === "missing_permission"
        ? `You cannot give somebody the ${ROLE_PRESETS[id].label} role, because it carries permissions you do not hold yourself (${decision.permissions.join(", ")}). Somebody who holds them has to do it.`
        : `You cannot give somebody the ${ROLE_PRESETS[id].label} role, because it sees more of the company than you do. Somebody who sees the whole company has to do it.`,
    );
  }
  return id;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteInput {
  email: string;
  name: string;
  role: string;
  businessUnitId?: string | null | undefined;
  /** Goes out to jobs, and so needs a technician record for the board. */
  goesOut?: boolean | undefined;
}

export interface InviteResult {
  membershipId: string;
  /** The link to choose a password, shown once. Null when this deployment has no public address set. */
  link: string | null;
  /** They were already invited and had not signed in; this is a new link and the old one no longer works. */
  reissued: boolean;
}

export async function invite(ctx: ServiceContext, input: InviteInput): Promise<InviteResult> {
  return guardedWrite(ctx, "user:invite", async (tx) => {
    const seen = await replayed<InviteResult>(tx, ctx, "membership_invite");
    if (seen) return seen;

    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!EMAIL.test(email)) throw new ConflictError(`"${input.email}" is not an email address.`);
    if (name === "") throw new ConflictError("Say who they are. Their name is what the board and the customer see.");
    const role = assertMayHandOut(ctx, input.role);
    if (input.businessUnitId) await liveBranch(tx, ctx, input.businessUnitId);

    const [outcome] = await tx.execute<{
      membership_id: string | null; user_id: string | null; outcome: string; active: boolean; has_password: boolean;
    }>(sql`select * from app.invite_member(${email}, ${name}, ${role})`);
    if (!outcome) throw new ConflictError("That invite did not go through. Nothing was changed.");

    if (outcome.outcome === "elsewhere") {
      throw new ConflictError(
        `${email} already has an account with another company. For their safety and yours, an account is only `
        + "ever added to the company that created it, so ask them for a different address to use here.",
      );
    }
    if (outcome.outcome === "member") {
      if (!outcome.active) {
        throw new ConflictError(`${email} is on your team and was turned off. Turn them back on from the list instead.`);
      }
      if (outcome.has_password) throw new ConflictError(`${email} is already on your team and can sign in.`);
      const link = await linkFor(tx, outcome.user_id!);
      const answer = { membershipId: outcome.membership_id!, link, reissued: true };
      await audit(tx, ctx, "membership.invite_reissued", "membership", outcome.membership_id!, null, { email });
      await remember(tx, ctx, "membership_invite", outcome.membership_id, answer);
      return answer;
    }

    const membershipId = outcome.membership_id!;
    if (input.businessUnitId) {
      await tx.update(schema.membership).set({ businessUnitId: input.businessUnitId })
        .where(eq(schema.membership.id, membershipId));
    }
    /**
     * A technician record for anybody who goes out to jobs. Nothing else in
     * the product makes one, so without it an invited technician could sign
     * in and could never be put on a visit: the board lists technicians, not
     * people.
     */
    const goesOut = input.goesOut ?? (role === "technician" || role === "crew_lead");
    if (goesOut) {
      await tx.insert(schema.technician).values({
        organizationId: ctx.actor.organizationId, membershipId, displayName: name,
      });
    }

    const link = await linkFor(tx, outcome.user_id!);
    await audit(tx, ctx, "membership.invited", "membership", membershipId, null, {
      email, role, businessUnitId: input.businessUnitId ?? null, technician: goesOut,
    });
    const answer = { membershipId, link, reissued: false };
    await remember(tx, ctx, "membership_invite", membershipId, answer);
    return answer;
  });
}

/** A fresh link for somebody invited who has not chosen a password. */
export async function resendInvite(ctx: ServiceContext, input: { membershipId: string }): Promise<InviteResult> {
  return guardedWrite(ctx, "user:invite", async (tx) => {
    const [member] = await tx.select().from(schema.membership)
      .where(and(
        eq(schema.membership.id, input.membershipId),
        eq(schema.membership.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!member) throw new NotFoundError("Person");
    if (!member.active) throw new ConflictError("They are turned off. Turn them back on before sending a link.");
    const link = await linkFor(tx, member.userId);
    await audit(tx, ctx, "membership.invite_reissued", "membership", member.id, null, {});
    return { membershipId: member.id, link, reissued: true };
  });
}

/**
 * The first-password link, through `app.issue_invite_token`, which refuses
 * anybody with a password or with a membership anywhere else. Null when the
 * deployment has no public address, because a link to nowhere is worse than
 * saying so.
 */
async function linkFor(tx: Database, userId: string): Promise<string | null> {
  const base = publicBaseUrl();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_DAYS * 864e5);
  const [row] = await tx.execute<{ issued: boolean }>(
    sql`select app.issue_invite_token(${userId}::uuid, ${hash}, ${expiresAt.toISOString()}::timestamptz) as issued`,
  );
  if (!row?.issued) {
    throw new ConflictError(
      "They have already chosen a password, or belong to another company as well, so there is no link to send. "
      + "They sign in as normal.",
    );
  }
  return base ? `${base}/welcome?token=${encodeURIComponent(token)}` : null;
}

/**
 * Change somebody's role to one of the presets.
 *
 * Checked in both directions. Handing out the new role needs its permissions,
 * and taking away the old one needs ITS permissions too: an administrator
 * cannot demote an owner, because the owner holds things the administrator
 * does not, and a role change is how one person takes another's access.
 * Choosing a preset also takes away any custom role, because a custom role
 * replaces the preset and a preset chosen under one would change nothing.
 */
export async function setRole(ctx: ServiceContext, input: { membershipId: string; role: string }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const role = assertMayHandOut(ctx, input.role);
    const [before] = await tx.select().from(schema.membership)
      .where(and(
        eq(schema.membership.id, input.membershipId),
        eq(schema.membership.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Person");
    if (before.userId === ctx.actor.userId) {
      throw new ConflictError("That is your own role. Somebody else has to change it, so nobody locks themselves out.");
    }
    assertMayHandOut(ctx, before.role);

    if (before.role === "owner" && role !== "owner" && before.active) {
      const [owners] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.membership)
        .where(and(
          eq(schema.membership.organizationId, ctx.actor.organizationId),
          eq(schema.membership.role, "owner"),
          eq(schema.membership.active, true),
        ));
      if ((owners?.n ?? 0) <= 1) {
        throw new ConflictError("That is the only owner. A company with none cannot make anybody one.");
      }
    }

    if (before.role === role && before.roleId === null) return before;
    const [after] = await tx.update(schema.membership)
      .set({ role, roleId: null, updatedAt: new Date() })
      .where(eq(schema.membership.id, input.membershipId))
      .returning();
    await audit(tx, ctx, "role.assigned", "membership", input.membershipId,
      { role: before.role, roleId: before.roleId }, { role, roleId: null });
    return after!;
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listTeam: async (ctx: ServiceContext) => ({ people: await roster(ctx) }),
  inviteMember: (ctx: ServiceContext, input: InviteInput) => invite(ctx, input),
  resendInvite: (ctx: ServiceContext, input: { membershipId: string }) => resendInvite(ctx, input),
  setMemberRole: async (ctx: ServiceContext, input: { membershipId: string; role: string }) => {
    const row = await setRole(ctx, input);
    return { membershipId: row.id, role: row.role, customRoleId: row.roleId };
  },
} as const;
