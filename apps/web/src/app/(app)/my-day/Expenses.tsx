"use client";

import { useState } from "react";
import { checkExpenseDraft, expenseFigure, type DayExpense } from "@opentradesos/field-client";

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

export function ExpensesPanel({ expenses, jobs, today, mileageRate, vehicles = [], workRates = false, onSave }: {
  expenses: DayExpense[];
  jobs: ExpenseJob[];
  /** The company's date today, which is the day a receipt defaults to. */
  today: string;
  /** What the company pays for one mile today, or null when it has set none, which hides the claim in miles. */
  mileageRate: string | null;
  /**
   * The vehicle picker's choices, from `vehicleChoices`: empty when no company vehicle has a rate of its own,
   * and then there is no picker.
   */
  vehicles?: { value: string; label: string }[];
  /** Whether a job's kind of work may pay its own rate for a mile, which the form says. */
  workRates?: boolean;
  onSave: (input: {
    amount: string; miles: string; vehicleId: string; spentOn: string; description: string; jobId: string | null; jobNumber: number | null; receipt: File | null;
  }) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [miles, setMiles] = useState("");
  const [vehicleId, setVehicleId] = useState("");
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
    const checked = checkExpenseDraft({ amount, miles, vehicleId, spentOn: day, description: what, jobId: jobId || null }, today);
    if (!checked.ok) { setProblem(checked.reason); return; }
    setProblem(null);
    setBusy(true);
    try {
      const job = jobs.find((j) => j.jobId === jobId);
      const failed = await onSave({
        amount: checked.amount ?? "", miles: checked.miles ?? "", vehicleId: checked.vehicleId ?? "",
        spentOn: checked.spentOn, description: checked.description,
        jobId: checked.jobId, jobNumber: job?.jobNumber ?? null, receipt,
      });
      if (failed) { setProblem(failed); return; }
      setAmount(""); setMiles(""); setVehicleId(""); setWhat(""); setReceipt(null); setJobId(""); setDay(today); setSaved(true);
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
          {(mileageRate !== null || vehicles.length > 0) && (
            <label className="block">
              <span className="text-sm font-medium">Or the miles you drove</span>
              <input value={miles} onChange={(e) => setMiles(e.target.value)} inputMode="decimal" placeholder="18.4" className={field} />
              <span className="mt-1 block text-sm text-ink-500">
                {mileageRate !== null
                  ? <>Your own vehicle. Fill in the miles or what you paid, not both. Miles are paid at ${mileageRate} a mile,
                    the rate for the day you drove, and the office sees the amount.</>
                  : <>Fill in the miles or what you paid, not both. Miles are paid at the rate for the vehicle you pick.</>}
                {workRates ? " A job whose kind of work has its own rate is paid at that rate." : ""}
              </span>
            </label>
          )}
          {vehicles.length > 0 && (
            <label className="block">
              <span className="text-sm font-medium">Which vehicle (if it has its own rate)</span>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={field}>
                {vehicles.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </label>
          )}
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
              <p className="font-medium">{expenseFigure(e)}, {e.description}</p>
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
