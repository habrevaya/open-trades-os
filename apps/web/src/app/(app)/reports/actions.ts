"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, ConflictError } from "@opentradesos/api/services";
import { definitionFromForm } from "@/lib/report-params";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Saving is the same shape as running: the form carries the definition, not a
 * blob somebody serialised earlier. `save` resolves it against the catalogue
 * and against what the author holds before it is stored, so a report nobody
 * can run never reaches the list.
 */
export async function saveReport(_previous: unknown, form: FormData) {
  const definition = definitionFromForm(form);
  if (!definition) return { error: "Pick a dataset first" };

  const description = String(form.get("description") ?? "").trim();
  let saved;
  try {
    saved = await reports.save(await ctx(), {
      name: String(form.get("name") ?? ""),
      definition,
      ...(description ? { description } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }

  revalidatePath("/reports");
  redirect(`/reports/saved/${saved.id}`);
}

export async function deleteReport(_previous: unknown, form: FormData) {
  try {
    await reports.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/reports");
  redirect("/reports");
}
