import { createDeflateRaw, createInflateRaw, crc32, type DeflateRaw } from "node:zlib";
import type { FileHandle } from "node:fs/promises";

/**
 * A ZIP ARCHIVE, WRITTEN AS IT GOES AND READ BACK FROM DISK
 *
 * The export page used to say a zip "has to be finished before its first byte
 * can be sent". That is true of the way most libraries write one and not of
 * the format: every entry can carry its sizes AFTER its data, in a data
 * descriptor, and the directory at the end is written last by design. So this
 * writes one entry at a time as rows arrive, compressing as it goes, holds
 * nothing but the directory's few dozen bytes per entry in memory, and sends
 * the first byte as soon as there is one.
 *
 * ZIP64 throughout, where it is needed and only there: a company with years of
 * photographs is an archive past four gigabytes and past sixty five thousand
 * entries, which is where the original format's fields run out. Below those
 * limits the archive is an ordinary zip that every operating system opens.
 *
 * Written here rather than taken from a library for the reason `ads/zip.ts`
 * gives: a dependency that writes and parses archives is one a self hoster has
 * to audit, for a format that fits in a few hundred lines on Node's own zlib.
 */

export type Sink = (chunk: Uint8Array) => Promise<void>;

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Bit 3: sizes follow the data. Bit 11: the name is UTF-8. */
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

interface Written {
  name: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** A time as DOS wrote it, which is what the format has room for: two second steps, from 1980. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getUTCFullYear(), 1980);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: Written[] = [];
  private open = false;
  private readonly stamp: { time: number; date: number };

  constructor(private readonly sink: Sink, at: Date = new Date()) {
    this.stamp = dosTime(at);
  }

  /** Bytes written so far, which is the archive's size once `finish` returns. */
  get size(): number {
    return this.offset;
  }

  private async out(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    this.offset += chunk.byteLength;
    await this.sink(chunk);
  }

  private localHeader(name: Buffer, flags: number, method: number, crc: number, compressed: number, size: number): Buffer {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, name]);
  }

  /**
   * An entry whose bytes are all in hand, such as one photograph. Stored as it
   * is: a JPEG does not get smaller by being deflated again, and storing it
   * means its sizes go in the header like any ordinary zip.
   */
  async addFile(name: string, data: Uint8Array): Promise<void> {
    if (this.open) throw new Error("An entry is still being written.");
    if (data.byteLength >= MAX32) throw new Error(`${name} is too large to store in one entry.`);
    const encoded = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const offset = this.offset;
    await this.out(this.localHeader(encoded, FLAG_UTF8, 0, crc, data.byteLength, data.byteLength));
    await this.out(data);
    this.entries.push({ name: encoded, flags: FLAG_UTF8, method: 0, crc, compressed: data.byteLength, size: data.byteLength, offset });
  }

  /**
   * An entry written as it is produced, such as a table's CSV: compressed on
   * the way, its checksum and sizes written after it.
   */
  async begin(name: string): Promise<EntryWriter> {
    if (this.open) throw new Error("An entry is still being written.");
    this.open = true;
    const encoded = Buffer.from(name, "utf8");
    const offset = this.offset;
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR;
    await this.out(this.localHeader(encoded, flags, 8, 0, 0, 0));
    return new EntryWriter(createDeflateRaw({ level: 6 }), (chunk) => this.out(chunk), async (crc, compressed, size) => {
      const big = compressed >= MAX32 || size >= MAX32;
      const descriptor = Buffer.alloc(big ? 24 : 16);
      descriptor.writeUInt32LE(DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      if (big) {
        descriptor.writeBigUInt64LE(BigInt(compressed), 8);
        descriptor.writeBigUInt64LE(BigInt(size), 16);
      } else {
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
      }
      await this.out(descriptor);
      this.entries.push({ name: encoded, flags, method: 8, crc, compressed, size, offset });
      this.open = false;
    });
  }

  /** The directory, which is what makes the archive whole. Nothing is a zip until this is written. */
  async finish(): Promise<void> {
    if (this.open) throw new Error("An entry is still being written.");
    const start = this.offset;
    for (const entry of this.entries) {
      const needs = {
        size: entry.size >= MAX32, compressed: entry.compressed >= MAX32, offset: entry.offset >= MAX32,
      };
      const extraFields: Buffer[] = [];
      if (needs.size) extraFields.push(u64(entry.size));
      if (needs.compressed) extraFields.push(u64(entry.compressed));
      if (needs.offset) extraFields.push(u64(entry.offset));
      const extraBody = Buffer.concat(extraFields);
      const extra = extraBody.length === 0 ? Buffer.alloc(0) : Buffer.concat([u16(0x0001), u16(extraBody.length), extraBody]);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL, 0);
      header.writeUInt16LE((3 << 8) | 45, 4);
      header.writeUInt16LE(extra.length > 0 ? 45 : 20, 6);
      header.writeUInt16LE(entry.flags, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(this.stamp.time, 12);
      header.writeUInt16LE(this.stamp.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(needs.compressed ? MAX32 : entry.compressed, 20);
      header.writeUInt32LE(needs.size ? MAX32 : entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      // A regular file readable by everybody, as unzip on a Unix machine expects.
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(needs.offset ? MAX32 : entry.offset, 42);
      await this.out(Buffer.concat([header, entry.name, extra]));
    }
    const directorySize = this.offset - start;
    const count = this.entries.length;
    if (count >= MAX16 || directorySize >= MAX32 || start >= MAX32) {
      const end64At = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(END64, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE((3 << 8) | 45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      await this.out(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(LOCATOR64, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(end64At), 8);
      locator.writeUInt32LE(1, 16);
      await this.out(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(directorySize, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    await this.out(end);
  }
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
};

/**
 * One entry being compressed as it is written.
 *
 * Each `write` waits until the compressed bytes it produced have been handed
 * to the sink, so a slow reader at the far end slows the export down rather
 * than letting it pile the company up in memory.
 */
export class EntryWriter {
  private crc = 0;
  private size = 0;
  private compressed = 0;
  private pending: Buffer[] = [];
  private failure: Error | null = null;

  constructor(
    private readonly deflate: DeflateRaw,
    private readonly out: (chunk: Uint8Array) => Promise<void>,
    private readonly close: (crc: number, compressed: number, size: number) => Promise<void>,
  ) {
    deflate.on("data", (chunk: Buffer) => { this.pending.push(chunk); });
    deflate.on("error", (error: Error) => { this.failure = error; });
  }

  private async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    const chunks = this.pending;
    this.pending = [];
    for (const chunk of chunks) {
      this.compressed += chunk.byteLength;
      await this.out(chunk);
    }
  }

  async write(text: string | Uint8Array): Promise<void> {
    const data = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text.buffer, text.byteOffset, text.byteLength);
    if (data.byteLength === 0) return;
    this.crc = crc32(data, this.crc) >>> 0;
    this.size += data.byteLength;
    await new Promise<void>((resolve, reject) => {
      this.deflate.write(data, (error) => (error ? reject(error) : resolve()));
    });
    await this.drain();
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.deflate.once("end", resolve);
      this.deflate.once("error", reject);
      this.deflate.end();
    });
    await this.drain();
    await this.close(this.crc, this.compressed, this.size);
  }
}

/* ---------------------------------------------------------------- reading */

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** A zip that cannot be read, said in words a person restoring a copy can act on. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/**
 * The entries of a zip on disk, from its directory.
 *
 * From the directory rather than by walking the entries in order, because an
 * entry written as a stream has no sizes in front of it, and because a zip
 * somebody unpacked and packed again with their own tool can be in any order.
 * A file without a directory at the end is a download that stopped, and is
 * refused as one.
 */
export async function readDirectory(file: FileHandle, fileSize: number): Promise<Map<string, ZipEntry>> {
  const tailSize = Math.min(fileSize, 65_557 + 20);
  const tail = Buffer.alloc(tailSize);
  await file.read(tail, 0, tailSize, fileSize - tailSize);
  let endAt = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === END) { endAt = i; break; }
  }
  if (endAt < 0) {
    throw new ZipError("This is not a whole zip file: its directory, which is written last, is missing. The download probably stopped part way; take the copy again.");
  }
  let count = tail.readUInt16LE(endAt + 10);
  let directorySize = tail.readUInt32LE(endAt + 12);
  let directoryAt = tail.readUInt32LE(endAt + 16);
  if (count === MAX16 || directorySize === MAX32 || directoryAt === MAX32) {
    const locatorAt = endAt - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== LOCATOR64) throw new ZipError("The zip's directory is damaged.");
    const end64At = Number(tail.readBigUInt64LE(locatorAt + 8));
    const record = Buffer.alloc(56);
    await file.read(record, 0, 56, end64At);
    if (record.readUInt32LE(0) !== END64) throw new ZipError("The zip's directory is damaged.");
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryAt = Number(record.readBigUInt64LE(48));
  }
  if (directoryAt + directorySize > fileSize) throw new ZipError("The zip's directory points past the end of the file.");
  const directory = Buffer.alloc(directorySize);
  await file.read(directory, 0, directorySize, directoryAt);

  const entries = new Map<string, ZipEntry>();
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw new ZipError("The zip's directory is damaged.");
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    let compressed = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let offset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extraAt);
      const length = directory.readUInt16LE(extraAt + 2);
      if (id === 0x0001) {
        let field = extraAt + 4;
        if (size === MAX32) { size = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (compressed === MAX32) { compressed = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (offset === MAX32) { offset = Number(directory.readBigUInt64LE(field)); field += 8; }
      }
      extraAt += 4 + length;
    }
    at = extraEnd + commentLength;
    if (name.endsWith("/")) continue;
    entries.set(name, { name, method, crc, compressed, size, offset });
  }
  return entries;
}

/**
 * One entry's bytes as a stream of chunks, checked against its checksum and
 * size at the end. A mismatch throws rather than ending quietly, because an
 * entry that inflates to the wrong bytes is a corrupted copy, and a restore
 * that loaded it would be loading something nobody exported.
 */
export async function* readEntry(file: FileHandle, entry: ZipEntry, chunkSize = 1 << 20): AsyncGenerator<Buffer> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.name} is compressed with method ${entry.method}, which this cannot read. Zip it again with ordinary compression.`);
  }
  const header = Buffer.alloc(30);
  await file.read(header, 0, 30, entry.offset);
  if (header.readUInt32LE(0) !== LOCAL) throw new ZipError(`${entry.name} is damaged in the zip.`);
  let at = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  let remaining = entry.compressed;

  const inflate = entry.method === 8 ? createInflateRaw() : null;
  const out: Buffer[] = [];
  let failure: Error | null = null;
  if (inflate) {
    inflate.on("data", (chunk: Buffer) => out.push(chunk));
    inflate.on("error", (error: Error) => { failure = error; });
  }
  let crc = 0;
  let size = 0;
  const emit = function* (chunks: Buffer[]) {
    for (const chunk of chunks) {
      crc = crc32(chunk, crc) >>> 0;
      size += chunk.byteLength;
      yield chunk;
    }
  };

  while (remaining > 0) {
    const take = Math.min(chunkSize, remaining);
    const buffer = Buffer.alloc(take);
    const { bytesRead } = await file.read(buffer, 0, take, at);
    if (bytesRead === 0) throw new ZipError(`${entry.name} is cut short in the zip.`);
    at += bytesRead;
    remaining -= bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    if (!inflate) {
      yield* emit([chunk]);
      continue;
    }
    await new Promise<void>((resolve, reject) => inflate.write(chunk, (error) => (error ? reject(error) : resolve())));
    if (failure) throw new ZipError(`${entry.name} would not decompress: ${(failure as Error).message}.`);
    yield* emit(out.splice(0));
  }
  if (inflate) {
    await new Promise<void>((resolve, reject) => {
      inflate.once("end", resolve);
      inflate.once("error", reject);
      inflate.end();
    }).catch((error: Error) => { throw new ZipError(`${entry.name} would not decompress: ${error.message}.`); });
    yield* emit(out.splice(0));
  }
  if (size !== entry.size || crc !== entry.crc) {
    throw new ZipError(`${entry.name} does not match its own checksum in the zip, so the copy is damaged.`);
  }
}

/** A whole entry in memory, refused past `limit` bytes before any of it is read. */
export async function readWhole(file: FileHandle, entry: ZipEntry, limit: number): Promise<Buffer> {
  if (entry.size > limit) throw new ZipError(`${entry.name} says it holds ${entry.size} bytes, more than any one file here can be.`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of readEntry(file, entry)) {
    total += chunk.byteLength;
    if (total > limit) throw new ZipError(`${entry.name} holds more than it said it did.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
