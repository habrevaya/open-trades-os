import type { Database } from "@opentradesos/db";
import type { ServiceContext } from "../services/context";
import { resolveToken, touch } from "../services/apps";
import type { ResolvedSession } from "../services/session";

/**
 * WHO IS MAKING THIS REQUEST
 *
 * Two credentials reach the same routes: a session cookie held by a person,
 * and a bearer token held by a connected application. They produce the same
 * `Actor`, and everything downstream treats them identically, which is the
 * whole reason an app is not a parallel authorization system.
 *
 * It lives here rather than in the web app for the reason the session mapping
 * moved here: code that only the framework can reach is code no test reaches
 * either, and the last time that was true a technician signed in and saw an
 * empty job list.
 */

const BEARER = /^Bearer\s+(ots_[A-Za-z0-9_-]+)$/;

export interface AuthDeps {
  db: Database;
  /** Reads the cookie. The framework's job, injected rather than imported. */
  session: () => Promise<ResolvedSession | null>;
}

export interface Authenticated {
  ctx: ServiceContext;
  /** Set when an application authenticated rather than a person. */
  appId?: string;
}

/**
 * The bearer token is checked FIRST, and this order matters.
 *
 * A browser attaches cookies to every request whether or not the caller meant
 * to use them. If the cookie won, a partner's request that carried a token
 * would silently run as whichever user happened to be signed in, with their
 * permissions rather than the app's, and the audit trail would name a person
 * who did nothing. Preferring the explicit credential means the request acts
 * as what it says it is, or not at all.
 */
export async function authenticate(
  request: Request,
  deps: AuthDeps,
): Promise<Authenticated | null> {
  const header = request.headers.get("authorization");
  const bearer = header ? BEARER.exec(header) : null;

  if (bearer) {
    const app = await resolveToken(deps.db, bearer[1]!);
    /**
     * A presented-and-rejected token is a refusal, never a fallback to the
     * cookie. Falling through would turn a revoked app's request into one
     * made as the operator who happened to be signed in on the same machine.
     */
    if (!app) return null;

    // Best effort, and deliberately not awaited into the critical path:
    // "when did this app last read anything" is what an operator checks
    // before revoking something they no longer recognise.
    void touch(deps.db, app.tokenId);

    return {
      ctx: {
        actor: app.actor,
        db: deps.db,
        // So every audit entry this request causes names the app.
        agentId: app.actor.agentId!,
      },
      appId: app.appId,
    };
  }

  const user = await deps.session();
  if (!user) return null;
  return { ctx: { actor: user.actor, db: deps.db } };
}

/**
 * An app token on a PUBLIC route.
 *
 * Booking is open to anybody with the company's slug, so a partner's token is
 * not what admits them: it is what attributes the booking. Resolved
 * separately, and never a reason to refuse, because a partner whose token
 * expired should still be able to book rather than silently stop sending
 * work.
 */
export async function attributingApp(
  request: Request,
  db: Database,
): Promise<string | undefined> {
  const header = request.headers.get("authorization");
  const bearer = header ? BEARER.exec(header) : null;
  if (!bearer) return undefined;
  const app = await resolveToken(db, bearer[1]!);
  return app?.appId;
}
