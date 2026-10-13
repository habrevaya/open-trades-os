import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { comms } from "@opentradesos/api/services";
import { files as fileRules } from "@opentradesos/core";

export const dynamic = "force-dynamic";

/**
 * A PICTURE FROM A THREAD
 *
 * Served by the thread and the picture's storage key, behind the session,
 * `message:read` and the conversation scope: a picture a customer sent is
 * what they said, and somebody who cannot read the thread cannot see it.
 * With the type the bytes were found to be when they were kept, never one a
 * request asked for, and sandboxed so nothing in a file runs as this site.
 *
 * `?download=1` saves it rather than showing it (a PDF that came with an
 * email), under the name the email carried with the extension of what the
 * bytes ARE, so nothing can be saved as a program whatever it was called.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string; key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id, key } = await context.params;
  try {
    /** A storage key is a path (`org/ab/cd/hash.jpg`), so it arrives as segments. */
    const storageKey = key.map((part) => decodeURIComponent(part)).join("/");
    const file = await comms.picture({ actor: user.actor, db: getDb() }, { conversationId: id, storageKey });
    const download = new URL(request.url).searchParams.get("download") === "1";
    const extension = /\.([a-z0-9]+)$/.exec(storageKey)?.[1] ?? "bin";
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ...(download
          ? { "Content-Disposition": `attachment; filename="${fileRules.downloadName(file.name ?? "attachment", extension)}"` }
          : {}),
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
