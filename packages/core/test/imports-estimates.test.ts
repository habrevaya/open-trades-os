import { describe, it, expect } from "vitest";
import { guessColumns, mappingProblems, readRow, readGroup, isGrouped, FIELDS } from "../src/imports/index.js";

/**
 * AN ESTIMATE THAT ARRIVES WHOLE, THE HALF WITH NO DATABASE
 *
 * An estimate in another product is a set of options, each with its lines, and
 * a file that carries it has a row per line. These read the rows of one
 * estimate together: which option each line is in, what each option comes to,
 * which one the customer chose, and every disagreement between the file and
 * itself, said in words, because a quote that comes in a cent different from the
 * customer's copy is worse than one that does not come in.
 */

const today = "2026-10-07";
const options = { dayFirst: false, today };

const COLUMNS = ["number", "customerRef", "street", "title", "issuedOn", "sentOn", "option", "lineName", "quantity",
  "unitPrice", "tax", "total", "recommended", "outcome", "decidedOn", "chosen", "reason"];

/** A row of an estimates file, with the cells it names and the rest empty. */
function row(cells: Partial<Record<(typeof COLUMNS)[number], string>>): string[] {
  return COLUMNS.map((c) => cells[c] ?? "");
}

/** Rows read as the service reads them: each as a line when there are several, then together. */
function together(rows: string[][], columns: readonly string[] = COLUMNS) {
  const line = rows.length > 1;
  const read = rows.map((cells, i) => ({ row: i + 2, ...readRow("estimates", columns, cells, { ...options, line }) }));
  const group = readGroup("estimates", read.map((r) => ({ row: r.row, values: r.values })));
  const own = read.flatMap((r) => r.problems.map((p) => (line ? `Row ${r.row}: ${p}` : p)));
  return { ...group, problems: [...own, ...group.problems] };
}

const BASE = { number: "7001", customerRef: "C-1", title: "Whole house", issuedOn: "2022-02-01" };

describe("the columns of an estimate with options and lines", () => {
  it("are guessed from their headings", () => {
    const header = ["Estimate #", "Customer ID", "Option", "Line item", "Qty", "Price each", "Tax", "Total", "Recommended", "Status", "Chosen"];
    expect(guessColumns("estimates", header))
      .toEqual(["number", "customerRef", "option", "lineName", "quantity", "unitPrice", "tax", "total", "recommended", "outcome", "chosen"]);
  });

  it("are grouped by the estimate's id or number, like an invoice's lines", () => {
    expect(isGrouped("estimates")).toBe(true);
    expect(new Set(FIELDS.estimates.map((f) => f.key)).size).toBe(FIELDS.estimates.length);
  });

  it("need a price for a quantity, and an amount from somewhere", () => {
    expect(mappingProblems("estimates", ["number", "customerRef", "issuedOn", "quantity", "total"]))
      .toContain("A column is set to Quantity and none to Price each. A quantity needs the price of one to make a line.");
    expect(mappingProblems("estimates", ["number", "customerRef", "issuedOn"]))
      .toContain("No column is set to Total, Before tax or Price each. Every estimate needs an amount.");
    expect(mappingProblems("estimates", ["number", "customerRef", "issuedOn", "unitPrice"])).toEqual([]);
  });
});

describe("one row is one estimate of one option and one line, as it always was", () => {
  it("keeps the old reading", () => {
    const one = together([row({ ...BASE, total: "4330", tax: "330", outcome: "Won", decidedOn: "2022-02-10" })]);
    expect(one.problems).toEqual([]);
    expect(one.options).toEqual([{
      name: "As quoted", recommended: true, chosen: true, total: "4330.0000", fileTotal: "4330.0000",
      lines: [{ name: "Whole house", quantity: "1", unitPrice: "4000.0000", subtotal: "4000.0000", tax: "330.0000" }],
    }]);
  });

  it("takes the option's name and the line's quantity at its price", () => {
    const one = together([row({ ...BASE, option: "Better", lineName: "Heat pump", quantity: "2", unitPrice: "1500" })]);
    expect(one.problems).toEqual([]);
    expect(one.options[0]).toMatchObject({
      name: "Better", total: "3000.0000", fileTotal: "3000.0000",
      lines: [{ name: "Heat pump", quantity: "2.0000", unitPrice: "1500.0000", subtotal: "3000.0000" }],
    });
  });
});

describe("several rows with one estimate number are one estimate", () => {
  /** Good: 3000 + 150 + 247.50 tax = 3397.50. Better: 4200 + 150 + 346.50 tax = 4696.50. */
  const rows = [
    row({ ...BASE, option: "Good", lineName: "Furnace", quantity: "1", unitPrice: "3000", tax: "247.50", total: "3397.50", recommended: "no" }),
    row({ number: "7001", option: "Good", lineName: "Install", quantity: "5", unitPrice: "30", tax: "0", total: "3397.50" }),
    row({ number: "7001", option: "Better", lineName: "Furnace plus filter", quantity: "1", unitPrice: "4200", tax: "346.50", total: "4696.50", recommended: "yes" }),
    row({ number: "7001", option: "Better", lineName: "Install", quantity: "5", unitPrice: "30", tax: "0", total: "4696.50" }),
  ];

  it("reads each option with its lines, its tax as charged and its own total", () => {
    const read = together(rows);
    expect(read.problems).toEqual([]);
    expect(read.options.map((o) => [o.name, o.recommended, o.chosen, o.total, o.fileTotal, o.lines.length])).toEqual([
      ["Good", false, false, "3397.5000", "3397.5000", 2],
      ["Better", true, false, "4696.5000", "4696.5000", 2],
    ]);
    expect(read.options[0]!.lines[1]).toEqual({ name: "Install", quantity: "5.0000", unitPrice: "30.0000", subtotal: "150.0000", tax: "0.0000" });
    expect(read.values).toMatchObject({ number: "7001", customerRef: "C-1", title: "Whole house", issuedOn: "2022-02-01", outcome: "open" });
  });

  it("keeps options in the order the file first names them, whatever the case it spells them in", () => {
    const read = together([
      row({ ...BASE, option: "Better", lineName: "A", unitPrice: "10" }),
      row({ number: "7001", option: "good", lineName: "B", unitPrice: "20" }),
      row({ number: "7001", option: "BETTER", lineName: "C", unitPrice: "30" }),
    ]);
    expect(read.problems).toEqual([]);
    expect(read.options.map((o) => [o.name, o.lines.length, o.total])).toEqual([["Better", 2, "40.0000"], ["good", 1, "20.0000"]]);
  });

  it("refuses an option whose lines do not come to its total, naming the option", () => {
    const bad = rows.map((r) => [...r]);
    bad[0]![COLUMNS.indexOf("total")] = "3400.00";
    bad[1]![COLUMNS.indexOf("total")] = "3400.00";
    expect(together(bad).problems).toEqual(['The option "Good" comes to 3397.50, not the 3400.00 in Total.']);
  });

  it("refuses rows of one option that give two totals, and rows that disagree about the estimate", () => {
    const two = rows.map((r) => [...r]);
    two[1]![COLUMNS.indexOf("total")] = "3500.00";
    expect(together(two).problems.join(" ")).toMatch(/Rows 2 and 3 are in the option "Good" and say its Total is 3397.50 and 3500.00/);
    const apart = rows.map((r) => [...r]);
    apart[3]![COLUMNS.indexOf("customerRef")] = "C-2";
    expect(together(apart).problems.join(" ")).toMatch(/Row 2 says Customer's id is C-1 and row 5 says C-2. They are one estimate, so they have to agree./);
  });

  it("refuses a line with no option when the others have one", () => {
    const read = together([
      row({ ...BASE, option: "Good", lineName: "A", unitPrice: "10" }),
      row({ number: "7001", lineName: "B", unitPrice: "20" }),
    ]);
    expect(read.problems).toEqual(['Row 3 is in no option, and row 2 is in the option "Good". Name the option on every line, or on none.']);
  });

  it("refuses a line with no amount, as an invoice's is", () => {
    const read = together([
      row({ ...BASE, option: "Good", lineName: "A", unitPrice: "10" }),
      row({ number: "7001", option: "Good", lineName: "B" }),
    ]);
    expect(read.problems).toEqual(["Row 3: A line of an estimate with several needs its own amount: fill in Before tax, or Price each."]);
  });

  it("refuses more options than an estimate can hold", () => {
    const many = ["A", "B", "C", "D", "E", "F"].map((o, i) => row({ ...(i === 0 ? BASE : { number: "7001" }), option: o, lineName: o, unitPrice: "10" }));
    expect(together(many).problems).toEqual(["It has 6 options. An estimate can have at most 5."]);
  });

  it("refuses a date it was written missing from every row, as a single row does", () => {
    const read = together([
      row({ number: "7001", customerRef: "C-1", option: "A", unitPrice: "10" }),
      row({ number: "7001", option: "A", unitPrice: "20" }),
    ]);
    expect(read.problems).toEqual(["Written on is empty."]);
  });

  it("needs a customer on some row", () => {
    const read = together([
      row({ number: "7001", issuedOn: "2022-02-01", option: "A", unitPrice: "10" }),
      row({ number: "7001", option: "A", unitPrice: "20" }),
    ]);
    expect(read.problems).toEqual(["Neither the customer's id nor their email is filled in, so there is no telling whose it is."]);
  });
});

describe("how an estimate with options ended", () => {
  const two = (over: Partial<Record<(typeof COLUMNS)[number], string>>, secondOver: Partial<Record<(typeof COLUMNS)[number], string>> = {}) => together([
    row({ ...BASE, option: "Good", lineName: "A", unitPrice: "100", ...over }),
    row({ number: "7001", option: "Better", lineName: "B", unitPrice: "200", ...secondOver }),
  ]);

  it("takes the option the customer chose from the file", () => {
    const read = two({ outcome: "Won", decidedOn: "2022-02-10" }, { chosen: "yes" });
    expect(read.problems).toEqual([]);
    expect(read.options.map((o) => [o.name, o.chosen])).toEqual([["Good", false], ["Better", true]]);
    expect(read.values["outcome"]).toBe("approved");
  });

  it("refuses an approval that does not say which option, rather than picking one", () => {
    expect(two({ outcome: "Won", decidedOn: "2022-02-10" }).problems)
      .toEqual(["It was approved and the file does not say which of its 2 options the customer chose. Fill in the Chosen column for that option."]);
  });

  it("refuses two chosen options and a chosen option on an estimate that was not approved", () => {
    expect(two({ outcome: "Won", decidedOn: "2022-02-10", chosen: "yes" }, { chosen: "yes" }).problems)
      .toEqual(['Two options are marked chosen: "Good" and "Better". The customer chose one.']);
    expect(two({ outcome: "Lost", decidedOn: "2022-02-10", reason: "Too dear" }, { chosen: "yes" }).problems)
      .toEqual(['The option "Better" is marked chosen, and the estimate was not approved.']);
  });

  it("takes the one option of an approved estimate as the chosen one", () => {
    const read = together([
      row({ ...BASE, lineName: "A", unitPrice: "100", outcome: "Won", decidedOn: "2022-02-10" }),
      row({ number: "7001", lineName: "B", unitPrice: "50" }),
    ]);
    expect(read.problems).toEqual([]);
    expect(read.options.map((o) => [o.name, o.chosen, o.recommended])).toEqual([["As quoted", true, true]]);
  });

  it("refuses an outcome that the dates contradict, once for the whole estimate", () => {
    const read = two({ outcome: "Lost", decidedOn: "2022-01-10", reason: "Too dear" });
    expect(read.problems).toEqual(["It was decided on 2022-01-10, before it was written on 2022-02-01."]);
  });

  it("refuses two options marked recommended", () => {
    const read = two({ recommended: "yes" }, { recommended: "yes" });
    expect(read.problems).toEqual(['Two options are marked recommended: "Good" and "Better". Only one can be.']);
  });

  it("leaves no option recommended when the file recommends none of several", () => {
    expect(two({}).options.map((o) => o.recommended)).toEqual([false, false]);
  });
});
