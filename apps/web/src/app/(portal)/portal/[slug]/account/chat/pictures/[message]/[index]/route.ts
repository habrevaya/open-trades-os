import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portalChat } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";
import { photoResponse } from "../../../../../../../photo-response";

/**
 * ONE PICTURE FROM A SIGNED IN CUSTOMER'S OWN CHAT, read with the sign in
 * cookie rather than a token in the address, for the reason the logo route
 * beside the account gives. Asked for by message and position, never by the
 * file's storage key, and only for a message in the conversation this sign in
 * names: anything else is the same 404 as a picture that does not exist.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request, { params }: { params: Promise<{ slug: string; message: string; index: string }> },
) {
  const { slug, message, index } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(message) || !/^[0-2]$/.test(index)) return new NextResponse("Not found", { status: 404 });
  const session = await currentPortalSession(slug);
  if (!session) return new NextResponse("Not found", { status: 404 });
  return photoResponse(await portalChat.picture(getDb(), {
    token: session.token, messageId: message, index: Number(index),
  }).catch(() => null));
}
