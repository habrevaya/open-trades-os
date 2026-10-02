import type { dataExport } from "@opentradesos/api/services";

type Manifest = dataExport.Manifest;
type Page = dataExport.Page;

/**
 * THE WHOLE COMPANY AS NEWLINE DELIMITED JSON
 *
 * Here rather than in the route handler so it can be tested without a database
 * or a request. The failure this guards against is the only one that really
 * matters in an export, and it is invisible from the outside: a file that stops
 * early and still looks complete. A test can stage that in a millisecond; a
 * route cannot be made to fail halfway through on demand.
 *
 * `fetchPage` is injected for the same reason. The real one is the export
 * service, which holds the permission, the redactions, the keyset cursor and the
 * audit line. Nothing in this file decides what may leave; it decides the shape
 * of the file.
 */
export function ndjson(
  manifest: Manifest,
  fetchPage: (table: string, after: string[] | undefined) => Promise<Page>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);

  return new ReadableStream<Uint8Array>({
    /**
     * The whole export in one `start` rather than a page per `pull`.
     *
     * Holding the cursor across pulls would mean keeping the position in a
     * closure the runtime may re-enter, and a page emitted twice is a customer
     * duplicated in the new system. Back pressure still works: `enqueue`
     * respects the queue and the consumer reads at its own rate.
     */
    async start(controller) {
      try {
        /**
         * The manifest first, so a reader knows the row counts before the rows.
         * Checking a count that arrives last means buffering the whole file to
         * find out it was short.
         */
        controller.enqueue(line({ manifest }));

        let written = 0;
        for (const table of manifest.tables) {
          /**
           * An empty table is named in the manifest and emits no rows. Writing
           * a marker line for it would make every reader special case a line
           * with no row in it.
           */
          if (table.rows === 0) continue;

          let after: string[] | undefined;
          for (;;) {
            const page = await fetchPage(table.table, after);
            for (const row of page.rows) {
              controller.enqueue(line({ table: table.table, row }));
              written += 1;
            }
            /**
             * Stop on `more`, never on an empty page. A page can come back
             * short of the limit and still have more behind it, and a reader
             * that stops on a short page silently truncates a table.
             */
            if (!page.more || page.cursor === null) break;
            after = page.cursor;
          }
        }

        /**
         * THE TERMINATOR, which is what makes a truncated file detectable.
         *
         * A complete export ends with this line and nothing else does. The count
         * is of rows this writer actually emitted, NOT `manifest.totalRows`
         * restated: restating it would make the check circular, and comparing
         * the two is the point. They differ when a table changed under the
         * export, which is a fact worth knowing rather than one to hide.
         */
        controller.enqueue(line({ complete: true, rows: written, expected: manifest.totalRows }));
        controller.close();
      } catch (error) {
        /**
         * A failure mid file cannot be a status code: the headers went out with
         * the first byte and they said 200. So the stream errors, which breaks
         * the transfer: curl exits non-zero, a browser marks the download
         * failed, and nobody is left holding a partial file they believe is
         * whole.
         *
         * THERE IS NO REASON LINE, and the first version of this had one. A test
         * showed it never arrives: `enqueue` followed by `error` discards the
         * queued chunk, by specification, so the sentence explaining what went
         * wrong was written into a buffer the runtime throws away. Writing it
         * anyway would have been a comment claiming a behaviour the code does
         * not have, which is worse than the gap.
         *
         * So the file says it is incomplete by the absence of the terminator
         * above, which is checkable without trusting anything, and the reason
         * goes to the server log where a failure belongs. Closing cleanly
         * instead, to deliver the reason, was the other option and it is the
         * wrong one: it would hand back a 200 and a successful-looking download.
         */
        controller.error(error);
      }
    },
  });
}

/** The file name a browser saves it under. Dated, because people keep several. */
export const exportFilename = (generatedAt: string) =>
  `opentradesos-export-${generatedAt.slice(0, 10)}.ndjson`;
