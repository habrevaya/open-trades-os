import { reporting } from "@opentradesos/core";
import type { reports } from "@opentradesos/api/services";
import { enumText } from "@/lib/labels";

type ReportResult = reports.ReportResult;
type Row = ReportResult["rows"][number];

/**
 * A REPORT, DRAWN
 *
 * Server rendered SVG from the numbers the table under it shows, with no
 * chart library: it renders with JavaScript off, it prints, and it costs the
 * page nothing. Where the bars and points go, the scale and the gridlines are
 * all decided in `packages/core/src/reporting/chart.ts`, which is tested
 * without a browser; this file only places shapes where it is told and writes
 * the words beside them.
 *
 * Every bar and every point is a link to the records behind it, exactly as
 * every number in the table is, because a chart whose tallest bar cannot be
 * opened is a chart somebody squints at and then goes and finds the table.
 *
 * Colours are the product's own tokens and nothing else: ink for bars, the
 * one blue for a line, red for a bar below zero (a loss is the one thing on
 * a chart that has to be seen first).
 */

const WIDTH = 720;
const HEIGHT = 260;

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A group's value in words: a month as a month, a status as words, nothing as "Not set". */
export function pointLabel(column: reporting.ChartColumn, value: string | number | null): string {
  if (value === null || value === "") return "Not set";
  const text = String(value);
  if (column.type === "date") {
    if (/^\d{4}-\d{2}$/.test(text)) {
      return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${text}-01T12:00:00Z`));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
        .format(new Date(`${text}T12:00:00Z`));
    }
  }
  if (column.type === "status") return enumText(text);
  return column.sortPrefix ? text.replace(/^\d+\s+/, "") : text;
}

/** The exact value, as the table would show it. */
function exactValue(type: string, exact: string): string {
  return type === "money" ? CENTS.format(Number(exact)) : NUMBER.format(Number(exact));
}

/** An axis tick, short: $12K rather than $12,000.00. */
function tickValue(type: string, value: number): string {
  if (type === "money") return Math.abs(value) >= 10_000 ? `$${COMPACT.format(value)}` : DOLLARS.format(value);
  return Math.abs(value) >= 10_000 ? COMPACT.format(value) : NUMBER.format(value);
}

/** A label that fits its space. A name cut short beats two names drawn over each other. */
function fit(text: string, characters: number): string {
  return text.length <= characters ? text : `${text.slice(0, Math.max(1, characters - 1))}…`;
}

export function ReportChart({
  result, measure, prefer, additive, drill, title, toggle, pick,
}: {
  result: ReportResult;
  /** Which measure to draw. The first, when not said. */
  measure?: string | undefined;
  prefer?: "line" | "columns" | undefined;
  additive: reporting.Additivity;
  drill?: ((row: Row) => string) | undefined;
  title: string;
  /** Where "Line" and "Columns" go, for a dated report. */
  toggle?: ((kind: "line" | "columns") => string) | undefined;
  /** Where drawing a different measure goes, when the report counts more than one. */
  pick?: ((measure: string) => string) | undefined;
}) {
  const decision = reporting.chartFor(result, { measure, prefer, additive });
  if (!decision.ok) {
    return <p className="mt-6 text-sm text-ink-500 print:hidden">No chart for this one. {decision.reason}</p>;
  }
  const plan = decision.plan;
  const described = `${plan.measure.label} by ${plan.dimension.label.toLowerCase()}`;
  const measures = result.columns.filter((c) => c.role === "measure");

  return (
    <figure className="mt-6 rounded-md border border-steel-200 bg-canvas p-4 print:border-0 print:p-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink-700">{described}</span>
        {pick && measures.length > 1 ? (
          <span className="flex flex-wrap gap-3 text-sm print:hidden">
            <span className="text-ink-500">Draw</span>
            {measures.map((m) => (
              m.key === plan.measure.key
                ? <span key={m.key} className="font-medium text-ink-900">{m.label}</span>
                : <a key={m.key} href={pick(m.key)} className="text-ink-700 underline underline-offset-4">{m.label}</a>
            ))}
          </span>
        ) : null}
        {toggle && plan.kind !== "bars" ? (
          <span className="flex gap-3 text-sm print:hidden">
            {(["line", "columns"] as const).map((kind) => (
              kind === plan.kind
                ? <span key={kind} className="font-medium text-ink-900">{kind === "line" ? "Line" : "Columns"}</span>
                : <a key={kind} href={toggle(kind)} className="text-ink-700 underline underline-offset-4">{kind === "line" ? "Line" : "Columns"}</a>
            ))}
          </span>
        ) : null}
      </figcaption>
      {plan.kind === "bars"
        ? <Bars plan={plan} drill={drill} title={title} described={described} />
        : <Series plan={plan} drill={drill} title={title} described={described} />}
      {plan.summedOver.length > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          Added up over {plan.summedOver.map((s) => s.toLowerCase()).join(" and ")}. The table below has every row.
        </p>
      ) : null}
      {plan.omitted > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          {plan.omitted} more not drawn, so the chart stays readable. The table below has every row.
        </p>
      ) : null}
    </figure>
  );
}

type Plan = reporting.ChartPlan;

/** A link around a shape when there is somewhere to go, and the shape alone when there is not. */
function Open({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <a href={href}>{children}</a> : <>{children}</>;
}

function Bars({ plan, drill, title, described }: {
  plan: Plan; drill: ((row: Row) => string) | undefined; title: string; described: string;
}) {
  const layout = reporting.barLayout(plan, WIDTH);
  const type = plan.measure.type;
  return (
    <svg viewBox={`0 0 ${WIDTH} ${layout.height}`} className="mt-3 h-auto w-full" role="img"
         aria-label={`${title}: ${described}, as bars`}>
      <title>{`${title}: ${described}`}</title>
      <line x1={layout.zeroX} x2={layout.zeroX} y1={0} y2={layout.height - 18} className="stroke-steel-300" strokeWidth={1} />
      {layout.bars.map((bar, index) => {
        const name = pointLabel(plan.dimension, bar.point.key);
        const value = exactValue(type, bar.point.exact);
        const negative = bar.point.value < 0;
        return (
          <Open key={index} href={drill ? drill(bar.point.row) : null}>
            <g>
              <title>{`${name}: ${value}`}</title>
              <text x={150} y={bar.y + bar.height / 2 + 4} textAnchor="end" className="fill-ink-700" fontSize={12}>
                {fit(name, 22)}
              </text>
              <rect
                x={bar.x} y={bar.y} width={Math.max(bar.width, bar.point.value === 0 ? 0 : 2)} height={bar.height}
                rx={2} className={negative ? "fill-red-600" : "fill-ink-700"}
              />
              <text
                x={negative ? bar.x - 6 : bar.x + bar.width + 6} y={bar.y + bar.height / 2 + 4}
                textAnchor={negative ? "end" : "start"} className="fill-ink-900" fontSize={12}
              >
                {value}
              </text>
            </g>
          </Open>
        );
      })}
      <text x={layout.zeroX} y={layout.height - 4} textAnchor="middle" className="fill-ink-500" fontSize={11}>
        {tickValue(type, 0)}
      </text>
    </svg>
  );
}

/**
 * A dated series as a line or columns, on its own: what a report draws, and
 * what anything else with one number over time can draw by handing it a plan
 * from core's `chartFor` (a customer's readings on their account page).
 */
export function Series({ plan, drill, title, described }: {
  plan: Plan; drill: ((row: Row) => string) | undefined; title: string; described: string;
}) {
  const layout = reporting.seriesLayout(plan, WIDTH, HEIGHT);
  const type = plan.measure.type;
  const every = reporting.labelEvery(layout.points.length);
  const path = layout.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-3 h-auto w-full" role="img"
         aria-label={`${title}: ${described}, as ${plan.kind === "line" ? "a line" : "columns"}`}>
      <title>{`${title}: ${described}`}</title>
      {layout.gridlines.map((grid) => (
        <g key={grid.value}>
          <line
            x1={layout.plot.x} x2={layout.plot.x + layout.plot.width} y1={grid.y} y2={grid.y}
            className={grid.value === 0 ? "stroke-steel-300" : "stroke-steel-200"} strokeWidth={1}
          />
          <text x={layout.plot.x - 8} y={grid.y + 4} textAnchor="end" className="fill-ink-500" fontSize={11}>
            {tickValue(type, grid.value)}
          </text>
        </g>
      ))}

      {plan.kind === "line" ? (
        <path d={path} fill="none" className="stroke-blue-600" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}

      {layout.points.map((point, index) => {
        const name = pointLabel(plan.dimension, point.point.key);
        const value = exactValue(type, point.point.exact);
        const negative = point.point.value < 0;
        return (
          <Open key={index} href={drill ? drill(point.point.row) : null}>
            <g>
              <title>{`${name}: ${value}`}</title>
              {plan.kind === "columns" ? (
                <rect
                  x={point.column.x} y={point.column.y} width={point.column.width}
                  height={Math.max(point.column.height, point.point.value === 0 ? 0 : 2)}
                  rx={2} className={negative ? "fill-red-600" : "fill-ink-700"}
                />
              ) : (
                /*
                  A point bigger than it looks, so it can be hit with a finger:
                  the visible dot is small and the transparent ring around it
                  is what takes the tap.
                */
                <>
                  <circle cx={point.x} cy={point.y} r={12} fill="transparent" />
                  <circle cx={point.x} cy={point.y} r={3.5} className={negative ? "fill-red-600" : "fill-blue-600"} />
                </>
              )}
            </g>
          </Open>
        );
      })}

      {layout.points.map((point, index) => (
        printed(index, layout.points.length, every) ? (
          <text key={index} x={point.x} y={HEIGHT - 12} textAnchor="middle" className="fill-ink-500" fontSize={11}>
            {fit(pointLabel(plan.dimension, point.point.key), 10)}
          </text>
        ) : null
      ))}
    </svg>
  );
}

/**
 * Whether a date label is printed: every `every`th one, and the last one
 * unless it would sit on top of the one before it.
 */
function printed(index: number, count: number, every: number): boolean {
  if (index % every === 0) return true;
  return index === count - 1 && index % every >= every / 2;
}

/**
 * Which measures can be added up across a grouping the chart folds away, from
 * the catalogue's own word for each: a count or a sum can, an average or a
 * minimum cannot.
 */
export function additivityFor(dataset: { measures: { key: string; kind: string }[] } | undefined): reporting.Additivity {
  const kinds = new Map((dataset?.measures ?? []).map((m) => [m.key, m.kind]));
  return (key) => kinds.get(key) === "count" || kinds.get(key) === "sum";
}
