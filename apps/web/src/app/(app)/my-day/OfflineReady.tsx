"use client";

import { useEffect, useState } from "react";
import { CACHE_FILL_HEADER, canKeepOffline, claimCache, DAY_CACHE, STATIC_CACHE } from "@/lib/my-day-offline";

/**
 * Keeps this day on the phone for when there is no signal, and says so.
 *
 * Registers the service worker for `/my-day`, then keeps this page and the
 * files it loaded straight away, so the first visit is enough: waiting for
 * the worker to see a second load would leave a technician who opened their
 * day once, in the yard, with nothing in the basement.
 */
export function OfflineReady({ person }: { person: string }) {
  const [state, setState] = useState<"saving" | "kept" | "unable" | "offline">("saving");

  useEffect(() => {
    if (!navigator.onLine) {
      setState("offline");
      return;
    }
    if (!canKeepOffline()) {
      setState("unable");
      return;
    }
    let cancelled = false;
    (async () => {
      await navigator.serviceWorker.register("/my-day-sw.js", { scope: "/my-day" });
      await navigator.serviceWorker.ready;
      await claimCache(person);
      const day = await caches.open(DAY_CACHE);
      await day.add(new Request(window.location.pathname + window.location.search, {
        headers: { [CACHE_FILL_HEADER]: "1" },
      }));
      const files = performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(`${window.location.origin}/_next/static/`));
      const kept = await caches.open(STATIC_CACHE);
      await Promise.all(files.map((name) => kept.add(name).catch(() => undefined)));
      if (!cancelled) setState("kept");
    })().catch(() => { if (!cancelled) setState("unable"); });
    return () => { cancelled = true; };
  }, [person]);

  if (state === "saving") return null;
  return (
    <p role="status" className="text-xs text-ink-500">
      {state === "kept" && "This day is saved on this phone, so it opens with no signal."}
      {state === "offline" && "No signal. This is your day as it was last saved on this phone. Anything you do is kept and sent when the signal is back."}
      {state === "unable" && "This browser cannot keep your day for when there is no signal."}
    </p>
  );
}
