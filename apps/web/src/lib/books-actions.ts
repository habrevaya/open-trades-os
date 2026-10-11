"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accounting } from "@opentradesos/api/services";

/**
 * SEND A RECORD TO THE BOOKS AGAIN, from the note on the record that says it
 * was deleted there.
 *
 * The same call as the retry on the accounting problems list, so the
 * permission (`accounting:sync`) and the refusals are the service's: the
 * record goes on the next sync pass under the same claim, so it cannot land
 * twice. The page to refresh comes from the form, and only an internal path
 * is taken.
 */
export async function sendToBooksAgain(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const state = await attempt(form, async () => {
    await accounting.retryDocument(ctx, { linkId: field(form, "linkId") ?? "" });
    return { message: "It goes to the books again on the next sync." };
  });
  const path = field(form, "path") ?? "";
  if (path.startsWith("/") && !path.startsWith("//")) revalidatePath(path);
  return state;
}
