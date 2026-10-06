import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dataExport } from "@opentradesos/api/services";
import { writeArchive, archiveFilename } from "@opentradesos/api/portability";
import { streamed } from "@/lib/export-stream";

export const dynamic = "force-dynamic";

/**
 * THE WHOLE COMPANY AS A ZIP OF SPREADSHEETS
 *
 * One CSV per table, the manifest, a README saying what every column holds,
 * and every photograph and document under its own name. Streamed: each table
 * is compressed as its rows arrive and the first byte leaves at once, so a
 * company with years of history gets a download that starts rather than a
 * request that times out while a server builds a file in memory.
 *
 * The same permission, redactions and audit lines as the other download,
 * because both are written by the export service from the same moment.
 */
export async function GET(): Promise<Response> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  /** The permission check, with a status, before a single byte says 200. */
  const manifest = await dataExport.manifest(ctx);

  const stream = streamed((sink) => dataExport.withSnapshot(ctx, "archive", (source) => writeArchive(source, sink)));

  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${archiveFilename(manifest.generatedAt)}"`,
      "cache-control": "no-store",
    },
  });
}
