import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/** The invoice as a PDF, under the same permission and scope as its page. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return officePdf(() => documents.invoicePdf({ actor: user.actor, db: getDb() }, { id }));
}
