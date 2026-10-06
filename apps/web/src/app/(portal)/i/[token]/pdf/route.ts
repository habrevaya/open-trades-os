import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { portalPdf } from "@/lib/pdf-response";

/** The invoice from the customer's link, as a PDF. Peeked, like the page: saving it is reading it. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return portalPdf(() => documents.invoicePdfForToken(getDb(), { token }));
}
