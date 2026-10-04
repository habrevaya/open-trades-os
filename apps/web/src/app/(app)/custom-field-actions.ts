"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, customers, jobs, properties } from "@opentradesos/api/services";
import { customFieldsFrom } from "@/lib/custom-field-form";

/**
 * Saving the custom fields on a customer, a property or a job, from its page.
 *
 * The record is read first so what the form does not draw is carried over,
 * and the write goes through the record's own update, which is where the
 * definitions are enforced and under that record's own permission. A refusal
 * is the service's, one sentence per field.
 */
export async function saveCustomFields(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const entityType = String(form.get("entityType") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    const definitions = await customFields.formFields(ctx, entityType);
    switch (entityType) {
      case "customer": {
        const before = await customers.get(ctx, { id });
        await customers.update(ctx, {
          id, customFields: customFieldsFrom(form, definitions, (before.customFields ?? {}) as Record<string, unknown>),
        });
        break;
      }
      case "property": {
        const before = await properties.get(ctx, { id });
        await properties.update(ctx, {
          id, customFields: customFieldsFrom(form, definitions, (before.customFields ?? {}) as Record<string, unknown>),
        });
        break;
      }
      case "job": {
        const before = await jobs.get(ctx, { id });
        await jobs.update(ctx, {
          id, customFields: customFieldsFrom(form, definitions, (before.customFields ?? {}) as Record<string, unknown>),
        });
        break;
      }
      /**
       * The five that grew a column later save through one write of their
       * own, under that record's write permission and scope, built on what
       * is stored so nothing the form does not draw is lost.
       */
      case "invoice":
      case "estimate":
      case "visit":
      case "equipment":
      case "technician": {
        const before = await customFields.valuesFor(ctx, { entityType, id });
        await customFields.setValues(ctx, { entityType, id, values: customFieldsFrom(form, definitions, before) });
        break;
      }
      default:
        throw new Error(`Unknown entity: ${entityType}`);
    }
    return { message: "Saved." };
  });

  if (state?.done) {
    const back = field(form, "back");
    if (back && back.startsWith("/") && !back.startsWith("//")) revalidatePath(back);
    const base = entityType === "customer" ? "/customers" : entityType === "property" ? "/properties" : "/jobs";
    revalidatePath(`${base}/${id}`);
  }
  return state;
}
