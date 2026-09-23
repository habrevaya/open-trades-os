import { Money } from "@opentradesos/ui";
import { formatDay } from "@/lib/dates";
import { Table, Th, Td, Empty } from "./Table";
import type { reports } from "@opentradesos/api/services";

type ReportResult = reports.ReportResult;

/**
 * WHAT A REPORT LOOKS LIKE
 *
 * One component for every report, built-in or not, because they all come back
 * in the same shape: some dimension columns, then some measure columns. A
 * report that rendered differently depending on where it came from would make
 * "save a copy of this built-in one" a visibly worse version of it.
 *
 * The bar on the first measure is the only flourish. It is a div with a
 * percentage width rather than a charting library: the thing an owner does
 * with a column of numbers is find the big one, and a bar does that at a
 * glance without adding three hundred kilobytes to the bundle.
 */

/** A month bucket comes back as `2026-09`, which nobody reads as September. */
function formatMonth(value: string): string {
  const date = new Date(`${value}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short", year: "numeric", timeZone: "UTC",
  }).format(date);
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * How wide the bar on a row is, as a percentage.
 *
 * Measured against the largest value in the column rather than against a
 * total, so two roughly equal rows draw two roughly equal bars instead of two
 * half bars.
 *
 * The floor keeps a small value visible, and zero is exempt from it. A paid
 * invoice group with nothing outstanding was drawing a two percent sliver
 * next to $0.00, which is a bar saying "a little" beside a number saying
 * "none".
 */
export function barWidth(value: number, peak: number): number {
  if (!Number.isFinite(value) || peak <= 0) return 0;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return 0;
  return Math.min(100, Math.max((magnitude / peak) * 100, 2));
}

function Cell({
  column, value, timezone,
}: {
  column: ReportResult["columns"][number];
  value: string | number | null;
  timezone: string;
}) {
  if (value === null || value === "") {
    // Not a zero and not a blank. A group with no value is a different fact
    // from a group whose value is nothing, and a reader will treat an empty
    // cell as a bug in the report.
    return <span className="text-ink-500">Not set</span>;
  }

  if (column.type === "money") return <Money value={String(value)} />;
  if (column.type === "number") {
    return <span className="font-mono tabular-nums">{NUMBER.format(Number(value))}</span>;
  }
  if (column.type === "date") {
    const text = String(value);
    return <span>{/^\d{4}-\d{2}$/.test(text) ? formatMonth(text) : formatDay(text, timezone)}</span>;
  }

  // The sort prefix is declared by the catalogue, not sniffed for here: a
  // customer called "3 Brothers Plumbing" would lose their name to a guess.
  const text = String(value);
  return <span>{column.sortPrefix ? text.replace(/^\d+\s+/, "") : text}</span>;
}

export function ReportTable({
  result, timezone,
}: { result: ReportResult; timezone: string }) {
  if (result.rows.length === 0) {
    return (
      <Empty title="Nothing matched">
        No records fell inside this report. Widen the dates, or drop a filter.
      </Empty>
    );
  }

  const dimensions = result.columns.filter((c) => c.role === "dimension");
  const measures = result.columns.filter((c) => c.role === "measure");
  const primary = measures[0];

  /**
   * The bar is drawn against the largest value in the column, not against a
   * total, so a report of two roughly equal rows still shows two roughly
   * equal bars rather than two half bars.
   */
  const peak = primary
    ? Math.max(...result.rows.map((row) => Math.abs(Number(row[primary.key] ?? 0))), 0)
    : 0;

  return (
    <>
      <Table
        head={
          <>
            {dimensions.map((c) => <Th key={c.key}>{c.label}</Th>)}
            {measures.map((c) => <Th key={c.key} className="text-right">{c.label}</Th>)}
            {primary && peak > 0 ? <Th className="w-40">{""}</Th> : null}
          </>
        }
      >
        {result.rows.map((row, index) => {
          const width = primary ? barWidth(Number(row[primary.key] ?? 0), peak) : 0;
          return (
            <tr key={index}>
              {dimensions.map((c) => (
                <Td key={c.key}>
                  <Cell column={c} value={row[c.key] ?? null} timezone={timezone} />
                </Td>
              ))}
              {measures.map((c) => (
                <Td key={c.key} className="text-right">
                  <Cell column={c} value={row[c.key] ?? null} timezone={timezone} />
                </Td>
              ))}
              {primary && peak > 0 ? (
                <Td>
                  <div className="h-2 w-full rounded-full bg-steel-100" aria-hidden="true">
                    <div className="h-2 rounded-full bg-ink-700" style={{ width: `${width}%` }} />
                  </div>
                </Td>
              ) : null}
            </tr>
          );
        })}
      </Table>

      {result.truncated ? (
        /*
          Said out loud. A report cut off without saying so is the worst
          failure this screen has: somebody totals the visible rows and acts
          on a number that is missing the rest.
        */
        <p className="mt-3 text-sm text-red-600">
          This is the first {result.rows.length} rows. There are more. Narrow the
          dates or add a filter to see the whole answer.
        </p>
      ) : null}
    </>
  );
}
