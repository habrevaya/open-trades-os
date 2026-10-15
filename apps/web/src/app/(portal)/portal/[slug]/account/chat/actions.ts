"use server";

import { getDb } from "@/lib/db";
import { portalChat } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";
import { requestMeta, requirePortalSession } from "@/lib/portal-session";

/**
 * THE CUSTOMER'S CHAT, bound to the company's slug and read with the sign in
 * cookie on the server like every other action on these pages. The service
 * puts every message on the customer the sign in names.
 */

export type ChatView = Awaited<ReturnType<typeof portalChat.read>>;

export async function readChat(slug: string): Promise<ChatView> {
  const session = await requirePortalSession(slug);
  return portalChat.read(getDb(), { token: session.token });
}

/**
 * One message: the words, any pictures (the bytes only, the service decides
 * what they are), and the key that makes a double tap one message. The pictures
 * arrive as files of the form, so nothing is encoded in the browser.
 */
export async function sendChat(slug: string, form: FormData): Promise<{ ok: true; chat: ChatView } | { ok: false; message: string }> {
  const session = await requirePortalSession(slug);
  const text = String(form.get("text") ?? "").slice(0, 2000);
  const key = String(form.get("key") ?? "").slice(0, 100);
  const pictures = await Promise.all(form.getAll("pictures")
    .filter((value): value is File => value instanceof File && value.size > 0)
    .slice(0, 4)
    .map(async (file) => ({
      fileName: file.name || "photo",
      contentType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()).toString("base64"),
    })));
  try {
    const chat = await portalChat.say(getDb(), {
      token: session.token, text, ...(pictures.length > 0 ? { pictures } : {}),
    }, { ...(await requestMeta()), idempotencyKey: key });
    return { ok: true, chat };
  } catch (error) {
    if (error instanceof Error && error.name === "TooManyRequestsError") {
      return { ok: false, message: "That is a lot of messages in a short time. Wait a few minutes, or call us." };
    }
    const message = refusalOf(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
}
