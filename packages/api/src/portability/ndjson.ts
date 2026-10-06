import type { ExportSource } from "../services/export";
import type { Sink } from "./zip";

/**
 * THE WHOLE COMPANY AS NEWLINE DELIMITED JSON
 *
 * The first line is the manifest, every line after it is one row tagged with
 * its table, then one line per stored file with its bytes in base64, and the
 * last line says the file is complete. `grep '"table":"customer"'` pulls one
 * table out with nothing installed, and a reader loading all of it reads a line
 * at a time and never holds the company in memory.
 *
 * A file line puts its description first and its bytes last, so a reader that
 * wants to know what files there are can stop reading each line at `"bytes"`.
 */
export async function writeNdjson(source: ExportSource, sink: Sink): Promise<{ rows: number; files: number }> {
  const encoder = new TextEncoder();
  const line = (value: unknown) => sink(encoder.encode(`${JSON.stringify(value)}\n`));

  /**
   * The manifest first, so a reader knows the row counts before the rows.
   * Checking a count that arrives last means buffering the whole file to find
   * out it was short.
   */
  await line({ manifest: source.manifest });

  let written = 0;
  for (const table of source.manifest.tables) {
    /**
     * An empty table is named in the manifest and emits no rows. Writing a
     * marker line for it would make every reader special case a line with no
     * row in it.
     */
    if (table.rows === 0) continue;

    let after: string[] | undefined;
    for (;;) {
      const page = await source.page(table.table, after, false);
      for (const row of page.rows) {
        await line({ table: table.table, row });
        written += 1;
      }
      /**
       * Stop on `more`, never on an empty page. A page can come back short of
       * the limit and still have more behind it, and a reader that stops on a
       * short page silently truncates a table.
       */
      if (!page.more || page.cursor === null) break;
      after = page.cursor;
    }
  }

  let files = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await source.files(cursor);
    for (const file of batch.files) {
      const bytes = await source.bytes(file);
      await line({
        file: {
          id: file.id, storageKey: file.storageKey, sha256: file.sha256,
          contentType: file.contentType, sizeBytes: file.sizeBytes,
        },
        bytes: bytes.toString("base64"),
      });
      files += 1;
    }
    if (!batch.more || batch.cursor === null) break;
    cursor = batch.cursor;
  }

  /**
   * THE TERMINATOR, which is what makes a truncated file detectable.
   *
   * A complete export ends with this line and nothing else does. The counts are
   * of what this writer actually emitted, NOT the manifest's totals restated:
   * restating them would make the check circular, and comparing the two is the
   * point. A copy is read at one moment, so they agree unless something is
   * wrong, and when they do not, that is a fact worth knowing rather than one
   * to hide.
   */
  await line({
    complete: true, rows: written, expected: source.manifest.totalRows,
    files, expectedFiles: source.manifest.files.count,
  });
  return { rows: written, files };
}

/** The file name a browser saves it under. Dated, because people keep several. */
export const ndjsonFilename = (generatedAt: string) =>
  `opentradesos-export-${generatedAt.slice(0, 10)}.ndjson`;
