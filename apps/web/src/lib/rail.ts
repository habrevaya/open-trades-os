import { cookies } from "next/headers";

/**
 * WHETHER THE RAIL IS COLLAPSED, AND WHY IT IS A COOKIE
 *
 * This application navigates with plain anchors and full document loads, so
 * component state would reset on every click: collapse the rail, open a job,
 * and it is wide again. `localStorage` would survive that and flash, because
 * the server renders the rail wide before any script has run, on every page,
 * forever.
 *
 * A cookie is read on the server before the first byte goes out, so the rail
 * renders in the state the person left it in and never moves afterwards.
 *
 * It is also the smallest thing that could hold this. A preference about how
 * wide a menu is does not belong in the database: it is per browser rather
 * than per person, it has no history worth keeping, and losing it costs one
 * click.
 */
export const RAIL_COOKIE = "ots_rail";

/** Expanded unless the cookie says otherwise, so a first visit shows labels. */
export async function railCollapsed(): Promise<boolean> {
  return (await cookies()).get(RAIL_COOKIE)?.value === "collapsed";
}

/**
 * A year, because it is a preference rather than a session.
 *
 * Not `httpOnly`: nothing here is a secret, and the day this needs to be
 * readable from a script is the day it should still work without one.
 */
export const RAIL_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax",
} as const;
