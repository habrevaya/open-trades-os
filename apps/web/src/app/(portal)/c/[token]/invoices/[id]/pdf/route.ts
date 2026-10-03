import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { portalPdf } from "@/lib/pdf-response";

/** One of the customer's invoices, from their account link, as a PDF. Never a draft, never somebody else's. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  return portalPdf(() => documents.invoicePdfForAccount(getDb(), { token, invoiceId: id }));
}
