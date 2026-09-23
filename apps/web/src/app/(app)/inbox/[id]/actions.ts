"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, ConflictError } from "@opentradesos/api/services";

/**
 * The reply goes through the service, which checks consent again.
 *
 * The screen already asked whether a reply was allowed and hid the box if
 * not. That is a courtesy; this is the rule. Between the render and the send
 * a customer can text STOP, and the answer has to be no.
 */
export async function sendReply(_previous: unknown, form: FormData) {
  const user = await requireSetupUser();
  const conversationId = String(form.get("conversationId") ?? "");
  const body = String(form.get("body") ?? "");

  try {
    await comms.reply({ actor: user.actor, db: getDb() }, { id: conversationId, body });
  } catch (error) {
    // A refusal is shown to the person, not thrown at them. The message it
    // carries names what happened rather than saying "forbidden".
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }

  revalidatePath(`/inbox/${conversationId}`);
  return { sent: true };
}
