import * as m from "../money/index.js";
import { classOf, type AccountClass } from "../ledger/index.js";

/**
 * M15. THE COMPANY BUDGET, AND HOW FAR THE YEAR IS FROM IT
 *
 * A budget is twelve numbers per line, written in January, and the only
 * question anybody asks of it afterwards is "where are we against it". The
 * actual has to come from the ledger, because that is what agrees with the
 * accountant's books; a budget report reading invoice totals would disagree
 * with the trial balance the first month anything was voided.
 *
 * A LINE IS A CATEGORY OR ONE ACCOUNT. The four categories are how an owner
 * thinks about the year (what came in, what the work cost in materials and in
 * people, and everything else), and each is a fixed set of accounts read from
 * the numbering of the chart:
 *
 *   revenue    every 4xxx account, net of discounts (4900 is contra revenue)
 *   materials  5000, cost of goods sold
 *   labour     every other 5xxx: direct labour and commission (5100)
 *   overhead   6xxx and above: card fees, write offs, rent, the trucks
 *
 * An account line is for the owner who budgets one thing closely, the card
 * fees or one expense account they map from their books.
 *
 * WHAT THE LEDGER DOES NOT HOLD is said where the report is read, not here:
 * this product posts revenue, fees, write offs and commission, and posts no
 * wages or materials of its own. Those arrive on the ledger by journal, so a
 * labour line is honest only for a company that journals its payroll.
 */

export const BUDGET_CATEGORIES = ["revenue", "materials", "labour", "overhead"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<BudgetCategory, string> = {
  revenue: "Revenue",
  materials: "Materials",
  labour: "Labour",
  overhead: "Overhead",
};

/** Which category an account's movement counts towards, or null for the balance sheet. */
export function categoryOf(accountCode: string): BudgetCategory | null {
  const code = accountCode.trim();
  const cls = classOf(code);
  if (cls === "revenue") return "revenue";
  if (cls !== "expense") return null;
  if (code.startsWith("5")) return code === "5000" ? "materials" : "labour";
  return "overhead";
}

export type LineKey = `category:${BudgetCategory}` | `account:${string}`;

export const ACCOUNT_CODE = /^[1-9]\d{2,9}$/;

/** A line's key from what somebody typed: a category's name or an account code. */
export function parseLine(text: string): LineKey | null {
  const value = text.trim().toLowerCase();
  const byName = BUDGET_CATEGORIES.find((c) => c === value || CATEGORY_LABEL[c].toLowerCase() === value);
  if (byName) return `category:${byName}`;
  if (value === "labor") return "category:labour";
  if (value.startsWith("category:")) {
    const rest = value.slice("category:".length);
    return (BUDGET_CATEGORIES as readonly string[]).includes(rest) ? `category:${rest as BudgetCategory}` : null;
  }
  const code = value.startsWith("account:") ? value.slice("account:".length) : value;
  return ACCOUNT_CODE.test(code) ? `account:${code}` : null;
}

export function lineLabel(key: LineKey): string {
  if (key.startsWith("category:")) return CATEGORY_LABEL[key.slice(9) as BudgetCategory];
  return `Account ${key.slice(8)}`;
}

/** Whether more is good on this line (revenue) or less is (a cost), or neither (the balance sheet). */
export function directionOf(key: LineKey): "more_is_better" | "less_is_better" | null {
  if (key.startsWith("category:")) return key === "category:revenue" ? "more_is_better" : "less_is_better";
  const cls: AccountClass = classOf(key.slice(8));
  if (cls === "revenue") return "more_is_better";
  if (cls === "expense") return "less_is_better";
  return null;
}

/** One account's two sides over a period, as the ledger sums them. */
export interface AccountSums { debit: m.Money; credit: m.Money }

/**
 * The actual for a line, signed so a positive number is "more of what the
 * line is": revenue as credits less debits, a cost as debits less credits.
 * A contra account inside a category (4900 discounts) therefore reduces it,
 * which is what a discount does to revenue.
 */
export function actualFor(key: LineKey, sums: ReadonlyMap<string, AccountSums>, currency = "USD"): m.Money {
  let total = m.zero(currency);
  const categoryWanted = key.startsWith("category:") ? key.slice(9) : null;
  for (const [code, side] of sums) {
    const counts = categoryWanted ? categoryOf(code) === categoryWanted : code === key.slice(8);
    if (!counts) continue;
    const cls = classOf(code);
    const naturalCredit = cls === "revenue" || cls === "liability" || cls === "equity";
    /**
     * Within a category the CATEGORY decides the sign, not the account: a
     * debit to 4900 is a reduction of revenue, and a credit to an expense
     * account (a refund from a supplier) is a reduction of that cost.
     */
    const creditPositive = categoryWanted ? categoryWanted === "revenue" : naturalCredit;
    total = m.add(total, creditPositive ? m.subtract(side.credit, side.debit) : m.subtract(side.debit, side.credit));
  }
  return total;
}

export interface Variance {
  /** Actual less budget. */
  variance: m.Money;
  /** Variance as a percentage of the budget, one decimal place, or null with no budget to be a share of. */
  percent: number | null;
  /** Better than planned, worse, or neither for a balance sheet line. Null on an exact hit as well. */
  favourable: boolean | null;
}

export function variance(key: LineKey, budget: m.Money, actual: m.Money): Variance {
  const diff = m.subtract(actual, budget);
  const direction = directionOf(key);
  const percent = m.isZero(budget)
    ? null
    : Math.round((Number(m.toString(diff)) / Number(m.toString(budget))) * 1000) / 10;
  let favourable: boolean | null = null;
  if (direction && !m.isZero(diff)) {
    favourable = direction === "more_is_better" ? m.isPositive(diff) : m.isNegative(diff);
  }
  return { variance: diff, percent, favourable };
}

/* ------------------------------------------------------------- the import */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

function monthOf(header: string): number | null {
  const value = header.trim().toLowerCase();
  if (/^\d{1,2}$/.test(value)) {
    const n = Number(value);
    return n >= 1 && n <= 12 ? n : null;
  }
  const index = MONTHS.findIndex((name) => value.startsWith(name));
  return index === -1 ? null : index + 1;
}

/** Split one CSV row, honouring double quotes, which is how a spreadsheet writes "1,200.00". */
function cells(row: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(current); current = ""; }
    else current += ch;
  }
  out.push(current);
  return out;
}

/** An amount as a spreadsheet exports it: "$1,200.00", "(300)", "-45.5". */
function amountOf(text: string): string | null {
  let value = text.trim().replace(/[$\s]/g, "").replace(/,/g, "");
  if (value === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  if (value.startsWith("-")) { negative = !negative; value = value.slice(1); }
  if (!/^\d+(\.\d{1,4})?$/.test(value)) return null;
  return `${negative ? "-" : ""}${value}`;
}

export interface BudgetCell { line: LineKey; month: number; amount: string }

export type ParsedBudget =
  | { ok: true; cells: BudgetCell[] }
  | { ok: false; problems: string[] };

/**
 * A budget from a spreadsheet: one row per line, one column per month.
 *
 *   Line,Jan,Feb,Mar,...,Dec
 *   Revenue,80000,85000,...
 *   Labour,30000,...
 *   6100,1200,...
 *
 * Every problem is reported at once, with its row, rather than the first
 * one, because somebody fixing a spreadsheet wants the whole list. A blank
 * cell is "no budget this month" and is left out; a cell that is not an
 * amount is a problem. Nothing is written unless the whole file reads.
 */
export function parseBudgetCsv(text: string): ParsedBudget {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length < 2) return { ok: false, problems: ["The file needs a header row and at least one line."] };

  const header = cells(rows[0]!);
  const columns: { index: number; month: number }[] = [];
  const problems: string[] = [];
  header.forEach((name, index) => {
    if (index === 0) return;
    if (/^\s*(total|year)\s*$/i.test(name)) return;
    const month = monthOf(name);
    if (month === null) problems.push(`Column ${index + 1} is headed "${name.trim()}", which is not a month.`);
    else columns.push({ index, month });
  });
  if (columns.length === 0) problems.push("No column is headed with a month (Jan to Dec, or 1 to 12).");
  if (new Set(columns.map((c) => c.month)).size !== columns.length) problems.push("A month has two columns.");

  const out: BudgetCell[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((row, i) => {
    const values = cells(row);
    const rowNumber = i + 2;
    const line = parseLine(values[0] ?? "");
    if (!line) {
      problems.push(`Row ${rowNumber}: "${(values[0] ?? "").trim()}" is not Revenue, Materials, Labour, Overhead or an account code.`);
      return;
    }
    if (seen.has(line)) {
      problems.push(`Row ${rowNumber}: ${lineLabel(line)} appears twice.`);
      return;
    }
    seen.add(line);
    for (const column of columns) {
      const raw = values[column.index] ?? "";
      if (raw.trim() === "") continue;
      const amount = amountOf(raw);
      if (amount === null) {
        problems.push(`Row ${rowNumber}, ${MONTHS[column.month - 1]}: "${raw.trim()}" is not an amount.`);
        continue;
      }
      out.push({ line, month: column.month, amount });
    }
  });

  return problems.length > 0 ? { ok: false, problems } : { ok: true, cells: out };
}
