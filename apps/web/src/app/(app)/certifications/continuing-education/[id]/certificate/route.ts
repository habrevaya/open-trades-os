import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { peopleRecords, NotFoundError } from "@opentradesos/api/services";
import { PermissionError } from "@opentradesos/core";
import { getCurrentUser } from "@/lib/auth";

/**
 * THE PHOTOGRAPH OF A CERTIFICATE KEPT WITH HOURS OF CONTINUING EDUCATION
 *
 * For the person whose hours they are, and for whoever reads the certification
 * register. The service decides which: anybody else's is refused, and the type
 * is the sniffed one from when it was stored, never anything a request asked
 * for. `?n=1` is the second photograph, oldest first.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const n = Number(new URL(request.url).searchParams.get("n") ?? "0");
  try {
    const file = await peopleRecords.ceCertificate({ actor: user.actor, db: getDb() }, { id, index: Number.isInteger(n) ? n : 0 });
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof PermissionError) return new NextResponse("Not found", { status: 404 });
    throw error;
  }
}
