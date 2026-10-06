import { serviceWorkerSource } from "@/lib/my-day-offline";

/**
 * The service worker that lets `/my-day` open with no signal once it has
 * been opened before. Served from the root so the browser lets it take the
 * scope `/my-day`; never cached by the browser, so a new build's worker is
 * picked up on the next visit. See `lib/my-day-offline.ts`.
 */
export function GET(): Response {
  return new Response(serviceWorkerSource(), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
