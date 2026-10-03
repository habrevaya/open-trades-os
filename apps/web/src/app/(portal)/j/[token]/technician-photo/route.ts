import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { liveLocation } from "@opentradesos/api/services";

/**
 * THE TECHNICIAN'S PHOTOGRAPH, ON THEIR CUSTOMER'S TRACKING LINK
 *
 * The lead on the visit the customer is waiting on, and only a picture. The
 * same treatment the job's photographs have: the token that grants sight of
 * the job is what grants sight of this, and a bad token, a job with nobody
 * on it and a technician with no photo are the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const photo = await liveLocation.trackingPhoto(getDb(), token).catch(() => null);
  if (!photo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.contentType,
      /** Short, because the office can change who is on the visit or take the photo down. */
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
