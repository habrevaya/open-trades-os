/**
 * The shapes a whole company copy is written in and read back from. The
 * writers take an `ExportSource` (see `services/export.ts`) and a sink, so the
 * same code writes a download, a scheduled copy into a bucket and a test's file.
 */
export { writeArchive, archiveFilename, archiveFolder, readme } from "./archive";
export { writeNdjson, ndjsonFilename } from "./ndjson";
export { openCopy, CopyError, type Copy } from "./reader";
export type { Sink } from "./zip";
