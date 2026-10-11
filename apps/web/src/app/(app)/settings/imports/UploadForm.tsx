"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { imports as rules } from "@opentradesos/core";
import { uploadSpreadsheet } from "./actions";

/**
 * THE UPLOAD. A file over the limit is refused here, before it is sent,
 * because the server would refuse it anyway and a five megabyte upload on a
 * truck's signal is a long wait for "too large". The server still checks:
 * this only saves the wait.
 */
export function UploadForm() {
  const [state, form, pending] = useKeptAction(uploadSpreadsheet, null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [kind, setKind] = useState<rules.ImportKind>("customers");

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
        <span className="text-sm font-medium text-ink-700">The file (CSV)</span>
        <input type="file" name="file" accept=".csv,text/csv" required className="mt-1 block text-sm" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Reading the file" : "Upload and match the columns"}
        </button>
      </div>
      {tooBig ? <p role="alert" className="text-sm text-red-600">{tooBig}</p> : null}
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
