import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, can, comms, field, type Actor } from "@opentradesos/core";
import type { z } from "zod";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, SignInRefusedError,
  type RequestMeta, type ServiceContext,
} from "./context";
import { checkCredentials, defaultOrganization } from "./passwords";
import { resolveSession } from "./session";
import { hashToken } from "./apps";
import { throttle } from "./website-tracking";
import { providerFor as smsProviderFor } from "./comms-outbox";
import { senderFor as smsSenderFor } from "./phone-numbers";
import * as email from "./email";
/**
 * The carrier and mail adapters, registered by importing them, because a code
 * is sent from the request rather than from the worker and the web process
 * would otherwise know no provider by name.
 */
import "../comms";
import "../email";
import type {
  signInDevice, listDevices, requestSignInCode, signInWithCode, setTechnicianMobile, listFieldPeople,
} from "../contracts/field";
import { readerFor } from "../secrets/store";

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
  return issueDeviceToken(db, checked.userId);
}

/**
 * A device token for somebody who has proved who they are, by a password or
 * by a code. One function for both, so the two doors cannot come to disagree
 * about who is let through them: a code that worked for an owner with no
 * route would be the same mistake as a password that did.
 */
async function issueDeviceToken(db: Database, userId: string): Promise<z.infer<typeof signInDevice.output>> {
  const organizationId = await defaultOrganization(db, userId);
  if (!organizationId) throw new SignInRefusedError("This account is not a member of any company.");

  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + DEVICE_SESSION_DAYS * 864e5);

  // Through the SECURITY DEFINER door, the same one the sign in form uses.
  // The session table denies the application role.
  await db.execute(
    sql`select app.create_session(${userId}::uuid, ${tokenHash}, ${organizationId}::uuid, ${expiresAt.toISOString()}::timestamptz)`,
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

/* --------------------------------------------------------- with a code */

/**
 * Where a code goes. The default sends it straight to the carrier or the mail
 * provider; a test passes one that writes it down.
 *
 * STRAIGHT TO THE PROVIDER, NOT THROUGH THE OUTBOX, and that is the point of
 * this seam. The outbox keeps every message's body in the `message` table,
 * where the office reads its conversations, and a sign in code sitting in the
 * inbox would be a sign in anybody in the office could use. So the code
 * exists in exactly two places: the text or email the person receives, and
 * the hash in `sign_in_code`.
 */
export type CodeSender = (db: Database, input: {
  organizationId: string;
  channel: "sms" | "email";
  to: string;
  subject: string;
  body: string;
  /** The code's own row, so a provider callback could be matched. Never the code. */
  reference: string;
}) => Promise<{ sent: boolean; reason: string | null }>;

/** What a code request acts as inside the company, to find who to send it to. */
function codeActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["message:read"], agentId: "sign-in-code" };
}

export const sendCodeDirect: CodeSender = async (db, input) => {
  const ctx: ServiceContext = { actor: codeActor(input.organizationId), db };

  if (input.channel === "sms") {
    const route = await inTenant(ctx, async (tx) => {
      const from = await smsSenderFor(tx, input.organizationId, { smsRequired: true });
      if (!from) return null;
      // The company's own carrier secret, read the way the worker reads it.
      const provider = await smsProviderFor(tx, input.organizationId, readerFor(tx, input.organizationId))
        .catch(() => null);
      return provider ? { provider, from: from.e164 } : null;
    });
    if (!route) return { sent: false, reason: "This company has no number connected that can send texts." };
    const result = await route.provider.send({
      to: comms.phoneAddress(input.to), from: route.from, body: input.body, media: [], reference: input.reference,
    });
    return result.ok ? { sent: true, reason: null } : { sent: false, reason: result.message };
  }

  const provider = await email.providerFor(db, input.organizationId).catch(() => null);
  const sender = provider ? await inTenant(ctx, (tx) => email.senderFor(tx, input.organizationId)) : null;
  if (!provider || !sender) return { sent: false, reason: "This company has no email provider connected." };
  const result = await provider.send({
    to: input.to,
    from: sender.fromName ? `${sender.fromName} <${sender.fromAddress}>` : sender.fromAddress,
    subject: input.subject,
    text: input.body,
    reference: input.reference,
  });
  return result.ok ? { sent: true, reason: null } : { sent: false, reason: result.message };
};

/** The hash a code is kept as: of the address and the code together, so equal codes for two people differ. */
const codeHash = (emailAddress: string, code: string): string =>
  createHash("sha256").update(`${emailAddress.trim().toLowerCase()}:${code}`).digest("hex");

const CODE_ON_ITS_WAY = {
  sms: "If that email belongs to a technician with a mobile number on file, a code is on its way by text. "
    + `It works for ${field.CODE_TTL_MINUTES} minutes.`,
  email: "If that email belongs to a technician, a code is on its way to it. "
    + `It works for ${field.CODE_TTL_MINUTES} minutes.`,
} as const;

/**
 * Send a code, and answer the same sentence whatever happened.
 *
 * Every branch below that does not send still answers "if that address
 * belongs to somebody, a code is on its way", and that is deliberate: an
 * answer that differed for an unknown address, a person who is not a
 * technician, or a technician with no number on file would make this form a
 * way to find out who works where. What actually happened is in the audit
 * log of the company the person belongs to, where the office can see why a
 * technician never got their code.
 */
export async function requestCode(
  db: Database,
  input: z.infer<typeof requestSignInCode.input>,
  meta?: RequestMeta,
  deps: { send?: CodeSender; now?: () => Date } = {},
): Promise<z.infer<typeof requestSignInCode.output>> {
  const send = deps.send ?? sendCodeDirect;
  const now = deps.now?.() ?? new Date();
  const answer = { ok: true as const, message: CODE_ON_ITS_WAY[input.channel] };
  const address = input.email.trim().toLowerCase();

  if (meta?.ip) await throttle(db, `field-code:${meta.ip}`, field.CODE_REQUESTS_PER_ADDRESS_PER_MINUTE);

  const code = field.newCode(randomInt);
  const expiresAt = new Date(now.getTime() + field.CODE_TTL_MINUTES * 60_000);
  const [issued] = await db.execute<{ user_id: string; email: string; name: string | null; issued: boolean }>(sql`
    select * from app.issue_sign_in_code(
      ${address}, ${codeHash(address, code)}, ${input.channel}, ${expiresAt.toISOString()}::timestamptz,
      ${field.CODES_PER_WINDOW}, ${field.CODE_WINDOW_MINUTES}
    )`);
  if (!issued) return answer;

  const organizationId = await defaultOrganization(db, issued.user_id);
  if (!organizationId) return answer;

  const ctx: ServiceContext = { actor: codeActor(organizationId), db };
  const found = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select({
      technicianId: schema.technician.id,
      mobilePhone: schema.technician.mobilePhone,
      company: schema.organization.name,
    }).from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .innerJoin(schema.organization, eq(schema.organization.id, schema.technician.organizationId))
      .where(and(
        eq(schema.membership.userId, issued.user_id),
        eq(schema.membership.active, true),
        eq(schema.technician.active, true),
      )).limit(1);
    return row ?? null;
  });

  const record = async (action: string, detail: Record<string, unknown>) =>
    inTenant(ctx, (tx) => audit(tx, ctx, action, "user", issued.user_id, null, { channel: input.channel, ...detail }));

  if (!found) return answer;
  if (!issued.issued) {
    await record("device.code_refused", { reason: "Asked for too many codes in a short time." });
    return answer;
  }

  const to = input.channel === "sms" ? found.mobilePhone : issued.email;
  if (!to) {
    await record("device.code_not_sent", { reason: "No mobile number is recorded for this technician." });
    return answer;
  }

  const sent = await send(db, {
    organizationId,
    channel: input.channel,
    to,
    subject: `Your ${found.company} sign in code`,
    body: field.codeMessage(found.company, code),
    reference: issued.user_id,
  }).catch((error: unknown) => ({ sent: false, reason: error instanceof Error ? error.message : String(error) }));

  await record(sent.sent ? "device.code_sent" : "device.code_not_sent", sent.sent ? {} : { reason: sent.reason });
  return answer;
}

/**
 * A code in, a device token out.
 *
 * One refusal for every way a code can be wrong. Telling "expired" from
 * "never sent" from "wrong" would tell somebody guessing which of their
 * guesses were close to a live code, and the person who typed it wrongly
 * needs to do the same thing in every case: ask for another.
 */
export async function signInWithCodeFor(
  db: Database,
  input: z.infer<typeof signInWithCode.input>,
  meta?: RequestMeta,
): Promise<z.infer<typeof signInWithCode.output>> {
  if (meta?.ip) await throttle(db, `field-code-try:${meta.ip}`, field.CODE_TRIES_PER_ADDRESS_PER_MINUTE);

  const code = field.normalizeCode(input.code);
  /** A typo is not a guess, so it is not counted against the code. */
  if (!code) throw new SignInRefusedError(`Enter the ${field.CODE_LENGTH} digit code from the text or email.`);

  const address = input.email.trim().toLowerCase();
  const [row] = await db.execute<{ user_id: string | null }>(sql`
    select app.consume_sign_in_code(${address}, ${codeHash(address, code)}, ${field.CODE_MAX_ATTEMPTS}) as user_id
  `);
  if (!row?.user_id) {
    throw new SignInRefusedError("That code is not right, or it has expired. Ask for a new one.");
  }
  return issueDeviceToken(db, row.user_id);
}

/* -------------------------------------------------------------- office */

/** The number a code is texted to. The office's to set, `user:write`, like the rest of who somebody is. */
export async function setMobile(
  ctx: ServiceContext,
  input: z.infer<typeof setTechnicianMobile.input>,
): Promise<z.infer<typeof setTechnicianMobile.output>> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const [before] = await tx.select({ id: schema.technician.id, mobilePhone: schema.technician.mobilePhone })
      .from(schema.technician)
      .where(and(eq(schema.technician.organizationId, ctx.actor.organizationId), eq(schema.technician.id, input.id)))
      .limit(1);
    if (!before) throw new NotFoundError("Technician");

    let mobilePhone: string | null = null;
    if (input.mobilePhone !== null) {
      /**
       * Kept in the form a carrier takes, and refused when it cannot be one,
       * so the day somebody asks for a code is not the day the office finds
       * out the number was typed with a letter in it.
       */
      mobilePhone = comms.phoneAddress(input.mobilePhone);
      if (!/^\+\d{8,15}$/.test(mobilePhone)) {
        throw new ConflictError("That does not look like a mobile number. Include the area code.");
      }
    }

    await tx.update(schema.technician).set({ mobilePhone, updatedAt: new Date() })
      .where(eq(schema.technician.id, before.id));
    if (before.mobilePhone !== mobilePhone) {
      await audit(tx, ctx, "technician.mobile_set", "technician", before.id,
        { mobilePhone: before.mobilePhone }, { mobilePhone });
    }
    return { id: before.id, mobilePhone };
  });
}

/**
 * Every technician, the number their code goes to, and each phone they have
 * signed in on. What `/settings/phones` shows, and what somebody reads before
 * taking a lost phone away.
 */
export async function people(
  ctx: ServiceContext,
  _input: z.infer<typeof listFieldPeople.input>,
): Promise<z.infer<typeof listFieldPeople.output>> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const technicians = await tx.select({
      id: schema.technician.id,
      name: schema.technician.displayName,
      active: schema.technician.active,
      mobilePhone: schema.technician.mobilePhone,
    }).from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.technician.active), asc(schema.technician.displayName));

    const devices = technicians.length === 0 ? [] : await tx.select().from(schema.device)
      .where(inArray(schema.device.technicianId, technicians.map((t) => t.id)))
      .orderBy(sql`${schema.device.lastSeenAt} desc nulls last`);

    return {
      technicians: technicians.map((t) => ({
        ...t,
        devices: devices.filter((d) => d.technicianId === t.id).map((d) => ({
          ...deviceView(d, t.name),
          notifications: d.pushToken !== null && d.revokedAt === null,
        })),
      })),
    };
  });
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
    /**
     * The push token goes with the sign in. A phone nobody is signed in on
     * is not told about anybody's day, and a second technician signing in on
     * the same handset registers it again as theirs.
     */
    await tx.update(schema.device)
      .set({ sessionTokenHash: null, pushToken: null, updatedAt: new Date() })
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
    /** And no more notices about somebody's day to a phone in a stranger's pocket. */
    await tx.update(schema.device)
      .set({ revokedAt, sessionTokenHash: null, pushToken: null, updatedAt: new Date() })
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
      devices: rows.map(({ device, technicianName }) => deviceView(device, technicianName)),
    };
  });
}

/** One phone as the office reads it. */
function deviceView(device: typeof schema.device.$inferSelect, technicianName: string) {
  return {
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
  };
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

