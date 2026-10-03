import { agents } from "@opentradesos/core";

/**
 * THE WEBSITE CHAT
 *
 * Loaded by the website snippet (`/t.js`) only when the company has its chat
 * agent on, or by a script tag of its own:
 *
 *   <script src="https://your-installation/chat.js?c=your-company" async></script>
 *
 * The same bytes for every visitor, so it is cached like the snippet. It asks
 * whether the chat is on before it draws anything, so a company that turns the
 * agent off stops showing the button within the hour without anybody editing
 * their website.
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
  return new Response(agents.chatWidgetSource({ apiBase: `${base}/api`, companyKey: key }), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      /** A script tag on another site is the point of this file. */
      "Access-Control-Allow-Origin": "*",
    },
  });
}
