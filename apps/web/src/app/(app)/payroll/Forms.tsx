"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useEffect, useRef } from "react";
import { close, declare, exportCsv, payOut, reopen, type ExportState, type PayrollState } from "./actions";

const input = "h-9 rounded border border-steel-300 px-2 text-sm";
const button = "inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60";
const primary = "inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60";

function Said({ state }: { state: PayrollState }) {
  if (state?.error) return <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>;
  if (state?.done) return <p role="status" className="mt-2 text-sm text-ink-500">Done.</p>;
  return null;
}

/** A start date and whole workweeks, which is all a period is. */
export function DeclarePeriod() {
  const [state, actionForm, pending] = useKeptAction(declare, null);
  return (
    <form {...actionForm} className="mt-3 flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-ink-500">Name
        <input name="label" required placeholder="Weeks 11 and 12" className={input} />
      </label>
      <label className="grid gap-1 text-xs text-ink-500">First day
        <input name="startDate" type="date" required className={input} />
      </label>
      <label className="grid gap-1 text-xs text-ink-500">Weeks
        <select name="weeks" defaultValue="2" className={input}>
          {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      <button type="submit" disabled={pending} className={primary}>{pending ? "Saving" : "Add period"}</button>
      <div className="basis-full"><Said state={state} /></div>
    </form>
  );
}

export function ClosePeriod({ periodId }: { periodId: string }) {
  const [state, actionForm, pending] = useKeptAction(close, null);
  return (
    <form {...actionForm} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="periodId" value={periodId} />
      <input name="note" placeholder="Note, e.g. sent to the bureau" className={`${input} min-w-64`} />
      <button type="submit" disabled={pending} className={primary}>{pending ? "Closing" : "Close period"}</button>
      <div className="basis-full"><Said state={state} /></div>
    </form>
  );
}

export function ReopenPeriod({ periodId }: { periodId: string }) {
  const [state, actionForm, pending] = useKeptAction(reopen, null);
  return (
    <form {...actionForm} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="periodId" value={periodId} />
      <input name="reason" required placeholder="Why it is being reopened" className={`${input} min-w-64`} />
      <button type="submit" disabled={pending} className={button}>{pending ? "Reopening" : "Reopen"}</button>
      <div className="basis-full"><Said state={state} /></div>
    </form>
  );
}

export function PayCommissions({ periodId }: { periodId: string }) {
  const [state, actionForm, pending] = useKeptAction(payOut, null);
  return (
    <form {...actionForm}>
      <input type="hidden" name="periodId" value={periodId} />
      <button type="submit" disabled={pending} className={button}>
        {pending ? "Recording" : "Record commissions as paid"}
      </button>
      <Said state={state} />
    </form>
  );
}

/** Produces the file, then saves it from the browser. */
export function ExportCsv({ periodId, label }: { periodId: string; label: string }) {
  const [state, actionForm, pending] = useKeptAction<ExportState>(exportCsv, null);
  const saved = useRef<string | null>(null);

  useEffect(() => {
    if (!state || !("file" in state) || saved.current === state.file.checksum) return;
    saved.current = state.file.checksum;
    const url = URL.createObjectURL(new Blob([state.file.content], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: state.file.name });
    link.click();
    URL.revokeObjectURL(url);
  }, [state]);

  return (
    <form {...actionForm}>
      <input type="hidden" name="periodId" value={periodId} />
      <input type="hidden" name="label" value={label} />
      <button type="submit" disabled={pending} className={primary}>{pending ? "Exporting" : "Export CSV"}</button>
      {state && "error" in state && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
      {state && "file" in state && (
        <p role="status" className="mt-2 text-sm text-ink-500">
          Saved {state.file.name}.{state.file.previouslyExported && " This period had been exported before; the file is the same."}
        </p>
      )}
    </form>
  );
}
