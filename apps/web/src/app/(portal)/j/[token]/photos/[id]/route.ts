import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

/**
 * ONE JOB PHOTOGRAPH, FOR THE CUSTOMER HOLDING THE JOB'S LINK.
 *
 * The treatment the company's logo has: a token that already grants sight
 * of the job is what grants sight of its photographs, and nothing else
 * does. By attachment id rather than storage key, because a content
 * addressed key is the same for anybody holding the same file and is not a
 * capability. The service checks the photograph is on this link's job and
 * shown to the customer; any other id, a bad token and a private photograph
 * are all the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const photo = await portal.jobPhotoFor(getDb(), token, id).catch(() => null);
  if (!photo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      /** The type sniffed when it was stored, never one a request asked for. */
      "Content-Type": photo.contentType,
      /**
       * Private, and not for ever: the company can stop showing a
       * photograph, and a shared cache keeping it would show it anyway.
       */
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
