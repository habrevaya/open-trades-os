import { setup, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty } from "@/components/Table";
import { setTax } from "./actions";

const CLASSES = [
  { value: "", label: "No class" },
  { value: "labor", label: "Labour" },
  { value: "material", label: "Material" },
  { value: "equipment", label: "Equipment" },
  { value: "service", label: "Service" },
  { value: "exempt", label: "Exempt" },
];
const classLabel = (value: string | null) => CLASSES.find((c) => c.value === (value ?? ""))?.label ?? value ?? "No class";

function Controls() {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="block font-medium text-ink-700">Taxable</span>
        <select name="taxable" defaultValue="yes" className="mt-1 h-9 rounded border border-steel-300 px-2">
          <option value="yes">Taxable</option>
          <option value="no">Not taxable</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="block font-medium text-ink-700">Class</span>
        <select name="taxClass" defaultValue="" className="mt-1 h-9 rounded border border-steel-300 px-2">
          {CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
    </div>
  );
}

/**
 * WHICH ITEMS ARE TAXED
 *
 * Every live item by shelf, with whether it is taxed and its class, and two
 * ways to change them: a whole shelf at once (the usual case: labour is not
 * taxed in this state), or the items ticked. Each change is a new version of
 * the item, so an invoice that charged tax last month still says it did.
 *
 * No rates. A rate belongs to the jurisdiction and is set on the document it
 * is charged on; working one out is something this product has decided not
 * to do (BUILD.md). The class is what an accountant or a tax service maps to
 * a rate.
 */
export async function TaxSection({ ctx }: { ctx: ServiceContext }) {
  const rows = await setup.taxTable(ctx);
  const writes = can(ctx.actor, "pricebook:write");
  if (rows.length === 0) {
    return (
      <Empty title="Nothing in the price book yet">
        Choose a trade to load a starting price book, or add items, and then say which are taxed.
      </Empty>
    );
  }

  const shelves = [...new Set(rows.map((r) => r.category ?? "No category"))];
  const taxable = rows.filter((r) => r.taxable).length;

  return (
    <div>
      <p className="text-sm text-ink-700">
        {taxable} of {rows.length} items are taxable.
      </p>

      {writes ? (
        <section className="mt-6" aria-labelledby="by-shelf">
          <h2 id="by-shelf" className="text-base font-semibold">A whole shelf at once</h2>
          <ul className="mt-3 space-y-3">
            {shelves.map((shelf) => {
              const on = rows.filter((r) => (r.category ?? "No category") === shelf);
              return (
                <li key={shelf} className="rounded-md border border-steel-200 bg-canvas p-3">
                  <ActionForm action={setTax} tone="quiet" submit={`Set every item in ${shelf}`}
                              className="flex flex-wrap items-end gap-3">
                    {on.map((r) => <input key={r.id} type="hidden" name="itemId" value={r.id} />)}
                    <span className="min-w-40 pb-2 text-sm">
                      <span className="font-medium">{shelf}</span>
                      <span className="text-ink-500"> ({on.length}, {on.filter((r) => r.taxable).length} taxable)</span>
                    </span>
                    <Controls />
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="by-item">
        <h2 id="by-item" className="text-base font-semibold">Item by item</h2>
        {writes ? (
          <ActionForm action={setTax} submit="Set the ticked items" className="mt-3 space-y-3">
            <ItemList rows={rows} tick />
            <Controls />
          </ActionForm>
        ) : (
          <div className="mt-3"><ItemList rows={rows} tick={false} /></div>
        )}
      </section>
    </div>
  );
}

function ItemList({ rows, tick }: { rows: setup.TaxRow[]; tick: boolean }) {
  return (
    <ul className="max-h-[28rem] divide-y divide-steel-200 overflow-y-auto rounded-md border border-steel-200">
      {rows.map((r) => (
        <li key={r.id} className="bg-canvas px-3 py-2">
          <label className="flex flex-wrap items-center gap-3 text-sm">
            {tick ? <input type="checkbox" name="itemId" value={r.id} className="h-4 w-4" /> : null}
            <span className="font-mono text-xs text-ink-500">{r.code}</span>
            <span className="font-medium">{r.name}</span>
            <span className="text-ink-500">{r.category ?? "No category"}</span>
            <span className="ml-auto flex gap-2">
              <Chip tone={r.taxable ? "info" : "neutral"}>{r.taxable ? "Taxable" : "Not taxable"}</Chip>
              <Chip tone="neutral">{classLabel(r.taxClass)}</Chip>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
