import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { spreadsheetImports } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * THE REFUSED ROWS, AS A FILE TO FIX
 *
 * The file's own columns, with each row's place in the first file and why it
 * was refused at the end. A cell that would run as a formula in a spreadsheet
 * is written as text by the service, which is also where the permission is.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireSetupUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const file = await spreadsheetImports.refusedFile({ actor: user.actor, db: getDb() }, { id });
  return new Response(file.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
    },
  });
}
