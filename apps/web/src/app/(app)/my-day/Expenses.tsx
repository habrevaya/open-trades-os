"use client";

import { useState } from "react";
import { checkExpenseDraft, formatAmount, type DayExpense } from "@opentradesos/field-client";

/**
 * MONEY I SPENT FOR THE COMPANY, ON THE PAGE
 *
 * What the technician paid for out of their own pocket: the amount, the day,
 * what it was for, the job if there was one and a photograph of the receipt.
 * Kept in the same queue as the rest of the day, so it is saved with no
 * signal and sent when there is one, and the office's answer comes back with
 * the day: approved, or not approved with the reason in the office's words.
 */

const button = "flex h-12 w-full items-center justify-center rounded border border-steel-300 px-4 text-base font-medium disabled:opacity-60";
const primary = "flex h-12 w-full items-center justify-center rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60";
const field = "h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";

export interface ExpenseJob { jobId: string; jobNumber: number; customerName: string }

export function ExpensesPanel({ expenses, jobs, today, onSave }: {
  expenses: DayExpense[];
  jobs: ExpenseJob[];
  /** The company's date today, which is the day a receipt defaults to. */
  today: string;
  onSave: (input: {
    amount: string; spentOn: string; description: string; jobId: string | null; jobNumber: number | null; receipt: File | null;
  }) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [day, setDay] = useState(today);
  const [jobId, setJobId] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const refused = expenses.filter((e) => e.status === "refused").length;

  async function save() {
    setSaved(false);
    const checked = checkExpenseDraft({ amount, spentOn: day, description: what, jobId: jobId || null }, today);
    if (!checked.ok) { setProblem(checked.reason); return; }
    setProblem(null);
    setBusy(true);
    try {
      const job = jobs.find((j) => j.jobId === jobId);
      const failed = await onSave({
        amount: checked.amount, spentOn: checked.spentOn, description: checked.description,
        jobId: checked.jobId, jobNumber: job?.jobNumber ?? null, receipt,
      });
      if (failed) { setProblem(failed); return; }
      setAmount(""); setWhat(""); setReceipt(null); setJobId(""); setDay(today); setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Money I spent" className="space-y-2 rounded-md border border-steel-200 p-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm font-medium">
          Money I spent for the company
          {refused > 0 ? <span className="ml-2 text-red-600">{refused} not approved</span> : null}
        </p>
        <button type="button" className="h-12 rounded border border-steel-300 px-4 text-base font-medium"
                aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add one"}
        </button>
      </div>

      {open && (
        <div className="space-y-2">
          <p className="text-sm text-ink-500">
            Paid for something for the company out of your own pocket? Put it here with a photo of the receipt.
            The office pays it back with your pay, with no tax taken off it.
          </p>
          <label className="block">
            <span className="text-sm font-medium">What you paid</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="42.50" className={field} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">What it was for</span>
            <input value={what} onChange={(e) => setWhat(e.target.value)} maxLength={300} placeholder="Capacitor from the supply house" className={field} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Day you paid it</span>
            <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Which job</span>
            <select value={jobId} onChange={(e) => setJobId(e.target.value)} className={field}>
              <option value="">Not for a job</option>
              {jobs.map((j) => <option key={j.jobId} value={j.jobId}>Job {j.jobNumber}, {j.customerName}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Photo of the receipt</span>
            <input type="file" accept="image/*,application/pdf" capture="environment" aria-label="Photo of the receipt"
                   onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
          </label>
          {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
          {saved && <p role="status" className="rounded bg-green-tint px-3 py-2 text-sm text-green-700">Saved. It is sent when there is a signal.</p>}
          <button type="button" className={primary} disabled={busy} onClick={() => void save()}>Save it</button>
          <button type="button" className={button} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}

      {expenses.length > 0 && (
        <ul className="divide-y divide-steel-200 text-sm">
          {expenses.map((e) => (
            <li key={e.id} className="py-2">
              <p className="font-medium">{formatAmount(e.amount)}, {e.description}</p>
              <p className="text-ink-500">
                {[e.spentOn, e.jobNumber ? `Job ${e.jobNumber}` : "Not for a job", e.receipts > 0 ? "Receipt kept" : "No receipt"].join(", ")}
              </p>
              <p className={e.status === "refused" ? "text-red-600" : e.status === "approved" ? "text-green-700" : "text-ink-700"}>
                {e.waiting ? "Waiting to send"
                  : e.status === "approved" ? "Approved: the office will pay you back"
                  : e.status === "refused" ? "Not approved"
                  : "Waiting for the office"}
              </p>
              {e.status === "refused" && e.decisionReason ? <p className="text-ink-700">{e.decisionReason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
