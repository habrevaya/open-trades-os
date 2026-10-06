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
 * A SECOND GROUPING CAN BE STACKED OR SET SIDE BY SIDE. A report grouped by two
 * things used to be drawn by one of them with the other added up. It can now
 * be split by the other: each bar or column is cut into the second grouping's
 * values and stacked end to end (a total with its parts, which needs a measure
 * that can be added up), or the values stand beside each other (a comparison,
 * which any measure allows, and which draws a line per value when the first
 * grouping is a date). More than six values of the second grouping are not
 * readable by colour, so the six biggest stay and the rest are added into one
 * "everything else" that says so; the table has every row either way.
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

/** How a second grouping is drawn: cut into one stack, or one bar for each of its values. */
export type ChartArrangement = "stacked" | "grouped";

/** One value of the second grouping, in the order it is drawn and listed. */
export interface ChartSeries {
  key: string | number | null;
  /** The values that did not fit, added together. Not one value of the grouping, so it cannot be opened. */
  other: boolean;
}

export interface ChartSplit {
  dimension: ChartColumn;
  arrangement: ChartArrangement;
  series: ChartSeries[];
}

/** One value of the first grouping cut by one value of the second. */
export interface ChartPart {
  /** Which of the plan's series this is. */
  series: number;
  /** The row it came from, which pins both groupings for the drill. Null for "everything else". */
  row: ChartRow | null;
  exact: string;
  value: number;
}

export interface ChartPoint {
  /** The group's value as the report returned it, for the label and the drill. */
  key: string | number | null;
  /** The row the point came from, or the first of the rows it sums. */
  row: ChartRow;
  /** Exact, as the report returned it (or summed it), for the label. */
  exact: string;
  /** For drawing only. A pixel is not money. */
  value: number;
  /** When the chart is split: this group cut by the second grouping, in series order, leaving out what is nothing. */
  parts?: ChartPart[];
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
  /** Set when the chart is cut by a second grouping. */
  split: ChartSplit | null;
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
 * The values of a second grouping told apart by colour. Past this the smallest
 * are added into one "everything else": a legend of twelve near colours is not
 * a chart anyone can read.
 */
export const MAX_SERIES = 6;
/** A category that is split is wider than one that is not, so fewer fit. */
export const MAX_SPLIT_GROUPS = 12;
/** And a split series over time has a column or a line per value in each slot. */
export const MAX_SPLIT_POINTS = 60;

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
    /** Cut each group by this other grouping, instead of adding it up. */
    split?: string | undefined;
    arrange?: ChartArrangement | undefined;
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
  /** A split by the grouping already drawn, or by one the report does not have, is no split. */
  const splitBy = options.split ? dimensions.find((d) => d.key === options.split && d.key !== dimension.key) : undefined;
  const others = dimensions.filter((d) => d.key !== dimension.key && d.key !== splitBy?.key);
  const additive = options.additive?.(measure.key) ?? false;
  const arrangement: ChartArrangement = options.arrange === "grouped" ? "grouped" : "stacked";

  if (others.length > 0 && !additive) {
    return {
      ok: false,
      reason: `This report is grouped by ${dimensions.map((d) => d.label.toLowerCase()).join(" and ")}, and ${measure.label.toLowerCase()} cannot be added up across ${others.map((d) => d.label.toLowerCase()).join(" and ")} without changing what it means. Group it by one thing to chart it.`,
    };
  }
  if (splitBy && arrangement === "stacked" && !additive) {
    return {
      ok: false,
      reason: `${measure.label} cannot be stacked: the parts of an average or a minimum do not add up to the whole. Set ${splitBy.label.toLowerCase()} side by side instead.`,
    };
  }

  const dated = dimension.type === "date";
  const folded = splitBy
    ? foldSplit(result.rows, dimension.key, splitBy.key, measure)
    : { points: fold(result.rows, dimension.key, measure), series: null };
  const points = folded.points;
  if (points.length === 0) return { ok: false, reason: "Nothing matched, so there is nothing to draw." };

  /**
   * A stack is columns over time (a line cannot be stacked); side by side over
   * time is a line per value, or columns when asked for.
   */
  const kind: ChartKind = dated
    ? (options.prefer === "columns" || (splitBy && arrangement === "stacked") ? "columns" : "line")
    : "bars";
  const cap = splitBy
    ? (kind === "bars" ? (arrangement === "stacked" ? MAX_BARS : MAX_SPLIT_GROUPS) : MAX_SPLIT_POINTS)
    : (kind === "bars" ? MAX_BARS : MAX_POINTS);
  /**
   * A dated report keeps its NEWEST points when it has too many, because the
   * report is already oldest first and the recent end is the one being
   * watched. A ranked report keeps its first, which are its biggest.
   */
  const kept = points.length > cap
    ? (dated ? points.slice(points.length - cap) : points.slice(0, cap))
    : points;

  const split: ChartSplit | null = splitBy && folded.series
    ? { dimension: splitBy, arrangement, series: folded.series }
    : null;

  return {
    ok: true,
    plan: {
      kind,
      dimension,
      measure,
      points: kept,
      omitted: points.length - kept.length,
      summedOver: others.map((d) => d.label),
      split,
      scale: split ? splitScale(kept, arrangement) : niceScale(Math.min(0, ...kept.map((p) => p.value)), Math.max(0, ...kept.map((p) => p.value))),
    },
  };
}

/** The scale a split chart is drawn on: the tallest stack and deepest, or the biggest single part. */
function splitScale(points: readonly ChartPoint[], arrangement: ChartArrangement): Scale {
  let low = 0;
  let high = 0;
  for (const point of points) {
    const parts = point.parts ?? [];
    if (arrangement === "stacked") {
      high = Math.max(high, parts.reduce((sum, p) => sum + Math.max(0, p.value), 0));
      low = Math.min(low, parts.reduce((sum, p) => sum + Math.min(0, p.value), 0));
    } else {
      for (const part of parts) {
        high = Math.max(high, part.value);
        low = Math.min(low, part.value);
      }
    }
  }
  return niceScale(low, high);
}

/**
 * Each group cut by the second grouping. The rows are added up by the pair, so
 * a report grouped by a third thing as well is folded over it, as it is
 * without a split.
 *
 * The series are the second grouping's values by how much they add up to,
 * biggest first, so the colours are the same on every chart of one report and
 * the biggest is the first in the legend. Past `MAX_SERIES` the smallest are
 * added together as one "everything else", which is a sum of the same measure
 * and so can be added, and which is left unopenable because it is not one value.
 */
function foldSplit(
  rows: readonly ChartRow[], key: string, splitKey: string, measure: ChartColumn,
): { points: ChartPoint[]; series: ChartSeries[] } {
  const idOf = (value: string | number | null) => (value === null ? "\u0000" : `${typeof value}:${String(value)}`);

  const seriesTotals = new Map<string, { key: string | number | null; values: (string | number | null)[] }>();
  for (const row of rows) {
    const value = row[splitKey] ?? null;
    const found = seriesTotals.get(idOf(value));
    if (found) found.values.push(row[measure.key] ?? null);
    else seriesTotals.set(idOf(value), { key: value, values: [row[measure.key] ?? null] });
  }
  const ranked = [...seriesTotals.entries()]
    .map(([id, s]) => ({ id, key: s.key, size: Math.abs(Number(total(s.values, measure.type))) }))
    .sort((a, b) => b.size - a.size);
  const keep = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const indexOf = new Map(keep.map((s, i) => [s.id, i]));
  const hasOther = ranked.length > keep.length;
  const series: ChartSeries[] = [
    ...keep.map((s) => ({ key: s.key, other: false })),
    ...(hasOther ? [{ key: null, other: true }] : []),
  ];
  const otherIndex = series.length - 1;

  const groups = new Map<string, {
    key: string | number | null; row: ChartRow;
    parts: Map<number, { row: ChartRow | null; values: (string | number | null)[] }>;
  }>();
  for (const row of rows) {
    const value = row[key] ?? null;
    const group = groups.get(idOf(value)) ?? { key: value, row, parts: new Map() };
    groups.set(idOf(value), group);
    const index = indexOf.get(idOf(row[splitKey] ?? null)) ?? otherIndex;
    const part = group.parts.get(index);
    if (part) {
      part.values.push(row[measure.key] ?? null);
      /** Two rows folded into one part (a third grouping) still pin both groupings: the first row does. */
      if (index === otherIndex && hasOther) part.row = null;
    } else {
      group.parts.set(index, { row: index === otherIndex && hasOther ? null : row, values: [row[measure.key] ?? null] });
    }
  }

  const points = [...groups.values()].map((group): ChartPoint => {
    const parts = [...group.parts.entries()].sort(([a], [b]) => a - b).map(([index, part]): ChartPart => {
      const exact = total(part.values, measure.type);
      return { series: index, row: part.row, exact, value: Number(exact) };
    });
    const exact = total(parts.map((p) => p.exact), measure.type);
    return { key: group.key, row: group.row, exact, value: Number(exact), parts };
  });
  return { points, series };
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

/* ------------------------------------------------- a chart cut by a second grouping */

export interface PartBox extends Box { part: ChartPart }

/**
 * Horizontal bars cut by a second grouping.
 *
 * STACKED, a group is one bar made of its parts end to end from zero, the
 * positive ones to the right and the negative ones to the left, each in the
 * order of the series so the same colour is in the same place on every row.
 * SIDE BY SIDE, a group is a cluster of thinner bars, one for each part that
 * is there, all growing from zero. A part with nothing to draw is a gap in a
 * cluster and nothing in a stack.
 */
export function splitBarLayout(plan: ChartPlan, width: number, labelWidth = 160): {
  height: number;
  zeroX: number;
  groups: { point: ChartPoint; y: number; height: number; parts: PartBox[]; endX: number }[];
} {
  const split = plan.split;
  const arrangement = split?.arrangement ?? "stacked";
  const plot = Math.max(1, width - labelWidth - 90);
  const zeroX = labelWidth + position(0, plan.scale) * plot;
  const unit = (value: number) => (Math.abs(position(value, plan.scale) - position(0, plan.scale))) * plot;
  const slot = arrangement === "grouped" ? Math.max(1, ...plan.points.map((p) => p.parts?.length ?? 1)) : 1;
  const bar = 14;
  const rowHeight = arrangement === "grouped" ? slot * bar + 14 : 28;

  const groups = plan.points.map((point, index) => {
    const top = index * rowHeight;
    const parts: PartBox[] = [];
    let right = zeroX;
    let left = zeroX;
    (point.parts ?? []).forEach((part, position_) => {
      const length = unit(part.value);
      if (arrangement === "stacked") {
        const negative = part.value < 0;
        const x = negative ? left - length : right;
        parts.push({ part, x, y: top + 6, width: length, height: rowHeight - 12 });
        if (negative) left -= length; else right += length;
      } else {
        const x = part.value < 0 ? zeroX - length : zeroX;
        parts.push({ part, x, y: top + 6 + position_ * bar, width: length, height: bar - 2 });
      }
    });
    const endX = arrangement === "stacked" ? right : Math.max(zeroX, ...parts.map((p) => p.x + p.width));
    return { point, y: top, height: rowHeight, parts, endX };
  });
  return { height: plan.points.length * rowHeight + 24, zeroX, groups };
}

/**
 * A series over time, cut by a second grouping: stacked columns, columns side
 * by side, or a line for each value of the grouping.
 */
export function splitSeriesLayout(plan: ChartPlan, width: number, height: number, inset = { left: 64, right: 16, top: 12, bottom: 36 }): {
  plot: Box;
  zeroY: number;
  gridlines: { y: number; value: number }[];
  groups: { point: ChartPoint; x: number; parts: PartBox[] }[];
  /** One line per series, for a split drawn as lines. Empty for columns. */
  lines: { series: number; points: { x: number; y: number; part: ChartPart; point: ChartPoint }[] }[];
} {
  const split = plan.split;
  const arrangement = split?.arrangement ?? "stacked";
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
  const across = Math.max(1, split?.series.length ?? 1);

  const groups = plan.points.map((point, index) => {
    const centre = plot.x + slot * index + slot / 2;
    const parts: PartBox[] = [];
    if (plan.kind === "columns") {
      if (arrangement === "stacked") {
        const columnWidth = Math.max(1, Math.min(48, slot * 0.7));
        let up = zeroY;
        let down = zeroY;
        for (const part of point.parts ?? []) {
          const length = Math.abs(zeroY - yOf(part.value));
          if (part.value < 0) { parts.push({ part, x: centre - columnWidth / 2, y: down, width: columnWidth, height: length }); down += length; }
          else { up -= length; parts.push({ part, x: centre - columnWidth / 2, y: up, width: columnWidth, height: length }); }
        }
      } else {
        const each = Math.max(1, Math.min(24, (slot * 0.8) / across));
        const start = centre - (each * across) / 2;
        for (const part of point.parts ?? []) {
          const y = yOf(part.value);
          parts.push({ part, x: start + part.series * each, y: Math.min(y, zeroY), width: Math.max(1, each - 1), height: Math.abs(zeroY - y) });
        }
      }
    }
    return { point, x: centre, parts };
  });

  const lines = plan.kind === "line"
    ? (split?.series ?? []).map((_, series) => ({
      series,
      points: groups.flatMap((group) => {
        const part = (group.point.parts ?? []).find((p) => p.series === series);
        return part ? [{ x: group.x, y: yOf(part.value), part, point: group.point }] : [];
      }),
    }))
    : [];

  return { plot, zeroY, gridlines: plan.scale.ticks.map((value) => ({ value, y: yOf(value) })), groups, lines };
}
