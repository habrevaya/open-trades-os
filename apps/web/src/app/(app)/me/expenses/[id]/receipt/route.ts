import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { expenses, NotFoundError } from "@opentradesos/api/services";
import { getCurrentUser } from "@/lib/auth";

/**
 * THE PHOTOGRAPH OF YOUR OWN RECEIPT
 *
 * The same bytes as the office's route beside it, for the person who recorded
 * it. The service decides whose it is: somebody else's is not found, and the
 * type is the sniffed one from when it was stored, never anything a request
 * asked for.
 *
 * `?n=1` is the second photograph, oldest first. The first when left out.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const n = Number(new URL(request.url).searchParams.get("n") ?? "0");
  try {
    const file = await expenses.receipt({ actor: user.actor, db: getDb() }, { id, index: Number.isInteger(n) ? n : 0 });
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
    if (error instanceof NotFoundError) return new NextResponse("Not found", { status: 404 });
    throw error;
  }
}
