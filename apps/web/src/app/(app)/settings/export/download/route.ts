import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dataExport } from "@opentradesos/api/services";
import { ndjson, exportFilename } from "@/lib/export-stream";

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
 * NOT CSV, and not one file per table in a zip. A CSV per table loses the type
 * of every column and cannot represent a jsonb field at all, which is where the
 * custom fields live. A zip has to be finished before its first byte can be
 * sent, so a company with real history gets a request that times out instead of
 * a file that starts arriving.
 *
 * The file's shape lives in `lib/export-stream.ts`, where it can be tested
 * without a database. This file is the authentication, the headers and nothing
 * else: the permission, the redactions, the keyset cursor and the audit line
 * per page are all the export service's.
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

  const stream = ndjson(manifest, (table, after) =>
    dataExport.page(ctx, { table, ...(after ? { after } : {}) }));

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(manifest.generatedAt)}"`,
      /** Nothing about a company's whole database belongs in a cache. */
      "cache-control": "no-store",
    },
  });
}
