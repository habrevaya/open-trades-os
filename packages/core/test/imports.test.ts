import { describe, it, expect } from "vitest";
import {
  guessColumns, headerKey, savedColumns, columnsFromSaved, mappingProblems, parseAmount, parseDate,
  parseJobStatus, parsePaymentMethod, readRow, invoiceAmounts, taxRateOf, naturalKey, readFile,
  refusedCsv, trimMoney, MAX_BYTES, MAX_ROWS, normalHeader,
} from "../src/imports/index.js";
import { parseCsv } from "../src/custom-objects/index.js";

/**
 * BRINGING IN A SPREADSHEET, THE HALF WITH NO DATABASE
 *
 * The owner sees these guesses and corrects them, so a wrong guess is a
 * nuisance rather than a disaster, but a wrong guess they do not notice puts
 * every phone number in the email column. And a cell read wrongly (a date
 * taken as the wrong month, an amount with its sign lost) is a record that is
 * wrong forever, so the readers refuse what they would otherwise have to
 * guess.
 */

const today = "2026-10-07";

describe("guessing a column from its header", () => {
  it("matches the common words, whatever the case and punctuation", () => {
    const header = ["Customer Name", "E-mail", "Phone #", "Street Address", "City", "State", "ZIP Code"];
    expect(guessColumns("customers", header)).toEqual(["name", "email", "phone", "street", "city", "state", "zip"]);
  });

  it("gives an exact phrase to its own field before a looser one can claim it", () => {
    const header = ["Name", "Email", "Contact Name", "Contact Email", "Contact Phone"];
    expect(guessColumns("customers", header)).toEqual(["name", "email", "contactName", "contactEmail", "contactPhone"]);
  });

  it("finds a two word phrase inside a longer header", () => {
    expect(guessColumns("customers", ["Customer Email Address"])).toEqual(["email"]);
    expect(guessColumns("invoices", ["Invoice Number (old)"])).toEqual(["number"]);
  });

  it("does not take a single word out of a longer header", () => {
    expect(guessColumns("customers", ["Last service date"])).toEqual([null]);
    expect(guessColumns("jobs", ["Phone number"])).toEqual([null]);
  });

  it("leaves a header it does not know unmatched rather than guessing", () => {
    expect(guessColumns("customers", ["Favourite colour", "Name"])).toEqual([null, "name"]);
  });

  it("uses each field once", () => {
    expect(guessColumns("customers", ["Phone", "Mobile"])).toEqual(["phone", null]);
  });

  it("reads an invoice file's money and dates", () => {
    const header = ["Invoice #", "Customer ID", "Invoice Date", "Due Date", "Subtotal", "Tax", "Total", "Amount Paid", "Payment Date", "Payment Method"];
    expect(guessColumns("invoices", header)).toEqual([
      "number", "customerRef", "issuedOn", "dueOn", "subtotal", "tax", "total", "paid", "paidOn", "method",
    ]);
  });

  it("reads a price book and a jobs file", () => {
    expect(guessColumns("pricebook", ["SKU", "Item Name", "Unit Price", "Cost", "Taxable"]))
      .toEqual(["code", "name", "price", "cost", "taxable"]);
    expect(guessColumns("jobs", ["Job #", "Customer Email", "Service Address", "Job Title", "Status", "Completed On"]))
      .toEqual(["number", "customerEmail", "street", "summary", "status", "finishedOn"]);
  });

  it("normalises a header the same way however it is written", () => {
    expect(normalHeader("  Invoice #  ")).toBe("invoice number");
    expect(normalHeader("E-MAIL")).toBe("e mail");
  });
});

describe("a saved mapping", () => {
  it("maps a second file with the same headers in another order", () => {
    const first = ["Name", "Cell", "Where"];
    const saved = savedColumns(first, ["name", "phone", null]);
    expect(saved).toEqual({ name: "name", cell: "phone" });
    expect(headerKey(["Where", "name", "CELL"])).toBe(headerKey(first));
    expect(columnsFromSaved(["Where", "name", "CELL"], saved)).toEqual([null, "name", "phone"]);
  });
});

describe("what a mapping is missing", () => {
  it("names the field every row needs", () => {
    expect(mappingProblems("pricebook", ["name", "price"])).toEqual([
      "No column is set to Code. Every item needs one.",
    ]);
  });

  it("refuses one field from two columns", () => {
    expect(mappingProblems("customers", ["name", "email", "email"])).toContain("Two columns are both set to Email. Choose one.");
  });

  it("needs a way to find the customer", () => {
    expect(mappingProblems("jobs", ["summary", "finishedOn"]).join(" ")).toMatch(/whose each job is/);
  });

  it("refuses a payment amount with no payment date", () => {
    expect(mappingProblems("invoices", ["customerRef", "issuedOn", "total", "paid"]).join(" "))
      .toMatch(/today's books/);
  });

  it("takes first and last names in place of a name", () => {
    expect(mappingProblems("customers", ["firstName", "lastName"])).toEqual([]);
  });
});

describe("reading an amount", () => {
  it("reads what people type", () => {
    expect(parseAmount("$1,240.50")).toEqual({ ok: true, value: "1240.5000" });
    expect(parseAmount("1240.5")).toEqual({ ok: true, value: "1240.5000" });
    expect(parseAmount("(12.00)")).toEqual({ ok: true, value: "-12.0000" });
    expect(parseAmount("-$12")).toEqual({ ok: true, value: "-12.0000" });
    expect(parseAmount(".5")).toEqual({ ok: true, value: "0.5000" });
  });

  it("refuses what it would have to guess", () => {
    expect(parseAmount("about 200").ok).toBe(false);
    expect(parseAmount("=SUM(B2:B9)").ok).toBe(false);
    expect(parseAmount("1.23456").ok).toBe(false);
  });
});

describe("reading a date", () => {
  it("reads the usual ways of writing one", () => {
    expect(parseDate("2021-03-04")).toEqual({ ok: true, value: "2021-03-04" });
    expect(parseDate("2021-03-04 14:30:00")).toEqual({ ok: true, value: "2021-03-04" });
    expect(parseDate("3/4/2021")).toEqual({ ok: true, value: "2021-03-04" });
    expect(parseDate("Mar 4, 2021")).toEqual({ ok: true, value: "2021-03-04" });
    expect(parseDate("4 March 2021")).toEqual({ ok: true, value: "2021-03-04" });
  });

  it("reads the day first when the owner says the file does", () => {
    expect(parseDate("3/4/2021", true)).toEqual({ ok: true, value: "2021-04-03" });
  });

  it("refuses a two digit year, a day that does not exist and a bare number", () => {
    expect(parseDate("3/4/21").ok).toBe(false);
    expect(parseDate("2/30/2021").ok).toBe(false);
    expect(parseDate("44197")).toEqual({ ok: false, why: expect.stringMatching(/a number, not a date/) });
  });
});

describe("reading the words in a cell", () => {
  it("reads a job's status", () => {
    expect(parseJobStatus("Done")).toEqual({ ok: true, value: "completed" });
    expect(parseJobStatus("Canceled")).toEqual({ ok: true, value: "cancelled" });
    expect(parseJobStatus("In Progress")).toEqual({ ok: true, value: "open" });
    expect(parseJobStatus("maybe").ok).toBe(false);
  });

  it("reads how a payment was made, and calls anything else other", () => {
    expect(parsePaymentMethod("Visa")).toEqual({ ok: true, value: "card" });
    expect(parsePaymentMethod("Cheque")).toEqual({ ok: true, value: "check" });
    expect(parsePaymentMethod("Zelle")).toEqual({ ok: true, value: "other" });
  });
});

describe("reading a row", () => {
  const options = { dayFirst: false, today };

  it("reads a customer with a whole address", () => {
    const row = readRow("customers", ["name", "email", "street", "city", "state", "zip"],
      ["Jane Doe", "jane@example.com", "12 Elm St", "Austin", "TX", "78701"], options);
    expect(row.problems).toEqual([]);
    expect(row.values).toMatchObject({ name: "Jane Doe", street: "12 Elm St", zip: "78701" });
  });

  it("joins a first and last name", () => {
    const row = readRow("customers", ["firstName", "lastName"], ["Jane", "Doe"], options);
    expect(row.values["name"]).toBe("Jane Doe");
  });

  it("refuses half an address rather than loading part of one", () => {
    const row = readRow("customers", ["name", "street"], ["Jane Doe", "12 Elm St"], options);
    expect(row.problems.join(" ")).toMatch(/missing its city, state, zip/);
  });

  it("keeps a cell that looks like a formula as the text it is", () => {
    const row = readRow("customers", ["name"], ['=HYPERLINK("http://example.com","x")'], options);
    expect(row.problems).toEqual([]);
    expect(row.values["name"]).toBe('=HYPERLINK("http://example.com","x")');
  });

  it("refuses an invoice with no date, which would land in today's books", () => {
    const row = readRow("invoices", ["customerRef", "issuedOn", "total"], ["C1", "", "100"], options);
    expect(row.problems.join(" ")).toMatch(/today's books/);
  });

  it("refuses a payment with no date", () => {
    const row = readRow("invoices", ["customerRef", "issuedOn", "total", "paid", "paidOn"],
      ["C1", "2021-03-04", "100", "100", ""], options);
    expect(row.problems.join(" ")).toMatch(/payment would be put in today's books/);
  });

  it("refuses a date that has not happened", () => {
    const row = readRow("invoices", ["customerRef", "issuedOn", "total"], ["C1", "2030-01-01", "100"], options);
    expect(row.problems.join(" ")).toMatch(/has not happened yet/);
  });

  it("refuses a finished job with no day it was finished", () => {
    const row = readRow("jobs", ["customerRef", "summary", "status"], ["C1", "Tune up", "Completed"], options);
    expect(row.problems.join(" ")).toMatch(/counted as finished today/);
  });

  it("takes a job's finish day as its being finished", () => {
    const row = readRow("jobs", ["customerRef", "summary", "finishedOn"], ["C1", "Tune up", "2021-05-06"], options);
    expect(row.problems).toEqual([]);
    expect(row.values["status"]).toBe("completed");
  });

  it("names every problem a row has", () => {
    const row = readRow("pricebook", ["code", "name", "price"], ["", "Tune up", "lots"], options);
    expect(row.problems).toEqual(["Price: \"lots\" is not an amount.", "Code is empty."]);
  });
});

describe("an invoice's amounts", () => {
  it("works out the one the file leaves out", () => {
    expect(invoiceAmounts({ subtotal: "100.0000", tax: "8.2500" })).toEqual({ ok: true, subtotal: "100.0000", tax: "8.2500", total: "108.2500" });
    expect(invoiceAmounts({ total: "108.2500", tax: "8.2500" })).toEqual({ ok: true, subtotal: "100.0000", tax: "8.2500", total: "108.2500" });
    expect(invoiceAmounts({ total: "50.0000" })).toEqual({ ok: true, subtotal: "50.0000", tax: "0.0000", total: "50.0000" });
  });

  it("refuses three that disagree", () => {
    const answer = invoiceAmounts({ subtotal: "100.0000", tax: "8.2500", total: "110.0000" });
    expect(answer).toEqual({ ok: false, why: "Before tax 100.00 and tax 8.25 come to 108.25, not the 110.00 in Total." });
  });

  it("gives the rate the tax was charged at", () => {
    expect(taxRateOf("8.2500", "100.0000")).toBe("0.082500");
    expect(taxRateOf("1.0000", "3.0000")).toBe("0.333333");
    expect(trimMoney("12.3400")).toBe("12.34");
    expect(trimMoney("0.1250")).toBe("0.125");
  });
});

describe("the id a record is given", () => {
  it("is the file's own id, or the field that already names one record", () => {
    expect(naturalKey("customers", { ref: "C-9" })).toBe("C-9");
    expect(naturalKey("customers", { name: "Jane" })).toBeNull();
    expect(naturalKey("pricebook", { code: "TUNE" })).toBe("TUNE");
    expect(naturalKey("invoices", { number: "1042" })).toBe("1042");
  });
});

describe("the file", () => {
  it("refuses one too large to be one file", () => {
    const answer = readFile("Name\nJane\n", MAX_BYTES + 1);
    expect(answer).toEqual({ ok: false, why: expect.stringMatching(/^That file is 5\.0 MB\. Bring in at most 5 MB/) });
  });

  it("refuses one with too many rows", () => {
    const text = `Name\n${Array.from({ length: MAX_ROWS + 1 }, (_, i) => `P${i}`).join("\n")}\n`;
    const answer = readFile(text, text.length);
    expect(answer.ok).toBe(false);
  });

  it("refuses a workbook, which is not a CSV, and says what to do", () => {
    expect(readFile("PK\u0003\u0004\u0014\u0000binary", 20)).toEqual({ ok: false, why: expect.stringMatching(/pick CSV/) });
  });

  it("refuses an empty file and a header with nothing under it", () => {
    expect(readFile("", 0)).toEqual({ ok: false, why: "That file is empty." });
    expect(readFile("Name\n", 5)).toEqual({ ok: false, why: "That file has a header row and nothing under it." });
  });
});

describe("the refused rows, handed back", () => {
  it("writes a formula cell as text and keeps a number a number", () => {
    const csv = refusedCsv(["Name", "Total"], [{ row: 2, cells: ['=HYPERLINK("http://x","y")', "-12.50"], reason: "No date." }]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Name,Total,Original row,Refused because");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")",-12.50,2,No date.`);
  });

  it("reads back as what was refused, ready to bring in again", () => {
    const csv = refusedCsv(["Name"], [{ row: 7, cells: ["+1 call me"], reason: "Phone missing" }]);
    expect(parseCsv(csv)).toEqual([["Name", "Original row", "Refused because"], ["+1 call me", "7", "Phone missing"]]);
    expect(guessColumns("customers", ["Name", "Original row", "Refused because"])).toEqual(["name", null, null]);
  });
});
