"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { addVendor, placeOrder, advanceOrder, orderParts } from "./actions";

function Note({ state }: { state: { done?: boolean; error?: string } }) {
  if (state.error) return <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p>;
  if (state.done) return <p className="mt-2 text-sm text-ink-500" role="status">Saved.</p>;
  return null;
}

export function AddVendor() {
  const [state, actionForm, pending] = useKeptAction(addVendor, {});
  return (
    <form {...actionForm} className="mt-3 flex flex-wrap items-end gap-2">
      {[
        { name: "name", label: "Name", required: true, width: "w-56" },
        { name: "accountNumber", label: "Account number", required: false, width: "w-40" },
        { name: "phone", label: "Phone", required: false, width: "w-40" },
      ].map((field) => (
        <label key={field.name} className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">{field.label}</span>
          <input name={field.name} required={field.required}
                 className={`h-10 ${field.width} rounded border border-steel-300 px-3 text-sm`} />
        </label>
      ))}
      <button type="submit" disabled={pending}
              className="h-10 rounded border border-steel-300 px-4 text-sm font-medium">
        {pending ? "Saving" : "Add vendor"}
      </button>
      <div className="w-full"><Note state={state} /></div>
    </form>
  );
}

export interface Suggestion {
  itemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  suggested: string;
  availableNow: string;
  reorderPoint: string;
  onOrder: string;
}

/**
 * WHAT THE SHELF SAYS, AND WHAT A PERSON DECIDES TO BUY.
 *
 * Every line is unticked by default. The suggestions are advice from a
 * reorder point somebody typed once, and a screen that pre-selects them is a
 * screen that gets money spent by whoever presses save without reading.
 */
export function OrderBuilder({ suggestions, vendors }: {
  suggestions: Suggestion[];
  vendors: { id: string; name: string }[];
}) {
  const [state, actionForm, pending] = useKeptAction(placeOrder, {});

  if (vendors.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        Add a vendor first. An order has to be addressed to somebody.
      </p>
    );
  }

  if (suggestions.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        Nothing is below its reorder point. Suggestions appear here when stock
        drops, counting what is already on order so you do not buy it twice.
      </p>
    );
  }

  return (
    <form {...actionForm} className="mt-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-700">Vendor</span>
        <select name="vendorId" required
                className="h-10 w-72 rounded border border-steel-300 px-2 text-sm">
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>

      <div className="mt-4 overflow-x-auto rounded-md border border-steel-200">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="border-b border-steel-200 bg-steel-100 text-left">
            <tr>
              <th className="px-4 py-2.5 font-medium text-ink-700">Order</th>
              <th className="px-4 py-2.5 font-medium text-ink-700">Part</th>
              <th className="px-4 py-2.5 font-medium text-ink-700">Where</th>
              <th className="px-4 py-2.5 text-right font-medium text-ink-700">Have</th>
              <th className="px-4 py-2.5 text-right font-medium text-ink-700">Point</th>
              <th className="px-4 py-2.5 text-right font-medium text-ink-700">Coming</th>
              <th className="px-4 py-2.5 text-right font-medium text-ink-700">Quantity</th>
              <th className="px-4 py-2.5 text-right font-medium text-ink-700">Unit price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-steel-200">
            {suggestions.map((line, i) => (
              <tr key={`${line.itemId}:${line.locationId}`}>
                <td className="px-4 py-3">
                  <input type="checkbox" name="pick" value={String(i)} />
                </td>
                <td className="px-4 py-3">{line.itemName}</td>
                <td className="px-4 py-3 text-ink-500">{line.locationName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{line.availableNow}</td>
                <td className="px-4 py-3 text-right tabular-nums text-ink-500">{line.reorderPoint}</td>
                <td className="px-4 py-3 text-right tabular-nums text-ink-500">{line.onOrder}</td>
                <td className="px-4 py-3 text-right">
                  <input name="lineQuantity" defaultValue={line.suggested} inputMode="decimal"
                         className="h-9 w-20 rounded border border-steel-300 px-2 text-right text-sm" />
                </td>
                <td className="px-4 py-3 text-right">
                  {/*
                    Never taken from the price book. What we CHARGE for a part
                    and what a vendor charges us are different numbers, and
                    defaulting one to the other is how a purchase order goes
                    out at retail. Left empty, the line takes the chosen
                    vendor's own price on record for the part, and is refused
                    in words when they have none.
                  */}
                  <input name="linePrice" inputMode="decimal" placeholder="Their price"
                         className="h-9 w-24 rounded border border-steel-300 px-2 text-right text-sm" />
                </td>
                <input type="hidden" name="lineItem" value={line.itemId} />
                <input type="hidden" name="lineLocation" value={line.locationId} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="submit" disabled={pending}
              className="mt-3 h-10 rounded border border-steel-300 px-4 text-sm font-medium">
        {pending ? "Saving" : "Create a draft order"}
      </button>
      <Note state={state} />
    </form>
  );
}

/**
 * Moving one order along.
 *
 * A draft counts for nothing in the reorder engine, deliberately: an order
 * sitting in somebody's drafts is not stock arriving, and counting it would
 * make the engine go quiet about a part nobody actually ordered. Sending it
 * is what makes it real, which is why this button is on the screen rather
 * than buried.
 */
export function Advance({ id, status }: { id: string; status: string }) {
  const [state, actionForm, pending] = useKeptAction(advanceOrder, {});

  const next =
    status === "draft" ? { to: "submitted", label: "Send to vendor" }
    : status === "submitted" ? { to: "acknowledged", label: "Vendor confirmed" }
    : null;

  if (!next) return <span className="text-ink-500">{state.error ?? ""}</span>;

  return (
    <form {...actionForm} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={next.to} />
      <button type="submit" disabled={pending}
              className="rounded border border-steel-300 px-3 py-1 text-xs font-medium">
        {pending ? "Saving" : next.label}
      </button>
      {state.error && <span className="ml-2 text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

export interface VendorPart { vendorId: string; partNumber: string; itemCode: string; itemName: string | null; cost: string | null }

const ROWS = [0, 1, 2, 3, 4, 5];

/**
 * AN ORDER WRITTEN FROM THE VENDOR'S OWN PART NUMBERS.
 *
 * Each line is looked up rather than typed: the vendor's number or our item
 * code, offered from what this vendor is known to sell, resolved to our item
 * on the server, priced at what they charge unless a price is given, and
 * sent with THEIR number on it. A part nobody can find is refused in words.
 */
export function PartOrder({ vendors, locations, parts }: {
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  parts: VendorPart[];
}) {
  const [state, actionForm, pending] = useKeptAction(orderParts, {});
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const known = parts.filter((p) => p.vendorId === vendorId);

  if (vendors.length === 0 || locations.length === 0) {
    return <p className="mt-3 text-sm text-ink-500">An order needs a vendor and somewhere for it to arrive.</p>;
  }

  return (
    <form {...actionForm} className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Vendor</span>
          <select name="vendorId" value={vendorId} onChange={(event) => setVendorId(event.target.value)}
                  className="h-10 w-64 rounded border border-steel-300 px-2 text-sm">
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Deliver to</span>
          <select name="locationId" className="h-10 w-56 rounded border border-steel-300 px-2 text-sm">
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      <datalist id="vendor-parts">
        {known.map((p) => (
          <option key={p.partNumber} value={p.partNumber}>{`${p.itemCode} ${p.itemName ?? ""}${p.cost ? `, ${Number(p.cost).toFixed(2)}` : ""}`}</option>
        ))}
      </datalist>
      <table className="text-sm">
        <thead>
          <tr className="text-left">
            <th className="pr-3 font-medium text-ink-700">Their part number, or our code</th>
            <th className="pr-3 font-medium text-ink-700">Quantity</th>
            <th className="font-medium text-ink-700">Price (empty for theirs)</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row}>
              <td className="pr-3 pt-2">
                <input name="partNumber" list="vendor-parts" aria-label={`Part, line ${row + 1}`}
                       className="h-9 w-64 rounded border border-steel-300 px-2 font-mono text-sm" />
              </td>
              <td className="pr-3 pt-2">
                <input name="partQuantity" inputMode="decimal" aria-label={`Quantity, line ${row + 1}`}
                       className="h-9 w-20 rounded border border-steel-300 px-2 text-right text-sm" />
              </td>
              <td className="pt-2">
                <input name="partPrice" inputMode="decimal" aria-label={`Price, line ${row + 1}`}
                       className="h-9 w-24 rounded border border-steel-300 px-2 text-right text-sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="submit" disabled={pending}
              className="h-10 rounded border border-steel-300 px-4 text-sm font-medium">
        {pending ? "Saving" : "Create a draft order"}
      </button>
      <Note state={state} />
    </form>
  );
}
