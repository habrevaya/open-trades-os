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

/**
 * A file the office marked for the customer, as a response, or a 404. Served
 * under the type it was sniffed as when stored (a PDF or a picture), sandboxed,
 * private and short lived for the reason a photograph is: the office can stop
 * showing it.
 */
export function fileResponse(file: { bytes: Buffer; contentType: string; fileName: string | null } | null): NextResponse {
  if (!file) return new NextResponse("Not found", { status: 404 });
  const name = (file.fileName ?? "file").replace(/[^A-Za-z0-9._ -]/g, "-");
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename="${name}"`,
    },
  });
}
