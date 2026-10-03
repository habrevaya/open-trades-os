/**
 * THE BOXES A COMPANY DECLARED, DRAWN FROM THEIR DEFINITIONS
 *
 * One control per custom field, chosen by its type, named `cf:<key>` so the
 * action can read them back through `customFieldsFrom` and nothing else on
 * the form can collide with a key a company chose. A date is a date picker,
 * a choice is a list of its options, yes or no has a third answer for "not
 * said", because a checkbox cannot tell "no" from "nobody asked".
 *
 * No hooks, so a server page and a client form can both draw it. It checks
 * nothing: the service refuses a bad value with one sentence per field, and
 * a second set of rules here would be a second thing to keep in step.
 */
export interface CustomFieldDefinitionView {
  key: string;
  label: string;
  dataType: string;
  options: string[];
  required: boolean;
}

export function CustomFieldInputs({
  definitions, values = {}, legend, prefix = "cf",
}: {
  definitions: readonly CustomFieldDefinitionView[];
  values?: Record<string, unknown>;
  legend?: string;
  /** Two sets of fields on one form, a customer's and its address's, need two prefixes. */
  prefix?: string;
}) {
  if (definitions.length === 0) return null;
  const box = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";
  return (
    <fieldset className="space-y-4 rounded-md border border-steel-200 p-4">
      {legend ? <legend className="px-1 text-sm font-medium">{legend}</legend> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {definitions.map((definition) => {
          const name = `${prefix}:${definition.key}`;
          const value = values[definition.key];
          const text = value === undefined || value === null || Array.isArray(value) ? "" : String(value);
          const label = (
            <span className="text-sm font-medium text-ink-700">
              {definition.label}
              {definition.required ? <span className="text-ink-500"> (required)</span> : null}
            </span>
          );

          switch (definition.dataType) {
            case "multiselect": {
              const ticked = new Set(Array.isArray(value) ? value.map(String) : []);
              return (
                <fieldset key={definition.key} className="block">
                  <legend>{label}</legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {definition.options.map((option) => (
                      <label key={option} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name={name} value={option} defaultChecked={ticked.has(option)} />
                        {option}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            }
            case "select":
            case "boolean": {
              const options = definition.dataType === "boolean"
                ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
                : definition.options.map((option) => ({ value: option, label: option }));
              return (
                <label key={definition.key} className="block">
                  {label}
                  <select name={name} defaultValue={text} className={box}>
                    <option value="">Not said</option>
                    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              );
            }
            default:
              return (
                <label key={definition.key} className="block">
                  {label}
                  <input
                    name={name}
                    defaultValue={text}
                    type={definition.dataType === "date" ? "date" : definition.dataType === "number" ? "number" : "text"}
                    {...(definition.dataType === "number" ? { step: "any" } : {})}
                    className={box}
                  />
                </label>
              );
          }
        })}
      </div>
    </fieldset>
  );
}

/** What a record holds, as a person reads it, for a page that only shows it. */
export function customFieldText(definition: CustomFieldDefinitionView, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
