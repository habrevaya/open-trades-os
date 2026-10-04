"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalBlocks } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

/**
 * Show the customer what happened on a visit, in the words in the box, or
 * stop showing it. The technician's own notes are never shown as they
 * stand; this is the office choosing what the customer reads.
 */
export async function shareVisitNotes(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  return attempt(form, async () => {
    const stop = field(form, "stop") === "yes";
    await portalBlocks.shareVisitNotes({ actor: (await requireSetupUser()).actor, db: getDb() }, {
      id: field(form, "visitId") ?? "",
      notes: stop ? null : (field(form, "notes") ?? ""),
    });
    revalidatePath(`/jobs/${jobId}`);
    return { message: stop ? "No longer shown." : "Shown on their account." };
  });
}
