import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/**
 * A dashboard somebody assembled, as one PDF of every tile the reader may
 * see; the tiles they may not see are named at the end.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  return officePdf(() => dashboards.dashboardPdf({ actor: user.actor, db: getDb() }, { dashboardId: id }));
}
