import { permissionsFor, dashboard } from "@opentradesos/core";
import { NotFoundError, type ServiceContext } from "./context";
import { CATALOGUE } from "./report-catalogue";
import { BUILT_IN_DASHBOARDS, type BuiltInDashboard } from "./dashboard-built-in";
import { run, type ReportResult } from "./reports";

export { BUILT_IN_DASHBOARDS };

/**
 * RUNNING A DASHBOARD
 *
 * Every tile goes through `reports.run`, which is the point. A dashboard has
 * no query of its own, so scope, permission and field redaction cannot be
 * weaker here than on the reports screen, and a tile cannot drift into
 * disagreeing with the report behind it about what a number means.
 *
 * The tiles run in parallel. They are independent reads inside one request,
 * and a money dashboard with six tiles run one after another is a screen
 * somebody watches assemble itself.
 */

export interface TileResult {
  key: string;
  title: string;
  caption?: string;
  kind: dashboard.TileKind;
  width: number;
  /** The measure being drawn, resolved. */
  measure?: { key: string; label: string; type: string };
  /** The dimension it is drawn against, for anything that is not a number. */
  dimension?: { key: string; label: string; type: string; sortPrefix?: boolean };
  result?: ReportResult;
  /**
   * Why this tile has nothing on it.
   *
   * Only ever a broken tile. A tile the reader may not run is gone from the
   * list entirely, the same way the navigation drops a link somebody cannot
   * open: a gap reading "you need report.financial:read" teaches a dispatcher
   * the shape of what is being kept from them.
   */
  problem?: string;
}

export function catalogue(ctx: ServiceContext): BuiltInDashboard[] {
  const held = permissionsFor(ctx.actor);
  return BUILT_IN_DASHBOARDS.filter((definition) => {
    const decision = dashboard.resolveDashboard(definition, CATALOGUE, held);
    /**
     * A dashboard with nothing left on it is not listed. The money dashboard
     * is every tile behind one permission, so for a dispatcher it is an empty
     * page with a title, and a link to an empty page is worse than no link.
     */
    return decision.tiles.length > 0;
  });
}

export async function get(
  ctx: ServiceContext, input: { slug: string },
): Promise<{ definition: BuiltInDashboard; tiles: TileResult[] }> {
  const found = BUILT_IN_DASHBOARDS.find((d) => d.slug === input.slug);
  if (!found) throw new NotFoundError("Dashboard");

  const held = permissionsFor(ctx.actor);
  const decision = dashboard.resolveDashboard(found, CATALOGUE, held);
  /**
   * Nothing visible reads as missing rather than forbidden, the same as any
   * other out-of-scope read in this product. "You may not see this dashboard"
   * answers a question the caller was not allowed to ask.
   */
  if (decision.tiles.length === 0) throw new NotFoundError("Dashboard");

  const tiles = await Promise.all(decision.tiles.map(async (entry): Promise<TileResult> => {
    const base = {
      key: entry.tile.key,
      title: entry.tile.title,
      kind: entry.tile.kind,
      width: entry.tile.width,
      ...(entry.tile.caption ? { caption: entry.tile.caption } : {}),
    };

    if (!entry.ok) {
      // `hidden` tiles never reach here; `resolveDashboard` drops them.
      return { ...base, problem: "detail" in entry ? entry.detail : "Unavailable." };
    }

    const measure = entry.report.measures.find((m) => m.key === entry.measure)!;
    const dimension = entry.report.dimensions[0];

    try {
      const result = await run(ctx, entry.tile.definition);
      return {
        ...base,
        measure: { key: measure.key, label: measure.label, type: measure.type },
        ...(dimension
          ? {
              dimension: {
                key: dimension.key, label: dimension.label, type: dimension.type,
                ...(dimension.sortPrefix ? { sortPrefix: true } : {}),
              },
            }
          : {}),
        result,
      };
    } catch (error) {
      /**
       * One tile failing does not take the page down. A dashboard is six
       * independent questions, and five answers plus one stated failure is
       * more use than an error page, particularly when the failure is a
       * report somebody edited and nobody has opened since.
       */
      return { ...base, problem: error instanceof Error ? error.message : "This tile failed to run." };
    }
  }));

  return { definition: found, tiles };
}
