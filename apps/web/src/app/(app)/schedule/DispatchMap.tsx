"use client";

import { useEffect, useMemo, useState } from "react";
import { geo } from "@opentradesos/core";
import type { dispatchMap } from "@opentradesos/api/services";
import { SlippyMap, type MapLine, type MapPin } from "@/components/SlippyMap";
import type { TileSource } from "@/lib/map-tiles";

export type MapData = Awaited<ReturnType<typeof dispatchMap.map>>;
type MapVisit = MapData["visits"][number];

const NOBODY = "#64748B";
const CREW = "#7C3AED";
/** How often the live pins are read again while the map is open. */
const LIVE_POLL_MS = 30_000;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).slice(0, 2).join("");

/**
 * THE DAY, WHERE IT HAPPENS
 *
 * Every visit as a pin in its technician's colour and numbered in the order
 * they will drive it; unassigned work as an outline, so it cannot be mistaken
 * for anybody's; a late visit ringed in red; each technician's day as a line
 * from where it starts, through the stops, and back. Clicking a pin opens the
 * visit's card, with a way to put it on somebody's day.
 *
 * A visit whose address is not on the map yet is LISTED beside it, with a
 * link to place the pin, rather than left off. A map that silently drops the
 * three addresses the geocoder could not find is a map showing a lighter day
 * than the one the technicians are going to have.
 */
export function DispatchMap({
  map, tiles, canDispatch, time, onAssign, readLive, className = "", stacked = false,
}: {
  map: MapData;
  tiles: TileSource;
  canDispatch: boolean;
  time: (iso: string | null) => string | null;
  /** The board's own assignment, so a refusal and its override work the same from either. */
  onAssign: (visitId: string, technicianId: string) => void;
  /** Where people are now, read again while the map is open. The board's server action. */
  readLive?: () => Promise<MapData["live"]>;
  className?: string;
  /**
   * The card and the lists under the map rather than beside it, for when the
   * map shares the screen with the board and a side panel would leave it a
   * strip too narrow to read.
   */
  stacked?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<string>("");
  /**
   * Where people are now, for somebody who dispatches, on today's map.
   * Read again every half minute while the map is open, so a van moves on
   * the screen without a reload; null for anybody else, who sees no pins.
   */
  const [live, setLive] = useState(map.live);
  useEffect(() => {
    setLive(map.live);
    if (!map.live?.enabled || !readLive) return;
    const timer = setInterval(async () => {
      const fresh = await readLive();
      if (fresh) setLive(fresh);
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [map.live, readLive]);

  const nameOf = useMemo(() => new Map(map.technicians.map((t) => [t.id, t.displayName])), [map.technicians]);
  const byId = useMemo(() => new Map(map.visits.map((v) => [v.id, v])), [map.visits]);

  const { pins, lines } = useMemo(() => {
    const pins: MapPin[] = [];
    const lines: MapLine[] = [];
    const starts = new Set<string>();

    for (const t of map.technicians) {
      const colour = t.color ?? NOBODY;
      const stops = t.route
        .map((id, i) => ({ visit: byId.get(id), order: i + 1 }))
        .filter((s): s is { visit: MapVisit; order: number } => Boolean(s.visit?.position));
      const start = t.start?.position ?? null;
      if (start && t.start && !starts.has(t.start.locationId)) {
        starts.add(t.start.locationId);
        pins.push({
          id: `start:${t.start.locationId}`, lat: start.lat, lng: start.lng, color: "#111827",
          shape: "square", text: "S", label: `Where days start: ${t.start.name}`,
        });
      }
      const points = [
        ...(start ? [{ lat: start.lat, lng: start.lng }] : []),
        ...stops.map((s) => ({ lat: s.visit.position!.lat, lng: s.visit.position!.lng })),
        ...(start ? [{ lat: start.lat, lng: start.lng }] : []),
      ];
      if (stops.length > 0 && points.length > 1) lines.push({ id: t.id, color: colour, points });
      for (const s of stops) {
        if (s.visit.technicianId !== t.id) continue;
        pins.push({
          id: s.visit.id, lat: s.visit.position!.lat, lng: s.visit.position!.lng, color: colour,
          text: String(s.order),
          label: `Visit #${s.visit.jobNumber}, ${s.visit.customerName}, ${t.displayName}${s.visit.isLate ? ", late" : ""}`,
          late: s.visit.isLate,
          approximate: !geo.isStreetLevel(s.visit.position!.precision),
        });
      }
    }
    /** A crew's day as a line too, in the crew's colour, from where the crew is based. */
    for (const c of map.crews) {
      const colour = c.color ?? CREW;
      const stops = c.route
        .map((id, i) => ({ visit: byId.get(id), order: i + 1 }))
        .filter((s): s is { visit: MapVisit; order: number } => Boolean(s.visit?.position));
      const start = c.start?.position ?? null;
      const points = [
        ...(start ? [{ lat: start.lat, lng: start.lng }] : []),
        ...stops.map((s) => ({ lat: s.visit.position!.lat, lng: s.visit.position!.lng })),
        ...(start ? [{ lat: start.lat, lng: start.lng }] : []),
      ];
      if (stops.length > 0 && points.length > 1) lines.push({ id: `crew:${c.id}`, color: colour, points });
      for (const s of stops) {
        pins.push({
          id: s.visit.id, lat: s.visit.position!.lat, lng: s.visit.position!.lng, color: colour, shape: "square",
          text: String(s.order),
          label: `Visit #${s.visit.jobNumber}, ${s.visit.customerName}, crew ${c.name}${s.visit.isLate ? ", late" : ""}`,
          late: s.visit.isLate,
          approximate: !geo.isStreetLevel(s.visit.position!.precision),
        });
      }
    }
    for (const v of map.visits) {
      if (v.technicianId || v.crewId || !v.position || v.status === "cancelled") continue;
      pins.push({
        id: v.id, lat: v.position.lat, lng: v.position.lng, color: "#FFFFFF", hollow: true,
        label: `Visit #${v.jobNumber}, ${v.customerName}, unassigned${v.isLate ? ", late" : ""}`,
        late: v.isLate, approximate: !geo.isStreetLevel(v.position.precision),
      });
    }
    /**
     * Where people are now. A pin older than half an hour is drawn faded and
     * says how old it is, because it is where somebody was, not where they are.
     */
    for (const p of live?.positions ?? []) {
      /**
       * The path they took today, dotted in their colour behind their pin,
       * so the planned day (the solid line) and the driven one can be told
       * apart at a glance.
       */
      if (p.trail.length >= 2) {
        lines.push({ id: `trail:${p.technicianId}`, color: p.color ?? NOBODY, dotted: true, points: p.trail.map((t) => ({ lat: t.lat, lng: t.lng })) });
      }
      pins.push({
        id: `live:${p.technicianId}`, lat: p.lat, lng: p.lng, color: p.color ?? NOBODY,
        text: initials(p.displayName),
        label: `${p.displayName}, here ${p.lastSeen}`,
        approximate: p.freshness === "stale",
      });
    }
    return { pins, lines };
  }, [map, byId, live]);

  const visit = selected ? byId.get(selected) ?? null : null;
  const unplaced = map.unplaced.map((id) => byId.get(id)).filter((v): v is MapVisit => Boolean(v));

  return (
    <div className={`flex min-h-0 flex-col ${stacked ? "" : "lg:flex-row"} ${className}`}>
      <SlippyMap
        tiles={tiles}
        pins={pins}
        lines={lines}
        selectedId={selected}
        onSelect={(id) => { if (byId.has(id)) { setSelected(id); setAssignTo(""); } }}
        fitKey={map.date}
        label="Dispatch map"
        className={stacked ? "h-[55%] min-h-[18rem] shrink-0" : "min-h-[24rem] flex-1"}
      />

      <aside className={`w-full overflow-y-auto border-t border-steel-200 bg-canvas p-3 text-sm ${
        stacked ? "min-h-0 flex-1" : "shrink-0 lg:w-80 lg:border-l lg:border-t-0"
      }`}>
        {visit ? (
          <article aria-label="Visit on the map" className="rounded border border-steel-200 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="truncate font-medium">{visit.customerName}</h2>
              <span className="font-mono text-xs text-ink-500">#{visit.jobNumber}</span>
            </div>
            <p className="mt-0.5 text-ink-700">{visit.summary}</p>
            <p className="mt-0.5 text-xs text-ink-500">{visit.address}</p>
            <p className="mt-1.5 text-xs tabular-nums text-ink-500">
              {time(visit.windowStart) ?? "Any time"}
              {visit.windowEnd ? ` to ${time(visit.windowEnd)}` : ""}
              {visit.isLate && <span className="ml-2 rounded bg-red-tint px-1.5 py-0.5 font-medium text-red-600">Late</span>}
            </p>
            <p className="mt-1.5 text-xs text-ink-700">
              {visit.technicianIds.length > 0
                ? `With ${visit.technicianIds.map((id) => nameOf.get(id) ?? "somebody").join(" and ")}`
                : visit.crewId
                  ? `With the crew ${map.crews.find((c) => c.id === visit.crewId)?.name ?? ""}`
                  : "Nobody yet"}
              <span className="capitalize text-ink-500">, {visit.status.replace(/_/g, " ")}</span>
            </p>
            {visit.position && !geo.isStreetLevel(visit.position.precision) && (
              <p className="mt-1.5 text-xs text-amber-700">
                {geo.describePrecision(visit.position.precision)}: the pin is not on the house.{" "}
                <a href={`/properties/${visit.propertyId}#pin`} className="underline">Place it</a>
              </p>
            )}
            {canDispatch && !["completed", "cancelled", "completed_after_cancellation"].includes(visit.status) && (
              <form
                className="mt-3 flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (assignTo) onAssign(visit.id, assignTo);
                }}
              >
                <label className="flex-1">
                  <span className="block text-xs font-medium text-ink-700">Put on the day of</span>
                  <select
                    value={assignTo}
                    onChange={(e) => setAssignTo(e.target.value)}
                    className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2"
                  >
                    <option value="">Choose somebody</option>
                    {/* Only your own people: somebody from another team is on the map for your job they cover, not to be given more. */}
                    {map.technicians.filter((t) => t.inScope).map((t) => (
                      <option key={t.id} value={t.id}>{t.displayName}{t.timeOff ? " (off)" : ""}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={!assignTo}
                        className="h-9 rounded bg-ink-900 px-3 font-medium text-white disabled:opacity-60">
                  Assign
                </button>
              </form>
            )}
          </article>
        ) : (
          <p className="text-ink-500">Click a pin to see the visit and put it on somebody&apos;s day.</p>
        )}

        {live && (
          <section aria-label="Where people are now" className="mt-5">
            <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-500">Where people are now</h2>
            {!live.enabled ? (
              <p className="mt-1 text-xs text-ink-500">
                Live location is off. <a href="/schedule/technicians" className="underline">Turn it on</a> to see
                technicians on the map while they work.
              </p>
            ) : live.positions.length === 0 ? (
              <p className="mt-1 text-xs text-ink-500">Nobody has shared a position today. Phones share only while their person is working.</p>
            ) : (
              <>
              <p className="mt-1 text-xs text-ink-500">The dotted line behind each person is where they have been today.</p>
              <ul className="mt-2 space-y-1">
                {live.positions.map((p) => (
                  <li key={p.technicianId} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color ?? NOBODY }} aria-hidden />
                    <span className="truncate">{p.displayName}</span>
                    <span className={`ml-auto text-xs ${p.freshness === "stale" ? "text-amber-700" : "text-ink-500"}`}>{p.lastSeen}</span>
                  </li>
                ))}
              </ul>
              </>
            )}
          </section>
        )}

        <h2 className="mt-5 text-xs font-medium uppercase tracking-[0.08em] text-ink-500">Who is where</h2>
        <ul className="mt-2 space-y-1">
          {map.technicians.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color ?? NOBODY }} aria-hidden />
              <span className="truncate">{t.displayName}</span>
              <span className="ml-auto text-xs text-ink-500">
                {t.timeOff ? "Off" : `${t.route.length} ${t.route.length === 1 ? "stop" : "stops"}`}
              </span>
            </li>
          ))}
          {map.crews.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.color ?? CREW }} aria-hidden />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-xs text-ink-500">Crew, {c.route.length} {c.route.length === 1 ? "stop" : "stops"}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 text-ink-500">
            <span className="h-2.5 w-2.5 rounded-full border border-dashed border-ink-900" aria-hidden />
            Unassigned
          </li>
        </ul>
        {map.technicians.some((t) => !t.start?.position) && (
          <p className="mt-2 text-xs text-ink-500">
            Somebody&apos;s day has no start on the map, so their line starts at their first stop.{" "}
            <a href="/schedule/technicians" className="underline">Set where days start</a>
          </p>
        )}

        <section aria-label="Not on the map yet" className="mt-5">
          <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
            Not on the map yet ({unplaced.length})
          </h2>
          {unplaced.length === 0 ? (
            <p className="mt-1 text-xs text-ink-500">Every visit today is on the map.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {unplaced.map((v) => (
                <li key={v.id} className="rounded border border-amber-700 bg-amber-tint p-2">
                  <p className="font-medium">{v.customerName}</p>
                  <p className="text-xs text-ink-700">{v.address}</p>
                  <a href={`/properties/${v.propertyId}#pin`} className="text-xs font-medium underline">
                    Place a pin
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!map.geocoder && (
            <p className="mt-2 text-xs text-ink-500">
              No geocoder is connected, so addresses only appear here once somebody places them.{" "}
              <a href="/settings/integrations" className="underline">Connect one</a>
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
