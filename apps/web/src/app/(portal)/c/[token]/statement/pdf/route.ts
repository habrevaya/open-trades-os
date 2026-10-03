import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { portalPdf, periodFrom } from "@/lib/pdf-response";

/** The customer's statement from their account link, for the period on the page, as a PDF. */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return portalPdf(() => documents.statementPdfForToken(getDb(), { token, ...periodFrom(request) }));
}
