import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { telephony } from "@opentradesos/api/services";

/**
 * THE AUDIO OF ONE CALL
 *
 * Served by the call's id, behind the session and `message:read`, which is
 * what reading the call itself takes: a recording is the conversation. Not
 * through the general file route, whose permission is about documents, and
 * never cached anywhere but the browser that asked, because a recording
 * deleted here must stop playing everywhere.
 */
export async function audio(context: { params: Promise<{ id: string }> }, which: "recording" | "voicemail") {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id } = await context.params;
  try {
    const file = await telephony.recordingAudio({ actor: user.actor, db: getDb() }, id, which);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
