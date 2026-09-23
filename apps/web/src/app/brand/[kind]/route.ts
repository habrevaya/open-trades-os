import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { branding, NotFoundError } from "@opentradesos/api/services";
import { getCurrentUser } from "@/lib/auth";
import { branding as brand } from "@opentradesos/core";

/**
 * A COMPANY'S LOGO AND FAVICON, SERVED FROM THE DATABASE
 *
 * Outside the app group on purpose. The proposal and the job tracking page
 * are opened by a customer with no account, and a logo behind a sign in is a
 * logo the people it exists for never see.
 *
 * It is still tenant scoped. There is no id in the path: the organization
 * comes from the session, so this route cannot be pointed at somebody else's
 * mark by changing a number.
 */
export const dynamic = "force-dynamic";

const KINDS = new Set<brand.BrandAssetKind>(["logo", "favicon"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  const { kind } = await params;
  if (!KINDS.has(kind as brand.BrandAssetKind)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });

  try {
    const asset = await branding.assetBytes(
      { actor: user.actor, db: getDb() },
      { kind: kind as brand.BrandAssetKind },
    );

    return new NextResponse(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.contentType,
        /**
         * A year, and safe because the URL carries a version that changes
         * when the mark does. Without that, a long cache is a logo somebody
         * replaced still showing up a week later, and a short one is the
         * whole file on every page load.
         */
        "Cache-Control": "public, max-age=31536000, immutable",
        /**
         * Belt and braces on top of refusing SVG at upload. If a bitmap
         * sniff is ever wrong, this stops the browser deciding for itself
         * that the bytes are a document.
         */
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return new NextResponse("Not found", { status: 404 });
    throw error;
  }
}
