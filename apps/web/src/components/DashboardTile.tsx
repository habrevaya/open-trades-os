import { Money } from "@opentradesos/ui";
import { dashboard } from "@opentradesos/core";
import type { dashboards } from "@opentradesos/api/services";
import { enumText } from "@/lib/labels";

type TileResult = dashboards.TileResult;

/**
 * A TILE
 *
 * Three shapes and no chart library. A dashboard tile is read at a glance
 * from across a desk, and at that size an axis, a legend and a tooltip are
 * all things nobody looks at: what is being communicated is one number, or
 * which bar is longest, or which way the line is going.
 *
 * So: divs with widths and heights, drawn from numbers the server already
 * aggregated. It also means the dashboard renders with no JavaScript at all,
 * which matters more than it sounds like: this is the screen most likely to
 * be open on a wall-mounted tablet in a back office.
 */

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** A month bucket comes back as `2026-09`, which nobody reads as September. */
function monthLabel(value: string): string {
  const date = new Date(`${value}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
}

function label(tile: TileResult, raw: string | number | null): string {
  if (raw === null || raw === "") return "Not set";
  const text = String(raw);
  if (/^\d{4}-\d{2}$/.test(text)) return monthLabel(text);
  // An enum column, made readable. `in_progress` on a tile an owner reads is
  // the database leaking onto their screen.
  if (tile.dimension?.type === "status") return enumText(text);
  // The sort prefix is declared by the catalogue rather than sniffed for
  // here, so a customer called "3 Brothers Plumbing" keeps their name.
  return tile.dimension?.sortPrefix ? text.replace(/^\d+\s+/, "") : text;
}

function Value({ type, value }: { type: string; value: string | number | null }) {
  if (value === null) return <span className="text-ink-500">None</span>;
  if (type === "money") return <Money value={String(value)} />;
  return <span className="font-mono tabular-nums">{NUMBER.format(Number(value))}</span>;
}

/**
 * How many of the twelve columns a tile takes.
 *
 * Exported, because the saved dashboard wraps each tile in a column of its
 * own to hang the reorder controls underneath it, and two copies of this map
 * is how the two dashboards end up laid out differently.
 */
export function tileSpan(width: number): string {
  return ({ 3: "lg:col-span-3", 6: "lg:col-span-6", 12: "lg:col-span-12" } as Record<number, string>)[width]
    ?? "lg:col-span-6";
}

export function DashboardTile({ tile }: { tile: TileResult }) {
  return (
    <section className="h-full rounded-lg border border-steel-200 bg-canvas p-4">
      <h2 className="text-sm font-medium text-ink-700">{tile.title}</h2>
      {tile.caption && <p className="mt-0.5 text-xs text-ink-500">{tile.caption}</p>}
      <div className="mt-3">
        <Body tile={tile} />
      </div>
    </section>
  );
}

function Body({ tile }: { tile: TileResult }) {
  if (tile.problem) {
    /**
     * A broken tile says so in its own place rather than disappearing. It
     * names a field that no longer exists, or draws a trend over a customer
     * name, and a dashboard quietly missing the tile somebody built it for
     * is worse than one with a visible fault on it.
     */
    return (
      <p className="rounded border border-red-600 bg-red-tint px-3 py-2 text-sm text-red-600">
        {tile.problem}
      </p>
    );
  }

  const rows = tile.result?.rows ?? [];
  const measure = tile.measure;
  if (!measure) return <Nothing />;

  if (tile.kind === "number") {
    /**
     * No rows and a count of zero are the same answer here, and only here.
     * A grouped report with no rows means "nothing matched"; an ungrouped
     * one means the number is nought, which is a number worth showing.
     */
    const value = rows[0]?.[measure.key] ?? (measure.type === "money" ? "0" : 0);
    return (
      <p className="text-3xl font-semibold tracking-[-0.02em]">
        <Value type={measure.type} value={value} />
      </p>
    );
  }

  if (rows.length === 0) return <Nothing />;

  const values = rows.map((row) => Math.abs(Number(row[measure.key] ?? 0)));
  const peak = Math.max(...values, 0);

  if (tile.kind === "trend") return <Trend tile={tile} peak={peak} />;
  return <Bars tile={tile} peak={peak} />;
}

function Nothing() {
  return <p className="py-2 text-sm text-ink-500">Nothing to show yet.</p>;
}

function Bars({ tile, peak }: { tile: TileResult; peak: number }) {
  const measure = tile.measure!;
  return (
    <ul className="space-y-2">
      {(tile.result?.rows ?? []).map((row, index) => {
        const value = Number(row[measure.key] ?? 0);
        const width = dashboard.proportion(Math.abs(value), peak) * 100;
        return (
          <li key={index}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-ink-700">
                {label(tile, row[tile.dimension?.key ?? ""] ?? null)}
              </span>
              <span className="shrink-0 text-ink-900">
                <Value type={measure.type} value={row[measure.key] ?? null} />
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-steel-100" aria-hidden="true">
              <div className="h-1.5 rounded-full bg-ink-700" style={{ width: `${width}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Trend({ tile, peak }: { tile: TileResult; peak: number }) {
  const measure = tile.measure!;
  const rows = tile.result?.rows ?? [];
  return (
    <>
      {/*
        Columns rather than a line. A line between twelve points implies the
        values in between exist, and a month is a bucket rather than a
        sample: nothing happened "between March and April".
      */}
      {/*
        `justify-start` with a width cap per column, so a chart with two
        buckets in it is two columns rather than two slabs. `flex-1` alone
        makes every column half the tile the month the company started.
      */}
      <div className="flex h-28 items-end justify-start gap-1" role="img"
           aria-label={`${measure.label} by ${tile.dimension?.label ?? "period"}`}>
        {rows.map((row, index) => {
          const value = Number(row[measure.key] ?? 0);
          const height = dashboard.proportion(Math.abs(value), peak) * 100;
          return (
            /*
              The column IS the flex item, with no wrapper around it. A
              wrapper looks harmless and is not: under `items-end` the
              wrapper is sized to its content rather than stretched, so the
              percentage height inside it resolves against nothing and every
              column renders at zero. The chart drew its month labels and no
              bars at all, which looks like a query returning no data.
            */
            <div
              key={index}
              className="min-w-0 max-w-14 flex-1 rounded-t bg-ink-700"
              /*
                A floor of two pixels, so a small month is a short column
                rather than nothing. Zero keeps nothing at all, because
                "none" and "a little" are different answers.
              */
              style={{ height: height === 0 ? "0" : `max(2px, ${height}%)` }}
              title={`${label(tile, row[tile.dimension?.key ?? ""] ?? null)}: ${
                measure.type === "money" ? `$${COMPACT.format(value)}` : NUMBER.format(value)
              }`}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-start gap-1 text-[11px] text-ink-500">
        {rows.map((row, index) => (
          <span key={index} className="min-w-0 max-w-14 flex-1 truncate text-center">
            {/*
              Every label, and let them truncate. Showing only the first and
              last is tidier and makes the middle of the chart unreadable,
              which is where somebody points and asks "what month is that".
            */}
            {label(tile, row[tile.dimension?.key ?? ""] ?? null)}
          </span>
        ))}
      </div>
    </>
  );
}
