import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { customerPortal } from "@opentradesos/core";
import { portalSignIn } from "@opentradesos/api/services";
import { getDb } from "@/lib/db";

/**
 * A CUSTOMER'S OWN SIGN IN, AS A COOKIE
 *
 * The token is a customer scope portal grant (see services/portal-sign-in.ts),
 * and on the web it lives in a cookie rather than in a URL, which is the
 * whole difference between it and an account link: it is not in the
 * browser's history, not in a `Referer`, and not in an email somebody can
 * forward.
 *
 * HttpOnly, so a script on the page cannot read it, and the pages behind it
 * never hand it to the browser in any other form: every action they offer
 * is bound to the company's slug and reads the cookie on the server. Scoped
 * to `/portal/{slug}`, so a customer of two companies on one deployment has
 * two sign ins that never see each other, and no other page on the site is
 * sent it.
 */
export const PORTAL_COOKIE = "ots_portal";

const path = (slug: string) => `/portal/${encodeURIComponent(slug)}`;

export async function setPortalToken(slug: string, token: string): Promise<void> {
  (await cookies()).set(PORTAL_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: path(slug),
    maxAge: customerPortal.SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearPortalToken(slug: string): Promise<void> {
  (await cookies()).set(PORTAL_COOKIE, "", { path: path(slug), maxAge: 0 });
}

export async function portalToken(): Promise<string | null> {
  return (await cookies()).get(PORTAL_COOKIE)?.value ?? null;
}

/**
 * The signed in customer for this company's pages, or nothing.
 *
 * A session for a different company than the slug in the address is
 * nothing too: the cookie path already keeps them apart, and this keeps
 * them apart again if a deployment ever serves two slugs under one path.
 */
export async function currentPortalSession(slug: string) {
  const token = await portalToken();
  if (!token) return null;
  const session = await portalSignIn.sessionFor(getDb(), token).catch(() => null);
  if (!session || session.organizationSlug !== slug) return null;
  return { ...session, token };
}

/** The signed in customer, or the sign in page. */
export async function requirePortalSession(slug: string) {
  const session = await currentPortalSession(slug);
  if (!session) redirect(path(slug));
  return session;
}

/** Where a request came from, for the counters and the record of who signed in from where. */
export async function requestMeta(): Promise<{ ip?: string | undefined; userAgent?: string | undefined }> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}
