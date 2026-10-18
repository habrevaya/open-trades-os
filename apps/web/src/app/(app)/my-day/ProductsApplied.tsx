"use client";

import { useState } from "react";
import {
  applicationFromBook, checkApplied, type ChemicalChoice, type DayReportField,
} from "@opentradesos/field-client";

/**
 * WHAT WAS APPLIED ON THIS VISIT, CHOSEN FROM THE PRICE BOOK
 *
 * The report's product questions, answered the way the phone app answers
 * them: the product picked from the chemicals the company marks in its price
 * book, and how much, in the unit its cost is per. The book's name, EPA
 * number and unit go on the record, so nothing regulated is typed twice and
 * the office can cost what was applied. A product the book does not hold is
 * typed, under "Not in the price book", and kept as typed.
 *
 * Kept in the same queue as the rest of the day, so it is saved with no
 * signal. A report already sent to the office is shown and not changed.
 */

const primary = "flex h-12 w-full items-center justify-center rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60";
const input = "h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";

export function ProductsApplied({ questions, chemicals, locked, onSave }: {
  /** The report's chemical questions, with what is recorded for each. */
  questions: DayReportField[];
  chemicals: ChemicalChoice[];
  /** The report has been sent to the office. */
  locked: boolean;
  onSave: (payload: Record<string, unknown>) => Promise<string | null>;
}) {
  if (questions.length === 0) return null;
  return (
    <section aria-label="Products applied" className="rounded border border-steel-200 p-3">
      <h3 className="text-base font-semibold">Products applied</h3>
      {questions.map((q) => (
        <Question key={q.key} question={q} chemicals={chemicals} locked={locked} onSave={onSave} />
      ))}
    </section>
  );
}

function Question({ question, chemicals, locked, onSave }: {
  question: DayReportField;
  chemicals: ChemicalChoice[];
  locked: boolean;
  onSave: (payload: Record<string, unknown>) => Promise<string | null>;
}) {
  const [chosen, setChosen] = useState("");
  const [amount, setAmount] = useState("");
  const [typed, setTyped] = useState({ product: "", epa: "", unit: "", amount: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chemical = chemicals.find((c) => c.id === chosen) ?? null;

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const failed = await onSave(payload);
      if (failed) { setProblem(failed); return; }
      setProblem(null);
      setChosen("");
      setAmount("");
      setTyped({ product: "", epa: "", unit: "", amount: "" });
    } finally {
      setBusy(false);
    }
  }

  async function saveFromBook() {
    if (!chemical) { setProblem("Choose the product applied."); return; }
    const checked = checkApplied(amount);
    if (!checked.ok) { setProblem(checked.problem); return; }
    await send(applicationFromBook(question, chemical, checked.quantity));
  }

  async function saveTyped() {
    const checked = checkApplied(typed.amount);
    if (typed.product.trim() === "") { setProblem("Type the product's name."); return; }
    if (!checked.ok) { setProblem(checked.problem); return; }
    await send({
      field: question.key, label: question.label, kind: "chemical", value: typed.product.trim(),
      productName: typed.product.trim(),
      ...(typed.epa.trim() ? { epaRegistrationNumber: typed.epa.trim() } : {}),
      quantityApplied: checked.quantity,
      ...(typed.unit.trim() ? { applicationUnit: typed.unit.trim() } : {}),
    });
  }

  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-ink-700">{question.label}</p>
      <p className="text-base text-ink-900">
        {question.value !== null ? `Recorded: ${question.value}` : "Nothing recorded yet."}
        {question.waiting ? <span className="text-sm text-amber-700"> waiting to send</span> : null}
      </p>
      {locked ? null : (
        <>
          {chemicals.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <label className="col-span-2 block min-w-0">
                <span className="text-sm text-ink-700">Product</span>
                <select className={`mt-1 ${input}`} value={chosen} onChange={(e) => setChosen(e.target.value)}
                        aria-label={`${question.label}: product`}>
                  <option value="">Choose the product</option>
                  {chemicals.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-ink-700">How much{chemical ? `, ${chemical.unit}` : ""}</span>
                <input className={`mt-1 ${input}`} inputMode="decimal" value={amount}
                       aria-label={`${question.label}: how much`} onChange={(e) => setAmount(e.target.value)} />
              </label>
              {chemical?.epaRegistrationNumber ? (
                <p className="col-span-3 text-sm text-ink-500">EPA {chemical.epaRegistrationNumber}</p>
              ) : null}
              <button type="button" className={`col-span-3 ${primary}`} disabled={busy} onClick={() => void saveFromBook()}>
                Save
              </button>
            </div>
          )}
          <details className="mt-2" open={chemicals.length === 0}>
            <summary className="cursor-pointer text-sm text-ink-700">Not in the price book</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input className={`col-span-2 ${input}`} placeholder="Product name" value={typed.product}
                     aria-label={`${question.label}: product name`} onChange={(e) => setTyped({ ...typed, product: e.target.value })} />
              <input className={`col-span-2 ${input}`} placeholder="EPA registration number" value={typed.epa}
                     aria-label={`${question.label}: EPA registration number`} onChange={(e) => setTyped({ ...typed, epa: e.target.value })} />
              <input className={input} inputMode="decimal" placeholder="How much" value={typed.amount}
                     aria-label={`${question.label}: amount typed`} onChange={(e) => setTyped({ ...typed, amount: e.target.value })} />
              <input className={input} placeholder="Unit" value={typed.unit}
                     aria-label={`${question.label}: unit`} onChange={(e) => setTyped({ ...typed, unit: e.target.value })} />
              <button type="button" className={`col-span-2 ${primary}`} disabled={busy} onClick={() => void saveTyped()}>
                Save as typed
              </button>
            </div>
          </details>
        </>
      )}
      {problem ? <p role="alert" className="mt-2 text-sm text-red-600">{problem}</p> : null}
    </div>
  );
}
