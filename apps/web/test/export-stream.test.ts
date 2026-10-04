import { describe, it, expect } from "vitest";
import { ndjson as ndjsonOf, archive as archiveOf, streamed, exportFilename } from "../src/lib/export-stream";
import type { dataExport } from "@opentradesos/api/services";

const manifest = (tables: { table: string; rows: number }[]): dataExport.Manifest => ({
  format: "opentradesos-export",
  version: 1,
  organizationId: "org1",
  generatedAt: "2026-10-02T09:00:00.000Z",
  totalRows: tables.reduce((n, t) => n + t.rows, 0),
  tables: tables.map((t) => ({ ...t, key: ["id"], redacted: [], apart: [], columns: [{ name: "id", type: "uuid", nullable: false, references: null }] })),
  company: { name: "Org One" },
  people: [],
  files: { count: 0, bytes: 0 },
  outsideTheTenant: [],
});

/** The export as the file sees it: a manifest and a page reader, with no stored files. */
const ndjson = (m: dataExport.Manifest, fetchPage: (table: string, after: string[] | undefined) => Promise<dataExport.Page>) =>
  ndjsonOf({
    manifest: m,
    page: (table, after) => fetchPage(table, after),
    files: async () => ({ files: [], cursor: null, more: false }),
    bytes: async () => Buffer.alloc(0),
  });

const page = (
  table: string, rows: Record<string, unknown>[], more: boolean, cursor: string[] | null,
): dataExport.Page => ({ table, rows, more, cursor, redacted: [] });

/**
 * A fetcher that serves a fixed sequence per table and then nothing.
 *
 * BOUNDED ON PURPOSE. The first version of these fakes answered the same page
 * forever once the sequence ran out, which meant a walk that stopped on the
 * wrong condition looped without end: the suite hung instead of failing, and so
 * did the sweep that reintroduces that exact bug to check this file catches it.
 * A fake that cannot say "there is no more" cannot test a loop at all.
 */
function serve(pages: Record<string, dataExport.Page[]>) {
  const calls: { table: string; after: string[] | undefined }[] = [];
  const fetchPage = async (table: string, after: string[] | undefined) => {
    calls.push({ table, after });
    const queue = pages[table] ?? [];
    const taken = queue.shift();
    return taken ?? page(table, [], false, null);
  };
  return { calls, fetchPage };
}

async function read(stream: ReadableStream<Uint8Array>): Promise<{ lines: unknown[]; failed: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    failed = true;
  }
  return {
    lines: text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)),
    failed,
  };
}

/** M30's FILE SHAPE, WHICH IS WHERE A TRUNCATED EXPORT WOULD LOOK COMPLETE */
describe("the export file", () => {
  it("puts the manifest first, then one line per row tagged with its table", async () => {
    const { lines, failed } = await read(ndjson(
      manifest([{ table: "customer", rows: 2 }, { table: "job", rows: 1 }]),
      async (table) => table === "customer"
        ? page(table, [{ id: "c1" }, { id: "c2" }], false, null)
        : page(table, [{ id: "j1" }], false, null),
    ));
    expect(failed).toBe(false);
    expect(lines).toEqual([
      { manifest: expect.objectContaining({ organizationId: "org1" }) },
      { table: "customer", row: { id: "c1" } },
      { table: "customer", row: { id: "c2" } },
      { table: "job", row: { id: "j1" } },
      { complete: true, rows: 3, expected: 3, files: 0, expectedFiles: 0 },
    ]);
  });

  it("passes the cursor back and keeps reading", async () => {
    /**
     * Keyset pagination is the whole reason this is not an offset: a company
     * exporting while its office is still booking jobs would lose a row to an
     * offset shifting underneath it.
     */
    const { calls, fetchPage } = serve({
      customer: [
        page("customer", [{ id: "c1" }, { id: "c2" }], true, ["c2"]),
        page("customer", [{ id: "c3" }], false, null),
      ],
    });
    const { lines } = await read(ndjson(manifest([{ table: "customer", rows: 3 }]), fetchPage));
    expect(calls.map((c) => c.after)).toEqual([undefined, ["c2"]]);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toEqual({ complete: true, rows: 3, expected: 3, files: 0, expectedFiles: 0 });
  });

  it("stops on more, not on a short page", async () => {
    /**
     * A page can come back short of the limit and still have rows behind it. A
     * reader that stops on a short page truncates the table and says nothing.
     */
    const { calls, fetchPage } = serve({
      customer: [
        page("customer", [{ id: "c1" }], true, ["c1"]),
        page("customer", [{ id: "c2" }], false, null),
      ],
    });
    const { lines } = await read(ndjson(manifest([{ table: "customer", rows: 2 }]), fetchPage));
    expect(calls).toHaveLength(2);
    expect(lines).toHaveLength(4);
  });

  it("asks nothing of a table the manifest counts at zero", async () => {
    const { calls, fetchPage } = serve({
      customer: [page("customer", [{ id: "c1" }], false, null)],
    });
    await read(ndjson(
      manifest([{ table: "rental", rows: 0 }, { table: "customer", rows: 1 }]), fetchPage,
    ));
    expect(calls.map((c) => c.table)).toEqual(["customer"]);
  });

  it("breaks the transfer and writes no terminator when it fails part way", async () => {
    /**
     * The failure that matters, and the one this file is shaped around. The
     * headers went out with the first byte and they said 200, so a status code
     * is no longer available.
     *
     * The first version of this enqueued a line saying why and then errored.
     * This test is what showed the line never arrives: `enqueue` followed by
     * `error` discards the queued chunk by specification. So the signal is the
     * ABSENCE of the terminator, which a reader can check without trusting
     * anything in the file, plus a transfer that visibly breaks.
     */
    const { lines, failed } = await read(ndjson(
      manifest([{ table: "customer", rows: 2 }, { table: "job", rows: 1 }]),
      async (table) => {
        if (table === "job") throw new Error("connection lost");
        return page(table, [{ id: "c1" }], false, null);
      },
    ));
    expect(failed).toBe(true);
    expect(lines.some((l) => (l as { complete?: boolean }).complete === true)).toBe(false);
  });

  it("reports a count that disagrees with the manifest rather than hiding it", async () => {
    /**
     * The terminator counts what this writer emitted, not what the manifest
     * said. Restating the manifest's own total would make the check circular,
     * and the two differing is a fact worth seeing: a table changed under the
     * export while it ran.
     */
    const { lines } = await read(ndjson(
      manifest([{ table: "customer", rows: 5 }]),
      async (table) => page(table, [{ id: "c1" }, { id: "c2" }], false, null),
    ));
    expect(lines.at(-1)).toEqual({ complete: true, rows: 2, expected: 5, files: 0, expectedFiles: 0 });
  });

  it("dates the file so somebody can keep several", () => {
    expect(exportFilename("2026-10-02T09:00:00.000Z")).toBe("opentradesos-export-2026-10-02.ndjson");
  });

  it("waits for the reader rather than piling the company up in memory", async () => {
    let written = 0;
    const stream = streamed(async (sink) => {
      for (let i = 0; i < 64; i++) {
        await sink(new Uint8Array(64 * 1024));
        written += 1;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A megabyte queued and no reader: the writer has stopped, well short of four.
    expect(written).toBeLessThanOrEqual(17);
    const reader = stream.getReader();
    let read = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      read += 1;
    }
    expect(read).toBe(64);
    expect(written).toBe(64);
  });

  it("stops writing when the reader goes away", async () => {
    let failed: Error | null = null;
    const stream = streamed(async (sink) => {
      try {
        for (;;) await sink(new Uint8Array(512 * 1024));
      } catch (error) {
        failed = error as Error;
        throw error;
      }
    });
    await stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failed).not.toBeNull();
  });

  it("writes the zip of spreadsheets through the same stream", async () => {
    const reader = archiveOf({
      manifest: manifest([{ table: "customer", rows: 1 }]),
      page: async (table) => page(table, [{ id: "c1" }], false, null),
      files: async () => ({ files: [], cursor: null, more: false }),
      bytes: async () => Buffer.alloc(0),
    }).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.includes(Buffer.from("tables/customer.csv"))).toBe(true);
  });
});
