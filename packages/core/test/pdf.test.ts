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

  it("prints Western European accents and drops an accent the fonts lack, and prints a question mark for a letter they lack", () => {
    const page = new pdf.PdfPage();
    page.text(48, 60, "José Peña ’s €5");
    page.text(48, 80, "Đức");
    const read = pdf.inspectPdf(pdf.renderPdf([page], { title: "t", createdAt: AT }));
    expect(read.pages[0]![0]).toBe("José Peña ’s €5");
    expect(read.pages[0]![1]).toBe("?uc");
  });

  it("measures text from the font's own widths", () => {
    // Helvetica: "W" is 944 units, "i" is 222. At 10 points, 9.44 and 2.22.
    expect(pdf.widthOf("W", "regular", 10)).toBeCloseTo(9.44, 5);
    expect(pdf.widthOf("i", "regular", 10)).toBeCloseTo(2.22, 5);
    expect(pdf.widthOf("W", "bold", 10)).toBeCloseTo(9.44, 5);
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
