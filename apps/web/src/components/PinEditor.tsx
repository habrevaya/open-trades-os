"use client";

import { useState } from "react";
import { geo } from "@opentradesos/core";
import type { FormState } from "@/lib/actions";
import type { TileSource } from "@/lib/map-tiles";
import { ActionForm, TextField } from "@/components/ActionForm";
import { SlippyMap } from "@/components/SlippyMap";

/**
 * PLACING SOMETHING ON THE MAP BY HAND
 *
 * Click where it is, or type the coordinates from a phone's map app, and
 * save. A pin placed here wins over the geocoder from then on, which the
 * caption says, and handing it back to the geocoder is a separate button
 * rather than an empty box, because clearing a pin by accident would quietly
 * move the customer to wherever the geocoder thinks the postcode is.
 */
export function PinEditor({
  id, label, tiles, current, place, clear, fallback,
}: {
  id: string;
  /** What is being placed, for the map's name: "4102 Ramsey Ave". */
  label: string;
  tiles: TileSource;
  current: {
    latitude: string | null; longitude: string | null;
    precision: geo.GeocodePrecision | null; source: string | null;
  };
  place: ((previous: FormState, form: FormData) => Promise<FormState>) | null;
  clear: ((previous: FormState, form: FormData) => Promise<FormState>) | null;
  fallback?: geo.Viewport;
}) {
  const stored = geo.parseLatLng(current.latitude, current.longitude);
  const [draft, setDraft] = useState<{ lat: string; lng: string }>({
    lat: current.latitude ?? "", lng: current.longitude ?? "",
  });
  const shown = geo.parseLatLng(draft.lat, draft.lng) ?? stored;
  const placedByHand = current.source === geo.PLACED_BY_HAND;

  return (
    <div>
      <p className="text-sm text-ink-700">
        {stored
          ? `${geo.describePrecision(current.precision)}${placedByHand ? "" : `, from ${current.source ?? "the geocoder"}`}.`
          : "Not on the map yet."}
        {placedByHand ? " The geocoder will not move it." : ""}
      </p>
      <SlippyMap
        tiles={tiles}
        label={`Map for ${label}`}
        pins={shown ? [{ id, lat: shown.lat, lng: shown.lng, color: "#1D4ED8", label: `Pin for ${label}` }] : []}
        {...(place ? { onPick: (at: geo.LatLng) => setDraft({ lat: geo.formatCoordinate(at.lat), lng: geo.formatCoordinate(at.lng) }) } : {})}
        fitKey={id}
        {...(fallback ? { fallback } : {})}
        className="mt-3 h-72 rounded-md border border-steel-200"
      />
      {place && (
        <ActionForm action={place} submit="Save pin" hidden={{ id }} className="mt-3 flex flex-wrap items-end gap-3">
          <TextField label="Latitude" name="latitude" value={draft.lat} inputMode="decimal"
                     onChange={(e) => setDraft({ ...draft, lat: e.target.value })} className="block w-40" />
          <TextField label="Longitude" name="longitude" value={draft.lng} inputMode="decimal"
                     onChange={(e) => setDraft({ ...draft, lng: e.target.value })} className="block w-40" />
        </ActionForm>
      )}
      {place && <p className="mt-1 text-xs text-ink-500">Click the map where it is, or type the coordinates, then save.</p>}
      {clear && placedByHand && (
        <ActionForm action={clear} submit="Hand back to the geocoder" tone="quiet" hidden={{ id }} className="mt-3" />
      )}
    </div>
  );
}
