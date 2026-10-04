"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { organizations, setupTokens, passwords, workflows } from "@opentradesos/api/services";
import { hashPassword, issueToken, SESSION_COOKIE, SESSION_TTL_DAYS, sessionCookieOptions } from "@/lib/session";
import { getDb } from "@/lib/db";
import { keptValues } from "@/lib/kept-values";

/** What the sign up form keeps when it is refused. Never the password. */
const SIGNUP_KEPT = ["name", "companyName", "email"] as const;

export type ActionState = { error?: string; fields?: Record<string, string>; values?: Record<string, string> };

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
    return { fields, values: keptValues(formData, SIGNUP_KEPT) };
  }
  const { name, email, password, companyName, timezone } = parsed.data;
  const db = getDb();

  const existing = await db.select({ id: schema.user.id }).from(schema.user)
    .where(eq(schema.user.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    return {
      fields: { email: "An account with that email already exists" },
      values: keptValues(formData, SIGNUP_KEPT),
    };
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

    /**
     * The recommended automations a new company starts with switched on (the
     * follow up on an unanswered estimate), installed by the owner exactly as
     * pressing "Turn on" would. The operator API does the same.
     */
    await workflows.installStarters({
      actor: { userId, organizationId: org.organizationId, roles: ["owner"] },
      db: tx,
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
  if (!parsed.success) return { error: "Enter your email and password", values: keptValues(formData, ["email"]) };

  const { email, password } = parsed.data;
  const db = getDb();

  /**
   * The password, the lockout and the choice of company are the API
   * package's, because the phone app signs in through the API and two copies
   * of "five wrong passwords, then fifteen minutes" would disagree the first
   * time one of them changed. The reasoning about each of them is there.
   */
  const checked = await passwords.checkCredentials(db, email, password);
  if (!checked.ok) return { error: checked.error, values: { email } };

  const organizationId = await passwords.defaultOrganization(db, checked.userId);
  if (!organizationId) return { error: "This account is not a member of any company", values: { email } };

  const { token, tokenHash } = issueToken();
  await db.execute(
    sql`select app.create_session(${checked.userId}::uuid, ${tokenHash}, ${organizationId}::uuid, ${new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString()}::timestamptz)`,
  );

  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
  redirect(safeNext(formData.get("next")) ?? "/");
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
    // The one field on this form is the password, which is never handed back.
    return fields["token"] ? { error: "This link is no longer valid.", values: {} } : { fields };
  }

  const db = getDb();
  const passwordHash = await hashPassword(parsed.data.password);
  const userId = await setupTokens.consume(db, parsed.data.token, passwordHash);
  if (!userId) {
    return { error: "This link is no longer valid. Ask whoever set up your account for a new one.", values: {} };
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
