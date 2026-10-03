import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can } from "@opentradesos/core";
import type { z } from "zod";
import {
  audit, guardedRead, guardedWrite, NotFoundError, SignInRefusedError, type RequestMeta,
  type ServiceContext,
} from "./context";
import { checkCredentials, defaultOrganization } from "./passwords";
import { resolveSession } from "./session";
import { hashToken } from "./apps";
import type { signInDevice, listDevices } from "../contracts/field";

/**
 * SIGNING A PHONE IN
 *
 * The technician's day already ran in a browser, signed in with a cookie. A
 * phone app has no cookie jar it can be trusted with, and the server it talks
 * to is whatever address the company typed in, so it signs in once with an
 * email and a password and is handed a token it presents on every request.
 *
 * The token is a SESSION, not a new kind of credential. That is the decision
 * everything else follows from: a session already resolves to exactly the
 * actor the person is today, already stops working the moment their
 * membership is deactivated, and is already ended by `revoke_sessions_for`
 * when an owner offboards somebody. A parallel token table would have needed
 * each of those built again, and the one that was forgotten would be the
 * fired technician still reading the customer list from the truck.
 *
 * What a phone adds is the device row it belongs to. `device.session_token_hash`
 * holds the hash of the token the phone registered with, so revoking the
 * device, from the phone when somebody signs out or from the office when a
 * phone is lost, ends the sign in as well as the sync.
 */

/**
 * The prefix a phone's token carries, so `authenticate` can tell it from a
 * connected app's `ots_` token without a lookup. Distinct on purpose: an app
 * token acts as the app, and this one acts as the person.
 */
export const DEVICE_TOKEN_PREFIX = "otd_";

/**
 * Ninety days, against thirty for a browser.
 *
 * A phone in a van signs in rarely and is expected to keep working through a
 * week without signal. A token that lapsed every month would sign somebody
 * out on a Monday in a basement with a day's work queued, which the queue
 * survives and the technician does not enjoy.
 */
export const DEVICE_SESSION_DAYS = 90;

const NOT_A_TECHNICIAN =
  "This account is not set up as a technician, so there is no day for the phone app to show. "
  + "Ask the office to add you as a technician.";

/**
 * Email and password in, a token out.
 *
 * Public, because there is nobody signed in yet. The password check, the
 * lockout and the choice of company are the same functions the sign in form
 * uses, so the phone is not a second way to guess passwords at a different
 * rate.
 */
export async function signIn(
  db: Database,
  input: z.infer<typeof signInDevice.input>,
  _meta?: RequestMeta,
): Promise<z.infer<typeof signInDevice.output>> {
  const checked = await checkCredentials(db, input.email, input.password);
  if (!checked.ok) throw new SignInRefusedError(checked.error);

  const organizationId = await defaultOrganization(db, checked.userId);
  if (!organizationId) throw new SignInRefusedError("This account is not a member of any company.");

  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + DEVICE_SESSION_DAYS * 864e5);

  // Through the SECURITY DEFINER door, the same one the sign in form uses.
  // The session table denies the application role.
  await db.execute(
    sql`select app.create_session(${checked.userId}::uuid, ${tokenHash}, ${organizationId}::uuid, ${expiresAt.toISOString()}::timestamptz)`,
  );

  /**
   * Resolved through the same function every request uses, so the actor
   * checked here is the actor the phone will be. A suspended company throws
   * from inside it, which is the refusal that should reach the phone.
   */
  const session = await resolveSession(db, tokenHash);

  /**
   * The technician record, not only the permission. An owner holds every
   * permission, including `field:sync`, and has no route; letting them in
   * would hand them a token for an app that then fails on its first request.
   * The token is ended rather than left to expire, because a credential
   * nobody will use is still a credential.
   */
  if (!session || !can(session.actor, "field:sync") || !session.actor.technicianId) {
    await db.execute(sql`select app.revoke_session(${tokenHash})`);
    throw new SignInRefusedError(session ? NOT_A_TECHNICIAN : "That account could not be signed in.");
  }

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    user: { id: session.userId, name: session.name, email: session.email },
    organization: {
      id: session.organizationId,
      name: session.organizationName,
      timezone: session.organizationTimezone,
    },
  };
}

/**
 * Point a device at the token it signed in with, and end the one it had.
 *
 * Called from `register`, inside its transaction. The previous token is
 * ended rather than left alone because a phone that signed in twice, a retry
 * after a dropped response or a second person on the same handset, should
 * have one working credential, not a pile of them that nothing lists.
 */
export async function bindToken(
  tx: Database,
  deviceId: string,
  previousHash: string | null,
  tokenHash: string,
): Promise<void> {
  if (previousHash && previousHash !== tokenHash) {
    await tx.execute(sql`select app.revoke_session(${previousHash})`);
  }
  if (previousHash !== tokenHash) {
    await tx.update(schema.device)
      .set({ sessionTokenHash: tokenHash, updatedAt: new Date() })
      .where(eq(schema.device.id, deviceId));
  }
}

/**
 * The phone signing itself out.
 *
 * Ends the token and forgets it, and leaves the device itself alone: the
 * sequence it reached is what lets the next sign in on this handset carry on
 * numbering rather than colliding with what it already sent.
 *
 * Only the person's own device. A technician signing somebody else's phone
 * out is the office's decision, which is `revoke`.
 */
export async function signOut(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "field:sync", async (tx) => {
    const device = await ownDevice(tx, ctx, input.id);

    await endTokens(tx, [device.sessionTokenHash, ctx.deviceTokenHash ?? null]);
    await tx.update(schema.device)
      .set({ sessionTokenHash: null, updatedAt: new Date() })
      .where(eq(schema.device.id, device.id));

    await audit(tx, ctx, "device.signed_out", "device", device.id, null, {});
    return { ok: true as const };
  });
}

/**
 * The office taking a phone away: lost, stolen, or handed back.
 *
 * Revokes the device, so it can no longer sync, and ends its sign in, so it
 * can no longer read anything either. `user:write` because it is the same
 * kind of decision as changing what somebody may do, and a dispatcher who can
 * move a visit should not be able to sign a technician out mid job.
 *
 * It does not stop the person signing in again: that is what deactivating
 * them is for, and it already ends every session they hold.
 */
export async function revoke(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [device] = await tx.select().from(schema.device)
      .where(and(
        eq(schema.device.organizationId, ctx.actor.organizationId),
        eq(schema.device.id, input.id),
      )).limit(1);
    if (!device) throw new NotFoundError("Device");

    // Already revoked is the state the caller asked for, so a retry is a no-op.
    const revokedAt = device.revokedAt ?? new Date();
    await endTokens(tx, [device.sessionTokenHash]);
    await tx.update(schema.device)
      .set({ revokedAt, sessionTokenHash: null, updatedAt: new Date() })
      .where(eq(schema.device.id, device.id));

    if (!device.revokedAt) {
      await audit(tx, ctx, "device.revoked", "device", device.id, null,
        { technicianId: device.technicianId, label: device.label });
    }
    return { ok: true as const, revokedAt: revokedAt.toISOString() };
  });
}

/** Every phone the company's technicians have signed in on. */
export async function list(
  ctx: ServiceContext,
  _input: z.infer<typeof listDevices.input>,
): Promise<z.infer<typeof listDevices.output>> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const rows = await tx.select({
      device: schema.device,
      technicianName: schema.technician.displayName,
    })
      .from(schema.device)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.device.technicianId))
      .where(eq(schema.device.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.device.lastSeenAt));

    return {
      devices: rows.map(({ device, technicianName }) => ({
        id: device.id,
        technicianId: device.technicianId,
        technicianName,
        label: device.label,
        platform: device.platform,
        appVersion: device.appVersion,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        lastSyncedAt: device.lastSyncedAt?.toISOString() ?? null,
        /** Whether a phone app token is live on it. A browser never has one. */
        signedIn: device.sessionTokenHash !== null && device.revokedAt === null,
        revokedAt: device.revokedAt?.toISOString() ?? null,
      })),
    };
  });
}

async function ownDevice(tx: Database, ctx: ServiceContext, id: string) {
  const [device] = await tx.select({
    id: schema.device.id,
    sessionTokenHash: schema.device.sessionTokenHash,
  })
    .from(schema.device)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.device.technicianId))
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.device.organizationId, ctx.actor.organizationId),
      eq(schema.device.id, id),
      eq(schema.membership.userId, ctx.actor.userId),
    )).limit(1);
  /**
   * Not found rather than forbidden for somebody else's phone, so the answer
   * does not confirm which device ids belong to colleagues.
   */
  if (!device) throw new NotFoundError("Device");
  return device;
}

async function endTokens(tx: Database, hashes: Array<string | null>): Promise<void> {
  for (const hash of new Set(hashes)) {
    if (hash) await tx.execute(sql`select app.revoke_session(${hash})`);
  }
}

