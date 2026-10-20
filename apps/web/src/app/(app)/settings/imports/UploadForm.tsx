"use client";

import { useRef, useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { imports as rules } from "@opentradesos/core";
import { uploadSpreadsheet, readWorkbookSheets, type Sheets } from "./actions";

/**
 * THE UPLOAD. A file over the limit is refused here, before it is sent,
 * because the server would refuse it anyway and a five megabyte upload on a
 * truck's signal is a long wait for "too large". The server still checks:
 * this only saves the wait.
 *
 * A WORKBOOK ASKS WHICH SHEET. As soon as an .xlsx is chosen it is sent to be
 * read, the sheets come back with their rows, and the owner picks one. It is
 * sent again with the form, so nothing is kept on the server between the two.
 */
export function UploadForm() {
  const [state, form, pending] = useKeptAction(uploadSpreadsheet, null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [kind, setKind] = useState<rules.ImportKind>("customers");
  const [sheets, setSheets] = useState<Sheets | "reading" | null>(null);
  const [sheet, setSheet] = useState("");
  /** Which file the sheets belong to, so a slow answer for a file since replaced is dropped. */
  const latest = useRef(0);

  /** The file just chosen: a workbook is read for its sheets, anything else clears them. */
  async function chosen(file: File | undefined) {
    const mine = ++latest.current;
    setSheets(null);
    setSheet("");
    setTooBig(null);
    if (!file || !/\.xlsx$/i.test(file.name)) return;
    if (file.size > rules.MAX_BYTES) {
      setTooBig(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Bring in at most 5 MB at a time: split it into smaller files and bring each one in.`);
      return;
    }
    setSheets("reading");
    const body = new FormData();
    body.set("file", file);
    const answer = await readWorkbookSheets(body);
    if (mine !== latest.current) return;
    setSheets(answer);
    if (answer.ok) setSheet(answer.sheets.find((s) => s.why === null)?.name ?? "");
  }
  const unreadable = sheets !== null && sheets !== "reading" && (!sheets.ok || sheets.sheets.every((s) => s.why !== null));

  return (
    <form
      {...form}
      className="mt-4 max-w-2xl space-y-4"
      onSubmit={(event) => {
        const input = event.currentTarget.elements.namedItem("file") as HTMLInputElement | null;
        const file = input?.files?.[0];
        if (file && file.size > rules.MAX_BYTES) {
          event.preventDefault();
          setTooBig(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Bring in at most 5 MB at a time: split it into smaller files and bring each one in.`);
        } else {
          setTooBig(null);
        }
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-ink-700">What is in the file</legend>
        <div className="mt-2 space-y-2">
          {rules.IMPORT_KINDS.map((k) => (
            <label key={k} className="flex items-start gap-2 text-sm">
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1 h-4 w-4" />
              <span>
                <span className="font-medium">{rules.KIND_LABEL[k].label}</span>
                <span className="block text-ink-500">{rules.KIND_LABEL[k].summary}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="text-sm font-medium text-ink-700">The file (CSV) or workbook (.xlsx)</span>
        <input type="file" name="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
               required className="mt-1 block text-sm" onChange={(event) => { void chosen(event.currentTarget.files?.[0]); }} />
      </label>
      {sheets === "reading" ? <p role="status" className="text-sm text-ink-500">Reading the workbook</p> : null}
      {sheets !== null && sheets !== "reading" && !sheets.ok ? (
        <p role="alert" className="text-sm text-red-600">{sheets.refusal}</p>
      ) : null}
      {sheets !== null && sheets !== "reading" && sheets.ok ? (
        <fieldset>
          <legend className="text-sm font-medium text-ink-700">Which sheet to bring in</legend>
          <p className="mt-1 text-sm text-ink-500">
            {sheets.sheets.length === 1 ? "This workbook has one sheet." : "This workbook has more than one sheet. Each is a separate list: bring in one at a time."}
          </p>
          <div className="mt-2 space-y-2">
            {sheets.sheets.map((s) => (
              <label key={s.name} className="flex items-start gap-2 text-sm">
                <input type="radio" name="sheet" value={s.name} checked={sheet === s.name} disabled={s.why !== null}
                       onChange={() => setSheet(s.name)} className="mt-1 h-4 w-4" />
                <span>
                  <span className="font-medium">{s.name}</span>
                  {s.why === null ? (
                    <span className="block text-ink-500">
                      {s.rows} {s.rows === 1 ? "row" : "rows"}. Columns: {s.header.filter((h) => h !== "").join(", ") || "none named"}
                    </span>
                  ) : (
                    <span className="block text-ink-500">Cannot be brought in. {s.why}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="holdAutomations" value="1" defaultChecked className="mt-1 h-4 w-4" />
        <span>
          <span className="font-medium">Do not start automations for what this file brings in</span>
          <span className="block text-ink-500">
            Leave this on so nobody on the list gets a welcome text or a review request about work from years ago.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || sheets === "reading" || unreadable}
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Reading the file" : "Upload and match the columns"}
        </button>
      </div>
      {tooBig ? <p role="alert" className="text-sm text-red-600">{tooBig}</p> : null}
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
