"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, field, refused, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { proposalTemplates } from "@opentradesos/api/services";
import { estimate as est } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * THE LAYOUT AS THE EDITOR POSTED IT
 *
 * One row per section, each named `s<n>.<field>`, plus one blank row for
 * adding a section. A row whose kind is left empty is taken out; the rest
 * are put in the order of their position boxes (ties keep the order they
 * were in). Plain form fields rather than a JSON blob from a script, so the
 * editor works with JavaScript off and what was typed is what was posted.
 * Core checks the result; nothing here decides what a layout may hold.
 */
function layoutFrom(form: FormData, existingPhoto: string | null) {
  const rows: { position: number; index: number; section: Record<string, unknown> }[] = [];
  for (let index = 0; index < 20; index += 1) {
    if (!form.has(`s${index}.kind`)) continue;
    const kind = field(form, `s${index}.kind`);
    if (!kind) continue;
    const position = Number(field(form, `s${index}.position`) ?? index + 1);
    rows.push({
      position: Number.isFinite(position) ? position : index + 1,
      index,
      section: {
        kind,
        title: field(form, `s${index}.title`) ?? "",
        body: field(form, `s${index}.body`) ?? null,
        ...(kind === "reviews" ? {
          minRating: field(form, `s${index}.minRating`) ?? undefined,
          count: field(form, `s${index}.count`) ?? undefined,
        } : {}),
      },
    });
  }
  rows.sort((a, b) => a.position - b.position || a.index - b.index);
  return {
    cover: form.get("cover") === "on"
      ? { headline: field(form, "headline") ?? "", intro: field(form, "intro") ?? null, photoKey: existingPhoto }
      : null,
    sections: rows.map((row) => row.section),
    showOptionPhotos: form.get("showOptionPhotos") === "on",
  };
}

/** Start a layout from a starting point worth editing, then open it. */
export async function startTemplate(_previous: FormState, form: FormData): Promise<FormState> {
  let made: string | null = null;
  const result = await attempt(form, async () => {
    const template = await proposalTemplates.save(await ctx(), {
      name: field(form, "name") ?? "",
      jobTypeId: field(form, "jobTypeId") ?? null,
      isDefault: form.get("isDefault") === "on",
      layout: est.starterLayout(field(form, "companyName") ?? "us"),
    });
    made = template.id;
  });
  revalidatePath("/estimates/templates");
  if (made) redirect(`/estimates/templates/${made}`);
  return result;
}

export async function saveTemplate(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const result = await attempt(form, async () => {
    const context = await ctx();
    const before = await proposalTemplates.get(context, { id });
    await proposalTemplates.save(context, {
      id,
      name: field(form, "name") ?? "",
      jobTypeId: field(form, "jobTypeId") ?? null,
      isDefault: form.get("isDefault") === "on",
      layout: layoutFrom(form, before.layout.cover?.photoKey ?? null),
    });
    return { message: "Saved. New estimates for its job type start with it; estimates it was already on keep theirs." };
  });
  revalidatePath(`/estimates/templates/${id}`);
  revalidatePath("/estimates/templates");
  return result;
}

export async function uploadCover(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return refused(form, "Choose a photograph to put on the cover.");
  const result = await attempt(form, async () => {
    await proposalTemplates.uploadCoverPhoto(await ctx(), {
      id, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return { message: "The cover has its photograph." };
  });
  revalidatePath(`/estimates/templates/${id}`);
  return result;
}

export async function retireTemplate(_previous: FormState, form: FormData): Promise<FormState> {
  let gone = false;
  const result = await attempt(form, async () => {
    await proposalTemplates.remove(await ctx(), { id: String(form.get("id") ?? "") });
    gone = true;
  });
  revalidatePath("/estimates/templates");
  if (gone) redirect("/estimates/templates");
  return result;
}
