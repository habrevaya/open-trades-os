import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketing } from "@opentradesos/api/services";
import { marketing as mk } from "@opentradesos/core";

export const dynamic = "force-dynamic";

/**
 * The conversions file, as a download.
 *
 * The same handler the API serves at `GET /v1/marketing/conversions`, asked
 * for the platform's own format, and handed back as a file named for the
 * platform and the dates so two downloads in a folder can be told apart.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const url = new URL(request.url);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!iso.test(from) || !iso.test(to)) return new Response("Give the dates as 2026-04-01.", { status: 400 });
  const format = url.searchParams.get("format") === "meta" ? "meta" as const : "google" as const;
  const model = mk.ATTRIBUTION_MODEL_KEYS.find((key) => key === url.searchParams.get("model")) ?? "position_based";

  try {
    const result = await marketing.conversionHandlers.getConversions(
      { actor: user.actor, db: getDb() }, { from, to, model, format },
    );
    return new Response(result.csv ?? "", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${format}-conversions-${from}-to-${to}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "PermissionError") return new Response(error.message, { status: 403 });
    throw error;
  }
}
