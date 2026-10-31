"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { publishVersion, writeProgramme } from "./actions";

const FIELD = "mt-1 block h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm";
const SMALL = "inline-flex h-8 items-center rounded border border-steel-300 px-2 text-sm hover:bg-steel-100 disabled:opacity-50";

export interface Remedy { priceBookItemKey: string; label: string; quantity: number; rationale: string }

export interface Checkpoint {
  key: string;
  label: string;
  assetCategory?: string | undefined;
  requiresReading?: boolean | undefined;
  unit?: string | undefined;
  range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
  remedies?: Remedy[] | undefined;
  failIsDeficiency?: boolean | undefined;
  severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
}

export interface EditorProgramme {
  name: string;
  standard: string | null;
  reportAudience: string;
  authorityName: string | null;
  frequencyMonths: number | null;
  checkpoints: Checkpoint[];
}

/**
 * How serious a fail is, in the words the backlog uses, with the deadline
 * each one sets. The deadline comes from this and from nothing typed.
 */
const SEVERITIES = [
  { value: "critical", label: "Safety: fix today" },
  { value: "major", label: "Failed: fix within 30 days" },
  { value: "minor", label: "Wearing out: fix within 180 days" },
  { value: "advisory", label: "Worth knowing: no deadline" },
] as const;

/** One checkpoint as the editor holds it: the numbers as typed, so a half typed "-" is not lost. */
interface Row {
  uid: number;
  key: string;
  label: string;
  assetCategory: string;
  reading: boolean;
  unit: string;
  min: string;
  max: string;
  close: string;
  severity: string;
  remedies: { code: string; label: string; quantity: string; rationale: string }[];
}

let next = 0;
const uid = () => (next += 1);

function toRow(c: Checkpoint): Row {
  return {
    uid: uid(),
    key: c.key,
    label: c.label,
    assetCategory: c.assetCategory ?? "",
    reading: c.requiresReading === true,
    unit: c.unit ?? "",
    min: c.range?.min === null || c.range?.min === undefined ? "" : String(c.range.min),
    max: c.range?.max === null || c.range?.max === undefined ? "" : String(c.range.max),
    close: c.range?.borderlineWithin === undefined ? "" : String(c.range.borderlineWithin),
    severity: c.severityOnFail ?? "",
    remedies: (c.remedies ?? []).map((r) => ({
      code: r.priceBookItemKey, label: r.label, quantity: String(r.quantity), rationale: r.rationale,
    })),
  };
}

const number = (typed: string): number | null => {
  const trimmed = typed.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

/** A key a technician never sees, made once from the question and kept from then on. */
function keyFor(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "check";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** The checkpoints as the route takes them. Nothing here decides whether they can be filed: the service does. */
function serialise(rows: Row[]): Checkpoint[] {
  const taken = new Set(rows.map((r) => r.key).filter((k) => k !== ""));
  return rows.map((row) => {
    const checkpoint: Checkpoint = { key: row.key || keyFor(row.label, taken), label: row.label.trim() };
    if (row.assetCategory.trim() !== "") checkpoint.assetCategory = row.assetCategory.trim();
    if (row.reading) {
      checkpoint.requiresReading = true;
      if (row.unit.trim() !== "") checkpoint.unit = row.unit.trim();
      const close = number(row.close);
      checkpoint.range = { min: number(row.min), max: number(row.max), ...(close !== null && close > 0 ? { borderlineWithin: close } : {}) };
    }
    if (row.severity !== "") checkpoint.severityOnFail = row.severity as Checkpoint["severityOnFail"];
    const remedies = row.remedies
      .filter((r) => r.code.trim() !== "" || r.label.trim() !== "" || r.rationale.trim() !== "")
      .map((r) => ({
        priceBookItemKey: r.code.trim(), label: r.label.trim(), quantity: number(r.quantity) ?? 1, rationale: r.rationale.trim(),
      }));
    if (remedies.length > 0) checkpoint.remedies = remedies;
    return checkpoint;
  });
}

/**
 * THE PROGRAMME, CHECKPOINT BY CHECKPOINT
 *
 * A list somebody edits and reorders, posted whole as JSON. Each checkpoint
 * is a question the technician answers with pass or fail or with a reading,
 * what it is about, how serious a fail is (which sets the deadline on the
 * finding), and the repairs from the price book a fail suggests quoting.
 *
 * Saving a new programme makes version 1. Saving changes to one publishes the
 * next version: inspections already done keep the version they were done
 * under. Whether it can be filed is decided by the service, which says what
 * is wrong in words under the button.
 */
export function ProgramEditor({
  mode, programme, programId, baseVersion, copiedFrom, replaceable, appliesTo, priceBook, problems,
}: {
  mode: "new" | "revise";
  programme: EditorProgramme;
  programId?: string | undefined;
  baseVersion?: number | undefined;
  /** `pack:plumbing:backflow-annual` or `program:<id>`, for a copy. */
  copiedFrom?: string | undefined;
  /** A programme this one could take the place of, and whether the box starts ticked. */
  replaceable?: { id: string; name: string; ticked: boolean } | null | undefined;
  appliesTo: string[];
  priceBook: { code: string; name: string }[];
  /** What stops the programme as it was opened from being filed. */
  problems: string[];
}) {
  const [rows, setRows] = useState<Row[]>(() => programme.checkpoints.map(toRow));
  const [audience, setAudience] = useState(programme.reportAudience);
  const [state, form, pending] = useKeptAction(mode === "new" ? writeProgramme : publishVersion, null);
  const names = new Map(priceBook.map((item) => [item.code, item.name]));

  const set = (i: number, patch: Partial<Row>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => setRows((all) => {
    const moved = [...all];
    const [taken] = moved.splice(i, 1);
    moved.splice(Math.max(0, Math.min(moved.length, i + by)), 0, taken!);
    return moved;
  });
  const setRemedy = (i: number, r: number, patch: Partial<Row["remedies"][number]>) =>
    set(i, { remedies: rows[i]!.remedies.map((x, k) => (k === r ? { ...x, ...patch } : x)) });

  return (
    <form {...form} className="mt-6 space-y-6">
      <input type="hidden" name="checkpoints" value={JSON.stringify(serialise(rows))} />
      {programId ? <input type="hidden" name="programId" value={programId} /> : null}
      {baseVersion !== undefined ? <input type="hidden" name="baseVersion" value={String(baseVersion)} /> : null}
      {copiedFrom ? <input type="hidden" name="copiedFrom" value={copiedFrom} /> : null}

      {problems.length > 0 && (
        <div role="note" className="rounded-md border border-amber-700/30 bg-amber-tint p-3 text-sm text-ink-900">
          <p className="font-medium">An inspection cannot be filed against this as it stands. Fix these before you save:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">The programme</legend>
        <label className="text-sm sm:col-span-2">Name
          <input name="name" defaultValue={programme.name} required maxLength={160} className={FIELD} />
        </label>
        <label className="text-sm">Standard it is done under
          <input name="standard" defaultValue={programme.standard ?? ""} maxLength={200} placeholder="AWWA C510" className={FIELD} />
        </label>
        <label className="text-sm">How often, in months
          <input name="frequencyMonths" type="number" min={1} max={120} defaultValue={programme.frequencyMonths ?? ""}
                 placeholder="No set interval" className={FIELD} />
        </label>
        <label className="text-sm">Who gets the report
          <select name="reportAudience" value={audience} onChange={(e) => setAudience(e.target.value)} className={FIELD}>
            <option value="customer">The customer</option>
            <option value="authority">An authority, such as the city or the water company</option>
            <option value="both">Both</option>
          </select>
        </label>
        {audience !== "customer" && (
          <label className="text-sm">Which authority
            <input name="authorityName" defaultValue={programme.authorityName ?? ""} maxLength={160} placeholder="City of Austin Water" className={FIELD} />
          </label>
        )}
      </fieldset>

      <datalist id="applies-to">
        {appliesTo.map((kind) => <option key={kind} value={kind} />)}
      </datalist>
      <datalist id="price-book-codes">
        {priceBook.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
      </datalist>

      <section aria-label="Checkpoints" className="space-y-3">
        <h2 className="text-base font-semibold">Checkpoints</h2>
        <p className="text-sm text-ink-700">
          Each one is a question the technician answers on the visit, in this order. A reading needs a unit and the
          range that passes, so the reading can be judged.
        </p>
        {rows.map((row, i) => (
          <fieldset key={row.uid} className="space-y-3 rounded-md border border-steel-200 p-3">
            <legend className="px-1 text-sm font-medium">Checkpoint {i + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm sm:col-span-2">Question
                <input value={row.label} onChange={(e) => set(i, { label: e.target.value })} maxLength={200}
                       placeholder="Relief valve opens" className={FIELD} />
              </label>
              <label className="text-sm">What it is about
                <input value={row.assetCategory} onChange={(e) => set(i, { assetCategory: e.target.value })} maxLength={60}
                       list="applies-to" placeholder="The whole property" className={FIELD} />
              </label>
              <label className="text-sm">Answer
                <select value={row.reading ? "reading" : "pass_fail"} onChange={(e) => set(i, { reading: e.target.value === "reading" })}
                        className={FIELD}>
                  <option value="pass_fail">Pass or fail</option>
                  <option value="reading">A reading</option>
                </select>
              </label>
              {row.reading && (
                <>
                  <label className="text-sm">Unit
                    <input value={row.unit} onChange={(e) => set(i, { unit: e.target.value })} maxLength={20} placeholder="psid" className={FIELD} />
                  </label>
                  <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                    <label className="text-sm">Lowest that passes
                      <input value={row.min} onChange={(e) => set(i, { min: e.target.value })} inputMode="decimal" placeholder="No lowest" className={FIELD} />
                    </label>
                    <label className="text-sm">Highest that passes
                      <input value={row.max} onChange={(e) => set(i, { max: e.target.value })} inputMode="decimal" placeholder="No highest" className={FIELD} />
                    </label>
                    <label className="text-sm">Say it is close within
                      <input value={row.close} onChange={(e) => set(i, { close: e.target.value })} inputMode="decimal" placeholder="Optional" className={FIELD} />
                    </label>
                  </div>
                </>
              )}
              <label className="text-sm sm:col-span-2">How serious a fail is
                <select value={row.severity} onChange={(e) => set(i, { severity: e.target.value })} className={FIELD}>
                  <option value="">Choose one</option>
                  {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Repairs to quote when it fails</p>
              {row.remedies.length === 0 && (
                <p className="text-xs text-ink-500">None. A finding from it is quoted at a price somebody gives.</p>
              )}
              {row.remedies.map((remedy, r) => (
                <div key={r} role="group" aria-label={`Repair ${r + 1} for checkpoint ${i + 1}`}
                     className="grid gap-2 rounded border border-steel-200 p-2 sm:grid-cols-4">
                  <label className="text-sm">Price book code
                    <input value={remedy.code} list="price-book-codes" maxLength={60}
                           onChange={(e) => setRemedy(i, r, {
                             code: e.target.value,
                             ...(remedy.label === "" && names.get(e.target.value) ? { label: names.get(e.target.value)! } : {}),
                           })}
                           className={FIELD} />
                  </label>
                  <label className="text-sm">What it is
                    <input value={remedy.label} onChange={(e) => setRemedy(i, r, { label: e.target.value })} maxLength={200} className={FIELD} />
                  </label>
                  <label className="text-sm">How many
                    <input value={remedy.quantity} onChange={(e) => setRemedy(i, r, { quantity: e.target.value })} inputMode="decimal" className={FIELD} />
                  </label>
                  <label className="text-sm">Why it fixes it
                    <input value={remedy.rationale} onChange={(e) => setRemedy(i, r, { rationale: e.target.value })} maxLength={500} className={FIELD} />
                  </label>
                  <div className="sm:col-span-4">
                    <button type="button" className={SMALL}
                            onClick={() => set(i, { remedies: row.remedies.filter((_, k) => k !== r) })}>
                      Take the repair off
                    </button>
                  </div>
                </div>
              ))}
              <button type="button" className={SMALL}
                      onClick={() => set(i, { remedies: [...row.remedies, { code: "", label: "", quantity: "1", rationale: "" }] })}>
                Add a repair to quote
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className={SMALL} disabled={i === 0} onClick={() => move(i, -1)}>Move up</button>
              <button type="button" className={SMALL} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>Move down</button>
              <button type="button" className={SMALL} onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                Take this checkpoint off
              </button>
            </div>
          </fieldset>
        ))}
        <button type="button" className={SMALL}
                onClick={() => setRows((all) => [...all, toRow({ key: "", label: "" })])}>
          Add a checkpoint
        </button>
      </section>

      {mode === "new" && replaceable ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="hidden" name="replaces" value={replaceable.id} />
          <input type="checkbox" name="replace" defaultChecked={replaceable.ticked} className="mt-0.5 h-4 w-4" />
          <span>
            Use this instead of {replaceable.name}. Technicians stop being offered that one as this one is saved.
            It is kept, with the inspections done under it.
          </span>
        </label>
      ) : null}

      <label className="block text-sm">{mode === "new" ? "A note to keep with it" : "What changed"}
        <textarea name="note" rows={2} maxLength={1000}
                  placeholder={mode === "new" ? "Optional" : "Optional, kept with this version"}
                  className="mt-1 w-full rounded border border-steel-300 bg-canvas px-2 py-1.5 text-sm" />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Saving" : mode === "new" ? "Save the programme" : `Publish version ${(baseVersion ?? 0) + 1}`}
        </button>
        {mode === "revise" && (
          <span className="text-xs text-ink-500">Inspections already done keep the version they were done under.</span>
        )}
      </div>
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
