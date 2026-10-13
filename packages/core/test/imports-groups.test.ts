import { describe, it, expect } from "vitest";
import {
  guessColumns, mappingProblems, parseQuantity, readRow, readGroup, lineAmount, isGrouped, naturalKey,
} from "../src/imports/index.js";

/**
 * SEVERAL ROWS THAT ARE ONE RECORD
 *
 * An invoice with three lines is three rows with one invoice number, and a
 * cheque that paid two invoices is two rows with one payment id. These are
 * the parts that need no database: reading a row as a line, and reading the
 * rows together, refusing them together when they disagree.
 */
const today = "2026-10-07";
const options = { dayFirst: false, today };

describe("an invoice of several lines", () => {
  const columns = ["number", "customerRef", "issuedOn", "description", "quantity", "unitPrice", "tax", "total"];
  const row = (cells: string[], line = true) => readRow("invoices", columns, cells, { ...options, line });

  it("guesses a quantity and a price each from their headers", () => {
    expect(guessColumns("invoices", ["Invoice #", "Qty", "Price Each", "Before Tax", "Invoice Total"]))
      .toEqual(["number", "quantity", "unitPrice", "subtotal", "total"]);
  });

  it("reads a quantity, and refuses one that is nothing or a guess", () => {
    expect(parseQuantity("1.5")).toEqual({ ok: true, value: "1.5000" });
    expect(parseQuantity("0")).toMatchObject({ ok: false });
    expect(parseQuantity("a few")).toMatchObject({ ok: false });
  });

  it("makes a line's amount from its quantity at its price each, rounded as the invoice rounds", () => {
    expect(lineAmount("3", "33.333")).toBe("100.0000");
    expect(row(["1", "C1", "2021-01-01", "Part", "2", "12.50", "", ""]).values["subtotal"]).toBe("25.0000");
  });

  it("refuses a quantity with no price each when the columns are set", () => {
    expect(mappingProblems("invoices", ["number", "customerRef", "issuedOn", "quantity", "total"]).join(" "))
      .toMatch(/Quantity and none to Price each/);
  });

  it("adds the lines up and checks a Total against them", () => {
    const rows = [
      { row: 2, values: row(["1", "C1", "2021-01-01", "Part", "2", "50", "8.25", "158.25"]).values },
      { row: 3, values: row(["1", "", "", "Labor", "1", "50", "", ""]).values },
    ];
    const group = readGroup("invoices", rows);
    expect(group.problems).toEqual([]);
    expect(group.values).toMatchObject({ subtotal: "150.0000", tax: "8.2500", total: "158.2500", issuedOn: "2021-01-01" });
    expect(group.lines.map((l) => [l.name, l.quantity, l.unitPrice])).toEqual([["Part", "2.0000", "50.0000"], ["Labor", "1.0000", "50.0000"]]);
    const wrong = readGroup("invoices", [rows[0]!, { row: 3, values: { ...rows[1]!.values, total: "158.2500" } }, { row: 4, values: row(["1", "", "", "Extra", "1", "1", "", ""]).values }]);
    expect(wrong.problems).toEqual(["Its 3 lines come to 159.25, not the 158.25 in Total."]);
  });

  it("refuses rows that disagree about the invoice, naming both", () => {
    const group = readGroup("invoices", [
      { row: 2, values: row(["1", "C1", "2021-01-01", "Part", "1", "10", "", ""]).values },
      { row: 3, values: row(["1", "C2", "2021-01-01", "Labor", "1", "10", "", ""]).values },
    ]);
    expect(group.problems).toEqual(["Row 2 says Customer's id is C1 and row 3 says C2. They are one invoice, so they have to agree."]);
  });

  it("asks for an invoice date somewhere among the rows rather than on each", () => {
    const group = readGroup("invoices", [
      { row: 2, values: row(["1", "C1", "", "Part", "1", "10", "", ""]).values },
      { row: 3, values: row(["1", "", "", "Labor", "1", "10", "", ""]).values },
    ]);
    expect(group.problems.join(" ")).toMatch(/no invoice date/);
  });
});

describe("a payment split across invoices", () => {
  const columns = ["ref", "invoiceRef", "amount", "paidOn", "method"];
  it("is grouped by its id, and so is an invoice, but nothing else", () => {
    expect(isGrouped("payments")).toBe(true);
    expect(isGrouped("invoices")).toBe(true);
    expect(isGrouped("customers")).toBe(false);
    expect(naturalKey("payments", { ref: "P-1" })).toBe("P-1");
  });

  it("adds its shares up, and refuses the same invoice twice", () => {
    const read = (cells: string[]) => readRow("payments", columns, cells, { ...options, line: true }).values;
    const group = readGroup("payments", [
      { row: 2, values: read(["P-1", "1001", "100", "2021-02-01", "check"]) },
      { row: 3, values: read(["P-1", "1002", "50", "", ""]) },
    ]);
    expect(group.problems).toEqual([]);
    expect(group.values["amount"]).toBe("150.0000");
    expect(group.allocations).toEqual([{ invoiceRef: "1001", amount: "100.0000" }, { invoiceRef: "1002", amount: "50.0000" }]);
    const twice = readGroup("payments", [
      { row: 2, values: read(["P-1", "1001", "100", "2021-02-01", ""]) },
      { row: 3, values: read(["P-1", "1001", "50", "", ""]) },
    ]);
    expect(twice.problems).toEqual(["Rows 2 and 3 both put this payment on invoice 1001. Put it on one row."]);
  });

  it("refuses a row with no day it was paid, and an amount of nothing", () => {
    const one = readRow("payments", columns, ["P-1", "1001", "0", "", ""], options);
    expect(one.problems.join(" ")).toMatch(/no day it was paid/);
    expect(one.problems.join(" ")).toMatch(/more than nothing/);
  });
});

describe("a past estimate", () => {
  const columns = ["number", "customerRef", "issuedOn", "sentOn", "total", "outcome", "decidedOn", "reason"];
  const read = (cells: string[]) => readRow("estimates", columns, cells, options);

  it("reads how it ended in the words people use", () => {
    expect(read(["1", "C1", "2022-01-01", "2022-01-02", "100", "Won", "2022-01-05", ""]).values)
      .toMatchObject({ outcome: "approved", sentOn: "2022-01-02", total: "100.0000", subtotal: "100.0000" });
    expect(read(["1", "C1", "2022-01-01", "", "100", "Lost", "2022-01-05", "Too dear"]).values["outcome"]).toBe("declined");
    expect(read(["1", "C1", "2022-01-01", "", "100", "", "", ""]).values["outcome"]).toBe("open");
  });

  it("refuses one sent and still waiting, one decided with no day, and days out of order", () => {
    expect(read(["1", "C1", "2022-01-01", "2022-01-02", "100", "Pending", "", ""]).problems.join(" "))
      .toMatch(/still waiting for an answer/);
    expect(read(["1", "C1", "2022-01-01", "", "100", "Declined", "", ""]).problems)
      .toEqual(["It says it was declined and not when. Fill in the day in Decided on."]);
    expect(read(["1", "C1", "2022-01-05", "2022-01-02", "100", "Won", "2022-01-04", ""]).problems.join(" "))
      .toMatch(/sent on 2022-01-02, before it was written on 2022-01-05/);
    expect(read(["1", "C1", "2022-01-01", "", "100", "Won", "2022-01-04", "Too dear"]).problems)
      .toEqual(["It has a reason it was declined and says it was approved."]);
  });
});
