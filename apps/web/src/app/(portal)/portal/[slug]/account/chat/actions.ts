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

export async function sendChat(slug: string, text: string, key: string): Promise<{ ok: true; chat: ChatView } | { ok: false; message: string }> {
  const session = await requirePortalSession(slug);
  try {
    const chat = await portalChat.say(getDb(), { token: session.token, text: text.slice(0, 2000) }, {
      ...(await requestMeta()), idempotencyKey: key.slice(0, 100),
    });
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
