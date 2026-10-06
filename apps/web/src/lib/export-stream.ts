import type { dataExport } from "@opentradesos/api/services";
import { writeArchive, writeNdjson, ndjsonFilename } from "@opentradesos/api/portability";

type Source = dataExport.ExportSource;
type Sink = (chunk: Uint8Array) => Promise<void>;

/**
 * A WRITER, AS A DOWNLOAD THAT CAN FAIL VISIBLY
 *
 * The shapes of the two files live in the API package, where the scheduled
 * copy writes them too. What lives here is the one thing a browser download
 * adds: a stream whose failure halfway is visible, and which only produces
 * bytes as fast as they are taken.
 *
 * Here rather than in the route handler so it can be tested without a database
 * or a request. The failure this guards against is the only one that really
 * matters in an export, and it is invisible from the outside: a file that stops
 * early and still looks complete. A test can stage that in a millisecond; a
 * route cannot be made to fail halfway through on demand.
 *
 * BACK PRESSURE IS REAL. The first version wrote the whole company in `start`
 * and enqueued every line regardless of whether anybody was reading, so a slow
 * connection meant the company piled up in the server's memory. The writer now
 * waits whenever the queue holds a megabyte, and a reader that goes away stops
 * it on its next write.
 *
 * A FAILURE BREAKS THE TRANSFER. The headers went out with the first byte and
 * said 200, so the stream errors instead: curl exits non-zero, a browser marks
 * the download failed, and nobody is left holding a partial file they believe
 * is whole. There is no line saying why: `enqueue` followed by `error` discards
 * the queued chunk, by specification, which a test of the first version showed.
 * The file says it is incomplete by the absence of its last line, and the
 * reason goes to the server log.
 */
export function streamed(write: (sink: Sink) => Promise<unknown>): ReadableStream<Uint8Array> {
  let wake: (() => void) | null = null;
  let cancelled = false;
  const resume = () => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: Sink = async (chunk) => {
        if (cancelled) throw new Error("The download was cancelled.");
        controller.enqueue(chunk);
        while ((controller.desiredSize ?? 1) <= 0 && !cancelled) {
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      };
      /**
       * Not awaited: `pull` is not called until `start` has settled, so a
       * writer awaited here would wait for a reader that is waiting for it.
       */
      void write(sink).then(
        () => { if (!cancelled) controller.close(); },
        (error: unknown) => {
          if (cancelled) return;
          console.error("[export] a copy stopped part way:", (error as Error).message);
          controller.error(error);
        },
      );
    },
    pull: resume,
    cancel() {
      cancelled = true;
      resume();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
}

/** The company as one newline delimited JSON file. */
export const ndjson = (source: Source) => streamed((sink) => writeNdjson(source, sink));

/** The company as a zip of spreadsheets, with the README and the files. */
export const archive = (source: Source) => streamed((sink) => writeArchive(source, sink));

/** The file name a browser saves it under. Dated, because people keep several. */
export const exportFilename = ndjsonFilename;
