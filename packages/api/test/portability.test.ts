import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "../src/storage";
import { writeArchive, readme } from "../src/portability/archive";
import { writeNdjson } from "../src/portability/ndjson";
import { openCopy, CopyError } from "../src/portability/reader";
import { ZipWriter, readDirectory, readWhole } from "../src/portability/zip";
import type { ExportSource, Manifest, Page } from "../src/services/export";

/**
 * THE FILES A COPY IS WRITTEN AS, AND READ BACK FROM
 *
 * No database here: the writers take their rows from a source that a test can
 * make up, so the things that go wrong in a file (a value with a line break in
 * it, a NULL beside an empty string, a download that stopped, an archive past
 * the original zip format's limits) can each be staged in a moment.
 */

let folder: string;
beforeAll(async () => { folder = await mkdtemp(join(tmpdir(), "ots-portability-")); });
afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

const ORG = "8f6c1b5e-2a1d-4c3b-9e7f-0a1b2c3d4e5f";

function source(tables: Record<string, Record<string, unknown>[]>, files: Record<string, Buffer> = {}): ExportSource {
  const names = Object.keys(tables).sort();
  const manifest: Manifest = {
    format: "opentradesos-export",
    version: 1,
    organizationId: ORG,
    generatedAt: "2026-10-04T09:00:00.000Z",
    totalRows: names.reduce((n, t) => n + tables[t]!.length, 0),
    tables: names.map((table) => ({
      table, rows: tables[table]!.length, key: ["id"], redacted: [], apart: [],
      columns: Object.keys(tables[table]![0] ?? { id: "" }).map((name) => ({
        name, type: name === "custom_fields" ? "jsonb" : "text", nullable: true, references: null,
      })),
    })),
    company: { name: "Kettle & Sons", timezone: "America/Chicago" },
    people: [],
    files: { count: Object.keys(files).length, bytes: Object.values(files).reduce((n, f) => n + f.length, 0) },
    outsideTheTenant: [],
  };
  return {
    manifest,
    /** Two rows a page, so every walk crosses a page boundary. */
    page: async (table, after, textual): Promise<Page> => {
      const rows = tables[table] ?? [];
      const start = after ? rows.findIndex((row) => row["id"] === after[0]) + 1 : 0;
      const slice = rows.slice(start, start + 2).map((row) => textual
        ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v)]))
        : row);
      const more = start + 2 < rows.length;
      return { table, rows: slice, more, cursor: slice.length ? [String(slice[slice.length - 1]!["id"])] : null, redacted: [] };
    },
    files: async () => ({
      files: Object.entries(files).map(([storageKey, bytes], i) => ({
        id: `file-${i}`, storageKey, sha256: "", contentType: "image/png", sizeBytes: bytes.length,
      })),
      cursor: null, more: false,
    }),
    bytes: async (file) => files[file.storageKey]!,
  };
}

async function written(write: (sink: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>, name: string): Promise<string> {
  const chunks: Buffer[] = [];
  await write(async (chunk) => { chunks.push(Buffer.from(chunk)); });
  const path = join(folder, name);
  await writeFile(path, Buffer.concat(chunks));
  return path;
}

const awkward = [
  { id: "a", name: "Ann \"the plumber\" O'Neil", note: "line one\nline two", email: null, custom_fields: { gate: "1234" } },
  { id: "b", name: "Bob, Jr.", note: "", email: "bob@example.com", custom_fields: {} },
  { id: "c", name: "Çelik Isıtma", note: "  spaced  ", email: null, custom_fields: { list: [1, 2] } },
];

describe("signing a request to a bucket", () => {
  it("matches the worked example in Amazon's Signature Version 4 documentation", () => {
    /**
     * GET /test.txt with a Range header, from the S3 documentation's
     * "Example: GET Object". The expected signature is theirs, not ours.
     */
    const header = sign({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {},
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", amzDate: "20130524T000000Z",
    });
    expect(header).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("the zip of spreadsheets", () => {
  it("reads back every value exactly, NULL apart from the empty string, line breaks inside one cell", async () => {
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const path = await written((sink) => writeArchive(source({ customer: awkward, empty_table: [] },
      { [`${ORG}/ab/cd/abcd.png`]: photo }), sink), "copy.zip");
    const copy = await openCopy(path);
    try {
      expect(copy.format).toBe("archive");
      expect(copy.complete).toEqual({ rows: 3, files: 1 });
      expect(copy.manifest.company["name"]).toBe("Kettle & Sons");
      const rows: Record<string, unknown>[] = [];
      for await (const batch of copy.rows("customer")) {
        expect(batch.textual).toBe(true);
        rows.push(...batch.rows);
      }
      expect(rows).toEqual(awkward.map((row) => ({
        ...row, custom_fields: JSON.stringify(row.custom_fields),
      })));
      expect(await copy.columnsOf("empty_table")).toEqual(["id"]);
      expect(await copy.bytes(`${ORG}/ab/cd/abcd.png`)).toEqual(photo);
    } finally {
      await copy.close();
    }
  });

  it("writes a README that names every table and says what an empty cell means", () => {
    const text = readme(source({ customer: awkward, job: [{ id: "j" }] }).manifest);
    expect(text).toMatch(/### customer/);
    expect(text).toMatch(/### job/);
    expect(text).toMatch(/NULL/);
    expect(text).toMatch(/\\copy customer from 'tables\/customer.csv'/);
  });

  it("refuses an archive that stopped part way, because its directory is written last", async () => {
    const whole = await written((sink) => writeArchive(source({ customer: awkward }), sink), "whole.zip");
    const bytes = await readFile(whole);
    const cut = join(folder, "cut.zip");
    await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length * 0.7)));
    await expect(openCopy(cut)).rejects.toThrow(CopyError);
    await expect(openCopy(cut)).rejects.toThrow(/stopped part way/);
  });

  it("goes past sixty five thousand entries, where the original zip format runs out", async () => {
    const path = await written(async (sink) => {
      const zip = new ZipWriter(sink);
      for (let i = 0; i < 66_000; i++) await zip.addFile(`f/${i}.txt`, Buffer.from(String(i)));
      const entry = await zip.begin("big.csv");
      await entry.write("x".repeat(100_000));
      await entry.end();
      await zip.finish();
    }, "many.zip");
    const handle = await open(path, "r");
    try {
      const entries = await readDirectory(handle, (await handle.stat()).size);
      expect(entries.size).toBe(66_001);
      expect((await readWhole(handle, entries.get("f/65999.txt")!, 100)).toString()).toBe("65999");
      expect((await readWhole(handle, entries.get("big.csv")!, 1_000_000)).length).toBe(100_000);
    } finally {
      await handle.close();
    }
  });
});

describe("the newline delimited copy", () => {
  it("reads back the manifest, each table's rows and each file", async () => {
    const photo = Buffer.from("not really a photograph");
    const path = await written((sink) => writeNdjson(source({ customer: awkward, job: [{ id: "j1" }, { id: "j2" }] },
      { "k/1.png": photo }), sink), "copy.ndjson");
    const copy = await openCopy(path);
    try {
      expect(copy.format).toBe("ndjson");
      expect(copy.complete).toEqual({ rows: 5, files: 1 });
      expect(copy.counted("customer")).toBe(3);
      const rows: Record<string, unknown>[] = [];
      for await (const batch of copy.rows("customer")) rows.push(...batch.rows);
      expect(rows).toEqual(awkward);
      expect(await copy.bytes("k/1.png")).toEqual(photo);
    } finally {
      await copy.close();
    }
  });

  it("says a file without its last line is not complete", async () => {
    const path = await written((sink) => writeNdjson(source({ customer: awkward }), sink), "whole.ndjson");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const cut = join(folder, "cut.ndjson");
    await writeFile(cut, `${lines.slice(0, -1).join("\n")}\n`);
    const copy = await openCopy(cut);
    expect(copy.complete).toBeNull();
    await copy.close();
  });

  it("refuses a line that is not part of a copy", async () => {
    const path = join(folder, "odd.ndjson");
    await writeFile(path, `${JSON.stringify({ manifest: source({ customer: [] }).manifest })}\n{"hello":1}\n`);
    await expect(openCopy(path)).rejects.toThrow(/not part of a copy/);
  });

  it("refuses a file that is neither shape", async () => {
    const path = join(folder, "odd.txt");
    await writeFile(path, "name,email\n");
    await expect(openCopy(path)).rejects.toThrow(/not a copy taken from OpenTradesOS/);
  });
});
