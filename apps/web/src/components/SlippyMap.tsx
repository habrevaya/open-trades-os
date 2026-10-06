"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { geo } from "@opentradesos/core";
import type { TileSource } from "@/lib/map-tiles";

/**
 * A SMALL SLIPPY MAP, AND WHY IT IS NOT A LIBRARY
 *
 * A dispatch map needs four things: tiles, pins, lines between them, and a
 * way to pan and zoom. A mapping library brings all of that and a great deal
 * more through the lockfile: a WebGL renderer, a style specification, a
 * vector tile parser, and a release cadence this product would then follow.
 * The arithmetic underneath is a dozen lines of Web Mercator, which lives in
 * `geo` in core with its own tests, and what is left here is a component
 * that draws raster tiles where that arithmetic says and listens for a drag
 * and a wheel.
 *
 * Pins are BUTTONS, not shapes on a canvas, so a keyboard can reach them, a
 * screen reader can name them, and a test can click one by what it is.
 *
 * The attribution is drawn on the map itself, always, because the tile
 * server's terms require it and a credit hidden behind an info button is not
 * one anybody reads.
 */

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  /** Fill colour, usually the technician's. */
  color: string;
  /** What the pin is, for a screen reader and for a test. */
  label: string;
  /** A short mark inside the pin, such as its place in the day. */
  text?: string | null;
  shape?: "round" | "square";
  /** Unassigned work: an outline rather than a fill, so it cannot be mistaken for anybody's. */
  hollow?: boolean;
  late?: boolean;
  /** Placed in the middle of a postcode or a town, not on the house. */
  approximate?: boolean;
}

export interface MapLine {
  id: string;
  color: string;
  points: geo.LatLng[];
}

const ZOOM_MIN = 3;
const ZOOM_MAX = 18;

export function SlippyMap({
  tiles, pins, lines = [], selectedId = null, onSelect, onPick, fitKey, fallback, label, className = "",
}: {
  tiles: TileSource;
  pins: MapPin[];
  lines?: MapLine[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** A click on the map itself, not on a pin: where a pin is being placed. */
  onPick?: (at: geo.LatLng) => void;
  /** When this changes the view is fitted to what is on the map again. */
  fitKey?: string;
  /** Where to look when there is nothing on the map. */
  fallback?: geo.Viewport;
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<geo.Viewport | null>(null);
  const [fittedFor, setFittedFor] = useState<string | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; centre: { x: number; y: number }; moved: boolean } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  /**
   * Fitted once the map knows its own size, and again when the caller says
   * the subject changed (another day). Not on every new pin, or assigning a
   * visit would yank the view away from where the dispatcher was looking.
   */
  useEffect(() => {
    if (!size || size.width === 0) return;
    if (view && fittedFor === fitKey) return;
    const points = [...pins.map((p) => ({ lat: p.lat, lng: p.lng })), ...lines.flatMap((l) => l.points)];
    setView(geo.fitBounds(points, size, fallback ? { fallback } : {}));
    setFittedFor(fitKey);
  }, [size, fitKey, view, fittedFor, pins, lines, fallback]);

  const zoomAround = useCallback((delta: number, pixel?: { x: number; y: number }) => {
    setView((current) => {
      if (!current || !size) return current;
      const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.zoom + delta));
      if (zoom === current.zoom) return current;
      const at = pixel ?? { x: size.width / 2, y: size.height / 2 };
      /** The point under the cursor stays under the cursor. */
      const anchor = geo.fromScreen(at, current, size);
      const p = geo.project(anchor, zoom);
      const centre = { x: p.x - (at.x - size.width / 2), y: p.y - (at.y - size.height / 2) };
      return { zoom, center: geo.unproject(centre, zoom) };
    });
  }, [size]);

  /**
   * A non-passive listener, because the page must not scroll while the
   * wheel is zooming the map, and React registers wheel handlers as passive.
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAround(event.deltaY < 0 ? 1 : -1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAround]);

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (!view || (event.target as HTMLElement).closest("button,a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, centre: geo.project(view.center, view.zoom), moved: false };
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || !view) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
    if (!start.moved) return;
    setView({ zoom: view.zoom, center: geo.unproject({ x: start.centre.x - dx, y: start.centre.y - dy }, view.zoom) });
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    drag.current = null;
    if (!start || start.moved || !view || !size || !onPick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onPick(geo.fromScreen({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view, size));
  }

  const ready = view && size && size.width > 0;
  const onScreen = (x: number, y: number) =>
    size !== null && x > -40 && y > -40 && x < size.width + 40 && y < size.height + 40;

  return (
    <div
      ref={box}
      role="region"
      aria-label={label}
      className={`relative select-none overflow-hidden bg-steel-100 ${onPick ? "cursor-crosshair" : "cursor-grab"} ${className}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { drag.current = null; }}
      style={{ touchAction: "none" }}
    >
      {ready && geo.tilesFor(view, size).map((t) => (
        // A plain img: raster tiles from a configured server are not assets Next can optimise.
        <img
          key={`${t.z}/${t.x}/${t.y}/${t.left}`}
          src={geo.tileUrl(tiles.url, t)}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none"
          style={{ left: t.left, top: t.top, width: geo.TILE_SIZE, height: geo.TILE_SIZE }}
        />
      ))}

      {ready && (
        <svg className="pointer-events-none absolute inset-0" width={size.width} height={size.height} aria-hidden>
          {lines.map((line) => (
            <polyline
              key={line.id}
              points={line.points.map((p) => {
                const s = geo.toScreen(p, view, size);
                return `${s.x},${s.y}`;
              }).join(" ")}
              fill="none"
              stroke={line.color}
              strokeWidth={3}
              strokeLinejoin="round"
              strokeOpacity={0.8}
            />
          ))}
        </svg>
      )}

      {ready && pins.map((pin) => {
        const s = geo.toScreen(pin, view, size);
        if (!onScreen(s.x, s.y)) return null;
        const selected = pin.id === selectedId;
        return (
          <button
            key={pin.id}
            type="button"
            aria-label={pin.label}
            aria-pressed={onSelect ? selected : undefined}
            title={pin.approximate ? `${pin.label}. Placed roughly, not on the house.` : pin.label}
            onClick={() => onSelect?.(pin.id)}
            className={`absolute flex h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center px-1 text-xs font-semibold shadow ${
              pin.shape === "square" ? "rounded-sm" : "rounded-full"
            } ${pin.late ? "ring-4 ring-red-600" : ""} ${selected ? "z-10 scale-125" : ""} ${
              pin.approximate ? "opacity-70" : ""
            }`}
            style={{
              left: s.x,
              top: s.y,
              background: pin.hollow ? "#FFFFFF" : pin.color,
              color: pin.hollow ? "#111827" : "#FFFFFF",
              border: `2px ${pin.hollow ? "dashed" : "solid"} ${pin.hollow ? "#111827" : "#FFFFFF"}`,
            }}
          >
            {pin.text ?? ""}
          </button>
        );
      })}

      <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded border border-steel-300 bg-canvas shadow">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAround(1)}
                className="h-8 w-8 text-lg leading-none hover:bg-steel-100">+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAround(-1)}
                className="h-8 w-8 border-t border-steel-300 text-lg leading-none hover:bg-steel-100">-</button>
      </div>

      <p className="absolute bottom-0 right-0 bg-canvas/80 px-1.5 py-0.5 text-[11px] text-ink-700">
        <a href={tiles.attributionUrl} target="_blank" rel="noreferrer" className="underline">
          {tiles.attribution}
        </a>
      </p>
    </div>
  );
}
