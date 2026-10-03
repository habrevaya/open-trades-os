import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { comms } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * A PICTURE FROM A THREAD
 *
 * Served by the thread and the picture's storage key, behind the session,
 * `message:read` and the conversation scope: a picture a customer sent is
 * what they said, and somebody who cannot read the thread cannot see it.
 * With the type the bytes were found to be when they were kept, never one a
 * request asked for, and sandboxed so nothing in a file runs as this site.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string; key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id, key } = await context.params;
  try {
    const file = await comms.picture({ actor: user.actor, db: getDb() }, {
      /** A storage key is a path (`org/ab/cd/hash.jpg`), so it arrives as segments. */
      conversationId: id, storageKey: key.map((part) => decodeURIComponent(part)).join("/"),
    });
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
