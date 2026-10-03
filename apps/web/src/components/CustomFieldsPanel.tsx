import { ActionForm } from "@/components/ActionForm";
import { saveCustomFields } from "@/app/(app)/custom-field-actions";
import {
  CustomFieldInputs, customFieldText, type CustomFieldDefinitionView,
} from "@/components/CustomFieldInputs";

/**
 * The fields this company added to a customer, a property or a job, on that
 * record's page: read for anybody who can see the record, editable for
 * anybody who can change it. Nothing at all when the company declared none,
 * because an empty "Custom fields" box is a heading with nothing under it.
 */
export function CustomFieldsPanel({
  entityType, id, definitions, values, canWrite,
}: {
  entityType: "customer" | "property" | "job";
  id: string;
  definitions: readonly CustomFieldDefinitionView[];
  values: Record<string, unknown>;
  canWrite: boolean;
}) {
  if (definitions.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby={`custom-fields-${id}`}>
      <h2 id={`custom-fields-${id}`} className="text-base font-semibold">Your fields</h2>
      {canWrite ? (
        <ActionForm action={saveCustomFields} submit="Save fields" hidden={{ entityType, id }} done="Saved.">
          <CustomFieldInputs definitions={definitions} values={values} />
        </ActionForm>
      ) : (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {definitions.map((definition) => (
            <div key={definition.key}>
              <dt className="text-ink-500">{definition.label}</dt>
              <dd>{customFieldText(definition, values[definition.key]) || "Not said"}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
