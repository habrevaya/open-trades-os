import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";
import { portalPdf } from "@/lib/pdf-response";

/** One of the signed in customer's invoices as a PDF. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const session = await currentPortalSession(slug);
  if (!session) return new NextResponse("Not found", { status: 404 });
  return portalPdf(() => documents.invoicePdfForAccount(getDb(), { token: session.token, invoiceId: id }));
}
