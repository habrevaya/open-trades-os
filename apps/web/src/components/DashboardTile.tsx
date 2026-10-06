import { Money } from "@opentradesos/ui";
import type { dashboards } from "@opentradesos/api/services";
import { ReportChart } from "@/components/ReportChart";
import { drillHref } from "@/lib/drill";

type TileResult = dashboards.TileResult;

/**
 * A TILE
 *
 * One number, or a chart. A dashboard tile is read at a glance from across a
 * desk, so the number is large and a chart is the report chart: the same
 * component the report screens and the print view draw with, so a tile and the
 * report it came from cannot disagree about which bar is longest, and a tile
 * has the chart's accessibility for free: every bar and column is named in its
 * tooltip, opens the records behind it, and the whole chart can be read as a
 * table ("View as a table"), which a tile needs because it has no table of the
 * report under it.
 *
 * Server rendered, so the dashboard renders with no JavaScript at all, which
 * matters more than it sounds like: this is the screen most likely to be open
 * on a wall-mounted tablet in a back office.
 */

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

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

/** Where one row of a tile opens, or nothing when the tile carries no report. */
type Drill = ((row: Row, pin: string[]) => string) | null;
type Row = NonNullable<TileResult["result"]>["rows"][number];

export function DashboardTile({ tile, back }: {
  tile: TileResult;
  /**
   * The dashboard this tile is on, which the records behind a number link
   * back to. A tile is a report, so every number on it opens the records that
   * make it, the same as on the reports screen.
   */
  back: string;
}) {
  const drill: Drill = tile.definition
    ? (row, pin) => drillHref(tile.definition!, row, { title: tile.title, back }, pin)
    : null;
  return (
    <section className="h-full rounded-lg border border-steel-200 bg-canvas p-4">
      <h2 className="text-sm font-medium text-ink-700">{tile.title}</h2>
      {tile.caption && <p className="mt-0.5 text-xs text-ink-500">{tile.caption}</p>}
      <div className="mt-3">
        <Body tile={tile} drill={drill} />
      </div>
    </section>
  );
}

/**
 * A link when there is somewhere to go, and the plain content when there is
 * not. Named by what it shows and described by what it opens, the same as a
 * number on a report.
 */
function Open({ href, label, className, children }: {
  href: string | null; label: string; className?: string; children: React.ReactNode;
}) {
  if (!href) return <>{children}</>;
  return <a href={href} title={label} className={className ?? "hover:underline"}>{children}</a>;
}

function Body({ tile, drill }: { tile: TileResult; drill: Drill }) {
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
        <Open href={drill ? drill(rows[0] ?? {}, []) : null} label={`Open the records behind ${tile.title}`}>
          <Value type={measure.type} value={value} />
        </Open>
      </p>
    );
  }

  if (rows.length === 0) return <Nothing />;

  /**
   * The tile's one grouping, drawn by the report chart. Columns for a date,
   * because a month is a bucket and a line between two of them implies values
   * between that do not exist; nothing here has a second grouping to add up.
   */
  return (
    <ReportChart
      result={{
        ...tile.result!,
        /**
         * The columns the tile resolved, which are the ones it was drawn from:
         * its one grouping and its one measure, with the label and the sort
         * prefix the catalogue gave them.
         */
        columns: [
          ...(tile.dimension ? [{ ...tile.dimension, role: "dimension" as const }] : []),
          { key: measure.key, label: measure.label, type: measure.type, role: "measure" as const },
        ],
      }}
      measure={measure.key}
      prefer="columns"
      additive={() => false}
      drill={drill ?? undefined}
      title={tile.title}
      withTable
      bare
    />
  );
}

function Nothing() {
  return <p className="py-2 text-sm text-ink-500">Nothing to show yet.</p>;
}
