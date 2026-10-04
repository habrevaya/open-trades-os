"use client";

import { useState } from "react";
import { Money } from "@opentradesos/ui";
import { useKeptAction } from "@/lib/use-kept-action";
import { applyCatalogue, previewCatalogue, type CatalogueState } from "./actions";

type Row = NonNullable<NonNullable<CatalogueState>["preview"]>["rows"][number];

const SAYS: Record<Row["action"], string> = {
  create: "New item", link: "Link to our item", update: "Update", unchanged: "No change", skip: "Skipped",
};

/**
 * A SUPPLIER'S SPREADSHEET, PREVIEWED BEFORE ANYTHING IS WRITTEN
 *
 * Paste it or pick the file, say which vendor it is from when the file does
 * not, and how new parts should be priced. The preview says what every row
 * would do and why a row would be skipped; untick anything to leave alone,
 * then apply. Applying works it out again from the same file, so what is
 * written is the plan as it stands at that moment.
 */
export function CatalogueImport({ vendors, shelves, seesCost }: {
  vendors: { id: string; name: string }[];
  shelves: { value: string; label: string }[];
  seesCost: boolean;
}) {
  const [csv, setCsv] = useState("");
  const [preview, previewForm, previewing] = useKeptAction(previewCatalogue, null);
  const [applied, applyForm, applying] = useKeptAction(applyCatalogue, null);
  const [settings, setSettings] = useState<FormData | null>(null);

  const rows = preview?.preview?.rows ?? [];
  const carried = settings ? Array.from(settings.entries()).filter(([name]) => name !== "csv") : [];

  return (
    <div className="space-y-6">
      <form {...previewForm} onSubmit={(event) => setSettings(new FormData(event.currentTarget))} className="space-y-4">
        <label className="block text-sm">
          <span className="font-medium text-ink-700">The file</span>
          <input type="file" accept=".csv,text/csv" className="mt-1 block text-sm"
                 onChange={async (event) => {
                   const file = event.target.files?.[0];
                   if (file) setCsv(await file.text());
                 }} />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-ink-700">Or paste it: a header line, then a row per part</span>
          <textarea name="csv" rows={8} value={csv} onChange={(event) => setCsv(event.target.value)} required
                    placeholder={"sku,description,cost,vendor\nC455R,\"Capacitor, dual run 45/5\",12.50,Ferguson"}
                    className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 font-mono text-sm" />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium text-ink-700">Vendor, for rows that name none</span>
            <select name="vendorId" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              <option value="">The vendor column says</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink-700">Price new parts at a margin of, per cent</span>
            <input name="marginPercent" inputMode="decimal" placeholder="40"
                   className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink-700">Round new prices up to cents ending</span>
            <select name="ending" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              <option value="">No rounding</option>
              <option value="00">.00</option><option value="95">.95</option><option value="99">.99</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink-700">New parts go in</span>
            <select name="categoryId" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              {shelves.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pt-6 text-sm sm:col-span-2">
            <input type="checkbox" name="updateItemCost" defaultChecked />
            Our cost for a matched item follows this vendor&apos;s (as a new version)
          </label>
        </div>
        <button type="submit" disabled={previewing}
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {previewing ? "Reading" : "Preview"}
        </button>
        {preview?.error ? <p role="alert" className="text-sm text-red-600">{preview.error}</p> : null}
      </form>

      {preview?.preview ? (
        <form {...applyForm} className="space-y-3" aria-label="Preview">
          <input type="hidden" name="csv" value={csv} />
          {carried.map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
          <p className="text-sm text-ink-700">
            {preview.preview.counts.create} new, {preview.preview.counts.link} linked, {preview.preview.counts.update} updated,{" "}
            {preview.preview.counts.unchanged} unchanged, {preview.preview.counts.skip + preview.preview.problems.length} skipped.
          </p>
          {preview.preview.problems.length > 0 ? (
            <ul className="text-sm text-red-600">
              {preview.preview.problems.map((p) => <li key={p.line}>Line {p.line}: {p.message}</li>)}
            </ul>
          ) : null}
          <div className="overflow-x-auto rounded-md border border-steel-200">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-steel-200 bg-steel-100 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-ink-700">Apply</th>
                  <th className="px-3 py-2 font-medium text-ink-700">Line</th>
                  <th className="px-3 py-2 font-medium text-ink-700">Their number</th>
                  <th className="px-3 py-2 font-medium text-ink-700">What happens</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-700">Their price</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-700">{seesCost ? "Our cost" : ""}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-200">
                {rows.map((row) => (
                  <tr key={row.line}>
                    <td className="px-3 py-2">
                      <input type="hidden" name="line" value={String(row.line)} />
                      {row.action === "skip" || row.action === "unchanged" ? null : (
                        <input type="checkbox" name="keep" value={String(row.line)} defaultChecked aria-label={`Apply line ${row.line}`} />
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-ink-500">{row.line}</td>
                    <td className="px-3 py-2 font-mono">{row.sku}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{SAYS[row.action]}</span>
                      {row.action === "skip" ? <span className="text-red-600">: {row.reason}</span> : null}
                      {row.action === "create" ? <span className="text-ink-700">: {row.name}, priced at <Money value={row.price} /></span> : null}
                      {row.action === "link" || row.action === "update" || row.action === "unchanged"
                        ? <span className="text-ink-700">: {row.itemCode} {row.itemName}</span> : null}
                      {row.action === "update" && row.partNumberBefore !== row.sku ? (
                        <span className="text-ink-500"> (was {row.partNumberBefore})</span>
                      ) : null}
                      {"vendorName" in row ? <span className="text-ink-500">, {row.vendorName}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {"cost" in row ? <Money value={row.cost} /> : null}
                      {"pack" in row && row.pack && Number(row.pack) !== 1 ? (
                        <div className="text-xs text-ink-500">
                          a {row.unit ?? "pack"} of {Number(row.pack)}, <Money value={row.eachCost ?? "0"} muted /> each
                        </div>
                      ) : null}
                      {"breaks" in row && row.breaks && row.breaks.length > 0 ? (
                        <div className="text-xs text-ink-500">
                          {row.breaks.map((b) => `${Number(b.minimum)}+ at ${Number(b.cost).toFixed(2)}`).join(", ")}
                        </div>
                      ) : null}
                      {row.action === "update" && row.costBefore && row.costBefore !== row.cost
                        ? <div className="text-xs text-ink-500">was <Money value={row.costBefore} muted /></div> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-ink-500">
                      {(row.action === "link" || row.action === "update") && row.itemCostAfter ? (
                        <>{seesCost && row.itemCostBefore ? <><Money value={row.itemCostBefore} muted /> to </> : "becomes "}<Money value={row.itemCostAfter} /></>
                      ) : null}
                      {(row.action === "link" || row.action === "update") && row.costHeldBack
                        ? "kept: a price change is scheduled" : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="submit" disabled={applying}
                  className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
            {applying ? "Applying" : "Apply the ticked rows"}
          </button>
          {applied?.error ? <p role="alert" className="text-sm text-red-600">{applied.error}</p> : null}
          {applied?.applied ? (
            <p role="status" className="text-sm text-ink-700">
              Done: {applied.applied.created} items added, {applied.applied.linked} linked, {applied.applied.updated} updated,
              {" "}{applied.applied.itemCostsRevised} item costs revised.
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
