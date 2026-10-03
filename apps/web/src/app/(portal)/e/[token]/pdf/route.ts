import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { portalPdf } from "@/lib/pdf-response";

/**
 * The proposal from the customer's estimate link, as a PDF. Peeked rather
 * than spent: the single use on an estimate link is for approving it.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return portalPdf(() => documents.proposalPdfForToken(getDb(), { token }));
}
