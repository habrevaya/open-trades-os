import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { documents } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/**
 * The job as a work order PDF, under the same permission and scope as its
 * page. `?for=technician` is the copy for the van, printed without prices.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const forTechnician = new URL(request.url).searchParams.get("for") === "technician";
  return officePdf(() => documents.workOrderPdf({ actor: user.actor, db: getDb() }, { id, forTechnician }));
}
