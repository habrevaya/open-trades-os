"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, refused, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { proposalTemplates } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/** Lay this draft's proposal out with a saved layout, or the plain one. */
export async function applyLayout(_previous: FormState, form: FormData): Promise<FormState> {
  const estimateId = String(form.get("estimateId") ?? "");
  const result = await attempt(form, async () => {
    const applied = await proposalTemplates.applyToEstimate(await ctx(), {
      estimateId, templateId: field(form, "templateId") ?? null,
    });
    return { message: applied.templateName ? `Laid out as ${applied.templateName}.` : "Back to the plain layout." };
  });
  revalidatePath(`/estimates/${estimateId}`);
  return result;
}

export async function addOptionPhoto(_previous: FormState, form: FormData): Promise<FormState> {
  const estimateId = String(form.get("estimateId") ?? "");
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return refused(form, "Choose a photograph.");
  const result = await attempt(form, async () => {
    await proposalTemplates.addOptionPhoto(await ctx(), {
      optionId: String(form.get("optionId") ?? ""), fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return { message: "Added." };
  });
  revalidatePath(`/estimates/${estimateId}`);
  return result;
}

export async function removeOptionPhoto(_previous: FormState, form: FormData): Promise<FormState> {
  const estimateId = String(form.get("estimateId") ?? "");
  const result = await attempt(form, async () => {
    await proposalTemplates.removeOptionPhoto(await ctx(), { attachmentId: String(form.get("photoId") ?? "") });
  });
  revalidatePath(`/estimates/${estimateId}`);
  return result;
}
