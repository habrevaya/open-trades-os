/**
 * `/my-day` WITH NO SIGNAL, ONCE IT HAS BEEN OPENED BEFORE
 *
 * The technician's day already records everything into a queue on the
 * phone, so a day already open keeps working in a basement. What it could
 * not do was OPEN: a page load is a request to the server. A service worker
 * keeps the last copy of the person's own day and the files the page needs
 * to run, and hands them back when the network does not answer.
 *
 * WHAT IS KEPT, AND WHOSE. Only `/my-day` itself, the day as the server
 * last drew it for the person signed in, and the page's own script and
 * style files, which are the same for everybody and say nothing about
 * anybody. No other screen, no API answer, nothing about another person.
 *
 * WHO IT BELONGS TO is written into the cache beside it (`OWNER_KEY`).
 * Every signed in page checks it (`claimCache`), and a different person
 * signed in on the same phone empties it before anything of theirs is kept.
 * The sign in page empties it outright, which is where signing out and an
 * ended session both land, so a borrowed phone keeps nobody's day once
 * they have gone.
 *
 * Network first for the page: with a signal the technician always gets the
 * day as it is now, and the copy is refreshed. The kept copy is only for
 * when there is no answer at all, and the page says what it is showing.
 */

/** The person's day. Emptied when somebody else signs in, or anybody signs out. */
export const DAY_CACHE = "ots-my-day";
/** The page's own script and style files: the same for everybody. */
export const STATIC_CACHE = "ots-my-day-static";
/** Who the kept day belongs to, kept as an entry in the day's own cache. */
export const OWNER_KEY = "/my-day/__owner";
/** The most script and style files kept, so old builds' files do not pile up. */
export const MAX_STATIC = 300;

/** Whether this browser can keep the day at all. A page not on HTTPS (other than localhost) cannot. */
export function canKeepOffline(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "caches" in window && window.isSecureContext;
}

/** Empty everything kept for `/my-day`. Signing out lands here. */
export async function forgetMyDay(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  await Promise.all([caches.delete(DAY_CACHE), caches.delete(STATIC_CACHE)]);
}

/**
 * Make the kept day this person's: empty it when it was somebody else's,
 * then write who it belongs to. Safe to call on every page.
 */
export async function claimCache(person: string): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  const cache = await caches.open(DAY_CACHE);
  const owner = await cache.match(OWNER_KEY);
  const was = owner ? await owner.text() : null;
  if (was === person) return;
  if (was !== null) await forgetMyDay();
  await (await caches.open(DAY_CACHE)).put(OWNER_KEY, new Response(person, { headers: { "Content-Type": "text/plain" } }));
}

/**
 * The service worker's source. Served at `/my-day-sw.js` and registered
 * with the scope `/my-day`, so it controls that page and nothing else.
 */
export function serviceWorkerSource(): string {
  return `/* The technician's day, kept for when there is no signal. See apps/web/src/lib/my-day-offline.ts. */
const DAY_CACHE = ${JSON.stringify(DAY_CACHE)};
const STATIC_CACHE = ${JSON.stringify(STATIC_CACHE)};
const OWNER_KEY = ${JSON.stringify(OWNER_KEY)};
const MAX_STATIC = ${MAX_STATIC};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const isDay = (url) => url.origin === self.location.origin && url.pathname === "/my-day";
const isStatic = (url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/");

async function trim() {
  const cache = await caches.open(STATIC_CACHE);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(keys.length - MAX_STATIC, 0))) await cache.delete(key);
}

async function day(request) {
  try {
    const response = await fetch(request);
    const landed = new URL(response.url || request.url);
    /** Only the person's own day, drawn: never a redirect to sign in, never an error page. */
    if (response.ok && !response.redirected && isDay(landed)) {
      const cache = await caches.open(DAY_CACHE);
      if (await cache.match(OWNER_KEY)) await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(DAY_CACHE);
    const kept = (await cache.match(request)) || (await cache.match("/my-day")) || (await cache.match(request, { ignoreSearch: true }));
    if (kept) return kept;
    throw error;
  }
}

async function file(request) {
  const cache = await caches.open(STATIC_CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trim();
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && isDay(url)) {
    event.respondWith(day(request));
    return;
  }
  if (isStatic(url)) event.respondWith(file(request));
});
`;
}
