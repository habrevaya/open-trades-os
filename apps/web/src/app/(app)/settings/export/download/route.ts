import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dataExport } from "@opentradesos/api/services";
import { writeNdjson } from "@opentradesos/api/portability";
import { streamed, exportFilename } from "@/lib/export-stream";

export const dynamic = "force-dynamic";

/**
 * THE WHOLE COMPANY, STREAMED
 *
 * Newline delimited JSON, because it is the only shape that is both streamable
 * and readable with nothing installed. The first line is the manifest and every
 * line after it is `{"table": ..., "row": {...}}`. A reader that only wants
 * customers greps one table out of it; a reader loading all of it reads a line
 * at a time and never holds the company in memory.
 *
 * The zip of spreadsheets is the other download, at `./archive`. This one keeps
 * every type and every nested value exactly, and is the better input to a
 * program; that one opens in a spreadsheet.
 *
 * The file's shape lives in the API package and the stream in
 * `lib/export-stream.ts`, where both can be tested without a database. This
 * file is the authentication, the headers and nothing else: the permission, the
 * redactions, the one moment and the audit lines are all the export service's.
 */
export async function GET(): Promise<Response> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  /**
   * The manifest first, OUTSIDE the stream, which makes it the permission check
   * too. Somebody without `data:export` is refused here with a status rather
   * than halfway down a file that already started downloading with a 200 on it.
   */
  const manifest = await dataExport.manifest(ctx);

  /**
   * The rows themselves are read in ONE transaction at one moment, so a job
   * booked while the file downloads cannot end up in it pointing at a
   * customer who is not.
   */
  const stream = streamed((sink) => dataExport.withSnapshot(ctx, "download", (source) => writeNdjson(source, sink)));

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(manifest.generatedAt)}"`,
      /** Nothing about a company's whole database belongs in a cache. */
      "cache-control": "no-store",
    },
  });
}
