import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/** The proposal as a PDF: the document `/estimates/{id}/proposal` draws, from the same reader. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return officePdf(() => documents.proposalPdf({ actor: user.actor, db: getDb() }, { id }));
}
