"use client";

import { useState } from "react";
import { checkGallons, type DayTruck } from "@opentradesos/field-client";

/**
 * THE FRESH WATER YOUR TRUCK USED TODAY, ON THE PAGE
 *
 * Read off the tank gauge or the fill meter at the end of the day, for a truck
 * checked out to this person today. Kept in the same queue as the rest of the
 * day, so it is saved with no signal and sent when there is one. Saving again
 * replaces the day's reading. Fresh water per stop, per truck, is made from it.
 */

const primary = "flex h-12 w-full items-center justify-center rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60";
const input = "h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";

export function TruckWaterPanel({ truck, today, onSave }: {
  truck: DayTruck;
  today: string;
  onSave: (gallons: string) => Promise<string | null>;
}) {
  const recorded = truck.water.find((w) => w.onDay === today) ?? null;
  const [gallons, setGallons] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const checked = checkGallons(gallons);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    setBusy(true);
    try {
      const failed = await onSave(checked.gallons);
      if (failed) { setProblem(failed); return; }
      setGallons("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Fresh water, ${truck.label}`} className="rounded border border-steel-200 bg-canvas p-4">
      <h2 className="text-base font-semibold">{truck.label}: fresh water today</h2>
      <p className="mt-1 text-base text-ink-700">
        {recorded
          ? `${Number(recorded.gallons)} gallons recorded${recorded.waiting ? ", waiting to send" : ""}.`
          : "Not recorded yet. Read the tank gauge or the fill meter at the end of the day."}
      </p>
      <label className="mt-3 block">
        <span className="text-sm font-medium text-ink-700">Gallons used today</span>
        <input className={`mt-1 ${input}`} inputMode="decimal" value={gallons} placeholder="410"
               onChange={(e) => setGallons(e.target.value)} />
      </label>
      {problem ? <p role="alert" className="mt-2 text-sm text-red-600">{problem}</p> : null}
      <button type="button" className={`mt-3 ${primary}`} disabled={busy} onClick={() => void save()}>
        {recorded ? "Save a new reading" : "Save the reading"}
      </button>
    </section>
  );
}
