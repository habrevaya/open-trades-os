import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards } from "@opentradesos/api/services";
import { officePdf } from "@/lib/pdf-response";
import { choiceOf } from "../../../DashboardDates";

/**
 * A dashboard somebody assembled, as one PDF of every tile the reader may
 * see; the tiles they may not see are named at the end.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  /** The days chosen on the screen travel in the address, so the file is the page that was being looked at. */
  return officePdf(async () => {
    const dates = await dashboards.chosenDates(ctx, choiceOf(Object.fromEntries(new URL(request.url).searchParams)));
    return dashboards.dashboardPdf(ctx, { dashboardId: id }, { dates });
  });
}
