"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { knowledge } from "@opentradesos/api/services";
import { createKnowledgeNote, updateKnowledgeNote } from "@opentradesos/api/contracts";

/**
 * Writing the company's how-to notes, through the same service and the same
 * schema as the API, so the refusals are the service's own sentences.
 */
const tagsOf = (form: FormData) =>
  String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function writeNote(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await knowledge.create(await ctx(), parsed(createKnowledgeNote.input, {
      title: field(form, "title") ?? "", body: field(form, "body") ?? "", tags: tagsOf(form),
    }));
    revalidatePath("/settings/agents/notes");
    return { message: "Saved. The field assistant can answer from it now." };
  });
}

export async function changeNote(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await knowledge.update(await ctx(), parsed(updateKnowledgeNote.input, {
      id: field(form, "id") ?? "", title: field(form, "title") ?? "", body: field(form, "body") ?? "", tags: tagsOf(form),
    }));
    revalidatePath("/settings/agents/notes");
    return { message: "Saved." };
  });
}

export async function removeNote(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await knowledge.remove(await ctx(), { id: field(form, "id") ?? "" });
    revalidatePath("/settings/agents/notes");
    return { message: "Taken out of use. The assistant no longer answers from it." };
  });
}
