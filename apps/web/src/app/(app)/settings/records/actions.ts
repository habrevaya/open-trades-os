"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, field, fields, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, customObjects } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * What a kind of record is called, what it points at and who may see and
 * change one, as the form posted it. The permission boxes are a choice of a
 * few in plain words, with the current one kept when it is something else.
 */
function definitionFrom(form: FormData) {
  return {
    label: field(form, "label") ?? "",
    pluralLabel: field(form, "pluralLabel"),
    titleLabel: field(form, "titleLabel"),
    description: field(form, "description") ?? null,
    links: fields(form, "links"),
    readPermission: field(form, "readPermission"),
    writePermission: field(form, "writePermission"),
    recordKind: fields(form, "links").includes("record") ? field(form, "recordKind") ?? null : null,
    customerVisible: form.get("customerVisible") === "yes",
  };
}

export async function defineKind(_previous: FormState, form: FormData): Promise<FormState> {
  let key: string | null = null;
  const result = await attempt(form, async () => {
    const made = await customObjects.defineKind(await ctx(), { key: field(form, "key") ?? "", ...definitionFrom(form) });
    key = made.key;
  });
  revalidatePath("/settings", "layout");
  revalidatePath("/records", "layout");
  if (key) redirect(`/settings/records/${key}`);
  return result;
}

export async function updateKind(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await customObjects.updateKind(await ctx(), { id: String(form.get("id") ?? ""), ...definitionFrom(form) });
    return { message: "Saved." };
  });
  revalidatePath("/settings", "layout");
  revalidatePath("/records", "layout");
  return result;
}

/**
 * Mark one of a kind's fields as shown to the customer, or take the mark
 * off. Only ever one field at a time, so what the customer sees changes by
 * a deliberate press rather than as a side effect of saving something else.
 */
export async function setFieldForCustomer(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await customFields.update(await ctx(), {
      id: String(form.get("id") ?? ""), customerVisible: form.get("customerVisible") === "1",
    });
  });
  revalidatePath("/settings/records", "layout");
  return result;
}

/** Retire a kind. Refused while records are on file until "retire it anyway" is ticked, with the count. */
export async function retireKind(_previous: FormState, form: FormData): Promise<FormState> {
  let gone = false;
  const result = await attempt(form, async () => {
    await customObjects.removeKind(await ctx(), { id: String(form.get("id") ?? ""), force: form.get("force") === "on" });
    gone = true;
  });
  revalidatePath("/settings", "layout");
  revalidatePath("/records", "layout");
  if (gone) redirect("/settings/records");
  return result;
}
