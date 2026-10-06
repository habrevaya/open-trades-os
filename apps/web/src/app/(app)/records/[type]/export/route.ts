import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects } from "@opentradesos/api/services";

/**
 * A kind's records as a CSV: every one the person may see, each field by its
 * label and what each points at by name and by id, so the file loads back in
 * on the import page. A refusal (the kind is not theirs to read) is a 404,
 * like the list it came from.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ type: string }> }) {
  const user = await requireSetupUser();
  const { type } = await params;
  try {
    const file = await customObjects.exportCsv({ actor: user.actor, db: getDb() }, { type });
    return new Response(file.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotFoundError" || name === "PermissionError") return new Response("Not found", { status: 404 });
    throw error;
  }
}
