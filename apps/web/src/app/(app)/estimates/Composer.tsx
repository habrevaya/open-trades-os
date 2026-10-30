"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useRef, useState } from "react";
import type { FormState } from "@/lib/actions";

/**
 * WRITING AN ESTIMATE: good, better, best.
 *
 * Each option is a whole scope of work with its own lines, not a discount
 * tier, and the customer chooses one. A line marked optional is priced and
 * shown and left out of the option's total until the customer ticks it,
 * which is the upsell. Totals are the server's, for the reason the invoice
 * composer gives.
 */
interface Row { key: number; priceBookItemId?: string | undefined; quantity?: string | undefined }
interface Option { key: number; name: string; rows: Row[] }

const NAMES = ["Good", "Better", "Best", "Option 4", "Option 5"];

/**
 * The after hours or holiday rate, offered because one of the job's visits
 * was booked outside the company's hours or on a holiday. Shown with why, and
 * added only when somebody presses the button.
 */
export interface EstimateOffer {
  kind: "after_hours" | "holiday";
  item: { id: string; name: string; price: string };
  quantity: number;
  because: string[];
}

export function EstimateComposer({
  action, hidden, properties, items, defaultPropertyId, offers = [], fields,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  properties: { id: string; label: string }[];
  /** `picture` is the version whose uploaded picture to draw beside a line of the item, when it has one. */
  items: { id: string; name: string; price: string; crewHours?: boolean | undefined; picture?: string | null | undefined }[];
  defaultPropertyId?: string | undefined;
  offers?: EstimateOffer[] | undefined;
  /** The company's own fields for a new estimate, drawn above the button. */
  fields?: React.ReactNode;
}) {
  const [state, runForm, pending] = useKeptAction(action, null);
  const counter = useRef(100);
  const [options, setOptions] = useState<Option[]>([{ key: 0, name: NAMES[0]!, rows: [{ key: 0 }] }]);
  const nextKey = () => { counter.current += 1; return counter.current; };
  const itemById = new Map(items.map((i) => [i.id, i]));
  /**
   * An offered rate as a line from the price book, on every option: the call
   * out is for the visit and is owed whichever option the customer chooses.
   */
  const take = (offer: EstimateOffer) => setOptions((all) => all.map((o) => ({
    ...o,
    rows: [...o.rows, { key: nextKey(), priceBookItemId: offer.item.id, quantity: String(offer.quantity) }],
  })));
  const waiting = offers.filter((offer) => !options.some((o) => o.rows.some((r) => r.priceBookItemId === offer.item.id)));

  const addOption = () => setOptions((all) => all.length >= 5 ? all
    : [...all, { key: nextKey(), name: NAMES[all.length] ?? `Option ${all.length + 1}`, rows: [{ key: nextKey() }] }]);
  const removeOption = (key: number) => setOptions((all) => all.filter((o) => o.key !== key));
  const addRow = (ok: number) => setOptions((all) => all.map((o) => o.key === ok ? { ...o, rows: [...o.rows, { key: nextKey() }] } : o));
  const removeRow = (ok: number, rk: number) =>
    setOptions((all) => all.map((o) => o.key === ok ? { ...o, rows: o.rows.filter((r) => r.key !== rk) } : o));
  const setItem = (ok: number, rk: number, id: string) =>
    setOptions((all) => all.map((o) => o.key !== ok ? o
      : { ...o, rows: o.rows.map((r) => r.key === rk ? { ...r, priceBookItemId: id || undefined } : r) }));

  return (
    <form {...runForm} className="mt-6 space-y-6">
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <input type="hidden" name="optionKeys" value={options.map((o) => o.key).join(",")} />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium text-ink-700">Title</span>
          <input name="title" maxLength={200} placeholder="Replace the condenser"
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Address</span>
          <select name="propertyId" defaultValue={defaultPropertyId}
                  className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
            {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Good until</span>
          <input type="date" name="expiresOn"
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Tax rate (%)</span>
          <input name="taxPercent" inputMode="decimal" placeholder="Your rate for this address"
                 className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
          <span className="mt-1 block text-xs text-ink-500">
            Leave empty to charge your rate for this customer and address, or type one. 0 charges none.
          </span>
        </label>
      </div>

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
            ${Number(offer.item.price).toFixed(2)}. It is not on this estimate unless you add it.
          </p>
          <button type="button" onClick={() => take(offer)}
                  className="mt-2 inline-flex h-8 items-center rounded border border-steel-300 bg-canvas px-2.5 text-sm font-medium hover:bg-steel-100">
            Add {offer.item.name} to every option
          </button>
        </section>
      ))}

      {options.map((option, oi) => (
        <fieldset key={option.key} className="space-y-3 rounded-md border border-steel-200 p-4">
          <legend className="px-1 text-sm font-medium">Option {oi + 1}</legend>
          <input type="hidden" name={`option.${option.key}.lineKeys`} value={option.rows.map((r) => r.key).join(",")} />
          <div className="flex flex-wrap items-end gap-4">
            <label className="block min-w-48 flex-1">
              <span className="text-sm text-ink-700">Option {oi + 1} name</span>
              <input name={`option.${option.key}.name`} defaultValue={option.name} maxLength={100}
                     className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
            </label>
            <label className="inline-flex items-center gap-2 pb-2 text-sm">
              <input type="radio" name="recommended" value={String(option.key)} defaultChecked={oi === 0} />
              Recommend option {oi + 1}
            </label>
            {options.length > 1 && (
              <button type="button" onClick={() => removeOption(option.key)}
                      className="pb-2 text-sm underline underline-offset-4">
                Remove option {oi + 1}
              </button>
            )}
          </div>

          {option.rows.map((row, ri) => {
            const at = `line.${option.key}.${row.key}`;
            const n = `option ${oi + 1} line ${ri + 1}`;
            const fromBook = row.priceBookItemId ? itemById.get(row.priceBookItemId) : undefined;
            return (
              <div key={row.key} className="grid gap-2 border-t border-steel-200 pt-3 sm:grid-cols-12">
                {items.length > 0 && (
                  <select name={`${at}.priceBookItemId`} aria-label={`Price book item, ${n}`} defaultValue={row.priceBookItemId ?? ""}
                          onChange={(e) => setItem(option.key, row.key, e.target.value)}
                          className="h-9 rounded border border-steel-300 bg-canvas px-2 text-sm sm:col-span-12">
                    <option value="">Typed by hand</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} (${Number(i.price).toFixed(2)})</option>)}
                  </select>
                )}
                <input name={`${at}.name`} aria-label={`Description, ${n}`} disabled={Boolean(fromBook)}
                       placeholder={fromBook?.name ?? "What is done or supplied"}
                       className="h-9 rounded border border-steel-300 bg-canvas px-2 text-sm disabled:bg-steel-100 sm:col-span-5" />
                <input name={`${at}.quantity`} aria-label={`Quantity, ${n}`} defaultValue={row.quantity ?? "1"} inputMode="decimal"
                       className="h-9 rounded border border-steel-300 bg-canvas px-2 text-sm sm:col-span-1" />
                <input name={`${at}.unitPrice`} aria-label={`Unit price, ${n}`} inputMode="decimal"
                       disabled={Boolean(fromBook)}
                       placeholder={fromBook ? Number(fromBook.price).toFixed(2) : "0.00"}
                       className="h-9 rounded border border-steel-300 bg-canvas px-2 font-mono text-sm disabled:bg-steel-100 sm:col-span-2" />
                <label className="inline-flex items-center gap-1 text-sm sm:col-span-2">
                  <input type="checkbox" name={`${at}.optional`} aria-label={`Optional, ${n}`} /> Optional
                </label>
                <label className="inline-flex items-center gap-1 text-sm sm:col-span-1">
                  <input type="checkbox" name={`${at}.taxable`} aria-label={`Taxable, ${n}`} disabled={Boolean(fromBook)} /> Tax
                </label>
                {fromBook?.picture ? (
                  <img src={`/pricebook/pictures/${fromBook.picture}`} alt={`Picture of ${fromBook.name}`}
                       className="h-16 w-24 rounded border border-steel-200 object-cover sm:col-span-12" />
                ) : null}
                {fromBook ? (fromBook.crewHours ? (
                  <p className="text-xs text-ink-500 sm:col-span-12">
                    The quantity is crew hours (people times hours). The job is budgeted from these lines.
                  </p>
                ) : null) : (
                  <label className="inline-flex items-center gap-1 text-xs text-ink-700 sm:col-span-12">
                    <input type="checkbox" name={`${at}.crewHours`} aria-label={`Quantity is crew hours, ${n}`} />
                    The quantity is crew hours (people times hours)
                  </label>
                )}
                {option.rows.length > 1 && (
                  <button type="button" onClick={() => removeRow(option.key, row.key)}
                          className="text-left text-xs underline underline-offset-4 sm:col-span-1">
                    Remove
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" onClick={() => addRow(option.key)}
                  className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
            Add a line to option {oi + 1}
          </button>
        </fieldset>
      ))}

      {options.length < 5 && (
        <button type="button" onClick={addOption}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100">
          Add an option
        </button>
      )}

      {fields}

      <div>
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "Saving" : "Save estimate"}
        </button>
      </div>
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
