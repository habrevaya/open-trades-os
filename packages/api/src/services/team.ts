import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  can, canDefineRole, presetDefinition, people, ROLE_PRESETS, ROLE_IDS, DEFAULT_SCOPES, type Actor, type RoleId,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { liveBranch } from "./branches";
import * as email from "./email";
import * as invites from "./invites";
import { replayed, remember } from "./once";
import { publicBaseUrl } from "./setup-tokens";

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
 * new owner, shown once to the person inviting, and the person is emailed a
 * link of their own through the outbox (`services/invites.ts` says why the
 * outbox never holds it). Both work for `people.INVITE_DAYS` days; a new
 * invite replaces the old one.
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
  /** For somebody waiting: when their invite was sent, whether it was emailed, and until when it works. */
  invite: invites.InviteView | null;
  locationId: string | null;
  locationName: string | null;
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
      locationName: schema.location.name,
      technicianId: schema.technician.id,
    }).from(schema.membership)
      .leftJoin(schema.role, and(eq(schema.role.id, schema.membership.roleId), isNull(schema.role.deletedAt)))
      .leftJoin(schema.businessUnit, eq(schema.businessUnit.id, schema.membership.businessUnitId))
      .leftJoin(schema.location, eq(schema.location.id, schema.membership.locationId))
      .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
      .where(eq(schema.membership.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.membership.createdAt));

    const standing = await invites.standings(
      tx, [...waiting], await timezoneOf(tx, ctx.actor.organizationId),
    );

    return rows.map(({ membership, roleName, branchName, locationName, technicianId }) => ({
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
      invite: waiting.has(membership.id) ? standing.get(membership.id) ?? null : null,
      locationId: membership.locationId,
      locationName,
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
  /**
   * Every scope said out loud. Checked against `DEFAULT_SCOPES` alone, which
   * leaves out whatever a preset sees in full, nothing was compared, and a
   * branch manager could hand out the office manager's whole company.
   */
  const decision = canDefineRole(ctx.actor, presetDefinition(id));
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
  /** Put in the outbox for them, with a link of its own. */
  emailed: boolean;
  /** Why it was not, when it was not: no email provider, no public address, an address that bounced. */
  emailNote: string | null;
  /** When both links stop working. */
  expiresAt: string;
}

/** A preset that sees only a branch's work, which nobody can hold without a branch. */
const branchLimited = (role: RoleId) =>
  Object.values(DEFAULT_SCOPES[role] ?? {}).includes("business_unit");

/**
 * The branch an invite puts somebody in, for an inviter who sees only part
 * of the company: their own, whatever they asked for, because somebody they
 * invite into another branch is somebody they can no longer see.
 */
function inviteBranch(ctx: ServiceContext, asked: string | null | undefined): string | null {
  if (scopeOf(ctx, "job") === "all") return asked ?? null;
  if (asked && asked !== ctx.actor.businessUnitId) {
    throw new ConflictError(
      "You can only invite people into your own branch. Somebody in another branch is somebody you would not see afterwards.",
    );
  }
  return ctx.actor.businessUnitId ?? null;
}

export async function invite(ctx: ServiceContext, input: InviteInput): Promise<InviteResult> {
  return guardedWrite(ctx, "user:invite", async (tx) => {
    const seen = await replayed<InviteResult>(tx, ctx, "membership_invite");
    if (seen) return seen;

    const address = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!EMAIL.test(address)) throw new ConflictError(`"${input.email}" is not an email address.`);
    if (name === "") throw new ConflictError("Say who they are. Their name is what the board and the customer see.");
    const role = assertMayHandOut(ctx, input.role);
    const businessUnitId = inviteBranch(ctx, input.businessUnitId);
    if (businessUnitId) await liveBranch(tx, ctx, businessUnitId);
    if (!businessUnitId && branchLimited(role)) {
      throw new ConflictError(
        `A ${ROLE_PRESETS[role].label.toLowerCase()} sees their branch's work only, so choose their branch. `
        + "With none they would see nothing at all.",
      );
    }

    const [outcome] = await tx.execute<{
      membership_id: string | null; user_id: string | null; outcome: string; active: boolean; has_password: boolean;
    }>(sql`select * from app.invite_member(${address}, ${name}, ${role})`);
    if (!outcome) throw new ConflictError("That invite did not go through. Nothing was changed.");

    if (outcome.outcome === "elsewhere") {
      throw new ConflictError(
        `${address} already has an account with another company. For their safety and yours, an account is only `
        + "ever added to the company that created it, so ask them for a different address to use here.",
      );
    }
    if (outcome.outcome === "member") {
      if (!outcome.active) {
        throw new ConflictError(`${address} is on your team and was turned off. Turn them back on from the list instead.`);
      }
      if (outcome.has_password) throw new ConflictError(`${address} is already on your team and can sign in.`);
      const sent = await send(tx, ctx, { membershipId: outcome.membership_id!, userId: outcome.user_id!, email: address, name });
      const answer = { membershipId: outcome.membership_id!, reissued: true, ...sent };
      await audit(tx, ctx, "membership.invite_reissued", "membership", outcome.membership_id!, null, {
        email: address, emailed: sent.emailed, expiresAt: sent.expiresAt,
      });
      await remember(tx, ctx, "membership_invite", outcome.membership_id, answer);
      return answer;
    }

    const membershipId = outcome.membership_id!;
    if (businessUnitId) {
      await tx.update(schema.membership).set({ businessUnitId })
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

    const sent = await send(tx, ctx, { membershipId, userId: outcome.user_id!, email: address, name });
    await audit(tx, ctx, "membership.invited", "membership", membershipId, null, {
      email: address, role, businessUnitId, technician: goesOut, emailed: sent.emailed, expiresAt: sent.expiresAt,
    });
    const answer = { membershipId, reissued: false, ...sent };
    await remember(tx, ctx, "membership_invite", membershipId, answer);
    return answer;
  });
}

/**
 * A new invite for somebody invited who has not chosen a password: a fresh
 * link shown once and emailed again, good for another `people.INVITE_DAYS`
 * days. The old invite's links stop working. This is what to do when one
 * has run out.
 */
export async function resendInvite(ctx: ServiceContext, input: { membershipId: string }): Promise<InviteResult> {
  return guardedWrite(ctx, "user:invite", async (tx) => {
    const seen = await replayed<InviteResult>(tx, ctx, "membership_invite_resend");
    if (seen) return seen;
    const [member] = await tx.select().from(schema.membership)
      .where(and(
        eq(schema.membership.id, input.membershipId),
        eq(schema.membership.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!member) throw new NotFoundError("Person");
    if (!member.active) throw new ConflictError("They are turned off. Turn them back on before sending a link.");
    const [directory] = await tx.execute<{ name: string | null; email: string }>(
      sql`select name, email from app.organization_people() where membership_id = ${member.id}`,
    );
    if (!directory) throw new NotFoundError("Person");
    const sent = await send(tx, ctx, {
      membershipId: member.id, userId: member.userId, email: directory.email, name: directory.name ?? directory.email,
    });
    await audit(tx, ctx, "membership.invite_reissued", "membership", member.id, null, {
      emailed: sent.emailed, expiresAt: sent.expiresAt,
    });
    const answer = { membershipId: member.id, reissued: true, ...sent };
    await remember(tx, ctx, "membership_invite_resend", member.id, answer);
    return answer;
  });
}

/**
 * The person's own sending identity for an email to a colleague: the
 * inviter, with `message:send` added for this one email the way a document
 * delivery adds it. Inviting is the decision, and holding `user:invite`
 * without being able to text customers must not stop an invite going out.
 * Revocation still wins, so a company that revoked it from this person
 * gets the link on the screen and no email.
 */
function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] };
  return { ...ctx, actor, db: tx };
}

/** Why an invite was not emailed, in the few words the team list has room for. */
function shortRefusal(reason: string): string {
  switch (reason) {
    case "channel_not_registered": return "no email provider is connected";
    case "suppressed": return "this address bounced or asked not to be emailed";
    case "consent_revoked": return "this address asked not to be emailed";
    default: return "the email could not be sent";
  }
}

/**
 * Send an invite: retire the last one, make the link shown to the inviter,
 * record the invite with when it runs out, and put its email in the outbox
 * sealed to it. The email is refused rather than thrown when it cannot go
 * (no provider, a bounced address), because the person is still invited and
 * the inviter still has the link to send by hand.
 */
async function send(tx: Database, ctx: ServiceContext, input: {
  membershipId: string; userId: string; email: string; name: string;
}): Promise<{ link: string | null; emailed: boolean; emailNote: string | null; expiresAt: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + people.INVITE_DAYS * 864e5);

  await tx.update(schema.membershipInvite)
    .set({ replacedAt: now, updatedAt: now })
    .where(and(
      eq(schema.membershipInvite.membershipId, input.membershipId),
      isNull(schema.membershipInvite.replacedAt),
    ));
  /** Retires every link the person had, the old invite's emailed one included. */
  const link = await linkFor(tx, input.userId, expiresAt);

  const [invite] = await tx.insert(schema.membershipInvite).values({
    organizationId: ctx.actor.organizationId,
    membershipId: input.membershipId,
    email: input.email,
    sentByUserId: ctx.actor.userId,
    expiresAt,
  }).returning({ id: schema.membershipInvite.id });

  let emailNote: string | null = null;
  if (!publicBaseUrl()) {
    emailNote = "this server has no public address (PUBLIC_URL), so there is no link to send";
  } else {
    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const [inviter] = await tx.execute<{ name: string | null }>(
      sql`select name from app.organization_people() where user_id = ${ctx.actor.userId}`,
    );
    const words = invites.composeInviteEmail({
      name: input.name,
      company: org?.name ?? "the company",
      inviter: inviter?.name ?? null,
      expiresOn: invites.expiresOn(expiresAt, await timezoneOf(tx, ctx.actor.organizationId)),
    });
    const transport = transportContext(ctx, tx);
    if (!can(transport.actor, "message:send")) {
      emailNote = "sending email has been taken away from you";
    } else {
      const outcome = await email.queueIn(tx, transport, {
        to: input.email, subject: words.subject, text: words.text, html: words.html,
        purpose: "transactional", sealedInviteId: invite!.id,
      });
      if (!outcome.queued) emailNote = shortRefusal(outcome.reason);
    }
  }
  if (emailNote) {
    await tx.update(schema.membershipInvite).set({ emailRefusal: emailNote, updatedAt: now })
      .where(eq(schema.membershipInvite.id, invite!.id));
  }
  return { link, emailed: emailNote === null, emailNote, expiresAt: expiresAt.toISOString() };
}

/**
 * The first-password link, through `app.issue_invite_token`, which refuses
 * anybody with a password or with a membership anywhere else, and retires
 * every link they had. Null when the deployment has no public address,
 * because a link to nowhere is worse than saying so.
 */
async function linkFor(tx: Database, userId: string, expiresAt: Date): Promise<string | null> {
  const base = publicBaseUrl();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
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

    if (branchLimited(role) && !before.businessUnitId) {
      throw new ConflictError(
        `A ${ROLE_PRESETS[role].label.toLowerCase()} sees their branch's work only, and they are in no branch. `
        + "Put them in one first, or they would see nothing at all.",
      );
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
