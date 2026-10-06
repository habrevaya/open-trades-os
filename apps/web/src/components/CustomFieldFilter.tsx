import type { CustomFieldDefinitionView } from "@/components/CustomFieldInputs";
import type { FieldPair } from "@/lib/field-filter";

/**
 * FILTER A LIST BY THE COMPANY'S OWN FIELDS, ONE OR SEVERAL AT ONCE
 *
 * Drawn for every list that holds records with fields: customers, jobs,
 * invoices, estimates, people and a company's own kinds of record. A plain
 * GET form, so it works with JavaScript off and a filtered list is a link
 * somebody can send; whatever else the list was filtered by rides along in
 * `keep`.
 *
 * Each field chosen is added to the ones already applied, and every one of
 * them has to hold: Plan is Annual, then Has pets is yes, is the customers who
 * are both. Each applied field is listed with a link that takes it off and
 * leaves the rest.
 *
 * The suggestions are each choice field's own options and yes or no, so the
 * common case is picked rather than typed. A field the company no longer
 * declares, or a value its type cannot hold, comes back from the service as
 * a sentence, shown above the list with the list unfiltered by its fields,
 * rather than as an error page or as an empty list that reads as "none".
 */
export function CustomFieldFilter({
  action, declared, keep = {}, pairs, refusal, noun,
}: {
  action: string;
  declared: readonly CustomFieldDefinitionView[];
  keep?: Record<string, string | string[] | undefined>;
  /** The fields the list is filtered by now, from `fieldFrom`. */
  pairs: readonly FieldPair[];
  refusal?: string | null | undefined;
  /** What the list is of, for the sentence saying how it is filtered: "jobs". */
  noun: string;
}) {
  if (declared.length === 0) return null;
  const hidden = Object.entries(keep).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value]).map((v) => [name, v] as const));
  /** This list's address with these field filters and everything in `keep`. */
  const href = (kept: readonly FieldPair[]) => {
    const params = new URLSearchParams();
    for (const [name, value] of hidden) params.append(name, value);
    for (const pair of kept) { params.append("field", pair.key); params.append("value", pair.value); }
    const query = params.toString();
    return query ? `${action}?${query}` : action;
  };
  const labelOf = (key: string) => declared.find((d) => d.key === key);
  const applied = refusal ? [] : pairs.map((pair) => ({ ...pair, definition: labelOf(pair.key) }));
  const listId = `field-values-${action.replace(/[^a-z0-9]+/gi, "-")}`;
  const phrase = (p: (typeof applied)[number]) =>
    `${p.definition?.label ?? p.key} ${p.definition?.dataType === "text" ? "contains" : "is"} ${p.value}`;

  return (
    <>
      <form action={action} method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Filter by a custom field">
        {hidden.map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={value} />)}
        {/* The fields already applied, so choosing another adds to them rather than replacing them. */}
        {(refusal ? [] : pairs).flatMap((pair, index) => [
          <input key={`applied-field-${index}`} type="hidden" name="field" value={pair.key} />,
          <input key={`applied-value-${index}`} type="hidden" name="value" value={pair.value} />,
        ])}
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">{applied.length > 0 ? "And field" : "Field"}</span>
          <select name="field" defaultValue="" className="h-9 rounded border border-steel-300 px-2">
            <option value="">Choose a field</option>
            {declared.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">Is</span>
          <input name="value" defaultValue="" list={listId} className="h-9 w-48 rounded border border-steel-300 px-2" />
        </label>
        <datalist id={listId}>
          {[...new Set(declared.flatMap((d) => (d.dataType === "boolean" ? ["yes", "no"] : d.options)))]
            .map((o) => <option key={o} value={o} />)}
        </datalist>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
          {applied.length > 0 ? "Add this filter" : "Filter"}
        </button>
        {pairs.length > 0 ? (
          <a href={href([])} className="pb-2 text-ink-700 underline underline-offset-4">
            {pairs.length > 1 ? "Clear the fields" : "Clear the field"}
          </a>
        ) : null}
      </form>
      {refusal ? (
        <p role="alert" className="mt-3 rounded border border-red-600 bg-red-tint px-3 py-2 text-sm text-red-600">
          {refusal} The list below is not filtered by {pairs.length > 1 ? "any of its fields" : "it"}.
        </p>
      ) : applied.length > 0 ? (
        <div className="mt-3 text-sm text-ink-700">
          <p>Showing {noun} whose {applied.map(phrase).join(", and whose ")}.</p>
          {applied.length > 1 ? (
            <ul className="mt-1.5 flex flex-wrap gap-2" aria-label="Fields filtered by">
              {applied.map((pair, index) => (
                <li key={`${pair.key}-${index}`}>
                  <a href={href(pairs.filter((_, i) => i !== index))}
                     className="inline-flex h-7 items-center rounded border border-steel-300 px-2 hover:bg-steel-100"
                     aria-label={`Stop filtering by ${pair.definition?.label ?? pair.key}`}>
                    {phrase(pair)}: take off
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
