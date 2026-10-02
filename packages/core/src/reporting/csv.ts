/**
 * A REPORT AS A SPREADSHEET
 *
 * The attachment on a delivered report, and the file an accountant opens. Two
 * things matter more than the format, which is plain RFC 4180.
 *
 * THE VALUE IS THE VALUE. Money stays a decimal with no currency sign and no
 * thousands separator, so a spreadsheet reads it as a number and a sum of the
 * column is the report's own total. A formatted "$1,240.50" is text to every
 * spreadsheet that opens it, and the first thing an accountant does is clean
 * it back out.
 *
 * A CELL CANNOT BE A FORMULA. A customer is called whatever somebody typed,
 * and a customer named `=HYPERLINK(...)` in a CSV opened in a spreadsheet is a
 * live formula on the accountant's machine. Text cells that begin with one of
 * the characters a spreadsheet treats as the start of a formula are prefixed
 * with an apostrophe, which every spreadsheet shows as text and none
 * evaluates. Numbers are not touched, so a negative margin stays a number.
 */

export interface CsvColumn {
  key: string;
  label: string;
  type: string;
  /** The aging buckets' numeric prefix, which exists only to sort. */
  sortPrefix?: boolean | undefined;
}

const FORMULA = /^[=+\-@\t\r]/;

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One value, as it goes in the file. */
export function csvValue(column: CsvColumn, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (column.type === "money" || column.type === "number") {
    // Already a decimal from the database. Only a float needs its exponent removed.
    return typeof value === "number" && /e/i.test(String(value)) ? value.toFixed(10) : String(value);
  }
  let text = String(value);
  if (column.sortPrefix) text = text.replace(/^\d+\s+/, "");
  /**
   * An enum value in the words the screen uses. `in_progress` in a
   * spreadsheet is the database leaking into the accountant's file, and the
   * filter they build on it should match what they saw in the app.
   */
  if (column.type === "status") {
    text = text.split("_").map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word)).join(" ");
  }
  return FORMULA.test(text) ? `'${text}` : text;
}

/** The whole file, header first, lines ending CRLF as RFC 4180 says. */
export function toCsv(
  columns: CsvColumn[],
  rows: Record<string, string | number | null>[],
): string {
  const lines = [columns.map((c) => cell(c.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(csvValue(c, row[c.key]))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
