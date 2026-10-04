import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

/**
 * The company's logo, by its public key.
 *
 * Served to anybody, because it is what the company puts on its vans and the
 * sign in page shows it before anybody has signed in. The signed in pages
 * use it too, so the sign in cookie never has to travel in an image's
 * address. Only the logo: the service reads nothing else of the company's.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const asset = await portal.publicLogoAt(getDb(), slug).catch(() => null);
  if (!asset) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": asset.contentType,
      /** A year, because the address carries a version that changes when the logo does. */
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
