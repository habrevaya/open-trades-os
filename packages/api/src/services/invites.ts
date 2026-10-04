import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { people, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { publicBaseUrl } from "./setup-tokens";

/**
 * M01. AN INVITE TO WORK HERE, BY EMAIL
 *
 * Inviting somebody (`team.invite`) makes the person and hands the inviter a
 * one time link to choose a password, shown once. It also emails them, through
 * the same outbox every other email goes through, so the inviter no longer has
 * to copy a link into a text message and the team list can say whether the
 * email went.
 *
 * THE LINK IS NOT IN THE OUTBOX. Everybody who reads the inbox can read the
 * outbox: a CSR, a dispatcher. A link that chooses a new colleague's password,
 * sitting in their inbox, would let them choose it first and walk into an
 * account they were never given, which for an invited administrator is the
 * company. So the stored email says where the link goes, the message carries
 * the invite it is sealed to (`message.sealed_invite_id`), and the outbox asks
 * this file for a fresh link at the moment it hands the email to the provider.
 * The link is in the copy the provider receives and nowhere else: not in the
 * table, not in a log. The phone app's sign in codes skip the outbox for the
 * same reason (`field-devices.ts`); an invite goes through it so that it is
 * retried, suppressed when the address bounces, and shown as sent or not.
 *
 * EXPIRY. An invite's link works for `people.INVITE_DAYS` days from when it
 * was sent, the inviter's copy and the emailed one alike. Sending a new one
 * replaces the old invite and stops its links, which is what the team list's
 * "Send a new invite" does once one has run out.
 */

/**
 * Where the link goes in the stored email. Readable as it stands in the
 * inbox, and replaced in the copy that is sent.
 */
export const INVITE_LINK_PLACEHOLDER = "[your sign in link, added as this email is sent]";

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The outbox, acting as nobody, inside one company, to make one invite's link. */
function outboxActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "email-outbox" };
}

/**
 * A fresh link for an invite whose email is being sent right now, or null when
 * the invite has expired, been replaced, or its person signed in or was turned
 * off since. `app.issue_invite_email_token` decides, and refuses unless an
 * email sealed to this invite is in the middle of being sent, so this cannot
 * be used to make a link at any other moment.
 *
 * Its own transaction, after the outbox's claim has committed, because the
 * database checks the claim.
 */
export async function sealedLink(db: Database, organizationId: string, inviteId: string): Promise<string | null> {
  const base = publicBaseUrl();
  if (!base) return null;
  const token = randomBytes(32).toString("base64url");
  const ctx: ServiceContext = { actor: outboxActor(organizationId), db };
  const expires = await inTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ expires: Date | string | null }>(
      sql`select app.issue_invite_email_token(${inviteId}::uuid, ${hash(token)}) as expires`,
    );
    return row?.expires ?? null;
  });
  return expires ? `${base}/welcome?token=${encodeURIComponent(token)}` : null;
}

/** The words of an invite email. The link is the placeholder; the outbox fills it in. */
export function composeInviteEmail(input: {
  name: string; company: string; inviter: string | null; expiresOn: string;
}): { subject: string; text: string; html: string } {
  const by = input.inviter ? `${input.inviter} has added you` : "You have been added";
  const subject = `You are invited to join ${input.company}`;
  const text = [
    `Hi ${input.name},`,
    "",
    `${by} to ${input.company}'s team. Choose your password here to sign in:`,
    "",
    INVITE_LINK_PLACEHOLDER,
    "",
    `The link works once, until ${input.expiresOn}. If you were not expecting this, you can ignore it.`,
  ].join("\n");
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = [
    `<p>Hi ${escape(input.name)},</p>`,
    `<p>${escape(by)} to ${escape(input.company)}'s team. Choose your password here to sign in:</p>`,
    `<p><a href="${INVITE_LINK_PLACEHOLDER}">${INVITE_LINK_PLACEHOLDER}</a></p>`,
    `<p>The link works once, until ${escape(input.expiresOn)}. If you were not expecting this, you can ignore it.</p>`,
  ].join("\n");
  return { subject, text, html };
}

/** The stored email with the link put in, for the copy the provider receives. */
export function withLink(body: string | null, link: string): string | null {
  return body === null ? null : body.split(INVITE_LINK_PLACEHOLDER).join(link);
}

export interface InviteView {
  sentAt: string;
  expiresAt: string;
  expired: boolean;
  email: people.InviteEmail;
  /** The team list's sentence: emailed or not, and until when the link works. */
  sentence: string;
}

/** The day an invite runs out, as the company writes a date. */
export const expiresOn = (at: Date, timeZone: string): string =>
  at.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });

/**
 * The live invite of each of these people, if they have one: the newest one
 * not replaced, with whether its email went.
 */
export async function standings(
  tx: Database, membershipIds: string[], timeZone: string, now = new Date(),
): Promise<Map<string, InviteView>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await tx.select({
    invite: schema.membershipInvite,
    status: schema.message.status,
    error: schema.message.errorMessage,
  }).from(schema.membershipInvite)
    .leftJoin(schema.message, eq(schema.message.sealedInviteId, schema.membershipInvite.id))
    .where(and(
      inArray(schema.membershipInvite.membershipId, membershipIds),
      isNull(schema.membershipInvite.replacedAt),
    ))
    .orderBy(desc(schema.membershipInvite.createdAt));

  const out = new Map<string, InviteView>();
  for (const { invite, status, error } of rows) {
    if (out.has(invite.membershipId)) continue;
    const email: people.InviteEmail = status === null
      ? "not_sent"
      : ["sent", "delivered"].includes(status)
        ? "sent"
        : ["failed", "undelivered"].includes(status)
          ? "failed"
          : "queued";
    const note = email === "not_sent" ? invite.emailRefusal : email === "failed" ? error : null;
    const standing = people.inviteStanding({
      expiresAt: invite.expiresAt, now, email, emailNote: note, expiresOn: expiresOn(invite.expiresAt, timeZone),
    });
    out.set(invite.membershipId, {
      sentAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
      expired: standing.expired,
      email,
      sentence: standing.sentence,
    });
  }
  return out;
}
