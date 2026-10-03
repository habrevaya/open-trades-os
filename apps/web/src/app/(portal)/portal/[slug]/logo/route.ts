import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";

/**
 * The company's logo, for a signed in customer's pages.
 *
 * The link pages put their token in the logo's address, which costs nothing
 * because the token is already in the page's own address. A sign in is a
 * cookie and must stay one, so these pages ask here instead, and the cookie
 * (scoped to `/portal/{slug}`) comes with the request.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await currentPortalSession(slug);
  if (!session) return new NextResponse("Not found", { status: 404 });
  const asset = await portal.brandAssetFor(getDb(), session.token).catch(() => null);
  if (!asset) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": asset.contentType,
      /** Private: it was fetched with somebody's sign in, so no shared cache keeps it. */
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
