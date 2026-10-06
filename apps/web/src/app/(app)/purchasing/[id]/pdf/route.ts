import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { purchaseOrderEmail } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/** The order as a PDF, the same file the vendor's email carries, under the same permission as its page. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return officePdf(() => purchaseOrderEmail.orderPdf({ actor: user.actor, db: getDb() }, { id }));
}
