import type { kpis } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";

type Kpi = kpis.KpiResult;

/**
 * HOW A KPI IS SHOWN, WHICH IS AS AN ARITHMETIC
 *
 * The number is big and the two halves are under it, always. "$620" is an
 * assertion and "$186,000 over 300 jobs" is something a contractor can argue
 * with, and arguing with it is how they come to trust it. Every dashboard in
 * this category shows the first and not the second, which is why nobody
 * believes any of them.
 *
 * A null value is "not this window" rather than zero, because the service
 * reports an empty denominator as null on purpose: nought per cent close rate
 * says every estimate was lost, and no estimates presented says there is
 * nothing to measure.
 */
export function Figure({ kpi, records }: {
  kpi: Kpi;
  /**
   * Where the records behind one half open. Each half is a link, as every
   * number on a report is: the list under it adds up to the half clicked.
   */
  records?: ((half: kpis.KpiHalf) => string) | undefined;
}) {
  const open = (half: kpis.KpiHalf, children: React.ReactNode) => records
    ? <a href={records(half)} className="underline underline-offset-2 hover:text-ink-900">{children}</a>
    : children;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{kpi.label}</span>
        {kpi.target ? <span className="text-xs text-ink-500">target {kpi.target}</span> : null}
      </div>

      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {kpi.value === null ? <span className="text-base font-normal text-ink-500">Not this window</span> : show(kpi.format, kpi.value)}
      </p>

      {/*
        The halves, named by the catalogue rather than by this component, so
        the labels cannot drift from the SQL that produced them.
      */}
      {kpi.value === null ? null : (
        <p className="mt-1 text-xs text-ink-500">
          {open("numerator", <>{half(kpi.numeratorMoney, kpi.numerator)} {kpi.numeratorLabel}</>)}
          {" over "}
          {open("denominator", <>{half(kpi.denominatorMoney, kpi.denominator)} {kpi.denominatorLabel}</>)}
        </p>
      )}

      {/*
        Counted beside the number and not in it: what the definition leaves
        out, so the exclusion can be checked, and what it counts for a reason
        nobody recorded, so nobody reads a guess as a fact.
      */}
      {kpi.besides && kpi.besides.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
          {kpi.besides.map((beside) => (
            <li key={beside.key}>{open(beside.key, <>{beside.count} {beside.label.charAt(0).toLowerCase() + beside.label.slice(1)}</>)}</li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-xs text-ink-700">{kpi.definition}</p>
    </>
  );
}

/**
 * THE SELECTOR UNDER A FIGURE WHOSE RECORDS CARRY A GROUPING
 *
 * A plain GET form, so it works with JavaScript off and the choice lives in
 * the address: `kpi` names the figure and `by` the grouping. Only one figure
 * is broken down at a time, because a scorecard of eight tables is a report.
 */
export function BreakdownPicker({ kpi, from, to, chosen, months }: {
  kpi: Kpi; from: string; to: string; chosen: string | null;
  /** How many months the table shows when it is month by month, or null for the window as one. */
  months?: number | null | undefined;
}) {
  const groupings = kpi.groupings ?? [];
  if (groupings.length === 0) return null;
  return (
    <form method="get" className="mt-3 flex flex-wrap items-end gap-2 text-xs">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="kpi" value={kpi.key} />
      <label className="flex flex-col gap-1">
        <span className="text-ink-700">Break it down by</span>
        <select name="by" defaultValue={chosen ?? ""} className="h-8 rounded border border-steel-300 bg-canvas px-2 text-sm">
          <option value="">Not broken down</option>
          {groupings.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
      </label>
      {kpi.monthly ? (
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">Over time</span>
          <select name="months" defaultValue={months ? String(months) : ""} className="h-8 rounded border border-steel-300 bg-canvas px-2 text-sm">
            <option value="">The whole window as one</option>
            {SERIES_MONTHS.map((n) => <option key={n} value={n}>{`Month by month, the last ${n}`}</option>)}
          </select>
        </label>
      ) : null}
      <button type="submit" className="h-8 rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
        Show
      </button>
    </form>
  );
}

/** The lengths the month by month view offers: half a year, a year, two years. */
export const SERIES_MONTHS = [6, 12, 24] as const;

/** `2026-06` as "Jun 2026". */
const monthName = (month: string): string =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * ONE FIGURE MONTH BY MONTH, BY A GROUPING: a row for each group and a column for each month, the month's
 * figure with its two halves under it, each half a link to that group's records in that month. The last
 * row adds every group up, and the last column adds every month up. A month the window cuts short is
 * marked, because its figure is for fewer days than the rest.
 */
export function SeriesTable({ result, records }: {
  result: kpis.KpiSeries;
  /** Where one half of one group opens, for a month (its first and last day), or for every month when `month` is null. */
  records: (half: kpis.KpiHalf, group: string | null, month: kpis.KpiSeriesMonth | null) => string;
}) {
  const halfOf = (money: boolean, value: string) => (money ? <Money value={value} /> : value);
  const link = (href: string, children: React.ReactNode) =>
    <a href={href} className="underline underline-offset-2 hover:text-ink-900">{children}</a>;
  const cell = (g: kpis.KpiSeriesGroup | undefined, group: string | null, month: kpis.KpiSeriesMonth | null) => {
    if (!g) return <span className="text-ink-500">None</span>;
    return (
      <>
        <div>{g.figure === null ? <span className="text-ink-500">No figure</span> : show(result.format, g.figure)}</div>
        <div className="text-xs text-ink-500">
          {link(records("numerator", group, month), halfOf(result.numeratorMoney, g.numerator))}
          {" of "}
          {link(records("denominator", group, month), halfOf(result.denominatorMoney, g.denominator))}
        </div>
      </>
    );
  };
  if (result.groups.length === 0) {
    return <p className="mt-3 text-sm text-ink-500">Nothing in these months to show.</p>;
  }
  const label = `${result.label} by ${result.by.label.toLowerCase()}, month by month`;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm" aria-label={label}>
        <caption className="pb-1 text-left text-xs text-ink-500">
          {label}. Each figure has its two halves under it: {result.numeratorLabel}, of {result.denominatorLabel}.
        </caption>
        <thead>
          <tr className="border-b border-steel-200 text-left text-xs text-ink-500">
            <th className="py-1 pr-3 font-medium">{result.by.label}</th>
            {result.months.map((m) => (
              <th key={m.month} className="py-1 pr-3 text-right font-medium">
                {monthName(m.month)}{m.partial ? <span className="block font-normal">part of the month</span> : null}
              </th>
            ))}
            <th className="py-1 pr-3 text-right font-medium">All months</th>
          </tr>
        </thead>
        <tbody>
          {result.groups.map((group) => (
            <tr key={group.value} className="border-b border-steel-200 align-top">
              <td className="py-1 pr-3">{group.label}</td>
              {result.months.map((m) => (
                <td key={m.month} className="py-1 pr-3 text-right tabular-nums">
                  {cell(m.groups.find((g) => g.value === group.value), group.value, m)}
                </td>
              ))}
              <td className="py-1 pr-3 text-right tabular-nums">
                {cell(result.all.find((g) => g.value === group.value), group.value, null)}
              </td>
            </tr>
          ))}
          <tr className="align-top">
            <td className="py-1 pr-3 font-medium">All of them</td>
            {result.months.map((m) => (
              <td key={m.month} className="py-1 pr-3 text-right font-medium tabular-nums">
                {cell(m.total, null, m)}
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * ONE FIGURE BROKEN DOWN: each group's figure and its two halves, the halves
 * linking to that group's records as the figure's own halves do, and the
 * groups added up on the last row, which are the figure's halves.
 */
export function BreakdownTable({ result, records }: {
  result: kpis.KpiBreakdown;
  /** Where one half of one group opens. */
  records: (half: kpis.KpiHalf, group: string) => string;
}) {
  const halfOf = (money: boolean, value: string) => (money ? <Money value={value} /> : value);
  const link = (href: string, children: React.ReactNode) =>
    <a href={href} className="underline underline-offset-2 hover:text-ink-900">{children}</a>;
  if (result.groups.length === 0) {
    return <p className="mt-3 text-sm text-ink-500">Nothing in this window to break down.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm" aria-label={`${result.label} by ${result.by.label.toLowerCase()}`}>
        <thead>
          <tr className="border-b border-steel-200 text-left text-xs text-ink-500">
            <th className="py-1 pr-3 font-medium">{result.by.label}</th>
            <th className="py-1 pr-3 text-right font-medium">Figure</th>
            <th className="py-1 pr-3 text-right font-medium">{capital(result.numeratorLabel)}</th>
            <th className="py-1 pr-3 text-right font-medium">{capital(result.denominatorLabel)}</th>
            {result.besides.map((b) => (
              <th key={b.key} className="py-1 pr-3 text-right font-medium">{b.key === "excluded" ? "Left out" : "Not known"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.groups.map((group) => (
            <tr key={group.value} className="border-b border-steel-200">
              <td className="py-1 pr-3">{group.label}</td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {group.figure === null ? <span className="text-ink-500">Not this window</span> : show(result.format, group.figure)}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {link(records("numerator", group.value), halfOf(result.numeratorMoney, group.numerator))}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {link(records("denominator", group.value), halfOf(result.denominatorMoney, group.denominator))}
              </td>
              {group.besides.map((b) => (
                <td key={b.key} className="py-1 pr-3 text-right tabular-nums">{link(records(b.key, group.value), b.count)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <td className="py-1 pr-3 font-medium">All of them</td>
            <td />
            <td className="py-1 pr-3 text-right font-medium tabular-nums">{halfOf(result.numeratorMoney, result.numerator)}</td>
            <td className="py-1 pr-3 text-right font-medium tabular-nums">{halfOf(result.denominatorMoney, result.denominator)}</td>
            {result.besides.map((b) => <td key={b.key} />)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a KPI this product cannot compute shows instead, which is the one
 * missing datum rather than the words "not built".
 */
export function Needs({ kpi }: { kpi: Kpi }) {
  return (
    <>
      <p className="text-sm font-medium">{kpi.label}</p>
      <p className="mt-1 text-sm text-ink-700">{kpi.definition}</p>
      <p className="mt-2 text-sm">
        <span className="font-medium text-ink-700">Needs: </span>
        <span className="text-ink-700">{kpi.needs}</span>
      </p>
    </>
  );
}

/**
 * A percentage keeps its sign, money is money, and a duration says its unit.
 *
 * A duration is hours here because every duration a pack declares is: average
 * rental days is counted as a number of days by the fleet report, not here.
 */
function show(format: Kpi["format"], value: string): React.ReactNode {
  switch (format) {
    case "money":
      return <Money value={value} />;
    case "percent":
      return `${value}%`;
    case "duration":
      return `${value} hrs`;
    case "number":
      return value;
  }
}

/**
 * A half is money when the service says it is: the numerator of a money ratio,
 * and both halves of a percentage of two dollar figures. Anything else is a count.
 */
function half(money: boolean, value: string | null): React.ReactNode {
  if (value === null) return null;
  return money ? <Money value={value} /> : value;
}
