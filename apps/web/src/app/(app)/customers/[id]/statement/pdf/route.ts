import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { officePdf, periodFrom } from "@/lib/pdf-response";

/** The customer's statement for the period on the screen, as a PDF. */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return officePdf(() => documents.statementPdf({ actor: user.actor, db: getDb() }, { id, ...periodFrom(request) }));
}
