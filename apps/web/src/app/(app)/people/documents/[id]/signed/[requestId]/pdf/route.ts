import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffDocuments } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/**
 * A signed copy of a document somebody was asked to sign, for the office:
 * who signed, when, how, the words, and the signature. `user:read`, the
 * permission that reads who signed; the document in the path is only the
 * page this link sits on, and the request is what is printed.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const user = await requireSetupUser();
  const { requestId } = await params;
  return officePdf(() => staffDocuments.signedPdf({ actor: user.actor, db: getDb() }, { requestId }));
}
