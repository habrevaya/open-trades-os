import { tracking } from "@opentradesos/core";

/**
 * THE WEBSITE SNIPPET
 *
 * What a company pastes into its own site:
 *
 *   <script src="https://your-installation/t.js?c=your-company" async></script>
 *
 * The same bytes for every visitor and every page, so it is cached for an
 * hour by the browser and by anything in between. Nothing per visitor is in
 * it: the visitor id lives in a first party cookie on the company's own
 * domain, and the number to show comes from `GET /v1/public/dni`. The
 * company key is only a name; an unknown one produces a script whose calls
 * are refused, which is the same thing a typo in it should produce.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const key = (url.searchParams.get("c") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(key)) {
    return new Response("/* No company key: add ?c= and your company's key from Settings, Website. */", {
      status: 400, headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }
  const base = (process.env["PUBLIC_URL"] || url.origin).replace(/\/$/, "");
  return new Response(tracking.snippetSource({ apiBase: `${base}/api`, appBase: base, companyKey: key }), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      /** A script tag on another site is the point of this file. */
      "Access-Control-Allow-Origin": "*",
    },
  });
}
