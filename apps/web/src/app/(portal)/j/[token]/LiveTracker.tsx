"use client";

import { useEffect, useState } from "react";
import type { liveLocation } from "@opentradesos/api/services";
import { SlippyMap, type MapPin } from "@/components/SlippyMap";
import type { TileSource } from "@/lib/map-tiles";

type Live = Awaited<ReturnType<typeof liveLocation.liveTracking>>;

/**
 * THE VAN ON ITS WAY
 *
 * The technician's first name and photo, how long until they arrive, and a
 * pin that moves while they drive, read again every twenty seconds. The
 * page stops asking once they have arrived or the visit is finished,
 * because there is nothing more to show and the server would show nothing.
 *
 * The ETA says what it is built from, in small words: by road, roughly (a
 * straight line), or what the technician said when they set off.
 */
const POLL_MS = 20_000;

export function LiveTracker({ token, initial, tiles }: { token: string; initial: Live; tiles: TileSource }) {
  const [live, setLive] = useState<Live>(initial);

  useEffect(() => {
    if (live.status === "arrived" || live.status === "finished") return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/j/${token}/live`, { cache: "no-store" });
        if (response.ok) setLive(await response.json() as Live);
      } catch {
        // A dropped connection on the customer's phone; the next tick tries again.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [token, live.status]);

  const pins: MapPin[] = [];
  if (live.destination) {
    pins.push({ id: "home", lat: live.destination.lat, lng: live.destination.lng, color: "#111827", shape: "square", text: "", label: "Your address" });
  }
  if (live.position) {
    pins.push({
      id: "van", lat: live.position.lat, lng: live.position.lng, color: "#1D4ED8", text: "",
      label: `${live.technician?.firstName ?? "Your technician"}, ${live.position.lastSeen}`,
    });
  }

  return (
    <section aria-label="Your technician" className="rounded-md border border-steel-200 bg-canvas p-5 text-center">
      {live.technician && (
        <div className="flex items-center justify-center gap-3">
          {live.technician.photoUrl && (
            /* A plain img: the photo is served through this link, not a static asset Next can optimise. */
            <img src={live.technician.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
          )}
          {/* First name only. A last name and a phone number are not the customer's to have. */}
          <span className="text-sm">{live.technician.firstName} is on this one.</span>
        </div>
      )}

      {live.etaMinutes !== null && (
        <p className="mt-3 text-lg font-medium" role="status">
          About {live.etaMinutes} {live.etaMinutes === 1 ? "minute" : "minutes"} away.
        </p>
      )}
      {live.etaBasis && (
        <p className="mt-0.5 text-xs text-ink-500">
          {live.etaBasis === "road" ? "Estimated by road from where they are now."
            : live.etaBasis === "estimate" ? "A rough estimate from where they are now."
            : "What your technician estimated when they set off."}
        </p>
      )}

      {live.tracking && pins.length > 0 && (
        <SlippyMap
          tiles={tiles}
          pins={pins}
          fitKey={token}
          label="Where your technician is"
          className="mt-4 h-64 w-full rounded"
        />
      )}
      {live.position && <p className="mt-2 text-xs text-ink-500">Updated {live.position.lastSeen}.</p>}
      <p className="mt-3 text-sm text-ink-700">{live.explanation}</p>
    </section>
  );
}
