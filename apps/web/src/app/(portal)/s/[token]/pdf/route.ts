import { getDb } from "@/lib/db";
import { statementDelivery } from "@opentradesos/api/services";
import { portalPdf } from "@/lib/pdf-response";

/** The one statement a statement link opens, as a PDF. The period is the link's own, never the address bar's. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return portalPdf(() => statementDelivery.statementLinkPdf(getDb(), { token }));
}
