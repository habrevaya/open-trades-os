import { schema } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import * as dashboards from "./dashboards";
import { inTenant } from "./context";
import { replayed, remember } from "./once";

/**
 * DASHBOARDS OVER THE API (M21)
 *
 * Wrappers and nothing else. Every route here calls the function the
 * dashboards screens call, so a tile drawn through the API is drawn by the
 * same `reports.run` the screen uses: the caller's scope, their branch, and
 * the tiles they may not see left out. The only work done here is the shape
 * on the wire: no tenant column, no soft delete, times as text.
 */

type Ctx = Parameters<typeof dashboards.list>[0];

function savedOnWire(row: typeof schema.dashboard.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tiles: row.tiles as unknown as dashboards.StoredTile[],
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A tile off the wire, with no key an optional field carries as undefined. */
function storedTile(tile: {
  key: string; kind: dashboards.StoredTile["kind"]; width: 3 | 6 | 12;
  reportId?: string | undefined; builtIn?: string | undefined; title?: string | undefined; caption?: string | undefined;
  breakdown?: "stacked" | "grouped" | undefined; splitBy?: string | undefined; secondMeasure?: string | undefined;
  followsDates?: boolean | undefined;
}): dashboards.StoredTile {
  return {
    key: tile.key,
    kind: tile.kind,
    width: tile.width,
    ...(tile.reportId !== undefined ? { reportId: tile.reportId } : {}),
    ...(tile.builtIn !== undefined ? { builtIn: tile.builtIn } : {}),
    ...(tile.title !== undefined ? { title: tile.title } : {}),
    ...(tile.caption !== undefined ? { caption: tile.caption } : {}),
    ...(tile.breakdown !== undefined ? { breakdown: tile.breakdown } : {}),
    ...(tile.splitBy !== undefined ? { splitBy: tile.splitBy } : {}),
    ...(tile.secondMeasure !== undefined ? { secondMeasure: tile.secondMeasure } : {}),
    ...(tile.followsDates !== undefined ? { followsDates: tile.followsDates } : {}),
  };
}

export const handlers = {
  /** The two lists the Dashboards screen shows, trimmed the same way. */
  listDashboards: async (ctx: Ctx, _input: Record<string, never>) => {
    assertCan(ctx.actor, "report:read");
    const saved = await dashboards.list(ctx);
    return {
      builtIn: dashboards.catalogue(ctx).map((d) => ({ slug: d.slug, title: d.title, description: d.description })),
      saved: saved.map(savedOnWire),
    };
  },

  getBuiltInDashboard: async (ctx: Ctx, input: { slug: string }) => {
    /**
     * Drawing checks each tile's own permission and nothing else; the
     * Dashboards screen is behind `report:read`, and so is this.
     */
    assertCan(ctx.actor, "report:read");
    const drawn = await dashboards.get(ctx, input);
    return {
      definition: { slug: drawn.definition.slug, title: drawn.definition.title, description: drawn.definition.description },
      tiles: drawn.tiles,
      leftOut: drawn.leftOut,
    };
  },

  getDashboard: async (ctx: Ctx, input: { id: string }) => {
    assertCan(ctx.actor, "report:read");
    const drawn = await dashboards.getSaved(ctx, input);
    /**
     * The tiles as stored, read through the same list the screen's tile
     * editor reads, so a caller can change one and send the list back.
     */
    const row = (await dashboards.list(ctx)).find((d) => d.id === input.id);
    return {
      definition: drawn.definition,
      stored: (row?.tiles ?? []) as unknown as dashboards.StoredTile[],
      tiles: drawn.tiles,
      leftOut: drawn.leftOut,
    };
  },

  /**
   * A retry with the same idempotency key is answered with the dashboard the
   * first one made. Kept here rather than in `dashboards.create`, which the
   * screens share, so the key is looked up before the create and written
   * after it, in a transaction of its own. Should that second write ever fail
   * after the create, a retry meets the dashboard's own name and is refused:
   * never a second dashboard.
   */
  createDashboard: async (ctx: Ctx, input: { name: string; description?: string | undefined }) => {
    assertCan(ctx.actor, "report:build");
    const prior = await inTenant(ctx, (tx) => replayed<{ id: string }>(tx, ctx, "dashboard.create"));
    if (prior) {
      const first = (await dashboards.list(ctx)).find((d) => d.id === prior.id);
      if (first) return savedOnWire(first);
    }
    const created = await dashboards.create(ctx, {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    await inTenant(ctx, (tx) => remember(tx, ctx, "dashboard.create", created.id, { id: created.id }));
    return savedOnWire(created);
  },

  setDashboardTiles: async (ctx: Ctx, input: { id: string; tiles: Parameters<typeof storedTile>[0][] }) => {
    assertCan(ctx.actor, "report:build");
    return savedOnWire(await dashboards.setTiles(ctx, { id: input.id, tiles: input.tiles.map(storedTile) }));
  },

  deleteDashboard: async (ctx: Ctx, input: { id: string }) => {
    await dashboards.remove(ctx, input);
    return { ok: true as const };
  },
} as const;
