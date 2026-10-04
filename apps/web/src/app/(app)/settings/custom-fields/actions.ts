"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * Options are typed one per line or separated by commas, because a list of
 * plan names is easier to paste than to enter one box at a time.
 */
function optionsFrom(form: FormData): string[] {
  return String(form.get("options") ?? "").split(/[\n,]/).map((o) => o.trim()).filter((o) => o !== "");
}

function sortOrderFrom(form: FormData): number | undefined {
  const raw = field(form, "sortOrder");
  return raw === undefined ? undefined : Number(raw);
}

export async function defineField(_previous: FormState, form: FormData): Promise<FormState> {
  const sortOrder = sortOrderFrom(form);
  const result = await attempt(form, async () => {
    const made = await customFields.define(await ctx(), {
      entityType: field(form, "entityType") ?? "",
      key: field(form, "key") ?? "",
      label: field(form, "label") ?? "",
      dataType: field(form, "dataType") ?? "text",
      options: optionsFrom(form),
      required: form.get("required") === "on",
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    });
    return {
      message: made.required && made.rowsMissingValue > 0
        ? `Added. ${made.rowsMissingValue} existing records have no value yet; they still save, and the field is asked for on new ones.`
        : "Added.",
    };
  });
  /** The fields on the product's records and on a company's own kinds are both under Settings. */
  revalidatePath("/settings", "layout");
  return result;
}

/** The label, the options, whether it is required and its place. Never the key or the record type. */
export async function editField(_previous: FormState, form: FormData): Promise<FormState> {
  const sortOrder = sortOrderFrom(form);
  const result = await attempt(form, async () => {
    const after = await customFields.update(await ctx(), {
      id: String(form.get("id") ?? ""),
      label: field(form, "label") ?? "",
      ...(form.has("options") ? { options: optionsFrom(form) } : {}),
      required: form.get("required") === "on",
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    });
    return {
      message: after.required && after.rowsMissingValue > 0
        ? `Saved. ${after.rowsMissingValue} records have no value yet.`
        : "Saved.",
    };
  });
  /** The fields on the product's records and on a company's own kinds are both under Settings. */
  revalidatePath("/settings", "layout");
  return result;
}

/**
 * Retire a field. The first press is refused while records hold a value, with
 * the count; ticking "retire it anyway" is the person saying they read it.
 */
export async function retireField(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const gone = await customFields.remove(await ctx(), {
      id: String(form.get("id") ?? ""),
      force: form.get("force") === "on",
    });
    return {
      message: gone.orphanedValues > 0
        ? `Retired. ${gone.orphanedValues} records keep their value, which no screen shows now.`
        : "Retired.",
    };
  });
  /** The fields on the product's records and on a company's own kinds are both under Settings. */
  revalidatePath("/settings", "layout");
  return result;
}
