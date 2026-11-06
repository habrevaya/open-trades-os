"use client";

import { useState } from "react";
import { haulClock, haulTipChoices, type DayHaul, type HaulMoment } from "@opentradesos/field-client";

/**
 * WHEN YOU DROPPED A CAN, AND WHEN YOU EMPTIED ONE
 *
 * For a driver whose day has container stops. The time a can was put down on
 * a site, and the time a full one was emptied at the facility (not when it was
 * loaded, and not when the truck crossed the scale), or, for a can that came
 * back with nothing in it, that it came back empty and when it was collected.
 * Tap when it happens, or type the time if it was earlier today. Kept in the
 * same queue as the rest of the day, so it is saved with no signal and sent
 * when there is one. Saving again replaces that time. The server holds "came
 * back empty" to the office's rules, and only the office takes it off.
 */

const primary = "flex h-12 w-full items-center justify-center rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60";
const input = "h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";

const LEG: Record<DayHaul["leg"], string> = { delivery: "Drop off", pickup: "Collection", swap: "Swap" };

export function HaulsPanel({ hauls, stopName, zone, onSave }: {
  hauls: DayHaul[];
  /** What to call a stop: the customer and the street. */
  stopName: (visitId: string) => string;
  zone: string;
  onSave: (input: { rentalId: string; visitId: string; moment: HaulMoment; at: Date }) => Promise<string | null>;
}) {
  if (hauls.length === 0) return null;
  return (
    <section aria-label="Container times" className="rounded border border-steel-200 bg-canvas p-4">
      <h2 className="text-base font-semibold">Container times</h2>
      <p className="mt-1 text-sm text-ink-700">
        Record when you put each can down, and when you emptied each full one at the facility.
      </p>
      <ul className="mt-3 space-y-4">
        {hauls.map((haul) => (
          <li key={haul.visitId} className="border-t border-steel-200 pt-3">
            <p className="text-base font-medium">{LEG[haul.leg]}: {stopName(haul.visitId)}</p>
            {haul.drop ? (
              <Moment label={`Container ${haul.drop.container} dropped`} zone={zone}
                      recorded={haul.drop.timeKnown ? haul.drop.deliveredAt : null} waiting={haul.drop.waiting}
                      onSave={(at) => onSave({ rentalId: haul.drop!.rentalId, visitId: haul.visitId, moment: "placed", at })} />
            ) : null}
            {haul.tip ? <TipMoments haul={haul} zone={zone} onSave={onSave} /> : null}
            {!haul.drop && haul.leg === "swap" ? (
              <p className="mt-2 text-sm text-ink-500">The empty you left can be timed once the office records the swap.</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const clock = (at: string, zone: string) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });

/** The tip, or that the can came back empty: one or the other, never both. */
function TipMoments({ haul, zone, onSave }: {
  haul: DayHaul;
  zone: string;
  onSave: (input: { rentalId: string; visitId: string; moment: HaulMoment; at: Date }) => Promise<string | null>;
}) {
  const tip = haul.tip!;
  const choices = haulTipChoices(tip);
  if (choices.emptyAt) {
    return (
      <p className="mt-2 text-base text-ink-700">
        Container {tip.container} came back empty: collected {clock(choices.emptyAt, zone)}{tip.waiting ? ", waiting to send" : ""}.
        <span className="block text-sm text-ink-500">If it was full after all, ask the office to take that off.</span>
      </p>
    );
  }
  return (
    <>
      <Moment label={`Container ${tip.container} emptied at the facility`} zone={zone}
              recorded={tip.tippedAt} waiting={tip.waiting}
              onSave={(at) => onSave({ rentalId: tip.rentalId, visitId: haul.visitId, moment: "tipped", at })} />
      {choices.offerEmpty ? (
        <Moment label={`Container ${tip.container} came back empty`} zone={zone} recorded={null} waiting={false}
                intro="Nothing in it, so nothing to tip? Say so instead, with the time you collected it."
                timeLabel="Time you collected it, if not now" button="It came back empty"
                onSave={(at) => onSave({ rentalId: tip.rentalId, visitId: haul.visitId, moment: "empty", at })} />
      ) : null}
    </>
  );
}

function Moment({ label, recorded, waiting, zone, onSave, intro, timeLabel = "Time, if not now", button = "Now" }: {
  label: string;
  recorded: string | null;
  waiting: boolean;
  zone: string;
  onSave: (at: Date) => Promise<string | null>;
  /** Said instead of the recorded time, for a moment that is a choice rather than a time to fill in. */
  intro?: string | undefined;
  timeLabel?: string | undefined;
  button?: string | undefined;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const checked = haulClock(typed);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    setBusy(true);
    try {
      const failed = await onSave(checked.at);
      if (failed) { setProblem(failed); return; }
      setTyped("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <p className="text-base text-ink-700">
        {intro ?? `${label}: ${recorded ? `${clock(recorded, zone)}${waiting ? ", waiting to send" : ""}` : "not recorded yet"}`}
      </p>
      <label className="mt-2 block">
        <span className="text-sm font-medium text-ink-700">{timeLabel}</span>
        <input className={`mt-1 ${input}`} value={typed} placeholder="14:30" aria-label={`${label}, time if not now`}
               onChange={(e) => setTyped(e.target.value)} />
      </label>
      {problem ? <p role="alert" className="mt-2 text-sm text-red-600">{problem}</p> : null}
      <button type="button" className={`mt-2 ${primary}`} disabled={busy} onClick={() => void save()}
              aria-label={`Save: ${label}`}>
        {typed.trim() ? "Save this time" : button}
      </button>
    </div>
  );
}
