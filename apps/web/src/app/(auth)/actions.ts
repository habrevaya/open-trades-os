"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { hashPassword, verifyPassword, issueToken, SESSION_COOKIE, SESSION_TTL_DAYS, sessionCookieOptions } from "@/lib/session";
import { getDb } from "@/lib/db";

export type ActionState = { error?: string; fields?: Record<string, string> };

const SignUp = z.object({
  name: z.string().min(1, "Tell us your name").max(120),
  email: z.string().email("That does not look like an email address"),
  password: z.string().min(12, "Use at least 12 characters"),
  companyName: z.string().min(1, "Your company needs a name").max(200),
});

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "company";

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
  const { name, email, password, companyName } = parsed.data;
  const db = getDb();

  const existing = await db.select({ id: schema.user.id }).from(schema.user)
    .where(eq(schema.user.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    return { fields: { email: "An account with that email already exists" } };
  }

  const passwordHash = await hashPassword(password);
  let slug = slugify(companyName);

  /**
   * Everything below happens in one transaction. A half created company, with
   * a user who cannot reach it or an organization nobody belongs to, is a
   * support ticket that has to be resolved by hand in the database.
   */
  const result = await db.transaction(async (tx) => {
    const taken = await tx.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, slug)).limit(1);
    if (taken.length > 0) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const [org] = await tx.insert(schema.organization)
      .values({ name: companyName, slug, legalName: companyName })
      .returning({ id: schema.organization.id });

    const [created] = await tx.insert(schema.user)
      .values({ email: email.toLowerCase(), name })
      .returning({ id: schema.user.id });

    await tx.insert(schema.credential).values({ userId: created!.id, passwordHash });

    // The person who creates the company owns it. Anything less means the
    // first thing a new user hits is a permission error on their own data.
    await tx.insert(schema.membership)
      .values({ organizationId: org!.id, userId: created!.id, role: "owner" });

    const { token, tokenHash } = issueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
    // Through the SECURITY DEFINER door, same as resolution. The session table
    // denies direct access to the application role.
    await tx.execute(
      sql`select app.create_session(${created!.id}::uuid, ${tokenHash}, ${org!.id}::uuid, ${expiresAt.toISOString()}::timestamptz)`,
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

  if (!row || !ok) return { error: "That email and password do not match" };
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    return { error: "This account is temporarily locked. Try again shortly." };
  }

  const memberships = await db
    .select({ organizationId: schema.membership.organizationId })
    .from(schema.membership)
    .where(and(eq(schema.membership.userId, row.userId), eq(schema.membership.active, true)))
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
