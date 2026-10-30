"use client";

import { useState } from "react";
import { checkPartRequest, type DayPartAsked } from "@opentradesos/field-client";

/**
 * ASKING THE OFFICE FOR A PART
 *
 * What the job needs, in the technician's own words, sent to the office's
 * queue. The office orders it and puts the job on hold against the order; this
 * never holds the job itself. Each part asked for is listed with whether the
 * office has held the job for it yet.
 */
export function PartAsk({ asked, onAsk }: {
  asked: DayPartAsked[];
  onAsk: (input: { part: string; note: string | null }) => Promise<string | null>;
}) {
  const [part, setPart] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section aria-label="Parts for this job">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Parts for this job</p>
      {asked.length > 0 ? (
        <ul className="mt-1 space-y-1 text-sm">
          {asked.map((a) => (
            <li key={a.id}>
              <span className="font-medium">{a.part}</span>
              <span className="text-ink-500">
                {a.waiting ? ", waiting to send" : a.held ? ", ordered and the job is on hold for it" : ", the office has it"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-2 rounded border border-steel-300">
        <summary className="flex h-12 cursor-pointer items-center px-3 text-base font-medium">Ask the office for a part</summary>
        <div className="space-y-3 border-t border-steel-200 p-3">
          <p className="text-sm text-ink-700">The office orders it and puts the job on hold until it comes in.</p>
          <label className="block">
            <span className="text-sm font-medium">What part</span>
            <input value={part} onChange={(e) => setPart(e.target.value)} maxLength={300}
                   placeholder="Condenser fan motor, 1/4 hp"
                   className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Anything else (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
                      placeholder="Model on the plate, how soon"
                      className="mt-1 w-full rounded border border-steel-300 p-3 text-base" />
          </label>
          {problem ? <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p> : null}
          <button type="button" disabled={busy}
                  onClick={async () => {
                    const checked = checkPartRequest(part, note);
                    if (!checked.ok) { setProblem(checked.problem); return; }
                    setBusy(true);
                    const failed = await onAsk({ part: checked.part, note: checked.note });
                    setBusy(false);
                    setProblem(failed);
                    if (!failed) { setPart(""); setNote(""); }
                  }}
                  className="h-12 w-full rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60">
            Send to the office
          </button>
        </div>
      </details>
    </section>
  );
}
