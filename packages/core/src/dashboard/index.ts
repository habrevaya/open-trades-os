import type { Permission } from "../access/permissions";
import {
  resolveReport, explainRefusal,
  type Dataset, type ReportDefinition, type ReportDecision, type ReportRefusal,
} from "../reporting/index.js";

/**
 * DASHBOARDS
 *
 * A report answers a question somebody went looking for. A dashboard answers
 * the questions somebody would not think to ask, which is why it is the
 * screen a business is actually run from and why it is the one every product
 * in this category leads with.
 *
 * A DASHBOARD IS A LIST OF REPORTS WITH A SHAPE ATTACHED. Nothing more. Every
 * tile is a `ReportDefinition`, resolved by `resolveReport` against the same
 * catalogue, so permissions, scope and field redaction hold on a dashboard
 * exactly as they do on the reports screen. There is no second query path.
 *
 * That is the whole design, and it is deliberate. The obvious alternative is
 * a widget type per tile with its own hand-written query, and within a year
 * the dashboard and the report disagree about what revenue means, because
 * one of them was updated. Here the tile cannot disagree: it is the report.
 *
 * AND THE LAYOUT IS DATA, NEVER CODE. Same argument as workflow conditions,
 * report definitions and dwell shapes. A dashboard somebody builds in a
 * product they self host must not be a way to get a function evaluated on the
 * server.
 */

/**
 * How a tile draws its answer.
 *
 * Three, because three is what the underlying shapes actually are. A tile is
 * either one number, a comparison between categories, or a line over time,
 * and a longer list of chart types is a chooser rather than a decision.
 */
export type TileKind =
  /** One number. No dimensions, one measure. */
  | "number"
  /** A category against a measure, biggest first. */
  | "bars"
  /** A measure over a date dimension, oldest first. */
  | "trend";

export interface Tile {
  key: string;
  title: string;
  /** What the number means, when the title cannot say it alone. */
  caption?: string;
  kind: TileKind;
  definition: ReportDefinition;
  /** Which measure to draw. Defaults to the first the definition names. */
  measure?: string;
  /**
   * How many of the twelve columns it takes. A number tile is three, a chart
   * is six or twelve, and anything else is a layout somebody is fighting.
   */
  width: 3 | 6 | 12;
}

export interface DashboardDefinition {
  key: string;
  title: string;
  /** Who opens this, and what they are looking for. */
  description: string;
  tiles: Tile[];
}

/**
 * Whether a tile's shape and its definition agree.
 *
 * The pairing is the part a person gets wrong when they build one: a number
 * tile with a dimension draws a hundred rows as one number, and a trend with
 * no date dimension is a bar chart that lies about being a timeline. Neither
 * throws. Both produce a tile that looks fine and says nothing true.
 */
export type ShapeRefusal = { ok: false; reason: "wrong_shape"; detail: string };

export function checkShape(tile: Tile, dataset: Dataset): ShapeRefusal | { ok: true } {
  const dimensions = tile.definition.dimensions;

  if (tile.kind === "number") {
    if (dimensions.length > 0) {
      return {
        ok: false, reason: "wrong_shape",
        detail: `A number tile shows one value, so it takes no dimensions. "${tile.title}" groups by ${dimensions.join(", ")}.`,
      };
    }
  } else if (dimensions.length !== 1) {
    return {
      ok: false, reason: "wrong_shape",
      detail: `A ${tile.kind} tile draws one dimension against one measure. "${tile.title}" has ${dimensions.length}.`,
    };
  }

  if (tile.kind === "trend") {
    const dimension = dataset.dimensions.find((d) => d.key === dimensions[0]);
    if (dimension && dimension.type !== "date") {
      /**
       * A trend over a non-date dimension is the mistake worth catching. It
       * renders as a perfectly ordinary line, and a line implies a sequence
       * where there is none: "revenue by customer" as a trend reads as
       * revenue rising over time.
       */
      return {
        ok: false, reason: "wrong_shape",
        detail: `A trend needs a date to run along. "${dimension.label}" is not one.`,
      };
    }
  }

  const named = tile.measure;
  if (named !== undefined && !tile.definition.measures.includes(named)) {
    return {
      ok: false, reason: "wrong_shape",
      detail: `"${tile.title}" draws "${named}", which its report does not select.`,
    };
  }

  return { ok: true };
}

export type TileDecision =
  | { ok: true; tile: Tile; report: Extract<ReportDecision, { ok: true }>; measure: string }
  /** Broken: shown in place, with the reason, so somebody fixes it. */
  | { ok: false; tile: Tile; detail: string }
  /** Not theirs to see: dropped entirely. */
  | { ok: false; tile: Tile; hidden: true };

export interface DashboardDecision {
  definition: DashboardDefinition;
  /** In layout order, with the hidden ones already gone. */
  tiles: TileDecision[];
}

/**
 * Resolve every tile, and decide which failures the reader should see.
 *
 * THE TWO KINDS OF FAILURE ARE NOT THE SAME THING, and treating them alike is
 * how a dashboard becomes either a wall of errors or a screen that silently
 * shrinks.
 *
 *   A tile the reader may not run is DROPPED, exactly as the navigation drops
 *   a link somebody cannot open. A dispatcher looking at a dashboard with a
 *   gap reading "you need cost:read" learns the shape of what is being kept
 *   from them, which is both unkind and a disclosure.
 *
 *   A tile that is BROKEN stays, with its reason. It names a field that no
 *   longer exists, or draws a trend over a customer name. Hiding that means
 *   the owner never finds out, and a dashboard quietly missing the tile
 *   somebody built it for is worse than one with a visible fault on it.
 */
export function resolveDashboard(
  definition: DashboardDefinition,
  catalogue: Dataset[],
  held: Set<Permission>,
): DashboardDecision {
  const tiles: TileDecision[] = [];

  for (const tile of definition.tiles) {
    const report = resolveReport(tile.definition, catalogue, held);

    if (!report.ok) {
      if (report.reason === "missing_permission") continue;
      tiles.push({ ok: false, tile, detail: explainRefusal(report as ReportRefusal) });
      continue;
    }

    const shape = checkShape(tile, report.dataset);
    if (!shape.ok) {
      tiles.push({ ok: false, tile, detail: shape.detail });
      continue;
    }

    tiles.push({
      ok: true, tile, report,
      // Defaulting rather than refusing an absent one: a tile drawing the
      // only measure it selects does not need to say which.
      measure: tile.measure ?? tile.definition.measures[0]!,
    });
  }

  return { definition, tiles };
}

/**
 * The proportion of the biggest value, for a bar or a column.
 *
 * Against the largest value on the tile rather than a fixed ceiling, because
 * a dashboard tile has no axis labels worth reading at that size and the
 * only thing a bar communicates is relative size.
 *
 * Zero gets no bar at all. A hairline against a large peak reads as a small
 * amount, and "none" and "a little" are different answers.
 */
export function proportion(value: number, peak: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(peak)) return 0;
  if (peak <= 0 || value <= 0) return 0;
  return Math.min(1, value / peak);
}
