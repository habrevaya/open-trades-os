import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { me } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/**
 * One's own signed copy of a document. The person comes from the session, so
 * a request that is somebody else's is not found.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const user = await requireSetupUser();
  const { requestId } = await params;
  return officePdf(() => me.signedPdf({ actor: user.actor, db: getDb() }, { requestId }));
}
