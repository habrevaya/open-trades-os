"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { applyTicketsAction, previewTicketsAction } from "./actions";

const SAYS = { attach: "Attach", unchanged: "Already recorded", skip: "Skipped" } as const;

/**
 * A FACILITY'S TICKETS, PREVIEWED BEFORE ANYTHING IS WRITTEN
 *
 * Pick the file or paste it. The preview says which haul each ticket weighed
 * and why any is skipped; untick anything to leave alone, then apply.
 */
export function TicketImport() {
  const [csv, setCsv] = useState("");
  const [preview, previewForm, previewing] = useKeptAction(previewTicketsAction, null);
  const [applied, applyForm, applying] = useKeptAction(applyTicketsAction, null);
  const rows = preview?.preview?.rows ?? [];

  return (
    <div className="space-y-6">
      <form {...previewForm} className="space-y-4">
        <label className="block text-sm">
          <span className="font-medium text-ink-700">The file</span>
          <input type="file" accept=".csv,text/csv" className="mt-1 block text-sm"
                 onChange={async (event) => {
                   const file = event.target.files?.[0];
                   if (file) setCsv(await file.text());
                 }} />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-ink-700">Or paste it: a header line, then a row per ticket</span>
          <textarea name="csv" rows={8} value={csv} onChange={(event) => setCsv(event.target.value)} required
                    placeholder={"ticket,date,container,net tons,material,facility\nW-1001,06/15/2026,4012,3.1,C&D,County Landfill"}
                    className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 font-mono text-sm" />
        </label>
        <button type="submit" disabled={previewing}
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {previewing ? "Reading" : "Preview"}
        </button>
        {preview?.error ? <p role="alert" className="text-sm text-red-600">{preview.error}</p> : null}
      </form>

      {preview?.preview ? (
        <form {...applyForm} className="space-y-3" aria-label="Preview">
          <input type="hidden" name="csv" value={csv} />
          <p className="text-sm text-ink-700">
            {preview.preview.counts.attach} to attach, {preview.preview.counts.unchanged} already recorded,{" "}
            {preview.preview.counts.skip + preview.preview.problems.length} skipped.
          </p>
          {preview.preview.problems.length > 0 ? (
            <ul className="text-sm text-red-600">
              {preview.preview.problems.map((p) => <li key={p.line}>Line {p.line}: {p.message}</li>)}
            </ul>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-steel-200">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-steel-200 bg-steel-100 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-ink-700">Apply</th>
                  <th className="px-3 py-2 font-medium text-ink-700">Ticket</th>
                  <th className="px-3 py-2 font-medium text-ink-700">Can</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-700">Tons</th>
                  <th className="px-3 py-2 font-medium text-ink-700">What happens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-200">
                {rows.map((row) => (
                  <tr key={row.line}>
                    <td className="px-3 py-2">
                      <input type="hidden" name="line" value={String(row.line)} />
                      {row.action === "attach" ? (
                        <input type="checkbox" name="keep" value={String(row.line)} defaultChecked aria-label={`Apply ticket ${row.ticketNumber}`} />
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono">{row.ticketNumber}</td>
                    <td className="px-3 py-2 font-mono">{row.container}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(row.netTons)}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{SAYS[row.action]}</span>
                      <span className={row.action === "skip" ? "text-red-600" : "text-ink-700"}>: {row.why}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="submit" disabled={applying}
                  className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
            {applying ? "Applying" : "Attach the ticked tickets"}
          </button>
          {applied?.error ? <p role="alert" className="text-sm text-red-600">{applied.error}</p> : null}
          {applied?.applied ? (
            <p role="status" className="text-sm text-ink-700">Attached {applied.applied.attached} tickets to their hauls.</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
