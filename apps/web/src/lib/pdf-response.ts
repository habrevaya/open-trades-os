import { NextResponse } from "next/server";
import { refusalOf } from "@/lib/actions";

/**
 * A PDF the product made, handed to the browser as a download.
 *
 * `no-store` and `private`, because every one of these is somebody's bill or
 * account: a shared cache between the company and the browser keeping a copy
 * would hand the next person through that proxy a stranger's statement.
 */
export function pdfResponse(file: { filename: string; bytes: Uint8Array }): NextResponse {
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The office's download: the file, or the service's refusal in words. A
 * missing or out of scope record is a 404, the way its page treats it.
 */
export async function officePdf(make: () => Promise<{ filename: string; bytes: Uint8Array }>): Promise<NextResponse> {
  try {
    return pdfResponse(await make());
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      return new NextResponse("Not found", { status: 404 });
    }
    const message = refusalOf(error);
    if (message === null) throw error;
    return new NextResponse(message, { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/**
 * The customer's download. Every failure is the same 404, as every page
 * behind a link is: saying which one it was tells somebody which tokens were
 * real.
 */
export async function portalPdf(make: () => Promise<{ filename: string; bytes: Uint8Array }>): Promise<NextResponse> {
  try {
    return pdfResponse(await make());
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A period from the query string, ignoring anything that is not a date. */
export function periodFrom(request: Request): { from?: string; to?: string } {
  const query = new URL(request.url).searchParams;
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  return { ...(DATE.test(from) ? { from } : {}), ...(DATE.test(to) ? { to } : {}) };
}
