import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { files, NotFoundError } from "@opentradesos/api/services";
import { getCurrentUser } from "@/lib/auth";

/**
 * THE BYTES OF AN ATTACHMENT
 *
 * A photograph a technician took, a signature, the PDF a manufacturer sent.
 * Served here rather than through the JSON API for the obvious reason: an
 * image tag cannot point at a JSON body, and base64 inside one would be a
 * third larger and uncacheable.
 *
 * TENANT SCOPED BY THE SESSION, NOT BY THE PATH. The key in the URL is
 * content addressed and begins with an organization id, and that prefix is
 * NOT what decides access: `files.open` filters on the caller's own
 * organization, so editing the prefix reaches nothing. Without that, a
 * content addressed key would be a capability anybody could type.
 *
 * NO PORTAL PATH, unlike the brand route. A customer's proposal does not
 * show job photographs yet, and adding an unauthenticated way to read one
 * "for later" is how a private photograph of somebody's house becomes
 * public. When the portal needs them, it gets the same treatment the logo
 * has: a token that already grants sight of the record the file is on.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });

  const { key } = await params;
  /**
   * Rejoined from the catch-all rather than taken as one parameter, because
   * the key has slashes in it by design: it fans out by the first four
   * characters of the hash so no directory ends up holding every file.
   */
  const storageKey = key.map((segment) => decodeURIComponent(segment)).join("/");

  try {
    const file = await files.open({ actor: user.actor, db: getDb() }, storageKey);

    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        /** The SNIFFED type, from when it was stored. Never anything a request asked for. */
        "Content-Type": file.contentType,
        /**
         * A year, and safe because the key IS the hash: different bytes are
         * a different URL, so there is nothing to invalidate.
         */
        "Cache-Control": "private, max-age=31536000, immutable",
        /**
         * Belt and braces over refusing everything but a known bitmap and
         * PDF at upload. If a sniff is ever wrong, this stops the browser
         * deciding for itself that the bytes are a document.
         */
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        /**
         * Inline, and every part of that is load bearing.
         *
         * `attachment` would be the cautious default and would break the
         * only thing this route exists for: a browser honours it and will
         * not render the bytes in an image tag, so every job photograph
         * would become a download.
         *
         * Inline is safe here because of what has already happened to this
         * file and not because of anything decided at this line. The type
         * was sniffed from the bytes when it was stored and nothing a
         * request says can change it; the accepted set is bitmaps and PDF
         * only, with SVG refused by name because it can carry script;
         * `nosniff` stops the browser second guessing the type; and the
         * sandbox CSP means a PDF cannot reach anything if a viewer is ever
         * persuaded to run something.
         *
         * No filename is offered at all, because the only name available is
         * one the uploader chose, and `invoice.pdf.html` is what that gets
         * you.
         */
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return new NextResponse("Not found", { status: 404 });
    throw error;
  }
}
