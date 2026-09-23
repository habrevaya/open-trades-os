import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { permissionsFor, dashboard, type reporting } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { CATALOGUE } from "./report-catalogue";
import { BUILT_IN } from "./report-built-in";
import { BUILT_IN_DASHBOARDS, type BuiltInDashboard } from "./dashboard-built-in";
import { run, type ReportResult } from "./reports";
import { audit } from "./customers";

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

  const tiles = await Promise.all(decision.tiles.map((entry) => drawTile(ctx, entry)));
  return { definition: found, tiles };
}

/**
 * One tile, run.
 *
 * Shared by the dashboards that ship and the ones people assemble, because
 * the two must not be able to render differently. A saved dashboard that
 * looked like a slightly worse version of a built-in one would make
 * "copy this and change it" the wrong move, which is the move the whole
 * feature is for.
 */
async function drawTile(
  ctx: ServiceContext, entry: dashboard.TileDecision,
): Promise<TileResult> {
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
}


// ---------------------------------------------------------------------------
// Dashboards somebody assembled
// ---------------------------------------------------------------------------

/**
 * A TILE POINTS AT A REPORT. IT DOES NOT COPY ONE.
 *
 * This is the whole design of a saved dashboard, and the thing worth being
 * strict about. A tile holding its own copy of a definition keeps showing
 * last quarter's version of a number after somebody corrects the report, and
 * the reader has no way to tell which of the two is right.
 *
 * So a stored tile is a pointer plus a shape: which report, drawn how, how
 * wide. No filters, no date range, no overrides, because every one of those
 * is a way for a tile and its report to end up disagreeing.
 */
export interface StoredTile {
  key: string;
  kind: dashboard.TileKind;
  width: 3 | 6 | 12;
  /** Exactly one of these. A saved report, or one that ships. */
  reportId?: string;
  builtIn?: string;
  /** Overrides the report's own name on this dashboard. Optional. */
  title?: string;
  caption?: string;
}

const WIDTHS = [3, 6, 12] as const;
const KINDS: dashboard.TileKind[] = ["number", "bars", "trend"];

/** What a stored tile resolves to: a name and a definition, or nothing. */
interface Source {
  title: string;
  definition: reporting.ReportDefinition;
}

async function sourceFor(tx: Database, tile: StoredTile): Promise<Source | null> {
  if (tile.builtIn !== undefined) {
    const found = BUILT_IN.find((r) => r.slug === tile.builtIn);
    return found ? { title: found.name, definition: found.definition } : null;
  }
  if (tile.reportId === undefined) return null;

  const [saved] = await tx.select().from(schema.report)
    .where(and(eq(schema.report.id, tile.reportId), isNull(schema.report.deletedAt)))
    .limit(1);
  return saved
    ? { title: saved.name, definition: saved.definition as unknown as reporting.ReportDefinition }
    : null;
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "report:read", async (tx) =>
    tx.select().from(schema.dashboard)
      .where(isNull(schema.dashboard.deletedAt))
      .orderBy(schema.dashboard.name));
}

export async function create(
  ctx: ServiceContext, input: { name: string; description?: string },
) {
  const name = input.name.trim();
  if (name === "") throw new ConflictError("A dashboard needs a name");

  return guardedWrite(ctx, "report:build", async (tx) => {
    const [created] = await tx.insert(schema.dashboard).values({
      organizationId: ctx.actor.organizationId,
      name,
      description: input.description?.trim() || null,
      // Empty, and it opens on an empty state telling you to add something.
      // A dashboard that arrived pre-filled would be somebody else's idea of
      // what this one is for.
      tiles: [],
      createdByUserId: ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "dashboard.created", "dashboard", created!.id, null, created);
    return created!;
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const [before] = await tx.select().from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, input.id), isNull(schema.dashboard.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Dashboard");

    await tx.update(schema.dashboard).set({ deletedAt: new Date() })
      .where(eq(schema.dashboard.id, input.id));
    await audit(tx, ctx, "dashboard.deleted", "dashboard", input.id, before, null);
  });
}

/**
 * Add a tile, or move or remove one. Always a write of the whole list.
 *
 * The order IS the data, so it is stored as an array and written whole. A
 * sort column on rows is what ends up with two tiles both claiming position
 * three, and a dashboard that renders in a different order each time is one
 * nobody trusts.
 */
export async function setTiles(
  ctx: ServiceContext, input: { id: string; tiles: StoredTile[] },
) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const [before] = await tx.select().from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, input.id), isNull(schema.dashboard.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Dashboard");

    const seen = new Set<string>();
    for (const tile of input.tiles) {
      if ((tile.reportId === undefined) === (tile.builtIn === undefined)) {
        /**
         * Exactly one source. Neither is a tile that draws nothing; both is a
         * tile whose meaning depends on which branch the reader happens to
         * check first, and the two can say different things.
         */
        throw new ConflictError("A tile shows one report, either a saved one or one that ships.");
      }
      if (!KINDS.includes(tile.kind)) {
        throw new ConflictError(`There is no tile shape called "${tile.kind}".`);
      }
      if (!WIDTHS.includes(tile.width as 3 | 6 | 12)) {
        throw new ConflictError(`A tile is 3, 6 or 12 columns wide, not ${tile.width}.`);
      }
      if (seen.has(tile.key)) {
        // Keys address a tile for removal and reordering. Two tiles with one
        // key means a remove takes both of them.
        throw new ConflictError("Two tiles share a key.");
      }
      seen.add(tile.key);

      const source = await sourceFor(tx, tile);
      if (!source) {
        /**
         * Refused at save rather than drawn as a broken tile later. A tile
         * pointing at a report that does not exist is a typo or a deleted
         * report, and both are worth hearing about now.
         */
        throw new ConflictError("That tile points at a report that does not exist.");
      }

      const decision = dashboard.checkShape(
        { key: tile.key, title: tile.title ?? source.title, kind: tile.kind, width: tile.width, definition: source.definition },
        CATALOGUE.find((d) => d.key === source.definition.dataset)!,
      );
      if (!decision.ok) throw new ConflictError(decision.detail);
    }

    const [after] = await tx.update(schema.dashboard)
      .set({ tiles: input.tiles as unknown as Record<string, unknown>[], updatedAt: new Date() })
      .where(eq(schema.dashboard.id, input.id))
      .returning();

    await audit(tx, ctx, "dashboard.updated", "dashboard", input.id, before, after);
    return after!;
  });
}

/**
 * Run a saved dashboard.
 *
 * Its tiles are turned into definitions here and then handed to exactly the
 * same resolver the built-in ones go through, so a saved dashboard and a
 * shipped one cannot behave differently. The lookup lives here rather than in
 * core because core takes data and returns a decision, and a database read is
 * neither.
 */
export async function getSaved(
  ctx: ServiceContext, input: { id: string },
): Promise<{ definition: { id: string; name: string; description: string | null }; tiles: TileResult[] }> {
  const [saved] = await inTenant(ctx, async (tx) =>
    tx.select().from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, input.id), isNull(schema.dashboard.deletedAt))).limit(1));
  if (!saved) throw new NotFoundError("Dashboard");

  const stored = saved.tiles as unknown as StoredTile[];
  const sources = await inTenant(ctx, async (tx) =>
    Promise.all(stored.map((tile) => sourceFor(tx, tile))));

  const resolvable: dashboard.Tile[] = [];
  const missing: TileResult[] = [];
  for (const [index, tile] of stored.entries()) {
    const source = sources[index];
    if (!source) {
      /**
       * The report was deleted after the tile was added. Said in place
       * rather than dropped: the tile is somebody's, they put it there on
       * purpose, and a dashboard that silently loses one is a dashboard
       * that has quietly stopped answering a question.
       */
      missing.push({
        key: tile.key, title: tile.title ?? "A deleted report", kind: tile.kind, width: tile.width,
        problem: "The report this tile showed has been deleted.",
      });
      continue;
    }
    resolvable.push({
      key: tile.key,
      title: tile.title ?? source.title,
      kind: tile.kind,
      width: tile.width,
      definition: source.definition,
      ...(tile.caption ? { caption: tile.caption } : {}),
    });
  }

  const decision = dashboard.resolveDashboard(
    { key: saved.id, title: saved.name, description: saved.description ?? "", tiles: resolvable },
    CATALOGUE,
    permissionsFor(ctx.actor),
  );

  const drawn = await Promise.all(decision.tiles.map((entry) => drawTile(ctx, entry)));
  /**
   * The missing ones go back where they were, by key, rather than on the
   * end. A tile that moves to the bottom of the page the day its report is
   * deleted takes the rest of the layout with it.
   */
  const byKey = new Map([...drawn, ...missing].map((tile) => [tile.key, tile]));
  const tiles = stored.map((tile) => byKey.get(tile.key)).filter((tile) => tile !== undefined);

  return {
    definition: { id: saved.id, name: saved.name, description: saved.description },
    tiles,
  };
}
