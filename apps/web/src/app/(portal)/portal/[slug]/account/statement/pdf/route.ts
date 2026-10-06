import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";
import { portalPdf, periodFrom } from "@/lib/pdf-response";

/** The signed in customer's statement as a PDF, through the grant their sign in carries. */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await currentPortalSession(slug);
  if (!session) return new NextResponse("Not found", { status: 404 });
  return portalPdf(() => documents.statementPdfForToken(getDb(), { token: session.token, ...periodFrom(request) }));
}
