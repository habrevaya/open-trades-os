"use client";

import { useId, useState } from "react";
import { CALL_OFF_CHOICES, callOffLabel, checkCallOff, type CallOffChoice, type CallOffPayload } from "@opentradesos/field-client";

/**
 * CALLING THE VISIT OFF FROM THE DOOR
 *
 * Folded away under the visit, because it is the one button on the card that
 * cannot be taken back from the phone. It asks who called it off with no
 * default (the customer turning the team away, or one of the company's own
 * reasons), and "something else" asks for words. It goes into the queue like
 * everything else, so it is kept with no signal, and the server lands it the
 * way the office's call off lands.
 */
export function CallOff({ onCallOff }: { onCallOff: (payload: CallOffPayload) => Promise<string | null> }) {
  const [choice, setChoice] = useState<CallOffChoice | "">("");
  const [words, setWords] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turnedAway = choice === "turned_away";
  const group = useId();

  return (
    <details className="rounded border border-steel-300">
      <summary className="flex h-12 cursor-pointer items-center px-3 text-base font-medium">Call off this visit</summary>
      <div className="space-y-3 border-t border-steel-200 p-3">
        <p className="text-sm text-ink-700">
          For when you are turned away at the door, or we cannot do the work today. The office is told as soon as it sends,
          and the visit comes off your day.
        </p>
        <fieldset>
          <legend className="text-sm font-medium">Who called it off, and why</legend>
          <div className="mt-2 space-y-2">
            {CALL_OFF_CHOICES.map((c) => (
              <label key={c.value} className="flex items-center gap-3 rounded border border-steel-300 px-3 py-3 text-base">
                <input type="radio" name={group} value={c.value} checked={choice === c.value}
                       onChange={() => { setChoice(c.value); setProblem(null); }} className="h-5 w-5" />
                <span>{callOffLabel(c.value)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {choice ? (
          <label className="block">
            <span className="text-sm font-medium">
              {choice === "other" ? "What happened" : turnedAway ? "What they said (optional)" : "More words (optional)"}
            </span>
            <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={2} maxLength={500}
                      className="mt-1 w-full rounded border border-steel-300 p-3 text-base" />
          </label>
        ) : null}
        {problem ? <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p> : null}
        <button type="button" disabled={busy}
                onClick={async () => {
                  const checked = checkCallOff(choice, words);
                  if (!checked.ok) { setProblem(checked.problem); return; }
                  setBusy(true);
                  const failed = await onCallOff(checked.payload);
                  setBusy(false);
                  setProblem(failed);
                }}
                className="h-12 w-full rounded bg-red-600 px-4 text-base font-medium text-white disabled:opacity-60">
          Call it off
        </button>
      </div>
    </details>
  );
}
