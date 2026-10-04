import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * WHO SIGNS IN TO A CUSTOMER'S ACCOUNT, SEEN FROM THE OFFICE
 *
 * Every code asked for and every sign in has been kept in `portal_sign_in`
 * since signing in existed, with what became of the message and from where
 * somebody asked. Nothing read it back, so the honest answer to "the code
 * never came" was a database client, and the office had no way to end a
 * customer's sign in short of waiting out its week.
 *
 * Three things here. The attempts, newest first, for the company or for one
 * customer: an attempt belongs to a customer when it signed in as them or
 * when the address was on their record at the time it was asked for, which
 * is what makes a failed try visible on the customer it was aimed at. The
 * sign ins themselves, each a customer scope grant opened by a code. And the
 * two levers: ending a sign in, and letting a contact on the customer sign
 * in as them.
 *
 * READING NEEDS `portal:read`, which the office has and a technician does
 * not: the addresses somebody signs in from and the tries that failed are
 * not a technician's business. ENDING ONE NEEDS `portal:revoke`, the
 * permission that already withdraws a link, because ending a sign in is the
 * same act on a grant held in a cookie.
 */

export type AttemptOutcome =
  | "signed_in" | "waiting" | "wrong_code" | "too_many_attempts" | "replaced" | "expired" | "no_account";

export interface SignInAttempt {
  id: string;
  at: string;
  channel: "email" | "sms";
  /** The email or mobile number it was asked for, as it is compared. */
  address: string;
  outcome: AttemptOutcome;
  /** Wrong codes typed against it. */
  wrongCodes: number;
  /** What became of the message: `queued`, or why it could not go. */
  delivery: string | null;
  requestedIp: string | null;
  signedInIp: string | null;
  /** Who it signed in as, or the customers the address was on when it was asked for. */
  customers: { id: string; name: string }[];
  /** The contact it signed in as the customer through, when it was one. */
  contactName: string | null;
}

/**
 * What became of one attempt, in one word the screen turns into a sentence.
 *
 * A code that has not ended is waiting until its ten minutes are up and then
 * expired; a wrong code counted against one that later signed in is still a
 * sign in, with its wrong codes beside it.
 */
function outcomeOf(row: typeof schema.portalSignIn.$inferSelect, now: Date): AttemptOutcome {
  switch (row.endedReason) {
    case "signed_in": return "signed_in";
    case "too_many_attempts": return "too_many_attempts";
    case "superseded": return "replaced";
    case "no_customer": return "no_account";
    default:
      if (row.expiresAt <= now) return row.attempts > 0 ? "wrong_code" : "expired";
      return row.attempts > 0 ? "wrong_code" : "waiting";
  }
}

export async function attempts(
  ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined },
): Promise<{ attempts: SignInAttempt[] }> {
  return guardedRead(ctx, "portal:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await tx.select().from(schema.portalSignIn)
      .where(input.customerId
        ? or(
          eq(schema.portalSignIn.customerId, input.customerId),
          sql`${input.customerId}::uuid = any(${schema.portalSignIn.matchedCustomerIds})`,
        )
        /**
         * The company wide list leaves out addresses nobody has. Those are
         * strangers typing numbers into a public page, and a list full of
         * them buries the customer who is ringing about a code.
         */
        : sql`cardinality(${schema.portalSignIn.matchedCustomerIds}) > 0`)
      .orderBy(desc(schema.portalSignIn.createdAt))
      .limit(limit);

    const customerIds = [...new Set(rows.flatMap((r) => [
      ...(r.customerId ? [r.customerId] : []), ...r.matchedCustomerIds,
    ]))];
    const names = customerIds.length > 0
      ? await tx.select({ id: schema.customer.id, name: schema.customer.name })
        .from(schema.customer).where(inArray(schema.customer.id, customerIds))
      : [];
    const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => id !== null))];
    const contacts = contactIds.length > 0
      ? await tx.select({ id: schema.contact.id, name: schema.contact.name })
        .from(schema.contact).where(inArray(schema.contact.id, contactIds))
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const now = new Date();

    return {
      attempts: rows.map((row) => {
        const ids = row.customerId ? [row.customerId] : row.matchedCustomerIds;
        return {
          id: row.id,
          at: row.createdAt.toISOString(),
          channel: row.channel,
          address: row.address,
          outcome: outcomeOf(row, now),
          wrongCodes: row.attempts,
          delivery: row.delivery,
          requestedIp: row.requestedIp,
          signedInIp: row.signedInIp,
          customers: ids.filter((id) => nameOf.has(id)).map((id) => ({ id, name: nameOf.get(id)! })),
          contactName: contacts.find((c) => c.id === row.contactId)?.name ?? null,
        };
      }),
    };
  });
}

export interface PortalSessionRow {
  id: string;
  startedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  /** Still open: not ended, not expired. */
  active: boolean;
  endedAt: string | null;
  /** `signed_out`, `office`, `access_removed`, or null while it is open or after it simply ran out. */
  endedReason: string | null;
  channel: "email" | "sms" | null;
  address: string | null;
  contactName: string | null;
}

/** One customer's sign ins, newest first: the open ones and the recent ended ones. */
export async function sessions(
  ctx: ServiceContext, input: { customerId: string },
): Promise<{ sessions: PortalSessionRow[] }> {
  return guardedRead(ctx, "portal:read", async (tx) => {
    const rows = await tx.select({
      grant: schema.portalGrant,
      channel: schema.portalSignIn.channel,
      address: schema.portalSignIn.address,
      contactName: schema.contact.name,
    })
      .from(schema.portalGrant)
      .innerJoin(schema.portalSignIn, eq(schema.portalSignIn.id, schema.portalGrant.signInId))
      .leftJoin(schema.contact, eq(schema.contact.id, schema.portalGrant.contactId))
      .where(and(
        eq(schema.portalGrant.customerId, input.customerId),
        eq(schema.portalGrant.scope, "customer"),
        isNotNull(schema.portalGrant.signInId),
      ))
      .orderBy(desc(schema.portalGrant.createdAt))
      .limit(20);
    const now = new Date();
    return {
      sessions: rows.map(({ grant, channel, address, contactName }) => ({
        id: grant.id,
        startedAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: grant.lastUsedIp,
        active: grant.revokedAt === null && grant.expiresAt > now,
        endedAt: grant.revokedAt?.toISOString() ?? null,
        endedReason: grant.revokedReason,
        channel,
        address,
        contactName,
      })),
    };
  });
}

/**
 * End a customer's sign in, or every one they have open.
 *
 * Ended everywhere at once, the way the customer's own sign out ends it: the
 * next page they open asks for a code. A link the office sent them is a
 * different thing and is left alone, because "sign them out" and "kill the
 * invoice link I emailed this morning" are different requests.
 */
export async function endSessions(
  ctx: ServiceContext, input: { customerId: string; sessionId?: string | undefined },
): Promise<{ ended: number }> {
  return guardedWrite(ctx, "portal:revoke", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(eq(schema.customer.id, input.customerId)).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const now = new Date();
    const ended = await tx.update(schema.portalGrant)
      .set({ revokedAt: now, revokedReason: "office", updatedAt: now })
      .where(and(
        eq(schema.portalGrant.customerId, input.customerId),
        eq(schema.portalGrant.scope, "customer"),
        isNotNull(schema.portalGrant.signInId),
        isNull(schema.portalGrant.revokedAt),
        gt(schema.portalGrant.expiresAt, now),
        input.sessionId ? eq(schema.portalGrant.id, input.sessionId) : undefined,
      ))
      .returning({ id: schema.portalGrant.id });
    /** Ending one that has already ended is the state that was asked for, not an error. */
    if (ended.length > 0) {
      await audit(tx, ctx, "portal.sign_in_ended", "customer", input.customerId, null, {
        sessions: ended.map((row) => row.id),
      });
    }
    return { ended: ended.length };
  });
}

/**
 * Let a contact on a customer sign in as that customer, or stop them.
 *
 * Needs `customer:write` because it changes the contact, and `portal:revoke`
 * because it decides who may hold a sign in to somebody's account: a
 * technician can edit a contact's phone number and must not be able to give
 * that number the customer's bills. Taking it away ends every sign in the
 * contact has open, at once.
 *
 * Only a contact on a customer, with an address a code can go to. A contact
 * on a property alone belongs to no account to sign in to.
 */
export async function setContactAccess(
  ctx: ServiceContext, input: { id: string; allowed: boolean },
): Promise<{ id: string; portalAccess: boolean; endedSessions: number }> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    assertCan(ctx.actor, "portal:revoke");
    const [before] = await tx.select().from(schema.contact)
      .where(and(eq(schema.contact.id, input.id), isNull(schema.contact.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Contact");
    if (input.allowed) {
      if (!before.customerId) {
        throw new ConflictError("This contact is on an address, not a customer, so there is no account for them to sign in to.");
      }
      if (!before.email?.trim() && !before.phone?.trim()) {
        throw new ConflictError("Add an email address or a mobile number to this contact first: that is where their sign in code goes.");
      }
    }
    const now = new Date();
    const portalAccessAt = input.allowed ? (before.portalAccessAt ?? now) : null;
    if ((before.portalAccessAt !== null) !== input.allowed) {
      await tx.update(schema.contact).set({ portalAccessAt, updatedAt: now })
        .where(eq(schema.contact.id, before.id));
      await audit(tx, ctx, input.allowed ? "contact.portal_access_given" : "contact.portal_access_removed",
        "contact", before.id, { portalAccessAt: before.portalAccessAt }, { portalAccessAt });
    }
    let endedSessions = 0;
    if (!input.allowed) {
      const ended = await tx.update(schema.portalGrant)
        .set({ revokedAt: now, revokedReason: "access_removed", updatedAt: now })
        .where(and(eq(schema.portalGrant.contactId, before.id), isNull(schema.portalGrant.revokedAt)))
        .returning({ id: schema.portalGrant.id });
      endedSessions = ended.length;
    }
    return { id: before.id, portalAccess: input.allowed, endedSessions };
  });
}

export const handlers = {
  listPortalSignIns: (ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined }) =>
    attempts(ctx, input),
  listCustomerPortalSessions: (ctx: ServiceContext, input: { id: string }) =>
    sessions(ctx, { customerId: input.id }),
  endCustomerPortalSessions: (ctx: ServiceContext, input: { id: string; sessionId?: string | undefined }) =>
    endSessions(ctx, { customerId: input.id, sessionId: input.sessionId }),
  setContactPortalAccess: (ctx: ServiceContext, input: { id: string; allowed: boolean }) =>
    setContactAccess(ctx, input),
} as const;
