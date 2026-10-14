"use client";

import { useRef, useState } from "react";
import {
  buildInspection, checkReading, resultLabel,
  type CheckpointEntry, type FieldInspectionProgram,
} from "@opentradesos/field-client";
import { SignatureCanvas, type InkHandle } from "./SignaturePad";

export interface VisitInspection {
  id: string;
  programName: string;
  result: string | null;
  waiting: boolean;
}

/**
 * RUNNING AN INSPECTION ON MY DAY
 *
 * The programme's checkpoints one under another, each a Pass and a Fail
 * button or a reading box, with not applicable behind a reason and a photo
 * per checkpoint. The phone app and this page build the same answers from
 * the same code in the field client, and neither decides the verdict: the
 * server does, from the programme, so a half finished inspection can never
 * be filed as a pass from here.
 *
 * Filed into the same queue as everything else, so it survives losing the
 * signal halfway down a plant room and goes when the phone finds one.
 *
 * THE INSPECTOR SIGNS BY DRAWING, as on the phone app: a box to draw in with
 * a finger, a stylus or a mouse, kept on the phone and sent with the
 * inspection. Typing the name is still asked for and still files it, because a
 * browser that cannot keep the picture (private browsing, no storage) must
 * not stop an inspection being filed; the drawing then waits to be cleared.
 */
export function InspectionRun({
  programs, filed, inspectorName, onFile, onPhoto,
}: {
  programs: FieldInspectionProgram[];
  filed: VisitInspection[];
  inspectorName: string;
  onFile: (input: {
    program: FieldInspectionProgram;
    built: ReturnType<typeof buildInspection>;
    inspectorName: string;
    inspectorLicense: string;
    signedByName: string;
    /** The drawn signature as a PNG data URL, or null when only the name was typed. */
    signature: string | null;
  }) => Promise<string | null>;
  onPhoto: (file: File) => Promise<{ uploadId: string } | { problem: string }>;
}) {
  const [programId, setProgramId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, CheckpointEntry>>({});
  const [inspector, setInspector] = useState(inspectorName);
  const [license, setLicense] = useState("");
  const [signedBy, setSignedBy] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const ink = useRef<InkHandle | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (programs.length === 0 && filed.length === 0) return null;
  const program = programs.find((p) => p.id === programId) ?? null;
  const set = (key: string, change: Partial<CheckpointEntry>) =>
    setEntries((all) => ({ ...all, [key]: { ...all[key], ...change } }));

  async function file(force: boolean) {
    if (!program) return;
    const built = buildInspection({ program, entries, by: inspector.trim() || inspectorName, at: new Date() });
    if (built.answers.length === 0) { setProblem("Nothing has been answered yet."); return; }
    if (!signedBy.trim()) { setProblem("Type your name to sign the inspection off."); return; }
    if (built.unanswered.length > 0 && !force) { setConfirming(built.unanswered); return; }
    setBusy(true);
    const failed = await onFile({
      program, built, inspectorName: inspector, inspectorLicense: license, signedByName: signedBy, signature,
    });
    setBusy(false);
    // Nothing is thrown away when it could not be kept: they can clear the drawing and file with the name.
    if (failed) { setProblem(failed); setConfirming(null); return; }
    setSignature(null);
    setProgramId(null);
    setEntries({});
    setConfirming(null);
    setProblem(null);
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Inspections</p>
      {filed.length > 0 && (
        <ul className="mt-1 space-y-1 text-sm">
          {filed.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span>{i.programName}</span>
              <span className="text-ink-500">{i.waiting ? "Waiting to send" : resultLabel(i.result)}</span>
            </li>
          ))}
        </ul>
      )}

      {!program && programs.length > 0 && (
        <label className="mt-2 block">
          <span className="sr-only">Run an inspection</span>
          <select
            value=""
            onChange={(e) => { setProgramId(e.target.value || null); setEntries({}); setProblem(null); }}
            className="h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base"
          >
            <option value="">Run an inspection…</option>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}

      {program && (
        <div className="mt-2 space-y-3 rounded border border-steel-300 p-3">
          <p className="font-medium">{program.name}</p>
          {program.standard && <p className="text-xs text-ink-500">Performed under {program.standard}</p>}
          <ol className="space-y-3">
            {program.checkpoints.map((checkpoint) => {
              const entry = entries[checkpoint.key] ?? {};
              const reading = checkpoint.requiresReading ? checkReading(checkpoint, entry.reading ?? "") : null;
              const na = entry.notApplicable !== undefined;
              return (
                <li key={checkpoint.key} className="border-t border-steel-200 pt-3">
                  <p className="text-base">{checkpoint.label}</p>
                  {checkpoint.requiresReading ? (
                    <label className="mt-2 flex items-center gap-2">
                      <input
                        inputMode="decimal"
                        aria-label={`${checkpoint.label} reading`}
                        value={entry.reading ?? ""}
                        disabled={na}
                        onChange={(e) => set(checkpoint.key, { reading: e.target.value })}
                        className="h-12 w-32 rounded border border-steel-300 px-3 text-base tabular-nums"
                      />
                      <span className="text-ink-500">{checkpoint.unit}</span>
                      <span className="text-xs text-ink-500">
                        {checkpoint.min !== null && checkpoint.max !== null ? `${checkpoint.min} to ${checkpoint.max}`
                          : checkpoint.min !== null ? `at least ${checkpoint.min}` : checkpoint.max !== null ? `at most ${checkpoint.max}` : ""}
                      </span>
                    </label>
                  ) : (
                    <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label={checkpoint.label}>
                      {([true, false] as const).map((passed) => (
                        <button
                          key={String(passed)}
                          type="button"
                          aria-pressed={entry.passed === passed}
                          disabled={na}
                          onClick={() => set(checkpoint.key, { passed })}
                          className={`h-12 rounded border text-base font-medium ${entry.passed === passed
                            ? passed ? "border-green-700 bg-green-tint text-green-700" : "border-red-600 bg-red-tint text-red-600"
                            : "border-steel-300"}`}
                        >
                          {passed ? "Pass" : "Fail"}
                        </button>
                      ))}
                    </div>
                  )}
                  {reading && (reading.state === "out_of_range" || reading.state === "not_a_number") && (
                    <p className="mt-1 text-sm text-red-600">{reading.message}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-sm">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={na}
                             onChange={(e) => set(checkpoint.key, { notApplicable: e.target.checked ? "" : undefined })} />
                      Not applicable
                    </label>
                    <label className="cursor-pointer underline underline-offset-4">
                      Photo{entry.photoIds && entry.photoIds.length > 0 ? ` (${entry.photoIds.length})` : ""}
                      <input type="file" accept="image/*" capture="environment" className="sr-only"
                             aria-label={`Photo for ${checkpoint.label}`}
                             onChange={async (e) => {
                               const picked = e.target.files?.[0];
                               e.target.value = "";
                               if (!picked) return;
                               const kept = await onPhoto(picked);
                               if ("problem" in kept) { setProblem(kept.problem); return; }
                               set(checkpoint.key, { photoIds: [...(entry.photoIds ?? []), kept.uploadId] });
                             }} />
                    </label>
                  </div>
                  {na && (
                    <input
                      aria-label={`Why ${checkpoint.label} does not apply`}
                      placeholder="Why it does not apply"
                      value={entry.notApplicable ?? ""}
                      onChange={(e) => set(checkpoint.key, { notApplicable: e.target.value })}
                      className="mt-2 h-12 w-full rounded border border-steel-300 px-3 text-base"
                    />
                  )}
                  <input
                    aria-label={`Note on ${checkpoint.label}`}
                    placeholder="What you saw (optional)"
                    value={entry.note ?? ""}
                    onChange={(e) => set(checkpoint.key, { note: e.target.value })}
                    className="mt-2 h-10 w-full rounded border border-steel-300 px-3 text-sm"
                  />
                </li>
              );
            })}
          </ol>

          <div className="space-y-2 border-t border-steel-200 pt-3">
            <label className="block text-sm">Inspector
              <input value={inspector} onChange={(e) => setInspector(e.target.value)} className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base" />
            </label>
            <label className="block text-sm">Licence number
              <input value={license} onChange={(e) => setLicense(e.target.value)} className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base" />
            </label>
            <label className="block text-sm">Type your name to sign it off
              <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} autoComplete="name" className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base" />
            </label>
            <div>
              <p className="text-sm">Sign in the box</p>
              <div className="mt-1">
                <SignatureCanvas label="Inspector's signature" onChange={setSignature} handle={ink} />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  disabled={!signature || busy}
                  onClick={() => ink.current?.clear()}
                  className="inline-flex h-10 items-center rounded border border-steel-300 px-4 text-sm font-medium disabled:opacity-60"
                >
                  Clear signature
                </button>
                <p className="text-xs text-ink-500">
                  {signature ? "Signed." : "Draw it with your finger, or file it with your typed name only."}
                </p>
              </div>
            </div>
          </div>

          {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
          {confirming && (
            <div role="alert" className="rounded border border-amber-700 bg-amber-tint p-3 text-sm text-ink-900">
              <p>Not answered: {confirming.join(", ")}. It will be filed as not finished, which is not a pass.</p>
              <button type="button" onClick={() => void file(true)} className="mt-2 h-12 w-full rounded border border-ink-900 text-base font-medium">
                File it as not finished
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setProgramId(null); setConfirming(null); }} className="h-12 rounded border border-steel-300 text-base">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void file(false)} className="h-12 rounded bg-ink-900 text-base font-medium text-white disabled:opacity-60">
              File inspection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
