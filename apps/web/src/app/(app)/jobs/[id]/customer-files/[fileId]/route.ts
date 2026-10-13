import { NextResponse } from "next/server";
import { files } from "@opentradesos/api/services";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

/**
 * OPENING A FILE THE CUSTOMER SENT, FROM THE JOB'S PAGE
 *
 * Opening it is what "the office has seen it" means: from here the customer
 * can no longer take it back, because the company may already have acted on
 * it. So the link goes through this route, which records the first person to
 * open it and then hands over to the ordinary file route, which checks the
 * reader may see documents and serves the bytes under their sniffed type.
 *
 * A read that writes, deliberately: a GET is what a person clicking a link
 * sends. Nothing prefetches it (it is a plain link, not a Next link), and in
 * the read only demo nothing is recorded and the file still opens.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { fileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return new NextResponse("Not found", { status: 404 });
  const user = await requireUser();
  const ctx = { actor: user.actor, db: getDb() };
  const seen = await files.markSeen(ctx, { attachmentId: fileId }).catch((error: unknown) => {
    if (error instanceof Error && (error.name === "NotFoundError" || error.name === "PermissionError")) return null;
    throw error;
  });
  if (!seen) return new NextResponse("Not found", { status: 404 });
  /** A relative address, so it lands on the same host the person used whatever is in front of the app. */
  return new NextResponse(null, { status: 303, headers: { Location: `/files/${seen.storageKey}` } });
}
