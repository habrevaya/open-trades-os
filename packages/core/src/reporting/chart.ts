import { money, toString as moneyString, add as moneyAdd, zero as moneyZero } from "../money/index.js";

/**
 * A REPORT AS A PICTURE
 *
 * A table answers "what is the number". A chart answers "which is biggest"
 * and "which way is it going", and those are the two things an owner reads a
 * report for more often than the number itself. Every report that has one
 * date or category column can be drawn, and this decides how, from the same
 * columns and rows the table shows: there is no second query, so the picture
 * cannot disagree with the table under it.
 *
 * TWO SHAPES, AND THE DATA PICKS. A report grouped by a date is drawn as a
 * line, oldest on the left, because what it is for is direction. A report
 * grouped by anything else is drawn as bars, in the report's own order
 * (biggest first, or the aging buckets in age order), because what it is for
 * is comparison. A person can ask for columns instead of the line; nothing
 * draws a category as a line, because a line between "Austin" and "Houston"
 * implies a Houston-ward trend that does not exist.
 *
 * Server rendered SVG, drawn from the numbers here, with no chart library:
 * it prints, it works with JavaScript off, and it adds nothing to the page
 * weight. So this file does the arithmetic (the scale, the ticks, where each
 * bar and point lands) and is tested without a browser, and the component
 * that draws it only places shapes where it is told.
 */

export interface ChartColumn {
  key: string;
  label: string;
  type: string;
  role: "dimension" | "measure";
  sortPrefix?: boolean;
}

export type ChartRow = Record<string, string | number | null>;

export type ChartKind = "line" | "columns" | "bars";

export interface ChartPoint {
  /** The group's value as the report returned it, for the label and the drill. */
  key: string | number | null;
  /** The row the point came from, or the first of the rows it sums. */
  row: ChartRow;
  /** Exact, as the report returned it (or summed it), for the label. */
  exact: string;
  /** For drawing only. A pixel is not money. */
  value: number;
}

export interface ChartPlan {
  kind: ChartKind;
  dimension: ChartColumn;
  measure: ChartColumn;
  points: ChartPoint[];
  /** Groups not drawn because there were too many to read. */
  omitted: number;
  /**
   * The rows were grouped by more than this one column and have been added
   * up over the others. Said under the chart, because a bar per technician
   * summed over statuses is a different picture from the table's rows.
   */
  summedOver: string[];
  scale: Scale;
}

export type ChartRefusal = { ok: false; reason: string };

/**
 * More bars than this and nobody reads them; the table under the chart still
 * has every row, and the chart says how many it left out.
 */
export const MAX_BARS = 25;
/** A year of days is still a readable line; ten years of days is not. */
export const MAX_POINTS = 400;

/**
 * Whether one measure can be added up over a dimension that is being folded
 * away. A count or a sum can; an average or a minimum cannot, because the
 * average of two averages is not the average of the rows.
 */
export type Additivity = (measureKey: string) => boolean;

/**
 * How to draw this report, or why it cannot be drawn.
 *
 * `measure` picks which number to draw when the report counts several, and
 * defaults to the first, which is the one the table's bars already use.
 * `dimension` picks which grouping, and defaults to the first date column,
 * else the first column.
 */
export function chartFor(
  result: { columns: readonly ChartColumn[]; rows: readonly ChartRow[] },
  options: {
    measure?: string | undefined;
    dimension?: string | undefined;
    prefer?: "line" | "columns" | undefined;
    additive?: Additivity | undefined;
  } = {},
): { ok: true; plan: ChartPlan } | ChartRefusal {
  const dimensions = result.columns.filter((c) => c.role === "dimension");
  const measures = result.columns.filter((c) => c.role === "measure");

  if (dimensions.length === 0) {
    return { ok: false, reason: "This report is one total rather than a list of groups, so there is nothing to compare in a chart." };
  }
  const measure = measures.find((m) => m.key === options.measure) ?? measures[0];
  if (!measure) return { ok: false, reason: "This report has no number to draw." };

  const dimension = dimensions.find((d) => d.key === options.dimension)
    ?? dimensions.find((d) => d.type === "date")
    ?? dimensions[0]!;
  const others = dimensions.filter((d) => d.key !== dimension.key);

  if (others.length > 0 && !(options.additive?.(measure.key) ?? false)) {
    return {
      ok: false,
      reason: `This report is grouped by ${dimensions.map((d) => d.label.toLowerCase()).join(" and ")}, and ${measure.label.toLowerCase()} cannot be added up across ${others.map((d) => d.label.toLowerCase()).join(" and ")} without changing what it means. Group it by one thing to chart it.`,
    };
  }

  const points = fold(result.rows, dimension.key, measure);
  if (points.length === 0) return { ok: false, reason: "Nothing matched, so there is nothing to draw." };

  const dated = dimension.type === "date";
  const kind: ChartKind = dated ? (options.prefer === "columns" ? "columns" : "line") : "bars";
  const cap = kind === "bars" ? MAX_BARS : MAX_POINTS;
  /**
   * A dated report keeps its NEWEST points when it has too many, because the
   * report is already oldest first and the recent end is the one being
   * watched. A ranked report keeps its first, which are its biggest.
   */
  const kept = points.length > cap
    ? (dated ? points.slice(points.length - cap) : points.slice(0, cap))
    : points;

  return {
    ok: true,
    plan: {
      kind,
      dimension,
      measure,
      points: kept,
      omitted: points.length - kept.length,
      summedOver: others.map((d) => d.label),
      scale: niceScale(Math.min(0, ...kept.map((p) => p.value)), Math.max(0, ...kept.map((p) => p.value))),
    },
  };
}

/**
 * One point per value of the dimension, in the order the report returned
 * them, adding up rows that share a value when the report was grouped by
 * more than this. Money is added as money; only the drawn value is a float.
 */
function fold(rows: readonly ChartRow[], key: string, measure: ChartColumn): ChartPoint[] {
  const groups = new Map<string, { key: string | number | null; row: ChartRow; values: (string | number | null)[] }>();
  for (const row of rows) {
    const value = row[key] ?? null;
    const id = value === null ? "\u0000" : `${typeof value}:${String(value)}`;
    const group = groups.get(id);
    if (group) group.values.push(row[measure.key] ?? null);
    else {
      groups.set(id, { key: value, row, values: [row[measure.key] ?? null] });
    }
  }
  return [...groups.values()].map((group) => {
    const exact = total(group.values, measure.type);
    return { key: group.key, row: group.row, exact, value: Number(exact) };
  });
}

function total(values: readonly (string | number | null)[], type: string): string {
  if (type === "money") {
    let sum = moneyZero();
    for (const value of values) {
      if (value === null || value === "") continue;
      sum = moneyAdd(sum, money(String(value)));
    }
    return moneyString(sum);
  }
  let sum = 0;
  for (const value of values) sum += Number(value ?? 0);
  return String(sum);
}

/* ------------------------------------------------------------- the scale */

export interface Scale {
  min: number;
  max: number;
  /** Gridline values from min to max, inclusive, always including zero. */
  ticks: number[];
}

/**
 * A scale whose gridlines land on round numbers: 0, 250, 500 rather than 0,
 * 237, 474. Always includes zero, because a bar chart whose axis starts at
 * 400 makes a 410 look twice the size of a 405, and that is the commonest lie
 * a chart tells. A scale over nothing (every value zero) is 0 to 1, so the
 * chart still draws a baseline rather than dividing by zero.
 */
export function niceScale(low: number, high: number, targetTicks = 5): Scale {
  const min = Math.min(0, Number.isFinite(low) ? low : 0);
  const max = Math.max(0, Number.isFinite(high) ? high : 0);
  if (min === 0 && max === 0) return { min: 0, max: 1, ticks: [0, 1] };

  const step = niceStep((max - min) / Math.max(1, targetTicks));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Rounded to the step's own precision, so 0.1 + 0.2 does not label a gridline 0.30000000000000004.
  const places = Math.max(0, -Math.floor(Math.log10(step)));
  for (let value = lo; value <= hi + step / 2; value += step) {
    ticks.push(Number(value.toFixed(places)));
  }
  return { min: lo, max: hi, ticks };
}

/** 1, 2, 2.5 or 5 times a power of ten, the steps a person counts in. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Where a value lands between 0 (the scale's min) and 1 (its max). */
export function position(value: number, scale: Scale): number {
  const span = scale.max - scale.min;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - scale.min) / span));
}

/* ------------------------------------------------------------ the layout */

export interface Box { x: number; y: number; width: number; height: number }

/**
 * Horizontal bars, one row per group, the label to the left and the value at
 * the end. Bars grow from zero, so a negative margin goes left of the axis
 * rather than being drawn as a short positive one.
 */
export function barLayout(plan: ChartPlan, width: number, row = 28, labelWidth = 160): {
  height: number; zeroX: number; bars: (Box & { point: ChartPoint })[];
} {
  const plot = Math.max(1, width - labelWidth - 90);
  const zeroX = labelWidth + position(0, plan.scale) * plot;
  const bars = plan.points.map((point, index) => {
    const x = labelWidth + position(point.value, plan.scale) * plot;
    return {
      point,
      x: Math.min(x, zeroX),
      y: index * row + 6,
      width: Math.abs(x - zeroX),
      height: row - 12,
    };
  });
  return { height: plan.points.length * row + 24, zeroX, bars };
}

/**
 * A line, or columns, over time: x by position in the series (each bucket is
 * one step, whatever its date), y by value against the scale. The plot area
 * leaves room on the left for the axis labels and underneath for the dates.
 */
export function seriesLayout(plan: ChartPlan, width: number, height: number, inset = { left: 64, right: 16, top: 12, bottom: 36 }): {
  plot: Box;
  zeroY: number;
  points: { x: number; y: number; column: Box; point: ChartPoint }[];
  gridlines: { y: number; value: number }[];
} {
  const plot: Box = {
    x: inset.left,
    y: inset.top,
    width: Math.max(1, width - inset.left - inset.right),
    height: Math.max(1, height - inset.top - inset.bottom),
  };
  const count = plan.points.length;
  const slot = plot.width / Math.max(1, count);
  const yOf = (value: number) => plot.y + plot.height - position(value, plan.scale) * plot.height;
  const zeroY = yOf(0);
  const points = plan.points.map((point, index) => {
    const x = plot.x + slot * index + slot / 2;
    const y = yOf(point.value);
    const columnWidth = Math.max(1, Math.min(48, slot * 0.7));
    return {
      point,
      x,
      y,
      column: { x: x - columnWidth / 2, y: Math.min(y, zeroY), width: columnWidth, height: Math.abs(zeroY - y) },
    };
  });
  return {
    plot,
    zeroY,
    points,
    gridlines: plan.scale.ticks.map((value) => ({ value, y: yOf(value) })),
  };
}

/**
 * Which date labels to print under a series. Every one, up to a dozen; past
 * that, an even spread that always keeps the first and the last, because a
 * row of four hundred overlapping dates is a black smear.
 */
export function labelEvery(count: number, room = 12): number {
  if (count <= room) return 1;
  return Math.ceil(count / room);
}
