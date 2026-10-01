import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, OrganizationSuspendedError, type ResolvedSession } from "@opentradesos/api/services";
import { getDb } from "./db";
import { SESSION_COOKIE, hashToken } from "./session";

/**
 * Resolving the current actor.
 *
 * Three things matter here and all three are easy to get subtly wrong:
 *
 * 1. The tenant comes from the SESSION, never from anything the client sends.
 *    A header or a query parameter naming an organization is an invitation to
 *    walk the tenant boundary.
 * 2. The session is looked up, not merely verified. That is what makes
 *    revocation immediate, which matters when the thing being revoked is a
 *    fired technician's access to the customer list.
 * 3. The result is an Actor, the same type an AI agent gets. There is no
 *    separate path with different rules.
 *
 * The mapping itself lives in @opentradesos/api rather than here, and that
 * move was not tidiness. While it lived in this file it was the only code
 * that built a real actor and no test could reach it, so every scope test
 * constructed its own by hand with `technicianId` filled in. The signed in
 * path produced one without, the `own` scope matched nothing, and a
 * technician saw an empty job list. Reading the cookie stays here, because
 * that genuinely is the framework's job.
 */
export type CurrentUser = ResolvedSession;

/**
 * The signed in user, or null, and null for a suspended company too.
 *
 * The callers of this one (a logo, a stored file) answer "not found" to
 * anybody without a user, which is the right answer for a suspended company
 * as well. Pages go through `requireUser`, which tells the person why.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    return await sessionFromCookie();
  } catch (error) {
    if (error instanceof OrganizationSuspendedError) return null;
    throw error;
  }
}

/**
 * The cookie half of authentication, on its own.
 *
 * Handed to `authenticate` in the API package, which decides between this and
 * a connected application's bearer token. Reading the cookie is genuinely the
 * framework's job; choosing between two credentials is not, and keeping that
 * choice here would put it where no test can reach it.
 */
export async function sessionFromCookie(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  /**
   * The shared pool, not a new one.
   *
   * `createClient` opens ten connections every time it is called, and this
   * runs on every authenticated request: the first version called it here
   * and Postgres started refusing with "sorry, too many clients already"
   * from pages that had nothing to do with connections. That is the exact
   * failure lib/db.ts exists to prevent, and it was reintroduced two lines
   * from the comment explaining it.
   */
  return resolveSession(getDb(), hashToken(token));
}

/** For a page that must not render to a signed out visitor. */
export async function requireUser(): Promise<CurrentUser> {
  let user: CurrentUser | null;
  try {
    user = await sessionFromCookie();
  } catch (error) {
    // Not the login page: they would sign in, succeed, and land back here.
    if (error instanceof OrganizationSuspendedError) redirect("/suspended");
    throw error;
  }
  if (!user) {
    const path = (await headers()).get("x-pathname") ?? "/";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return user;
}

/** For a page inside the app shell, which also requires setup to be finished. */
export async function requireSetupUser(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.setupCompleted) redirect("/setup");
  return user;
}
