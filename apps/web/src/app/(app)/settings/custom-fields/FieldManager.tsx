import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import { defineField, editField, retireField } from "./actions";

export const TYPES: { value: string; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "A number" },
  { value: "boolean", label: "Yes or no" },
  { value: "date", label: "A date" },
  { value: "select", label: "One choice from a list" },
  { value: "multiselect", label: "Several choices from a list" },
];
const typeLabel = (value: string) => TYPES.find((t) => t.value === value)?.label ?? value;

interface Usage {
  entityType: string;
  rows: number;
  defined: Array<{
    id: string; key: string; label: string; dataType: string; options: string[]; required: boolean;
    sortOrder: number; rowsWithValue: number; rowsMissingValue: number;
  }>;
  undefinedKeys: Array<{ key: string; rowsWithValue: number }>;
}

/**
 * THE FIELDS ON ONE OR MORE KINDS OF RECORD, AND A FORM TO ADD ONE.
 *
 * Drawn by Settings, Custom fields for the product's own records, and by a
 * kind of record's own settings page for its fields, which are the same
 * definitions on `object:<key>` and are changed, retired and counted the
 * same way. One component, so the two screens cannot come to disagree about
 * what changing a field means.
 */
export function FieldManager({
  records, usage, writes, heading = true,
}: {
  records: { key: string; label: string }[];
  usage: Usage[];
  writes: boolean;
  /** A section heading per record; off when the page is about one record already. */
  heading?: boolean;
}) {
  return (
    <>
      {records.map((record) => {
        const report = usage.find((u) => u.entityType === record.key);
        const defined = report?.defined ?? [];
        return (
          <section key={record.key} className="mt-10" aria-labelledby={`fields-${record.key}`}>
            {heading ? <h2 id={`fields-${record.key}`} className="text-base font-semibold">{record.label}</h2> : null}
            {defined.length === 0 ? (
              <p className="mt-2 text-sm text-ink-500">No fields on {record.label.toLowerCase()} yet.</p>
            ) : (
              <Table head={<><Th>Field</Th><Th>Type</Th><Th className="text-right">Filled in</Th><Th>{""}</Th></>}>
                {defined.map((def) => (
                  <tr key={def.id}>
                    <Td>
                      <span className="font-medium">{def.label}</span>
                      <span className="ml-2 font-mono text-xs text-ink-500">{def.key}</span>
                      {def.required ? <span className="ml-2"><Chip tone="info">Required</Chip></span> : null}
                      {def.options.length > 0 ? (
                        <span className="block text-xs text-ink-500">{def.options.join(", ")}</span>
                      ) : null}
                    </Td>
                    <Td className="text-ink-700">{typeLabel(def.dataType)}</Td>
                    <Td className="text-right tabular-nums">
                      {def.rowsWithValue} of {report?.rows ?? 0}
                      {def.required && def.rowsMissingValue > 0 ? (
                        <span className="block text-xs text-amber-700">{def.rowsMissingValue} missing</span>
                      ) : null}
                    </Td>
                    <Td>
                      {writes ? (
                        <details>
                          <summary className="cursor-pointer text-sm text-ink-700 underline underline-offset-4">
                            Change or retire {def.label}
                          </summary>
                          <ActionForm action={editField} tone="quiet" submit={`Save ${def.label}`}
                                      hidden={{ id: def.id }} className="mt-3 space-y-3">
                            <TextField label="Label" name="label" defaultValue={def.label} required maxLength={120} />
                            {def.dataType === "select" || def.dataType === "multiselect" ? (
                              <label className="block">
                                <span className="text-sm font-medium text-ink-700">Choices, one per line</span>
                                <textarea name="options" rows={3} defaultValue={def.options.join("\n")}
                                          className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm" />
                              </label>
                            ) : null}
                            <TextField label="Order on the form" name="sortOrder" type="number" defaultValue={String(def.sortOrder)} />
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" name="required" defaultChecked={def.required} className="h-4 w-4" />
                              Required on new records and on edits that touch it
                            </label>
                          </ActionForm>
                          <ActionForm action={retireField} tone="danger" submit={`Retire ${def.label}`}
                                      hidden={{ id: def.id }} className="mt-3 space-y-2">
                            {def.rowsWithValue > 0 ? (
                              <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name="force" className="h-4 w-4" />
                                Retire it anyway. {def.rowsWithValue} records keep their value, which no screen shows after.
                              </label>
                            ) : null}
                          </ActionForm>
                        </details>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
            {(report?.undefinedKeys.length ?? 0) > 0 ? (
              <p className="mt-2 text-sm text-amber-700">
                Values stored under names no field describes: {report!.undefinedKeys.map((k) => `${k.key} (${k.rowsWithValue})`).join(", ")}.
                Usually an import. Define a field with the same key to show them.
              </p>
            ) : null}
          </section>
        );
      })}

      {writes ? (
        <section className="mt-12" aria-labelledby="add-field">
          <h2 id="add-field" className="text-base font-semibold">Add a field</h2>
          <ActionForm action={defineField} submit="Add the field" className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2"
                      hidden={records.length === 1 ? { entityType: records[0]!.key } : {}}>
            {records.length > 1 ? (
              <label className="block">
                <span className="text-sm font-medium text-ink-700">On</span>
                <select name="entityType" defaultValue={records[0]?.key} className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                  {records.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
            ) : null}
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Kind of answer</span>
              <select name="dataType" defaultValue="text" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <TextField label="Label people read" name="label" required maxLength={120} placeholder="Gate code" />
            <TextField label="Key it is stored under" name="key" required maxLength={64} placeholder="gate_code"
                       pattern="[a-z][a-z0-9_]*" title="Lowercase letters, digits and underscores, starting with a letter" />
            <label className="block sm:col-span-2">
              <span className="text-sm font-medium text-ink-700">Choices, one per line (for a list)</span>
              <textarea name="options" rows={3} className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm" />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="required" className="h-4 w-4" />
              Required. Existing records still save without it; new ones are asked.
            </label>
            <p className="text-xs text-ink-500 sm:col-span-2">
              The key cannot be changed later, because every stored value is found by it. The label can.
            </p>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
