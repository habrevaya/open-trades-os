"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { transcription } from "@opentradesos/api/services";

/**
 * Write a call's audio out now, rather than waiting for the worker: for a
 * call whose transcript failed, or whose audio was kept before speech to
 * text was connected. The service decides whether there is anything to send.
 */
export async function transcribeNow(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const id = field(form, "id") ?? "";
  const state = await attempt(form, async () => {
    const result = await transcription.transcribeNow({ actor: user.actor, db: getDb() }, id);
    return {
      message: result.status === "done" ? "Written out."
        : result.status === "failed" ? `It could not be written out: ${result.error ?? "no reason given"}`
          : "Queued. It will appear here in a minute or two.",
    };
  });
  revalidatePath(`/marketing/calls/${id}`);
  return state;
}
