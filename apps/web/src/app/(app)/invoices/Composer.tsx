"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState } from "react";
import type { FormState } from "@/lib/actions";

/**
 * WRITING AN INVOICE
 *
 * One row per line: picked from the price book (the book's price wins, the
 * server says so and re-prices it), typed by hand, or carried from what was
 * used on the job, which keeps the job line it bills so the same part cannot
 * be invoiced twice. The totals are not computed here. The server computes
 * them from the lines and nothing else, and a second copy of that sum in a
 * browser is a second answer to disagree with.
 */
export interface ComposerLine {
  jobLineId?: string | undefined;
  priceBookItemId?: string | undefined;
  name: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxable: boolean;
}

export interface ComposerItem { id: string; name: string; price: string; taxable: boolean }

/**
 * The after hours or holiday rate, offered because one of the job's visits
 * was booked outside the company's hours or on a holiday. Shown with why,
 * and added only when somebody presses the button.
 */
export interface ComposerOffer {
  kind: "after_hours" | "holiday";
  item: ComposerItem;
  quantity: number;
  because: string[];
}

const blank = (): ComposerLine => ({ name: "", quantity: "1", unitPrice: "", discountAmount: "", taxable: false });

export function Composer({
  action, hidden, lines, items, submit, draftable = true, adjustment, memo, dueOn, purchaseOrderNumber, offers = [],
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  lines: ComposerLine[];
  items: ComposerItem[];
  submit: string;
  /** Offer "save as a draft". Not when editing what already is one. */
  draftable?: boolean;
  adjustment?: { name: string; amount: string } | undefined;
  memo?: string | undefined;
  dueOn?: string | undefined;
  purchaseOrderNumber?: string | undefined;
  offers?: ComposerOffer[] | undefined;
}) {
  const [state, runForm, pending] = useKeptAction(action, null);
  const [rows, setRows] = useState<(ComposerLine & { key: number })[]>(
    () => (lines.length > 0 ? lines : [blank()]).map((line, key) => ({ ...line, key })),
  );
  const [next, setNext] = useState(rows.length);

  const add = () => { setRows((r) => [...r, { ...blank(), key: next }]); setNext((n) => n + 1); };
  const remove = (key: number) => setRows((r) => r.filter((row) => row.key !== key));
  const itemById = new Map(items.map((item) => [item.id, item]));
  /** An offered rate as a line from the price book, at the book's price, for as many visits as it is for. */
  const take = (offer: ComposerOffer) => {
    setRows((r) => [...r, {
      key: next, priceBookItemId: offer.item.id, name: offer.item.name, quantity: String(offer.quantity),
      unitPrice: "", discountAmount: "", taxable: offer.item.taxable,
    }]);
    setNext((n) => n + 1);
  };
  const waiting = offers.filter((offer) => !rows.some((row) => row.priceBookItemId === offer.item.id));

  return (
    <form {...runForm} className="mt-6 space-y-6">
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <input type="hidden" name="lineKeys" value={rows.map((r) => r.key).join(",")} />

      {waiting.map((offer) => (
        <section key={offer.item.id} aria-label={offer.kind === "holiday" ? "Holiday rate" : "After hours rate"}
                 className="rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm">
          <p className="font-medium text-ink-900">
            {offer.kind === "holiday" ? "Booked on a holiday" : "Booked outside your hours"}
          </p>
          <ul className="mt-1 list-disc pl-5 text-ink-700">
            {offer.because.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="mt-1 text-ink-700">
            Your {offer.kind === "holiday" ? "holiday" : "after hours"} rate is {offer.item.name},
            ${Number(offer.item.price).toFixed(2)}. It is not on this invoice unless you add it.
          </p>
          <button type="button" onClick={() => take(offer)}
                  className="mt-2 inline-flex h-8 items-center rounded border border-steel-300 bg-canvas px-2.5 text-sm font-medium hover:bg-steel-100">
            Add {offer.item.name}
          </button>
        </section>
      ))}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink-700">Lines</legend>
        {rows.map((row, index) => {
          const n = index + 1;
          const fromBook = row.priceBookItemId ? itemById.get(row.priceBookItemId) : undefined;
          return (
            <div key={row.key} className="rounded-md border border-steel-200 p-3">
              {row.jobLineId && <input type="hidden" name={`line.${row.key}.jobLineId`} value={row.jobLineId} />}
              <div className="grid gap-3 sm:grid-cols-12">
                {items.length > 0 && !row.jobLineId && (
                  <label className="block sm:col-span-12">
                    <span className="text-xs text-ink-500">Line {n} from the price book</span>
                    <select
                      name={`line.${row.key}.priceBookItemId`} aria-label={`Line ${n} price book item`}
                      defaultValue={row.priceBookItemId ?? ""}
                      onChange={(e) => {
                        const id = e.target.value;
                        setRows((r) => r.map((x) => x.key === row.key ? { ...x, priceBookItemId: id || undefined } : x));
                      }}
                      className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm"
                    >
                      <option value="">Typed by hand</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>{item.name} (${Number(item.price).toFixed(2)})</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block sm:col-span-5">
                  <span className="text-xs text-ink-500">Line {n} description</span>
                  <input name={`line.${row.key}.name`} aria-label={`Line ${n} description`}
                         defaultValue={row.name} disabled={Boolean(fromBook)}
                         placeholder={fromBook ? fromBook.name : ""}
                         className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm disabled:bg-steel-100" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs text-ink-500">Qty</span>
                  <input name={`line.${row.key}.quantity`} aria-label={`Line ${n} quantity`} defaultValue={row.quantity}
                         inputMode="decimal" className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs text-ink-500">Unit price</span>
                  <input name={`line.${row.key}.unitPrice`} aria-label={`Line ${n} unit price`}
                         defaultValue={row.unitPrice} disabled={Boolean(fromBook)}
                         placeholder={fromBook ? Number(fromBook.price).toFixed(2) : "0.00"} inputMode="decimal"
                         className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2 font-mono text-sm disabled:bg-steel-100" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs text-ink-500">Discount</span>
                  <input name={`line.${row.key}.discountAmount`} aria-label={`Line ${n} discount`}
                         defaultValue={row.discountAmount} placeholder="0.00" inputMode="decimal"
                         className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2 font-mono text-sm" />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm sm:col-span-1">
                  <input type="checkbox" name={`line.${row.key}.taxable`} aria-label={`Line ${n} taxable`}
                         defaultChecked={row.taxable} disabled={Boolean(fromBook)} />
                  Tax
                </label>
              </div>
              <div className="mt-2 flex justify-between text-xs text-ink-500">
                <span>
                  {row.jobLineId ? "Used on the job." : fromBook ? "Priced from the price book." : ""}
                </span>
                {rows.length > 1 && (
                  <button type="button" onClick={() => remove(row.key)} className="underline underline-offset-4">
                    Remove line {n}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button type="button" onClick={add}
                className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
          Add a line
        </button>
        <p className="text-xs text-ink-500">
          Tax is worked out by the server from what is marked taxable, at the rate the company charges.
        </p>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium text-ink-700">Adjustment</legend>
        <label className="block">
          <span className="text-sm text-ink-700">Adjustment description</span>
          <input name="adjustmentName" defaultValue={adjustment?.name} placeholder="Loyal customer discount"
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm text-ink-700">Adjustment amount (negative takes money off)</span>
          <input name="adjustmentAmount" defaultValue={adjustment?.amount} placeholder="-25.00" inputMode="decimal"
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 font-mono text-sm" />
        </label>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Due</span>
          <input type="date" name="dueOn" defaultValue={dueOn}
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">PO number</span>
          <input name="purchaseOrderNumber" defaultValue={purchaseOrderNumber} maxLength={100}
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-medium text-ink-700">Note to the customer</span>
        <textarea name="memo" defaultValue={memo} rows={2} maxLength={2000}
                  className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm" />
      </label>

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "Saving" : submit}
        </button>
        {draftable && (
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" name="draft" value="1" />
            Save as a draft to finish later
          </label>
        )}
      </div>
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
