"use client";

import { useState } from "react";

/**
 * CHOOSING A COPY AND SENDING IT
 *
 * The file goes as the request's body to the upload route rather than through
 * a server action, because a server action takes a few megabytes and a
 * company's copy is gigabytes. Sent with a progress bar, because a large copy
 * takes minutes to upload and a button that says "Checking" for all of them
 * looks like a page that has hung.
 *
 * Either button sends the whole file: the check is the restore itself, rolled
 * back, so what it says is what would happen, and nothing is kept between the
 * check and the restore that the restore would then have to trust.
 */
export function RestoreForm({ canRestore }: { canRestore: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [keepSending, setKeepSending] = useState(false);
  const [sending, setSending] = useState<null | "check" | "restore">(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function send(mode: "check" | "restore") {
    if (!file) {
      setError("Choose the copy to restore: the .zip or .ndjson file from Take a copy.");
      return;
    }
    setError(null);
    setSending(mode);
    setProgress(0);
    const query = new URLSearchParams({
      dryRun: mode === "check" ? "1" : "0", keepSending: keepSending ? "1" : "0", name: file.name,
    });
    const request = new XMLHttpRequest();
    request.open("POST", `/setup/restore/upload?${query.toString()}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-opentradesos-restore", "1");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let answer: { runId?: string; error?: string } = {};
      try {
        answer = JSON.parse(request.responseText) as typeof answer;
      } catch {
        answer = { error: "The server did not answer in a way this page understands. Nothing was restored." };
      }
      if (request.status >= 200 && request.status < 300 && answer.runId) {
        window.location.assign(`/setup/restore?run=${encodeURIComponent(answer.runId)}`);
        return;
      }
      setSending(null);
      setError(answer.error ?? `The server answered ${request.status}. Nothing was restored.`);
    };
    request.onerror = () => {
      setSending(null);
      setError("The upload stopped before it finished. Nothing was restored; try again.");
    };
    request.send(file);
  }

  return (
    <div className="mt-4 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-ink-700">The copy</span>
        <input
          type="file" name="copy" accept=".zip,.ndjson,application/zip,application/x-ndjson"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={keepSending}
               onChange={(event) => setKeepSending(event.target.checked)} />
        <span>
          Let texts, emails and webhooks go out straight away. Leave this off unless the old company is gone for
          good: with it off, every connection waits for you to check it on Settings, Integrations.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={sending !== null} onClick={() => send("check")}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
          {sending === "check" ? "Checking" : "Check this copy"}
        </button>
        {canRestore ? (
          <button type="button" disabled={sending !== null} onClick={() => send("restore")}
                  className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
            {sending === "restore" ? "Restoring" : "Restore it into this company"}
          </button>
        ) : null}
        {sending ? (
          <span role="status" className="text-sm text-ink-700">
            {progress < 100 ? `Sending, ${progress}%` : "Reading the copy. A large company takes a few minutes."}
          </span>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
