import { NextResponse } from "next/server";

/**
 * A customer's photograph as a response, or a 404. Private and short lived,
 * because the company can stop showing a photograph and a shared cache
 * keeping it would show it anyway; typed as it was sniffed when stored.
 */
export function photoResponse(photo: { bytes: Buffer; contentType: string } | null): NextResponse {
  if (!photo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
