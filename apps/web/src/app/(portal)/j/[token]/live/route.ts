import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { liveLocation } from "@opentradesos/api/services";

/**
 * THE MOVING PART OF A TRACKING LINK
 *
 * Read by the tracking page every twenty seconds while the technician is on
 * the way. What it will show is decided in `liveLocation.liveTracking`: one
 * pin, only for this visit, only after the text, and none once they have
 * arrived. A bad token is the same 404 as a job that does not exist.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const live = await liveLocation.liveTracking(getDb(), { token }).catch(() => null);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(live, {
    /** Where somebody is now: never cached, by anybody. */
    headers: { "Cache-Control": "no-store" },
  });
}
