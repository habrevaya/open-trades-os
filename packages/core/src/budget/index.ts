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
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((row) => row.trim() !== "");
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

/* ------------------------------------------------------------ the forecast */

/**
 * WHERE THE YEAR IS HEADING, FROM THE YEAR SO FAR
 *
 * A year end figure per line: what the months already over actually came to,
 * plus an assumption for the months still to come. It is an estimate and the
 * report says so beside it; nothing here is a promise about the rest of the
 * year, and nothing is posted.
 *
 * THE MONTHS ALREADY OVER are the closed ones: every month before the one the
 * company is in. The month in progress is not read at its actual so far,
 * because ten days of October are not October, and counting them as the month
 * would make every forecast read worst on the first of the month. It is a
 * month still to come, taken like the rest.
 *
 * THE MONTHS TO COME are taken one of three ways, or a blend of them, and
 * the company chooses:
 *
 *   budget     each month at its own budget. The default, because it is the
 *              figure the company already wrote down for that month, and a
 *              month with no budget counts as nothing rather than as a guess.
 *   run_rate   each month at the average of the closed months. Better for a
 *              company whose budget has stopped describing the year, and wrong
 *              for a seasonal one, which the screen says.
 *   seasonal   shaped like last year: the closed months are the share of the
 *              year they were last year, so the year is what they came to
 *              over that share, and the months to come are the rest. A
 *              company that does a third of its year by May, as it did last
 *              year, is forecast to do three times May's year to date.
 *              The shape can be the average of several past years (their
 *              months added together), so one odd month in one year counts
 *              for less.
 *   blend      the three above, weighted by whole percentages the company
 *              sets that add up to 100.
 *
 * MONTH BY MONTH as well as for the year: each month to come is given its
 * part of the months to come (its budget, an even part of the run rate, its
 * share of last year's shape, or the weighted mix of those), to the cent, so
 * the months add up to the year end figure. Shown, never stored as the budget.
 *
 * With no month closed yet (January, or a year not begun) there is no run
 * rate and nothing to scale last year by, so the budget is used and the
 * result says it fell back. A seasonal line whose last year came to nothing,
 * or whose closed months came to nothing or less of it, has no shape to
 * follow, and is taken at its budget the same way (`fellBack`). Choosing it at
 * all needs a whole year in the books, which the service checks.
 */
export const FORECAST_METHODS = ["budget", "run_rate", "seasonal", "blend"] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export const FORECAST_LABEL: Record<ForecastMethod, string> = {
  budget: "The months to come at their budget",
  run_rate: "The months to come at the run rate so far",
  seasonal: "The months to come shaped like last year",
  blend: "The months to come as a blend of the three",
};

/**
 * A BLEND OF THE THREE, BY WEIGHTS THE OWNER SETS.
 *
 * Whole percentages of the budget, the run rate and the seasonal shape, adding
 * up to 100. Each of the three is worked out exactly as it would be on its own,
 * falling back to the budget where it would on its own (no month over yet, no
 * shape last year), and the months to come are the weighted sum. A blend of 50
 * budget and 50 run rate is the point halfway between the two forecasts.
 */
export interface ForecastWeights {
  budget: number;
  runRate: number;
  seasonal: number;
}

export type WeightsCheck = { ok: true; weights: ForecastWeights } | { ok: false; field: string; reason: string };

/** Whether a blend can be saved: three whole percentages, none negative, adding up to 100. */
export function checkWeights(input: { budget?: unknown; runRate?: unknown; seasonal?: unknown }): WeightsCheck {
  const read = (value: unknown): number | null => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (text === "") return 0;
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
  };
  const fields: [keyof ForecastWeights, unknown][] = [["budget", input.budget], ["runRate", input.runRate], ["seasonal", input.seasonal]];
  const weights: ForecastWeights = { budget: 0, runRate: 0, seasonal: 0 };
  for (const [field, value] of fields) {
    const n = read(value);
    if (n === null || n > 100) return { ok: false, field, reason: "Each part of a blend is a whole percentage from 0 to 100." };
    weights[field] = n;
  }
  const total = weights.budget + weights.runRate + weights.seasonal;
  if (total !== 100) return { ok: false, field: "budget", reason: `The three parts of a blend add up to 100, and these add up to ${total}.` };
  return { ok: true, weights };
}

/** The most past years a seasonal shape can be averaged over. */
export const MAX_SEASONAL_YEARS = 5;

/**
 * THE MONTHS TO COME, MONTH BY MONTH, adding up to `total` to the cent: in
 * proportion to `weights` when none is negative and they are not all
 * nothing, otherwise evenly. The run rate is even; a seasonal shape is
 * last year's months; a blend is the weighted months of its parts.
 */
function spread(total: m.Money, weights: readonly m.Money[]): m.Money[] {
  if (weights.length === 0) return [];
  const usable = weights.every((w) => w.amount >= 0n) && weights.some((w) => w.amount > 0n);
  return usable ? m.allocate(total, weights.map((w) => m.toString(w)), 2) : m.split(total, weights.length, 2);
}

/**
 * What the months to come of one line come to when they are shaped like last
 * year, or null when last year gives no shape: the closed months' actual
 * times the rest of last year over the closed months of last year, worked in
 * whole hundredths of a cent and rounded once, half up.
 */
export function seasonalToCome(closedActual: m.Money, lastYear: readonly m.Money[], closed: number): m.Money | null {
  const total = lastYear.reduce((sum, month) => sum + month.amount, 0n);
  const before = lastYear.slice(0, closed).reduce((sum, month) => sum + month.amount, 0n);
  /** Nothing last year, or nothing or less by this point: no share to scale by, and a sign that flips is no shape. */
  if (total === 0n || before === 0n || (total > 0n) !== (before > 0n)) return null;
  const rest = total - before;
  const numerator = closedActual.amount * rest;
  const negative = (numerator < 0n) !== (before < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = before < 0n ? -before : before;
  let units = absNum / absDen;
  if ((absNum % absDen) * 2n >= absDen) units += 1n;
  return m.round({ amount: negative ? -units : units, currency: closedActual.currency });
}

/**
 * How many months of a year are over on a day in the company's calendar: none
 * for a year not yet begun, twelve for one that has ended, and otherwise the
 * months before the current one.
 */
export function closedMonths(year: number, today: string): number {
  const [thisYear, thisMonth] = today.split("-").map(Number) as [number, number];
  if (year < thisYear) return 12;
  if (year > thisYear) return 0;
  return thisMonth - 1;
}

export interface Forecast {
  /** The year end figure: closed months at their actual plus the months to come. */
  forecast: m.Money;
  /** What the closed months came to. */
  closedActual: m.Money;
  /** What the months to come are taken at. */
  toCome: m.Money;
  /**
   * The year month by month, January to December: a closed month at its
   * actual, a month to come at what the method takes it at. They add up to
   * `forecast` to the cent.
   */
  months: m.Money[];
  closed: number;
  /** The way the months to come were taken: the one asked for, or the budget when there was no run rate or no shape yet. */
  method: ForecastMethod;
  /** For a blend, true when a part it gives any weight to fell back to the budget. */
  fellBack: boolean;
  /** Months to come with no budget, counted as nothing. Only when they were taken at the budget (or a blend gives the budget weight). */
  unbudgetedMonths: number;
  /** For a blend, what each of the three would make the months to come on its own. */
  parts?: { budget: m.Money; runRate: m.Money; seasonal: m.Money };
  /**
   * The seasonal shape was asked for (on its own, or weighed in a blend), some
   * months are over and some to come, and the past year gave this line none,
   * so that part is at its budget.
   */
  noShape: boolean;
  /** The forecast against the whole year's budget, signed and judged as a variance is. */
  yearBudget: m.Money;
  variance: Variance;
}

/** The months to come by one of the three single methods, with its fallback. */
function toComeBy(
  method: "budget" | "run_rate" | "seasonal",
  remaining: readonly { month: number; budget: m.Money | null }[],
  closedActual: m.Money, closed: number, lastYear: readonly m.Money[] | undefined, currency: string,
): {
  method: "budget" | "run_rate" | "seasonal"; fellBack: boolean; total: m.Money; months: m.Money[]; unbudgeted: number;
  /** Seasonal, with months over and to come, and last year gave no shape. */
  noShape: boolean;
} {
  const shaped = method === "seasonal" && closed > 0 && closed < 12 && lastYear?.length === 12
    ? seasonalToCome(closedActual, lastYear, closed)
    : null;
  const fellBack = (method === "run_rate" && closed === 0) || (method === "seasonal" && closed < 12 && shaped === null);
  const used = fellBack ? "budget" : method;
  const noShape = method === "seasonal" && closed > 0 && closed < 12 && shaped === null;
  if (used === "seasonal") {
    const total = m.round(shaped ?? m.zero(currency));
    return {
      method: used, fellBack, total, months: spread(total, remaining.map((r) => lastYear![r.month - 1]!)), unbudgeted: 0, noShape,
    };
  }
  if (used === "run_rate") {
    /** Multiplied before it is divided, so the average is not rounded on its way in. */
    const total = m.round(m.divide(m.multiply(closedActual, String(remaining.length)), String(closed)));
    return { method: used, fellBack, total, months: spread(total, remaining.map(() => m.money("1", currency))), unbudgeted: 0, noShape };
  }
  let total = m.zero(currency);
  let unbudgeted = 0;
  const months = remaining.map((r) => {
    if (r.budget) total = m.add(total, r.budget);
    else unbudgeted += 1;
    return m.round(r.budget ?? m.zero(currency));
  });
  return { method: used, fellBack, total: m.round(total), months, unbudgeted, noShape };
}

/**
 * The year end forecast for one line. `months` is January to December with
 * each month's budget (null for none) and its actual from the ledger.
 */
export function forecastLine(input: {
  key: LineKey;
  months: readonly { month: number; budget: m.Money | null; actual: m.Money }[];
  closed: number;
  method: ForecastMethod;
  /**
   * The past year's actual (or several past years' added together, month by
   * month), January to December, for `seasonal` and a blend that weighs it.
   * Without it a seasonal line falls back to its budget.
   */
  lastYear?: readonly m.Money[] | undefined;
  /** For `blend`: the weights. Left out, a blend is all budget. */
  weights?: ForecastWeights | undefined;
  currency?: string;
}): Forecast {
  const currency = input.currency ?? "USD";
  const closed = Math.max(0, Math.min(12, Math.trunc(input.closed)));
  let closedActual = m.zero(currency);
  let yearBudget = m.zero(currency);
  for (const month of input.months) {
    if (month.budget) yearBudget = m.add(yearBudget, month.budget);
    if (month.month <= closed) closedActual = m.add(closedActual, month.actual);
  }
  const remaining = input.months.filter((month) => month.month > closed);
  const by = (method: "budget" | "run_rate" | "seasonal") =>
    toComeBy(method, remaining, closedActual, closed, input.lastYear, currency);

  let method: ForecastMethod;
  let fellBack: boolean;
  let toCome: m.Money;
  let toComeMonths: m.Money[];
  let unbudgetedMonths: number;
  let parts: Forecast["parts"];
  let noShape: boolean;
  if (input.method === "blend") {
    const weights = input.weights ?? { budget: 100, runRate: 0, seasonal: 0 };
    const budget = by("budget");
    const runRate = by("run_rate");
    const seasonal = by("seasonal");
    const weighed: [number, ReturnType<typeof by>][] = [[weights.budget, budget], [weights.runRate, runRate], [weights.seasonal, seasonal]];
    const mix = (pick: (part: ReturnType<typeof by>) => m.Money) => weighed.reduce(
      (sum, [w, part]) => (w === 0 ? sum : m.add(sum, m.multiply(pick(part), String(w / 100)))), m.zero(currency));
    toCome = m.round(mix((part) => part.total));
    toComeMonths = spread(toCome, remaining.map((_, i) => mix((part) => part.months[i] ?? m.zero(currency))));
    method = "blend";
    fellBack = weighed.some(([w, part]) => w > 0 && part.fellBack);
    unbudgetedMonths = weighed.some(([w, part]) => w > 0 && part.method === "budget") ? budget.unbudgeted : 0;
    parts = { budget: budget.total, runRate: runRate.total, seasonal: seasonal.total };
    noShape = weights.seasonal > 0 && seasonal.noShape;
  } else {
    const single = by(input.method);
    method = single.method;
    fellBack = single.fellBack;
    toCome = single.total;
    toComeMonths = single.months;
    unbudgetedMonths = single.method === "budget" ? single.unbudgeted : 0;
    noShape = single.noShape;
  }

  const months = input.months.map((month) => (month.month <= closed
    ? month.actual
    : toComeMonths[remaining.findIndex((r) => r.month === month.month)] ?? m.zero(currency)));
  const forecast = m.add(closedActual, toCome);
  return {
    forecast, closedActual, toCome, months, closed, method, fellBack, unbudgetedMonths, noShape,
    ...(parts ? { parts } : {}),
    yearBudget, variance: variance(input.key, yearBudget, forecast),
  };
}
