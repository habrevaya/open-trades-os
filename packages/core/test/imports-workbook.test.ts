import { describe, it, expect } from "vitest";
import { cellText, readSheetGrid, parseTime, MAX_COLUMNS, MAX_ROWS } from "../src/imports/index.js";

/**
 * A WORKBOOK'S CELLS, AS THE TEXT A CSV WOULD HAVE HELD
 *
 * Everything after this point (the mapping, the readers, the checks) takes
 * text, so what a number, a date and a time become on the way in is where a
 * workbook can differ from a CSV, and where a wrong guess puts an invoice in
 * the wrong month.
 */

describe("a cell as text", () => {
  it("leaves text as it is, including text that looks like a formula", () => {
    expect(cellText("Ada Lovelace")).toBe("Ada Lovelace");
    expect(cellText('=HYPERLINK("http://evil.example","Click me")')).toBe('=HYPERLINK("http://evil.example","Click me")');
  });

  it("writes a number with the digits a spreadsheet shows, not the noise it stores", () => {
    expect(cellText(19.99)).toBe("19.99");
    expect(cellText(108.25000000000001)).toBe("108.25");
    expect(cellText(0.1 + 0.2)).toBe("0.3");
    expect(cellText(2134)).toBe("2134");
    expect(cellText(-12.5)).toBe("-12.5");
    expect(cellText(Number.NaN)).toBe("");
    expect(cellText(Infinity)).toBe("");
  });

  it("writes true and false the way the yes or no reader takes them", () => {
    expect(cellText(true)).toBe("true");
    expect(cellText(false)).toBe("false");
  });

  it("writes a date as a day, with the time after it only when there is one", () => {
    expect(cellText(new Date(Date.UTC(2021, 2, 4)))).toBe("2021-03-04");
    expect(cellText(new Date(Date.UTC(2021, 2, 4, 14, 30)))).toBe("2021-03-04 14:30");
    expect(cellText(new Date(Date.UTC(2021, 11, 31, 23, 59)))).toBe("2021-12-31 23:59");
  });

  it("writes a time with no day, which a spreadsheet keeps as a day in 1899, as a time", () => {
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 9, 5)))).toBe("09:05");
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 0, 0)))).toBe("00:00");
  });

  it("writes an empty cell and an invalid date as nothing", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText(new Date(Number.NaN))).toBe("");
  });
});

describe("a time with its day in front, as a date column gives it", () => {
  it("is the time", () => {
    expect(parseTime("2021-03-04 14:30")).toEqual({ ok: true, value: "14:30" });
    expect(parseTime("2021-03-04T09:05")).toEqual({ ok: true, value: "09:05" });
  });
  it("still refuses a day alone", () => {
    expect(parseTime("2021-03-04").ok).toBe(false);
  });
});

describe("a sheet as a header and rows", () => {
  it("takes the first row as the header and keeps each row's own number", () => {
    const read = readSheetGrid("Customers", [
      ["Name", "Zip"],
      ["Ada", 2134],
      [null, null],
      ["Grace", "78702"],
    ]);
    expect(read).toEqual({ ok: true, header: ["Name", "Zip"], rows: [["Ada", "2134"], ["Grace", "78702"]], numbers: [2, 4] });
  });

  it("drops the empty cells after the last named column, and pads a short row", () => {
    const read = readSheetGrid("S", [["A", "B", null, null], ["x"], ["y", "z", "left over"]]);
    expect(read).toEqual({ ok: true, header: ["A", "B"], rows: [["x", ""], ["y", "z"]], numbers: [2, 3] });
  });

  it("refuses a sheet whose first row is empty, because skipping it would renumber every row", () => {
    const read = readSheetGrid("Notes", [[null, null], ["Name"], ["Ada"]]);
    expect(read).toEqual({ ok: false, why: expect.stringContaining('The first row of the sheet "Notes" is empty') });
  });

  it("refuses an empty sheet and one with a header and nothing under it", () => {
    expect(readSheetGrid("Empty", []).ok).toBe(false);
    expect(readSheetGrid("Head", [["Name"], [null], ["", "  "]])).toEqual({
      ok: false, why: 'The sheet "Head" has a header row and nothing under it.',
    });
  });

  it("refuses too many rows and too many columns", () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => [`P${i}`]);
    expect(readSheetGrid("Long", [["Name"], ...rows])).toEqual({ ok: false, why: expect.stringContaining("Bring in at most 10,000") });
    const wide = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `C${i}`);
    expect(readSheetGrid("Wide", [wide, wide.map(() => "x")])).toEqual({ ok: false, why: expect.stringContaining(`at most ${MAX_COLUMNS}`) });
  });

  it("accepts exactly the most rows", () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => [`P${i}`]);
    const read = readSheetGrid("Long", [["Name"], ...rows]);
    expect(read.ok).toBe(true);
  });
});
