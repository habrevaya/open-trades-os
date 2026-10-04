import { inflateRawSync } from "node:zlib";
import { PlatformUnavailableError } from "./provider";

/**
 * THE ONE FILE INSIDE A ZIPPED REPORT
 *
 * Microsoft Advertising hands a report back as a zip holding one CSV. A
 * library for that would be a dependency for forty lines, and a dependency
 * that parses archives from the internet is the kind a self hoster has to
 * audit; this reads the central directory, finds the first CSV and inflates
 * it with Node's own zlib, and refuses anything it does not understand
 * rather than guessing at it.
 *
 * Bounded, because a zip is a format in which a few kilobytes can claim to
 * hold gigabytes: an entry claiming more than the ceiling is refused before
 * it is inflated, and the inflate itself is capped at the same number.
 */
const MAX_BYTES = 64 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function firstCsvIn(archive: Buffer, platform: string): string {
  const refuse = (why: string) => new PlatformUnavailableError(`${platform} sent a report this could not open: ${why}.`);
  /** The end record is in the last 64 KB plus its own 22 bytes, searched backwards for its signature. */
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65_557); i--) {
    if (archive.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw refuse("it is not a zip file");
  const entries = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  for (let n = 0; n < entries; n++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL) throw refuse("its directory is damaged");
    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (!/\.csv$/i.test(name)) continue;
    if (size > MAX_BYTES || compressed > MAX_BYTES) throw refuse("the report is larger than any one account's spend should be");
    if (local + 30 > archive.length || archive.readUInt32LE(local) !== LOCAL) throw refuse("an entry is damaged");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + compressed);
    let bytes: Buffer;
    if (method === 0) bytes = data;
    else if (method === 8) {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: MAX_BYTES });
      } catch (error) {
        throw refuse(`the report would not inflate (${(error as Error).message})`);
      }
    } else throw refuse(`it is compressed with method ${method}, which is not one zip files use for reports`);
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  }
  throw refuse("there is no CSV inside it");
}
