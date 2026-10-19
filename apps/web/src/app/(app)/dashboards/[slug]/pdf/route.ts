import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";

/**
 * A dashboard that ships, as one PDF of every tile the reader may see, drawn
 * as the screen draws them; the tiles they may not see are named at the end.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSetupUser();
  const { slug } = await params;
  return officePdf(() => dashboards.dashboardPdf({ actor: user.actor, db: getDb() }, { builtInDashboard: slug }));
}
