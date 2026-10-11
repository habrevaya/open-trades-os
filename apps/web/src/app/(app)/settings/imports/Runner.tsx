"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { runStep } from "./actions";

/**
 * CHECKING AND LOADING, A BATCH AT A TIME, WITH THE COUNT ON THE SCREEN.
 *
 * Each press runs one batch per request until the server says there is no
 * more, so a file of ten thousand rows is a hundred short requests rather
 * than one that a proxy cuts off at a minute. Closing the page stops it
 * between batches, and every batch that finished is kept: pressing the button
 * again carries on from the next one.
 */
export function Runner({ id, step, label, rows }: {
  id: string; step: "check" | "load"; label: string; rows: number;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function go() {
    setRunning(true);
    setRefusal(null);
    try {
      for (;;) {
        const answer = await runStep(id, step);
        if (!answer.ok) { setRefusal(answer.refusal); break; }
        setDone(answer.done);
        if (!answer.more) break;
      }
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <button type="button" onClick={go} disabled={running}
              className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
        {running ? (step === "check" ? "Checking" : "Loading") : label}
      </button>
      {done !== null ? (
        <p role="status" className="text-sm text-ink-700">
          {step === "check" ? "Checked" : "Through"} {done.toLocaleString("en-US")} of {rows.toLocaleString("en-US")} rows
          {running ? "..." : "."}
        </p>
      ) : null}
      {done !== null ? (
        <div className="h-2 max-w-md overflow-hidden rounded bg-steel-100" aria-hidden="true">
          <div className="h-2 bg-ink-900" style={{ width: `${Math.min(100, Math.round((done / Math.max(rows, 1)) * 100))}%` }} />
        </div>
      ) : null}
      {refusal ? <p role="alert" className="text-sm text-red-600">{refusal}</p> : null}
    </div>
  );
}
