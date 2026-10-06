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
 *
 * CUT BY A SECOND GROUPING, a chart needs a colour for each value of it, and
 * colour alone is not an answer: every segment is named in its own tooltip,
 * the legend names each colour in words beside its swatch, and "View as a
 * table" is the same numbers as rows and columns. The six values that fit are
 * ink, blue, green, amber, purple, and grey for everything else.
 *
 * ONE CHART FOR EVERYTHING THAT DRAWS A REPORT: the report screens, the print
 * view, and the dashboard's tiles, which used to draw their own bars and
 * columns. A tile passes `withTable`, because it has no table of the report
 * under it the way a report screen does.
 */

const WIDTH = 720;
const HEIGHT = 260;

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The colour of each value of a second grouping, by its place in the legend.
 * Written out in full, because Tailwind finds a class by reading it, and the
 * sixth is grey: it is "everything else", and nothing more important than the
 * five named values should be drawn in a colour that stands out more.
 */
const SERIES_FILL = ["fill-ink-700", "fill-blue-600", "fill-green-700", "fill-amber-700", "fill-purple-700", "fill-steel-400"] as const;
const SERIES_STROKE = ["stroke-ink-700", "stroke-blue-600", "stroke-green-700", "stroke-amber-700", "stroke-purple-700", "stroke-steel-400"] as const;
const SERIES_SWATCH = ["bg-ink-700", "bg-blue-600", "bg-green-700", "bg-amber-700", "bg-purple-700", "bg-steel-400"] as const;

/** The colour slot of a series: the last one is for "everything else" wherever it falls. */
function slot(split: reporting.ChartSplit, index: number): number {
  return split.series[index]?.other ? SERIES_FILL.length - 1 : Math.min(index, SERIES_FILL.length - 2);
}

function seriesName(split: reporting.ChartSplit, index: number): string {
  const series = split.series[index];
  return !series || series.other ? "Everything else" : pointLabel(split.dimension, series.key);
}

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
  result, measure, prefer, split, arrange, additive, drill, title, toggle, pick, splitHref, arrangeHref, withTable, bare,
}: {
  result: ReportResult;
  /** Which measure to draw. The first, when not said. */
  measure?: string | undefined;
  prefer?: "line" | "columns" | undefined;
  /** Cut each group by this other grouping, instead of adding it up. */
  split?: string | undefined;
  arrange?: "stacked" | "grouped" | undefined;
  additive: reporting.Additivity;
  /** Where a bar, a segment or a point opens, given the row and the groupings that row pins. */
  drill?: ((row: Row, pin: string[]) => string) | undefined;
  title: string;
  /** Where "Line" and "Columns" go, for a dated report. */
  toggle?: ((kind: "line" | "columns") => string) | undefined;
  /** Where drawing a different measure goes, when the report counts more than one. */
  pick?: ((measure: string) => string) | undefined;
  /** Where cutting by another grouping goes, or null for adding it up again. */
  splitHref?: ((dimension: string | null) => string) | undefined;
  /** Where stacking and setting side by side go, for a chart that is cut. */
  arrangeHref?: ((arrangement: "stacked" | "grouped") => string) | undefined;
  /** The same numbers as a table, folded away under the chart, for a place that has no table of its own. */
  withTable?: boolean | undefined;
  /**
   * Drawn inside something that already has a border and a title (a dashboard
   * tile): no frame of its own, and its caption left to a screen reader.
   */
  bare?: boolean | undefined;
}) {
  const decision = reporting.chartFor(result, { measure, prefer, split, arrange, additive });
  if (!decision.ok) {
    return (
      <>
        <p className={`${bare ? "" : "mt-6 "}text-sm text-ink-500 print:hidden`}>No chart for this one. {decision.reason}</p>
        {splitHref && split ? (
          <p className="mt-1 text-sm print:hidden">
            <a href={splitHref(null)} className="text-ink-700 underline underline-offset-4">Add it up instead</a>
            {arrangeHref && arrange !== "grouped" ? (
              <> <span className="text-ink-500">or</span> <a href={arrangeHref("grouped")} className="text-ink-700 underline underline-offset-4">set them side by side</a></>
            ) : null}
          </p>
        ) : null}
      </>
    );
  }
  const plan = decision.plan;
  const described = `${plan.measure.label} by ${plan.dimension.label.toLowerCase()}${plan.split ? ` and ${plan.split.dimension.label.toLowerCase()}` : ""}`;
  const measures = result.columns.filter((c) => c.role === "measure");
  /** The other groupings the chart could be cut by: any the report has that is not the one drawn. */
  const cuts = result.columns.filter((c) => c.role === "dimension" && c.key !== plan.dimension.key);
  const canStack = additive(plan.measure.key);

  return (
    <figure className={bare ? "" : "mt-6 rounded-md border border-steel-200 bg-canvas p-4 print:border-0 print:p-0"}>
      <figcaption className={bare ? "sr-only" : "flex flex-wrap items-baseline justify-between gap-3"}>
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
        {toggle && plan.kind !== "bars" && !(plan.split && plan.split.arrangement === "stacked") ? (
          <span className="flex gap-3 text-sm print:hidden">
            {(["line", "columns"] as const).map((kind) => (
              kind === plan.kind
                ? <span key={kind} className="font-medium text-ink-900">{kind === "line" ? "Line" : "Columns"}</span>
                : <a key={kind} href={toggle(kind)} className="text-ink-700 underline underline-offset-4">{kind === "line" ? "Line" : "Columns"}</a>
            ))}
          </span>
        ) : null}
      </figcaption>

      {splitHref && cuts.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm print:hidden">
          <span className="text-ink-500">Break down by</span>
          {cuts.map((c) => (
            plan.split?.dimension.key === c.key
              ? <span key={c.key} className="font-medium text-ink-900">{c.label}</span>
              : <a key={c.key} href={splitHref(c.key)} className="text-ink-700 underline underline-offset-4">{c.label}</a>
          ))}
          {plan.split
            ? <a href={splitHref(null)} className="text-ink-700 underline underline-offset-4">Not broken down</a>
            : <span className="font-medium text-ink-900">Not broken down</span>}
          {plan.split && arrangeHref ? (
            <>
              <span className="text-ink-500">Shown</span>
              {canStack
                ? (plan.split.arrangement === "stacked"
                  ? <span className="font-medium text-ink-900">Stacked</span>
                  : <a href={arrangeHref("stacked")} className="text-ink-700 underline underline-offset-4">Stacked</a>)
                : null}
              {plan.split.arrangement === "grouped"
                ? <span className="font-medium text-ink-900">Side by side</span>
                : <a href={arrangeHref("grouped")} className="text-ink-700 underline underline-offset-4">Side by side</a>}
            </>
          ) : null}
        </p>
      ) : null}

      {plan.split ? <Legend split={plan.split} /> : null}

      {plan.kind === "bars"
        ? (plan.split
          ? <SplitBars plan={plan} drill={drill} title={title} described={described} />
          : <Bars plan={plan} drill={drill} title={title} described={described} />)
        : (plan.split
          ? <SplitSeries plan={plan} drill={drill} title={title} described={described} />
          : <Series plan={plan} drill={drill} title={title} described={described} />)}
      {plan.summedOver.length > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          Added up over {plan.summedOver.map((s) => s.toLowerCase()).join(" and ")}. The table below has every row.
        </p>
      ) : null}
      {plan.split && plan.split.series.some((s) => s.other) ? (
        <p className="mt-2 text-xs text-ink-500">
          Only the {plan.split.series.length - 1} biggest {plan.split.dimension.label.toLowerCase()} values are told apart.
          The rest are added together as everything else, and the table has every row.
        </p>
      ) : null}
      {plan.omitted > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          {plan.omitted} more not drawn, so the chart stays readable. {withTable ? "The report has every row." : "The table below has every row."}
        </p>
      ) : null}
      {withTable ? <ChartTable plan={plan} described={described} /> : null}
    </figure>
  );
}

/** What each colour is, in words beside it, because a colour alone says nothing to everybody. */
function Legend({ split }: { split: reporting.ChartSplit }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-700" aria-label={`${split.dimension.label}, by colour`}>
      {split.series.map((_, index) => (
        <li key={index} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${SERIES_SWATCH[slot(split, index)]}`} aria-hidden="true" />
          {fit(seriesName(split, index), 28)}
        </li>
      ))}
    </ul>
  );
}

/**
 * THE SAME NUMBERS AS A TABLE, for anybody who reads a table better than a
 * picture and for a screen that has no table of its own under the chart (a
 * dashboard tile). One row for each group; for a chart cut by a second
 * grouping, one column for each value of it and a total.
 */
function ChartTable({ plan, described }: { plan: Plan; described: string }) {
  const type = plan.measure.type;
  const split = plan.split;
  return (
    <details className="mt-3 text-sm print:hidden">
      <summary className="cursor-pointer text-ink-700 underline underline-offset-4">View as a table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm" aria-label={`${described}, as a table`}>
          <thead>
            <tr className="border-b border-steel-200 text-left text-ink-500">
              <th scope="col" className="py-1 pr-3 font-medium">{plan.dimension.label}</th>
              {split
                ? split.series.map((_, index) => (
                  <th key={index} scope="col" className="py-1 pr-3 text-right font-medium">{fit(seriesName(split, index), 20)}</th>
                ))
                : <th scope="col" className="py-1 text-right font-medium">{plan.measure.label}</th>}
              {split ? <th scope="col" className="py-1 text-right font-medium">Total</th> : null}
            </tr>
          </thead>
          <tbody>
            {plan.points.map((point, row) => (
              <tr key={row} className="border-b border-steel-200">
                <th scope="row" className="py-1 pr-3 text-left font-normal">{pointLabel(plan.dimension, point.key)}</th>
                {split
                  ? split.series.map((_, index) => {
                    const part = point.parts?.find((p) => p.series === index);
                    return (
                      <td key={index} className="py-1 pr-3 text-right font-mono tabular-nums">
                        {part ? exactValue(type, part.exact) : ""}
                      </td>
                    );
                  })
                  : null}
                <td className="py-1 text-right font-mono tabular-nums">{exactValue(type, point.exact)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

type Plan = reporting.ChartPlan;
type Drill = ((row: Row, pin: string[]) => string) | undefined;

/** A link around a shape when there is somewhere to go, and the shape alone when there is not. */
function Open({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <a href={href}>{children}</a> : <>{children}</>;
}

function Bars({ plan, drill, title, described }: {
  plan: Plan; drill: Drill; title: string; described: string;
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
          <Open key={index} href={drill ? drill(bar.point.row, [plan.dimension.key]) : null}>
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
  plan: Plan; drill: Drill; title: string; described: string;
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
          <Open key={index} href={drill ? drill(point.point.row, [plan.dimension.key]) : null}>
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

/** A part opens the records of that group and that value of the second grouping, and the rolled up "everything else" opens nothing. */
function partHref(plan: Plan, drill: Drill, part: reporting.ChartPart): string | null {
  if (!drill || !part.row || !plan.split) return null;
  return drill(part.row, [plan.dimension.key, plan.split.dimension.key]);
}

function SplitBars({ plan, drill, title, described }: { plan: Plan; drill: Drill; title: string; described: string }) {
  const split = plan.split!;
  const layout = reporting.splitBarLayout(plan, WIDTH);
  const type = plan.measure.type;
  return (
    <svg viewBox={`0 0 ${WIDTH} ${layout.height}`} className="mt-3 h-auto w-full" role="img"
         aria-label={`${title}: ${described}, as ${split.arrangement === "stacked" ? "stacked" : "side by side"} bars`}>
      <title>{`${title}: ${described}`}</title>
      <line x1={layout.zeroX} x2={layout.zeroX} y1={0} y2={layout.height - 18} className="stroke-steel-300" strokeWidth={1} />
      {layout.groups.map((group, index) => {
        const name = pointLabel(plan.dimension, group.point.key);
        return (
          <g key={index}>
            <Open href={drill ? drill(group.point.row, [plan.dimension.key]) : null}>
              <text x={150} y={group.y + group.height / 2 + 4} textAnchor="end" className="fill-ink-700" fontSize={12}>
                <title>{`${name}: ${exactValue(type, group.point.exact)}`}</title>
                {fit(name, 22)}
              </text>
            </Open>
            {group.parts.map((box, i) => (
              <Open key={i} href={partHref(plan, drill, box.part)}>
                <g>
                  <title>{`${name}, ${seriesName(split, box.part.series)}: ${exactValue(type, box.part.exact)}`}</title>
                  <rect
                    x={box.x} y={box.y} width={Math.max(box.width, box.part.value === 0 ? 0 : 2)} height={box.height}
                    className={`${SERIES_FILL[slot(split, box.part.series)]} stroke-canvas`} strokeWidth={1}
                  />
                </g>
              </Open>
            ))}
            {split.arrangement === "stacked" ? (
              <text x={group.endX + 6} y={group.y + group.height / 2 + 4} className="fill-ink-900" fontSize={12}>
                {exactValue(type, group.point.exact)}
              </text>
            ) : null}
          </g>
        );
      })}
      <text x={layout.zeroX} y={layout.height - 4} textAnchor="middle" className="fill-ink-500" fontSize={11}>
        {tickValue(type, 0)}
      </text>
    </svg>
  );
}

function SplitSeries({ plan, drill, title, described }: { plan: Plan; drill: Drill; title: string; described: string }) {
  const split = plan.split!;
  const layout = reporting.splitSeriesLayout(plan, WIDTH, HEIGHT);
  const type = plan.measure.type;
  const every = reporting.labelEvery(layout.groups.length);
  const how = plan.kind === "line" ? "as a line for each value" : split.arrangement === "stacked" ? "as stacked columns" : "as columns side by side";
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-3 h-auto w-full" role="img" aria-label={`${title}: ${described}, ${how}`}>
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

      {layout.lines.map((line) => (
        <path
          key={line.series}
          d={line.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill="none" className={SERIES_STROKE[slot(split, line.series)]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
        />
      ))}
      {layout.lines.flatMap((line) => line.points.map((p, i) => {
        const name = pointLabel(plan.dimension, p.point.key);
        return (
          <Open key={`${line.series}-${i}`} href={partHref(plan, drill, p.part)}>
            <g>
              <title>{`${name}, ${seriesName(split, line.series)}: ${exactValue(type, p.part.exact)}`}</title>
              <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={3.5} className={SERIES_FILL[slot(split, line.series)]} />
            </g>
          </Open>
        );
      }))}

      {layout.groups.flatMap((group, index) => group.parts.map((box, i) => {
        const name = pointLabel(plan.dimension, group.point.key);
        return (
          <Open key={`${index}-${i}`} href={partHref(plan, drill, box.part)}>
            <g>
              <title>{`${name}, ${seriesName(split, box.part.series)}: ${exactValue(type, box.part.exact)}`}</title>
              <rect
                x={box.x} y={box.y} width={box.width} height={Math.max(box.height, box.part.value === 0 ? 0 : 2)}
                className={`${SERIES_FILL[slot(split, box.part.series)]} stroke-canvas`} strokeWidth={1}
              />
            </g>
          </Open>
        );
      }))}

      {layout.groups.map((group, index) => (
        printed(index, layout.groups.length, every) ? (
          <text key={index} x={group.x} y={HEIGHT - 12} textAnchor="middle" className="fill-ink-500" fontSize={11}>
            {fit(pointLabel(plan.dimension, group.point.key), 10)}
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
