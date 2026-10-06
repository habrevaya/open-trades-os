import { customFields } from "@opentradesos/core";
import type { CustomFieldDefinitionView } from "@/components/CustomFieldInputs";

/**
 * The custom fields a form posted, as the values the service checks.
 *
 * Built on what the record already holds, so a key the form does not draw is
 * carried through and a box left empty for a field never filled in stays
 * absent. That second part is what lets a record from before a field became
 * required save without anybody filling it in: absent before, absent after,
 * which the service reads as untouched. See `fromForm` in core.
 */
export function customFieldsFrom(
  form: FormData,
  definitions: readonly CustomFieldDefinitionView[],
  previous: Record<string, unknown> = {},
  prefix = "cf",
): Record<string, unknown> {
  return customFields.fromForm(
    definitions,
    (key) => form.getAll(`${prefix}:${key}`).filter((v): v is string => typeof v === "string"),
    previous,
  );
}
