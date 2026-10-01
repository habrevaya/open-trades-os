"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { organizations, setupTokens } from "@opentradesos/api/services";
import { hashPassword, verifyPassword, issueToken, SESSION_COOKIE, SESSION_TTL_DAYS, sessionCookieOptions } from "@/lib/session";

/**
 * Five wrong passwords, then fifteen minutes.
 *
 * Low enough to make an online guessing attack pointless, high enough that a
 * person working through their password manager does not lock themselves out.
 * The window restarts on every further attempt, so somebody hammering the
 * form keeps extending their own lock rather than waiting it out.
 */
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
import { getDb } from "@/lib/db";

export type ActionState = { error?: string; fields?: Record<string, string> };

const SignUp = z.object({
  name: z.string().min(1, "Tell us your name").max(120),
  email: z.string().email("That does not look like an email address"),
  password: z.string().min(12, "Use at least 12 characters"),
  companyName: z.string().min(1, "Your company needs a name").max(200),
  /**
   * The browser's own zone, validated rather than trusted.
   *
   * It arrives from a hidden field, so it is a value a caller chooses, and an
   * unchecked one reaches `Intl.DateTimeFormat` on every booking page and
   * every agreement date. Optional because a client with scripting off sends
   * nothing, and a company in the default zone is the behaviour that already
   * existed rather than a regression.
   */
  timezone: z.string().max(64).optional(),
});

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = SignUp.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fields[key]) fields[key] = issue.message;
    }
    return { fields };
  }
  const { name, email, password, companyName, timezone } = parsed.data;
  const db = getDb();

  const existing = await db.select({ id: schema.user.id }).from(schema.user)
    .where(eq(schema.user.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    return { fields: { email: "An account with that email already exists" } };
  }

  const passwordHash = await hashPassword(password);

  /**
   * Everything below happens in one transaction. A half created company, with
   * a user who cannot reach it or an organization nobody belongs to, is a
   * support ticket that has to be resolved by hand in the database.
   *
   * The organization and its owner's membership are written by the same
   * function the operator API uses, so a company somebody created for you
   * and one you created yourself are the same kind of company. The password
   * and the session are this form's own business.
   */
  const result = await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const userId = await organizations.createUser(tx, { email, name });
    await tx.insert(schema.credential).values({ userId, passwordHash });

    const org = await organizations.createOrganization(tx, {
      name: companyName,
      timezone,
      ownerUserId: userId,
    });

    const { token, tokenHash } = issueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
    // Through the SECURITY DEFINER door, same as resolution. The session table
    // denies direct access to the application role.
    await tx.execute(
      sql`select app.create_session(${userId}::uuid, ${tokenHash}, ${org.organizationId}::uuid, ${expiresAt.toISOString()}::timestamptz)`,
    );

    return { token };
  });

  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions);
  redirect("/setup");
}

const SignIn = z.object({
  email: z.string().email("That does not look like an email address"),
  password: z.string().min(1, "Enter your password"),
});

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = SignIn.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter your email and password" };

  const { email, password } = parsed.data;
  const db = getDb();

  /**
   * The hash is fetched through app.credential_for_login, not selected. The
   * credential table denies the application role entirely, so a password hash
   * is only ever reachable through a path that can be logged and rate limited.
   */
  const rows = await db.execute<{ user_id: string; password_hash: string; locked_until: Date | null }>(
    sql`select * from app.credential_for_login(${email})`,
  );
  const found = rows[0];
  const row = found
    ? { userId: found.user_id, passwordHash: found.password_hash, lockedUntil: found.locked_until }
    : undefined;

  /**
   * One message for an unknown email and for a wrong password, and the hash
   * comparison runs either way. Distinguishing them turns the login form into
   * an endpoint for enumerating which of your customers use this product.
   */
  const ok = row
    ? await verifyPassword(password, row.passwordHash)
    : await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");

  if (!row || !ok) {
    /**
     * THE LOCKOUT IS NOW RECORDED, AND IT WAS NOT.
     *
     * `failed_attempts` and `locked_until` were columns nothing ever wrote.
     * `credential_for_login` returned `locked_until` specifically so the
     * branch below could refuse on it, and it was always null, so the branch
     * was dead and the message asserted a control that did not exist. There
     * was no brute force protection on this form at all, and the code read as
     * though there were, which is the most expensive way to be wrong about a
     * security property: a reviewer ticks it off.
     *
     * Counted for an unknown email too, harmlessly: the function matches on
     * the address and updates nothing when there is no such user, so it adds
     * no behavioural difference between a real address and a made up one.
     */
    await db.execute(
      sql`select app.record_failed_login(${email}, ${MAX_ATTEMPTS}, ${LOCK_MINUTES})`,
    );
    return { error: "That email and password do not match" };
  }

  /**
   * Checked AFTER the password, deliberately, and the order is the privacy
   * property rather than an oversight.
   *
   * Somebody guessing passwords gets the same generic message whether or not
   * the account is locked, so the form never becomes an oracle for which
   * addresses exist or which are under attack. Only a caller who has proved
   * they know the password is told why they are still refused, which is the
   * person who needs to know.
   */
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    return { error: "This account is temporarily locked. Try again shortly." };
  }

  // Correct password, not locked. A person who mistyped twice and then got it
  // right must not carry those attempts toward a lock next week.
  await db.execute(sql`select app.clear_failed_logins(${row.userId}::uuid)`);

  /**
   * A company that is not suspended first, when there is one.
   *
   * Somebody who belongs to two companies, one of which has been suspended,
   * would otherwise be signed into whichever row the database returned first
   * and told their account is suspended when the other one is fine. When
   * every company they belong to is suspended they still get a session, and
   * the app shows them the suspension rather than a wrong password.
   */
  const memberships = await db
    .select({ organizationId: schema.membership.organizationId })
    .from(schema.membership)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.membership.organizationId))
    .where(and(eq(schema.membership.userId, row.userId), eq(schema.membership.active, true)))
    .orderBy(sql`${schema.organization.suspendedAt} is not null`)
    .limit(1);

  if (memberships.length === 0) return { error: "This account is not a member of any company" };

  const { token, tokenHash } = issueToken();
  await db.execute(
    sql`select app.create_session(${row.userId}::uuid, ${tokenHash}, ${memberships[0]!.organizationId}::uuid, ${new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString()}::timestamptz)`,
  );

  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
  redirect("/");
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const { hashToken } = await import("@/lib/session");
    const db = getDb();
    // Revoke rather than delete, so the audit trail keeps the session.
    await db.execute(sql`select app.revoke_session(${hashToken(token)})`);
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

const Welcome = z.object({
  token: z.string().min(1),
  password: z.string().min(12, "Use at least 12 characters"),
});

/**
 * Choosing a first password from a link the operator API issued.
 *
 * The link is spent and the password stored in one SQL function, so two tabs
 * submitting together cannot both set one, and a link for somebody who
 * already has a password stores nothing. Then the same session sign in
 * creates, in the same company sign in would choose.
 */
export async function completeWelcome(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = Welcome.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fields[key]) fields[key] = issue.message;
    }
    return fields["token"] ? { error: "This link is no longer valid." } : { fields };
  }

  const db = getDb();
  const passwordHash = await hashPassword(parsed.data.password);
  const userId = await setupTokens.consume(db, parsed.data.token, passwordHash);
  if (!userId) {
    return { error: "This link is no longer valid. Ask whoever set up your account for a new one." };
  }

  const memberships = await db
    .select({ organizationId: schema.membership.organizationId })
    .from(schema.membership)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.membership.organizationId))
    .where(and(eq(schema.membership.userId, userId), eq(schema.membership.active, true)))
    .orderBy(sql`${schema.organization.suspendedAt} is not null`)
    .limit(1);

  // The password is set either way, so the honest next step is the sign in
  // page rather than an error that implies nothing happened.
  if (memberships.length === 0) redirect("/login");

  const { token, tokenHash } = issueToken();
  await db.execute(
    sql`select app.create_session(${userId}::uuid, ${tokenHash}, ${memberships[0]!.organizationId}::uuid, ${new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString()}::timestamptz)`,
  );

  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
  redirect("/");
}
