import { describe, it, expect } from "vitest";
import { portability as p, time } from "../src/index";

/**
 * The pure rules under the archive and the restore. The failures these guard
 * against are the quiet ones: a NULL that comes back as an empty string, a row
 * split in two by a line break inside a note, a table loaded before the one it
 * points at, an id in a jsonb blob that a renumbering missed.
 */

/** Reads a whole CSV text in chunks of `size`, so chunk boundaries fall everywhere. */
function readAll(text: string, size: number): (string | null)[][] {
  const reader = new p.CsvReader();
  const rows: (string | null)[][] = [];
  for (let i = 0; i < text.length; i += size) rows.push(...reader.push(text.slice(i, i + size)));
  rows.push(...reader.end());
  return rows;
}

describe("the CSV the archive writes", () => {
  it("writes NULL as an empty cell and the empty string as two quotes, which is Postgres's COPY convention", () => {
    expect(p.csvLine([null, "", "a"])).toBe(",\"\",\"a\"\r\n");
  });

  it("doubles a quote inside a value", () => {
    expect(p.csvCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
  });

  it("reads back exactly what it wrote, whatever the chunk size", () => {
    const rows: (string | null)[][] = [
      ["1", null, ""],
      ["a, b", "line one\r\nline two", "she said \"no\""],
      ["\"", ",", "\n"],
      ["ünïcödé 🔧", "  spaced  ", null],
    ];
    const text = `\uFEFF${p.csvHeader(["x", "y", "z"])}${rows.map((row) => p.csvLine(row)).join("")}`;
    for (const size of [1, 2, 3, 7, 64, 100_000]) {
      const read = readAll(text, size);
      expect(read[0]).toEqual(["x", "y", "z"]);
      expect(read.slice(1)).toEqual(rows);
    }
  });

  it("drops the byte order mark from the first column's name", () => {
    expect(readAll("\uFEFFid,name\r\n\"1\",\"a\"\r\n", 4)[0]).toEqual(["id", "name"]);
  });

  it("takes plain line feeds and a last line with no line break", () => {
    expect(readAll("a,b\n\"1\",\"2\"", 3)).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("refuses a file that stops inside a quoted value rather than inventing the rest of the row", () => {
    const reader = new p.CsvReader();
    reader.push("a,b\r\n\"1\",\"half");
    expect(() => reader.end()).toThrow(/cut short/);
  });
});

describe("the order a restore loads tables in", () => {
  const key = (table: string, column: string, references: string, nullable = false): p.ForeignKey =>
    ({ table, column, references, nullable });

  it("puts every table after the tables it points at", () => {
    const { order } = p.loadOrder(
      ["invoice", "customer", "job", "invoice_line"],
      [key("invoice", "customer_id", "customer"), key("job", "customer_id", "customer"),
        key("invoice", "job_id", "job", true), key("invoice_line", "invoice_id", "invoice")],
    );
    expect(order).toEqual(["customer", "job", "invoice", "invoice_line"]);
  });

  it("loads a table that points at itself, with that column filled in afterwards", () => {
    const { order, deferred } = p.loadOrder(
      ["customer"], [key("customer", "referred_by_customer_id", "customer", true)],
    );
    expect(order).toEqual(["customer"]);
    expect(deferred.map((k) => k.column)).toEqual(["referred_by_customer_id"]);
  });

  it("breaks a ring of tables at a key that may be empty", () => {
    const { order, deferred } = p.loadOrder(
      ["a", "b"], [key("a", "b_id", "b", true), key("b", "a_id", "a")],
    );
    expect(order).toEqual(["a", "b"]);
    expect(deferred).toEqual([key("a", "b_id", "b", true)]);
  });

  it("says which tables cannot be loaded when the ring has no key that may be empty", () => {
    expect(() => p.loadOrder(["a", "b"], [key("a", "b_id", "b"), key("b", "a_id", "a")])).toThrow(/a, b/);
  });

  it("ignores keys to tables that are not in the copy", () => {
    expect(p.loadOrder(["job"], [key("job", "network_id", "network")]).order).toEqual(["job"]);
  });
});

describe("carrying ids across", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const NEW = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const lookup = (id: string) => (id === OLD ? NEW : undefined);

  it("finds ids in strings, nested values and object keys", () => {
    const found = new Set<string>();
    p.uuidsIn({ a: `${OLD}/ab/cd.jpg`, [OTHER]: [1, { b: OLD.toUpperCase() }], c: null }, found);
    expect([...found].sort()).toEqual([OLD, OTHER]);
  });

  it("replaces an id wherever it sits and leaves an id it does not know alone", () => {
    expect(p.remap({
      storageKey: `${OLD}/ab/cd/x.jpg`,
      [OLD]: { before: { customerId: OLD, provider: OTHER } },
      list: [OLD, "INV-1001", 3, true, null],
    }, lookup)).toEqual({
      storageKey: `${NEW}/ab/cd/x.jpg`,
      [NEW]: { before: { customerId: NEW, provider: OTHER } },
      list: [NEW, "INV-1001", 3, true, null],
    });
  });

  it("leaves a short string untouched without scanning it", () => {
    expect(p.remap("abc", () => { throw new Error("should not be asked"); })).toBe("abc");
  });
});

describe("when the next copy is due", () => {
  const zone = "America/Chicago";
  const at = (after: string, frequency: p.BackupFrequency, hour: number, weekday: number | null = null) =>
    p.nextBackupAt({
      frequency, hour, weekday, after: new Date(after),
      dateIn: (instant) => time.dateIn(instant, zone),
      instantOf: (date, minutes) => time.instantOfLocal(date, minutes, zone),
    });

  it("is two in the morning on the company's own clock, later today when that has not passed", () => {
    // 2026-10-04 01:00 in Chicago is 06:00 UTC; two in the morning there is 07:00 UTC.
    expect(at("2026-10-04T06:00:00Z", "daily", 2)).toEqual(new Date("2026-10-04T07:00:00Z"));
  });

  it("is tomorrow once today's hour has passed, and never the instant asked about", () => {
    expect(at("2026-10-04T07:00:00Z", "daily", 2)).toEqual(new Date("2026-10-05T07:00:00Z"));
  });

  it("waits for the chosen day of the week", () => {
    // 2026-10-04 is a Sunday; Wednesday is the 7th.
    expect(at("2026-10-04T12:00:00Z", "weekly", 2, 3)).toEqual(new Date("2026-10-07T07:00:00Z"));
  });

  it("follows the clocks when they change", () => {
    // Daylight saving ends in Chicago on 2026-11-01, so two in the morning moves from 07:00 to 08:00 UTC.
    expect(at("2026-11-01T12:00:00Z", "daily", 2)).toEqual(new Date("2026-11-02T08:00:00Z"));
  });

  it("is never when copies are off", () => {
    expect(at("2026-10-04T12:00:00Z", "off", 2)).toBeNull();
  });
});

describe("which copies the bucket no longer needs", () => {
  const copy = (id: string, day: number, status = "succeeded", pruned = false): p.CopyOnRecord => ({
    id, status, startedAt: new Date(Date.UTC(2026, 9, day)), prunedAt: pruned ? new Date() : null,
  });

  it("keeps the newest finished copies and lets the older ones go", () => {
    const copies = [copy("a", 1), copy("b", 2), copy("c", 3), copy("d", 4)];
    expect(p.copiesToPrune(copies, 2).sort()).toEqual(["a", "b"]);
  });

  it("does not count a failed or running copy, or one already deleted", () => {
    const copies = [copy("a", 1), copy("b", 2, "failed"), copy("c", 3, "running"), copy("d", 4, "succeeded", true), copy("e", 5)];
    expect(p.copiesToPrune(copies, 1)).toEqual(["a"]);
  });

  it("always keeps at least one", () => {
    expect(p.copiesToPrune([copy("a", 1), copy("b", 2)], 0)).toEqual(["a"]);
  });
});

describe("a destination", () => {
  const good: p.DestinationInput = {
    endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "acme-backups", region: "us-east-1",
    prefix: "opentradesos/", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretKeyRef: "BACKUP_SECRET_KEY",
    frequency: "daily", hour: 2, weekday: null, keep: 14,
  };

  it("passes when everything is in order", () => {
    expect(p.checkDestination(good)).toEqual([]);
  });

  it("refuses the secret key itself in place of its name", () => {
    const problems = p.checkDestination({ ...good, secretKeyRef: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1" });
    expect(problems.join(" ")).toMatch(/looks like the secret key itself/);
  });

  it("says what is wrong with each box", () => {
    const problems = p.checkDestination({
      ...good, endpoint: "s3.amazonaws.com", bucket: "Acme Backups", frequency: "weekly", weekday: null, keep: 0,
    });
    expect(problems).toHaveLength(4);
  });

  it("names a copy by its company and when it was taken", () => {
    expect(p.backupObjectKey("backups", "acme", new Date("2026-10-04T07:00:12.345Z")))
      .toBe("backups/acme/opentradesos-acme-20261004T070012Z.zip");
    expect(p.backupObjectKey("", "acme", new Date("2026-10-04T07:00:12Z")))
      .toBe("acme/opentradesos-acme-20261004T070012Z.zip");
  });
});
