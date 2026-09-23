import { NextResponse, type NextRequest } from "next/server";

/**
 * THE PATH A SERVER COMPONENT CANNOT ASK FOR
 *
 * A server component knows nothing about the URL it is rendering unless it is
 * a page with params. Two things need it: the navigation, to mark where you
 * are, and `requireUser`, which sends a signed out visitor to the login page
 * with a `next` parameter so they come back to the screen they asked for.
 *
 * That second one was already written and reading a header nobody set, so it
 * always sent people to `/`. Somebody opening a link to an invoice, signing
 * in, and landing on the dashboard is a small thing that happens every day.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  /**
   * Everything except the things that are not pages. Running this on every
   * static asset costs a function invocation each, which on a self hosted
   * instance is somebody's CPU.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
