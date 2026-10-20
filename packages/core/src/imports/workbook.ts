import { MAX_ROWS } from "./index.js";

/**
 * A WORKBOOK'S SHEET, AS THE SAME ROWS A CSV GIVES
 *
 * A reader library turns an .xlsx into cells of text, numbers, true or false,
 * and dates. This is the half of reading a workbook that needs no library and
 * no file: what each of those becomes as text, so a sheet goes through the
 * mapping and the checks a CSV goes through and not through a second set.
 *
 * NOTHING IS EVALUATED. A cell holding a formula arrives as the answer the
 * spreadsheet program last worked out and stored beside it, never as the
 * formula, and a cell of text that starts with `=` is the characters it holds.
 */

/** What a workbook reader hands back for one cell. */
export type WorkbookValue = string | number | boolean | Date | null | undefined;

/** The widest sheet taken: a sheet of columns past this is not a list of anything. */
export const MAX_COLUMNS = 500;
/** The most sheets in one workbook the screen will list. */
export const MAX_SHEETS = 50;
/**
 * The most the parts of a workbook may come to once opened. A workbook is a zip
 * of XML, XML shrinks a thousand to one, and five megabytes of zip could
 * otherwise open into gigabytes.
 */
export const MAX_OPENED_BYTES = 100 * 1024 * 1024;
/**
 * The most cells a sheet may span from its first cell to its last, formatted
 * blanks included, because a reader makes room for every one of them. Ten
 * thousand rows of five hundred columns is as much as a file may hold.
 */
export const MAX_SPAN = 5_000_000;
/** Rows past which even blank, formatted cells are not allowed: the data stops far sooner. */
export const MAX_BLANK_ROWS = 200_000;

const two = (n: number) => String(n).padStart(2, "0");

/**
 * One cell as text.
 *
 * A number is written with the fifteen digits a spreadsheet shows, because the
 * file stores the nearest binary fraction (a price of 108.25 worked out by a
 * formula is stored as 108.25000000000001) and an amount with fourteen decimal
 * places would be refused. A date is `YYYY-MM-DD`, with the time after it when
 * it has one; a time with no day (spreadsheets keep it as a day in 1899) is
 * `HH:MM`. A spreadsheet keeps a date as a number of days with no time zone, so
 * the reader's date holds the wall clock in its UTC fields.
 */
export function cellText(value: WorkbookValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(Number(value.toPrecision(15)));
  }
  if (Number.isNaN(value.getTime())) return "";
  const clock = `${two(value.getUTCHours())}:${two(value.getUTCMinutes())}`;
  if (value.getUTCFullYear() < 1900) return clock;
  const day = `${String(value.getUTCFullYear()).padStart(4, "0")}-${two(value.getUTCMonth() + 1)}-${two(value.getUTCDate())}`;
  return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 ? day : `${day} ${clock}`;
}

/** The size of a file past which it is several files, said the way a CSV's is. */
export function tooBigMessage(bytes: number): string {
  return `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB. Bring in at most 5 MB at a time: split it into smaller files and bring each one in.`;
}

export type Sheet =
  | { ok: true; header: string[]; rows: string[][]; numbers: number[] }
  | { ok: false; why: string };

/**
 * A sheet as a header and rows, refused in words when it is not a list.
 *
 * The first row is the header, as in a CSV, so the first row has to be the
 * column names: skipping blank rows above it would make every row number
 * disagree with the one the spreadsheet program shows. A row with nothing in
 * it is left out, and each row keeps its own number from the sheet, so "row 12"
 * on the screen is row 12 in the spreadsheet.
 */
export function readSheetGrid(name: string, grid: ReadonlyArray<ReadonlyArray<WorkbookValue>>): Sheet {
  const head = (grid[0] ?? []).map((cell) => cellText(cell).trim());
  let width = head.length;
  while (width > 0 && head[width - 1] === "") width -= 1;
  if (width === 0) {
    return { ok: false, why: `The first row of the sheet "${name}" is empty. Put the column names in the first row, with the rows under it, and bring it in again.` };
  }
  if (width > MAX_COLUMNS) {
    return { ok: false, why: `The sheet "${name}" has ${width.toLocaleString("en-US")} columns. Bring in at most ${MAX_COLUMNS}.` };
  }
  const rows: string[][] = [];
  const numbers: number[] = [];
  for (let r = 1; r < grid.length; r++) {
    const source = grid[r] ?? [];
    const cells = Array.from({ length: width }, (_, c) => cellText(source[c]));
    if (cells.every((cell) => cell.trim() === "")) continue;
    rows.push(cells);
    numbers.push(r + 1);
  }
  if (rows.length === 0) return { ok: false, why: `The sheet "${name}" has a header row and nothing under it.` };
  if (rows.length > MAX_ROWS) {
    return { ok: false, why: `The sheet "${name}" has ${rows.length.toLocaleString("en-US")} rows. Bring in at most ${MAX_ROWS.toLocaleString("en-US")} at a time: split it into smaller sheets.` };
  }
  return { ok: true, header: head.slice(0, width), rows, numbers };
}
