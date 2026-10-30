"use server";

import { refused } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, conversationClose, ConflictError } from "@opentradesos/api/services";

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
  /**
   * The bytes only. What a picture is gets decided from them by the
   * service; the name and type the browser sent are never trusted.
   */
  const pictures = await Promise.all(form.getAll("pictures")
    .filter((value): value is File => value instanceof File && value.size > 0)
    .map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name })));

  try {
    await comms.reply({ actor: user.actor, db: getDb() }, { id: conversationId, body, pictures });
  } catch (error) {
    // A refusal is shown to the person, not thrown at them. The message it
    // carries names what happened rather than saying "forbidden".
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }

  revalidatePath(`/inbox/${conversationId}`);
  return { sent: true };
}

/**
 * The office closes a conversation: a website chat, a customer's chat from their
 * account, a text thread or an email thread. Everything said is kept. A customer
 * with a chat from their account is told in words on their chat page, not by text
 * or email. A conversation already closed is a close already made.
 */
export async function closeChat(_previous: unknown, form: FormData) {
  const user = await requireSetupUser();
  const conversationId = String(form.get("conversationId") ?? "");
  const kind = String(form.get("kind") ?? "");
  try {
    await conversationClose.close({ actor: user.actor, db: getDb() }, { id: conversationId });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  return {
    done: true,
    message: kind === "account" ? "Closed. The customer will see that you closed it." : "Closed. You can reopen it from here.",
  };
}

/**
 * The office reopens a closed conversation. It is the same thread, with every
 * message, back in the open inbox. The customer is not told.
 */
export async function reopenChat(_previous: unknown, form: FormData) {
  const user = await requireSetupUser();
  const conversationId = String(form.get("conversationId") ?? "");
  try {
    await conversationClose.reopen({ actor: user.actor, db: getDb() }, { id: conversationId });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  return { done: true, message: "Reopened." };
}
