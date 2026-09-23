import type { reporting } from "@opentradesos/core";
import { queryFor } from "@/lib/report-params";

/**
 * The builder form.
 *
 * No client component and no state hook. Every control is a link or a field
 * in a GET form, so the whole builder works with JavaScript off, the URL is
 * always the truth, and there is no second copy of the definition that can
 * disagree with the one the server ran.
 *
 * Choosing a dataset is a LINK rather than a select, deliberately: the
 * dimensions and measures belong to the dataset, so carrying the old ones
 * across would submit fields the new dataset has never heard of and earn a
 * refusal instead of a fresh start.
 */
export interface DatasetOption {
  key: string;
  label: string;
  description: string;
  dimensions: { key: string; label: string }[];
  measures: { key: string; label: string }[];
}

const OPS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "in", label: "is one of" },
] as const;

function Check({
  name, value, label, checked,
}: { name: string; value: string; label: string; checked: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 rounded border border-steel-300 px-3 py-1.5 text-sm hover:bg-steel-100">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} className="h-4 w-4" />
      {label}
    </label>
  );
}

export function Builder({
  datasets, definition,
}: {
  datasets: DatasetOption[];
  definition: reporting.ReportDefinition | null;
}) {
  const dataset = datasets.find((d) => d.key === definition?.dataset);
  const chosenDimensions = new Set(definition?.dimensions ?? []);
  const chosenMeasures = new Set(definition?.measures ?? []);
  const filters = definition?.filters ?? [];

  return (
    <div className="mt-6 space-y-6">
      <section>
        <h2 className="text-sm font-medium text-ink-700">What is it about?</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {datasets.map((d) => (
            <a
              key={d.key}
              href={`/reports/new?dataset=${d.key}`}
              title={d.description}
              className={`inline-flex h-8 items-center rounded px-3 text-sm ${
                d.key === dataset?.key
                  ? "bg-ink-900 font-medium text-white"
                  : "border border-steel-300 text-ink-700 hover:bg-steel-100"
              }`}
            >
              {d.label}
            </a>
          ))}
        </div>
      </section>

      {dataset ? (
        <form method="get" action="/reports/new" className="space-y-6">
          <input type="hidden" name="dataset" value={dataset.key} />
          {/*
            The filters already applied ride along as hidden fields, so the
            row below adds one rather than replacing the set.
          */}
          {filters.map((filter, index) => (
            <input
              key={index}
              type="hidden"
              name="filter"
              value={`${filter.dimension}:${filter.op}:${
                Array.isArray(filter.value) ? filter.value.join(",") : filter.value
              }`}
            />
          ))}

          <section>
            <h2 className="text-sm font-medium text-ink-700">Group it by</h2>
            <p className="mt-1 text-xs text-ink-500">
              Nothing chosen gives one total row, which is a fair answer to some
              questions.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {dataset.dimensions.map((d) => (
                <Check
                  key={d.key} name="dimensions" value={d.key} label={d.label}
                  checked={chosenDimensions.has(d.key)}
                />
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-medium text-ink-700">Measure</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {dataset.measures.map((m) => (
                <Check
                  key={m.key} name="measures" value={m.key} label={m.label}
                  checked={chosenMeasures.has(m.key)}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-ink-700">From</span>
              <input
                type="date" name="from" defaultValue={definition?.from ?? ""}
                className="mt-1 h-9 rounded border border-steel-300 px-2"
              />
            </label>
            <label className="text-sm">
              <span className="block text-ink-700">To</span>
              <input
                type="date" name="to" defaultValue={definition?.to ?? ""}
                className="mt-1 h-9 rounded border border-steel-300 px-2"
              />
            </label>
            <label className="text-sm">
              <span className="block text-ink-700">Order by</span>
              <select
                name="orderBy" defaultValue={definition?.orderBy ?? ""}
                className="mt-1 h-9 rounded border border-steel-300 px-2"
              >
                <option value="">The first measure</option>
                {dataset.measures
                  .filter((m) => chosenMeasures.has(m.key))
                  .map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </label>
            <span className="pb-2 text-xs text-ink-500">To is exclusive.</span>
          </section>

          <section>
            <h2 className="text-sm font-medium text-ink-700">Narrow it down</h2>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <select name="fd" defaultValue="" aria-label="Field to filter on"
                      className="h-9 rounded border border-steel-300 px-2 text-sm">
                <option value="">Add a filter</option>
                {dataset.dimensions.map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
              </select>
              <select name="fo" defaultValue="eq" aria-label="Comparison"
                      className="h-9 rounded border border-steel-300 px-2 text-sm">
                {OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
              </select>
              <input
                name="fv" aria-label="Value" placeholder="paid, or paid,void"
                className="h-9 w-48 rounded border border-steel-300 px-2 text-sm"
              />
            </div>

            {filters.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {filters.map((filter, index) => {
                  const label = dataset.dimensions.find((d) => d.key === filter.dimension)?.label
                    ?? filter.dimension;
                  const op = OPS.find((o) => o.value === filter.op)?.label ?? filter.op;
                  const value = Array.isArray(filter.value) ? filter.value.join(", ") : filter.value;
                  /*
                    Removing one is a link to the same report without it,
                    computed here rather than by stripping a query parameter
                    by hand, so there is one writer of this query string.
                  */
                  const without = queryFor({
                    ...definition!,
                    filters: filters.filter((_, i) => i !== index),
                  });
                  return (
                    <li key={index}
                        className="inline-flex items-center gap-2 rounded-full border border-steel-300 bg-steel-100 px-3 py-1 text-sm">
                      <span>{label} {op} {value}</span>
                      <a href={`/reports/new?${without}`} aria-label={`Remove the ${label} filter`}
                         className="text-ink-500 hover:text-red-600">
                        &times;
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          <button
            type="submit"
            className="inline-flex h-9 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700"
          >
            Run it
          </button>
        </form>
      ) : null}
    </div>
  );
}
