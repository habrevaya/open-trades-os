import type { CustomFieldDefinitionView } from "@/components/CustomFieldInputs";

/**
 * FILTER A LIST BY ONE OF THE COMPANY'S OWN FIELDS
 *
 * The customer list's field filter, drawn for every list that holds records
 * with fields: jobs, invoices, estimates, people and a company's own kinds of
 * record. A plain GET form, so it works with JavaScript off and a filtered
 * list is a link somebody can send; whatever else the list was filtered by
 * rides along in `keep`.
 *
 * The suggestions are each choice field's own options and yes or no, so the
 * common case is picked rather than typed. A field the company no longer
 * declares, or a value its type cannot hold, comes back from the service as
 * a sentence, shown above the list with the list unfiltered by it, rather
 * than as an error page or as an empty list that reads as "none".
 */
export function CustomFieldFilter({
  action, declared, keep = {}, fieldKey, fieldValue, refusal, noun,
}: {
  action: string;
  declared: readonly CustomFieldDefinitionView[];
  keep?: Record<string, string | string[] | undefined>;
  fieldKey?: string | undefined;
  fieldValue?: string | undefined;
  refusal?: string | null | undefined;
  /** What the list is of, for the sentence saying how it is filtered: "jobs". */
  noun: string;
}) {
  if (declared.length === 0) return null;
  const hidden = Object.entries(keep).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value]).map((v) => [name, v] as const));
  const clear = (() => {
    const params = new URLSearchParams();
    for (const [name, value] of hidden) params.append(name, value);
    const query = params.toString();
    return query ? `${action}?${query}` : action;
  })();
  const filtering = fieldKey && fieldValue && !refusal ? declared.find((d) => d.key === fieldKey) : undefined;
  const listId = `field-values-${action.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <>
      <form action={action} method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Filter by a custom field">
        {hidden.map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={value} />)}
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">Field</span>
          <select name="field" defaultValue={fieldKey ?? ""} className="h-9 rounded border border-steel-300 px-2">
            <option value="">Choose a field</option>
            {declared.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">Is</span>
          <input name="value" defaultValue={fieldValue ?? ""} list={listId} className="h-9 w-48 rounded border border-steel-300 px-2" />
        </label>
        <datalist id={listId}>
          {[...new Set(declared.flatMap((d) => (d.dataType === "boolean" ? ["yes", "no"] : d.options)))]
            .map((o) => <option key={o} value={o} />)}
        </datalist>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
          Filter
        </button>
        {fieldKey && fieldValue ? (
          <a href={clear} className="pb-2 text-ink-700 underline underline-offset-4">Clear the field</a>
        ) : null}
      </form>
      {refusal ? (
        <p role="alert" className="mt-3 rounded border border-red-600 bg-red-tint px-3 py-2 text-sm text-red-600">
          {refusal} The list below is not filtered by it.
        </p>
      ) : filtering ? (
        <p className="mt-3 text-sm text-ink-700">
          Showing {noun} whose {filtering.label} {filtering.dataType === "text" ? "contains" : "is"} {fieldValue}.
        </p>
      ) : null}
    </>
  );
}
