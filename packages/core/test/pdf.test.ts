import { describe, it, expect } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import { pdf, reporting } from "../src/index";

/**
 * THE HAND WRITTEN PDF
 *
 * Every test reads the file back through `inspectPdf`, which checks that the
 * cross reference table points at every object and pulls out every string
 * drawn. A test that only checked the first five bytes would pass on a file
 * no reader can open.
 */

const AT = new Date("2026-06-15T12:00:00Z");
const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes));
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

describe("the writer", () => {
  it("writes a file whose cross reference table holds together", () => {
    const page = new pdf.PdfPage();
    page.text(48, 60, "Hello, Austin");
    page.rect(48, 80, 100, 20, { fill: pdf.hex("#1F6FEB") });
    const bytes = pdf.renderPdf([page, new pdf.PdfPage()], { title: "Two pages", createdAt: AT });
    const read = pdf.inspectPdf(bytes);
    expect(read.problems).toEqual([]);
    expect(read.pageCount).toBe(2);
    expect(read.title).toBe("Two pages");
    expect(read.pages[0]).toEqual(["Hello, Austin"]);
  });

  it("compresses when given a compressor, and reads back the same text", () => {
    const page = new pdf.PdfPage();
    page.text(48, 60, "Compressed");
    const bytes = pdf.renderPdf([page], { title: "Small", createdAt: AT }, { deflate });
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/FlateDecode");
    const read = pdf.inspectPdf(bytes, inflate);
    expect(read.problems).toEqual([]);
    expect(read.text).toBe("Compressed");
  });

  it("prints a name in any Latin, Greek or Cyrillic alphabet as itself, from the font in the file", () => {
    const page = new pdf.PdfPage();
    page.text(48, 60, "José Peña ’s €5");
    page.text(48, 80, "Nguyễn Thị Đức");
    page.text(48, 100, "Dvořák, Łukasz Żółć", { font: "bold" });
    page.text(48, 120, "Σωκράτης Παπαδόπουλος");
    page.text(48, 140, "Анна Петрова");
    const read = pdf.inspectPdf(pdf.renderPdf([page], { title: "Nguyễn Thị Đức", createdAt: AT }));
    expect(read.problems).toEqual([]);
    expect(read.pages[0]).toEqual([
      "José Peña ’s €5", "Nguyễn Thị Đức", "Dvořák, Łukasz Żółć", "Σωκράτης Παπαδόπουλος", "Анна Петрова",
    ]);
    expect(read.title).toBe("Nguyễn Thị Đức");
    /** Both weights are in the file, each a subset named as PDF asks. */
    expect(read.fonts).toHaveLength(2);
    for (const name of read.fonts) expect(name).toMatch(/^[A-Z]{6}\+NotoSans-(Regular|Bold)$/);
  });

  it("prints a letter the bundled scripts lack as its base letter, or a question mark", () => {
    const page = new pdf.PdfPage();
    // A Chinese character, a polytonic Greek alpha (which comes apart into alpha and its breathing), a ligature.
    page.text(48, 60, "\u738b \u1f00 \ufb01");
    const read = pdf.inspectPdf(pdf.renderPdf([page], { title: "t", createdAt: AT }));
    expect(read.pages[0]![0]).toBe("? \u03b1 ?");
  });

  it("keeps only the glyphs a document uses in its copy of the font", () => {
    const small = new pdf.PdfPage();
    small.text(48, 60, "Hi");
    const large = new pdf.PdfPage();
    large.text(48, 60, "The quick brown fox jumps over the lazy dog. ÀÉÎÕÜ àéîõü Ωω Жж 0123456789");
    const smallBytes = pdf.renderPdf([small], { title: "s", createdAt: AT });
    const largeBytes = pdf.renderPdf([large], { title: "l", createdAt: AT });
    expect(smallBytes.length).toBeLessThan(largeBytes.length);
    // The whole regular face is over a hundred kilobytes; two letters and their notdef are a fraction of it.
    expect(smallBytes.length).toBeLessThan(40_000);
    expect(pdf.inspectPdf(smallBytes).problems).toEqual([]);
  });

  it("measures text from the embedded font's own widths", () => {
    // Noto Sans: "W" is 930 units of 1000 and "i" 258, bold "W" 967. At 10 points, 9.3, 2.58 and 9.67.
    expect(pdf.widthOf("W", "regular", 10)).toBeCloseTo(9.3, 5);
    expect(pdf.widthOf("i", "regular", 10)).toBeCloseTo(2.58, 5);
    expect(pdf.widthOf("W", "bold", 10)).toBeCloseTo(9.67, 5);
    // A wider name measures wider, so a right aligned total never runs over its label.
    expect(pdf.widthOf("Đức", "regular", 10)).toBeGreaterThan(pdf.widthOf("Duc", "regular", 10) - 0.5);
  });

  it("wraps at spaces, keeps line breaks, and breaks a word too long for the line", () => {
    const lines = pdf.wrap("one two three four five six", "regular", 10, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(pdf.widthOf(line, "regular", 10)).toBeLessThanOrEqual(60);
    expect(pdf.wrap("first\nsecond", "regular", 10, 500)).toEqual(["first", "second"]);
    const serial = pdf.wrap("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "regular", 10, 50);
    expect(serial.join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    for (const line of serial) expect(pdf.widthOf(line, "regular", 10)).toBeLessThanOrEqual(50);
  });
});

describe("the documents", () => {
  it("prints an invoice with its lines, totals and balance", () => {
    const bytes = pdf.invoicePdf({
      company: { name: "Lone Star Air", color: "#0F7B6C" },
      number: 1042, status: "partially_paid", issuedOn: "2026-06-01", dueOn: "2026-06-15", currency: "USD",
      customerName: "Dana Ruiz", propertyAddress: "4 Lane, Austin, TX",
      lines: [{ name: "Capacitor", description: "45/5 MFD", quantity: "1.0000", unitPrice: "189.0000", lineTotal: "189.0000" }],
      subtotal: "189.0000", discountTotal: "0.0000", taxTotal: "15.5900", total: "204.5900",
      amountPaid: "100.0000", balance: "104.5900",
      payments: [{ receivedAt: "2026-06-02T15:00:00Z", method: "card", amount: "100.0000" }],
      note: "Pay online from the link in your email.",
      generatedAt: AT,
    }, { deflate });
    const read = pdf.inspectPdf(bytes, inflate);
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Invoice 1042");
    expect(read.text).toContain("Dana Ruiz");
    expect(read.text).toContain("Capacitor");
    expect(read.text).toContain("$204.59");
    expect(read.text).toContain("Balance due");
    expect(read.text).toContain("$104.59");
    expect(read.text).toContain("Page 1 of 1");
  });

  it("runs a long table onto more pages and numbers them", () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({
      name: `Line ${i + 1}`, description: null, quantity: "1", unitPrice: "1.0000", lineTotal: "1.0000",
    }));
    const read = pdf.inspectPdf(pdf.invoicePdf({
      company: { name: "Co", color: null }, number: 7, status: "open", issuedOn: null, dueOn: null,
      currency: "USD", customerName: "C", propertyAddress: "", lines,
      subtotal: "120.0000", discountTotal: "0", taxTotal: "0", total: "120.0000", amountPaid: "0", balance: "120.0000",
      payments: [], generatedAt: AT,
    }));
    expect(read.problems).toEqual([]);
    expect(read.pageCount).toBeGreaterThan(2);
    expect(read.text).toContain(`Page ${read.pageCount} of ${read.pageCount}`);
    expect(read.text).toContain("Line 120");
    // The heading repeats on the page the table continues onto.
    expect(read.pages[1]).toContain("Amount");
  });

  it("prints a statement with what is owed today", () => {
    const read = pdf.inspectPdf(pdf.statementPdf({
      company: { name: "Lone Star Air", color: null },
      customerName: "Dana Ruiz", from: "2026-05-01", to: "2026-05-31", asOf: "2026-06-01",
      openingBalance: "0.00", closingBalance: "250.00", owedOnInvoices: "250.00", heldOnAccount: "0.00",
      lines: [{ date: "2026-05-04", description: "Invoice 1001", charge: "250.00", credit: null, balance: "250.00" }],
      aging: { current: "0.00", days1To30: "250.00", days31To60: "0.00", days61To90: "0.00", over90: "0.00" },
      openInvoices: [{ number: 1001, issuedOn: "2026-05-04", dueOn: "2026-05-10", total: "250.00", balance: "250.00", daysOverdue: 22 }],
      generatedAt: AT,
    }));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Statement");
    expect(read.text).toContain("May 1, 2026 to May 31, 2026");
    expect(read.text).toContain("Invoice 1001");
    expect(read.text).toContain("22 days late");
  });

  it("draws a report's chart from the same plan the screen uses", () => {
    const result = {
      columns: [
        { key: "month", label: "Month", type: "date", role: "dimension" as const },
        { key: "revenue", label: "Revenue", type: "money", role: "measure" as const },
      ],
      rows: [
        { month: "2026-04", revenue: "1200.0000" },
        { month: "2026-05", revenue: "-300.0000" },
        { month: "2026-06", revenue: "2500.5000" },
      ],
    };
    const chart = reporting.chartFor(result);
    expect(chart.ok).toBe(true);
    const read = pdf.inspectPdf(pdf.reportPdf({
      company: { name: "Lone Star Air", color: "#1F6FEB" },
      name: "Revenue by month", question: "What did we earn?", period: "April to June 2026",
      columns: result.columns, rows: result.rows, truncated: false,
      chart: chart.ok ? chart.plan : null, generatedAt: AT,
    }));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Revenue by month");
    expect(read.text).toContain("Revenue by month");
    expect(read.text).toContain("Jun 2026");
    expect(read.text).toContain("$2,500.50");
    expect(read.text).toContain("-$300.00");
  });
});

/** A PNG of the given colour type and rows, built here so a test can say exactly what is in it. */
function png(width: number, height: number, colourType: number, rows: number[][], extra: Array<[string, number[]]> = []): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: number[]) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, body: number[]) => {
    const typed = [...type].map((c) => c.charCodeAt(0));
    return [...u32(body.length), ...typed, ...body, ...u32(crc([...typed, ...body]))];
  };
  const raw = rows.flatMap((row) => [0, ...row]);
  const idat = [...deflateSync(Uint8Array.from(raw))];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32(width), ...u32(height), 8, colourType, 0, 0, 0]),
    ...extra.flatMap(([type, body]) => chunk(type, body)),
    ...chunk("IDAT", idat),
    ...chunk("IEND", []),
  ]);
}

describe("the company's logo", () => {
  const codecs = { inflate, deflate };

  it("reads a logo with transparency into its colour and a mask", () => {
    // Two pixels: solid red, and blue half see through.
    const logo = pdf.readImage(png(2, 1, 6, [[255, 0, 0, 255, 0, 0, 255, 128]]), codecs)!;
    expect(logo).toMatchObject({ width: 2, height: 1, colorSpace: "DeviceRGB", filter: "FlateDecode" });
    expect([...inflate(logo.data)]).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...inflate(logo.mask!.data)]).toEqual([255, 128]);
    /** Without the codecs it is refused, as it always was. */
    expect(pdf.readImage(png(2, 1, 6, [[255, 0, 0, 255, 0, 0, 255, 128]]))).toBeNull();
  });

  it("reads a palette logo, with the palette's transparency, and leaves a solid one unmasked", () => {
    const paletted = pdf.readImage(png(2, 1, 3, [[0, 1]], [["PLTE", [10, 20, 30, 200, 210, 220]], ["tRNS", [0]]]), codecs)!;
    expect([...inflate(paletted.data)]).toEqual([10, 20, 30, 200, 210, 220]);
    expect([...inflate(paletted.mask!.data)]).toEqual([0, 255]);
    const solid = pdf.readImage(png(1, 2, 6, [[1, 2, 3, 255], [4, 5, 6, 255]]), codecs)!;
    expect(solid.mask).toBeUndefined();
  });

  it("undoes the PNG row filters", () => {
    // Grey with alpha, the second row filtered "up": each byte is its difference from the row above.
    const image = pdf.readImage(pngWith(1, 2, 4, [[0, 100, 255], [2, 5, 0]]), codecs)!;
    expect([...inflate(image.data)]).toEqual([100, 105]);
    /** Solid everywhere, so no mask. */
    expect(image.mask).toBeUndefined();
  });

  it("prints on every page of an invoice, beside the company's name", () => {
    const logo = pdf.readImage(png(2, 1, 6, [[255, 0, 0, 255, 0, 0, 255, 128]]), codecs);
    const lines = Array.from({ length: 80 }, (_, i) => ({
      name: `Line ${i + 1}`, description: null, quantity: "1", unitPrice: "1.0000", lineTotal: "1.0000",
    }));
    const read = pdf.inspectPdf(pdf.invoicePdf({
      company: { name: "Lone Star Air", color: "#0F7B6C", logo },
      number: 9, status: "open", issuedOn: null, dueOn: null, currency: "USD",
      customerName: "Nguyễn Thị Đức", propertyAddress: "", lines,
      subtotal: "80.0000", discountTotal: "0", taxTotal: "0", total: "80.0000", amountPaid: "0", balance: "80.0000",
      payments: [], generatedAt: AT,
    }, { deflate }), inflate);
    expect(read.problems).toEqual([]);
    expect(read.pageCount).toBeGreaterThan(1);
    /** One image object, drawn on each page, carrying its mask. */
    expect(read.images).toEqual([{ width: 2, height: 1, colorSpace: "DeviceRGB", masked: true }]);
    expect(read.text).toContain("Nguyễn Thị Đức");
  });
});

/** A PNG from rows that already carry their filter byte, for testing the filters. */
function pngWith(width: number, height: number, colourType: number, filteredRows: number[][]): Uint8Array {
  const plain = png(width, height, colourType, filteredRows.map((r) => r.slice(1)));
  // Swap the IDAT for one holding the rows exactly as given, filter bytes and all.
  const idat = [...deflateSync(Uint8Array.from(filteredRows.flat()))];
  const at = findChunk(plain, "IDAT");
  const length = (plain[at]! << 24) | (plain[at + 1]! << 16) | (plain[at + 2]! << 8) | plain[at + 3]!;
  const before = [...plain.subarray(0, at)];
  const after = [...plain.subarray(at + 12 + length)];
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of [0x49, 0x44, 0x41, 0x54, ...idat]) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([...before, ...u32(idat.length), 0x49, 0x44, 0x41, 0x54, ...idat, ...u32(c), ...after]);
}

function findChunk(bytes: Uint8Array, type: string): number {
  let at = 8;
  while (at < bytes.length) {
    const length = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!) === type) return at;
    at += 12 + length;
  }
  throw new Error(`No ${type}`);
}
