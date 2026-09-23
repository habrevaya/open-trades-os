import type { dashboards } from "@opentradesos/api/services";

type StoredTile = dashboards.StoredTile;

/**
 * THE LIST OPERATIONS BEHIND ADD, REMOVE AND REORDER
 *
 * Pulled out of the server actions so they can be tested. Three small array
 * functions is exactly the size of thing that looks too obvious to test and
 * then silently drops a tile, swaps the wrong pair, or generates a key that
 * collides with one already on the dashboard.
 *
 * None of them mutate. A server action that mutated the list it was handed
 * would still work, right up to the day something else reads the same array
 * afterwards.
 */

/**
 * A key for a new tile: the report it points at, plus a suffix if needed.
 *
 * Derived from the source rather than random, so a dashboard's stored tiles
 * are readable to a person looking at the row. A suffix only when the same
 * report is genuinely on the dashboard twice, which is legitimate: the same
 * numbers as a headline and as a trend is a real layout.
 */
export function keyFor(source: string, existing: StoredTile[]): string {
  const taken = new Set(existing.map((tile) => tile.key));
  if (!taken.has(source)) return source;
  for (let n = 2; ; n += 1) {
    const candidate = `${source}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const KINDS = new Set(["number", "bars", "trend"]);
const WIDTHS = new Set([3, 6, 12]);

/**
 * The add form to a tile.
 *
 * The report field carries which kind of source it is, because a uuid and a
 * built-in slug are both strings and a tile that guessed between them would
 * be wrong exactly when somebody names a saved report after a built-in one.
 */
export function tileFromForm(
  form: { get(name: string): FormDataEntryValue | null },
  existing: StoredTile[],
): StoredTile | null {
  const report = String(form.get("report") ?? "");
  const [kind, value] = [report.slice(0, report.indexOf(":")), report.slice(report.indexOf(":") + 1)];
  if ((kind !== "saved" && kind !== "builtIn") || value === "") return null;

  const shape = String(form.get("kind") ?? "");
  const width = Number(form.get("width") ?? 6);
  if (!KINDS.has(shape) || !WIDTHS.has(width)) return null;

  const title = String(form.get("title") ?? "").trim();
  return {
    key: keyFor(value, existing),
    kind: shape as StoredTile["kind"],
    width: width as StoredTile["width"],
    ...(kind === "saved" ? { reportId: value } : { builtIn: value }),
    // Left off when blank, so the tile shows the report's own name and keeps
    // showing it when the report is renamed.
    ...(title ? { title } : {}),
  };
}

export function withoutTile(tiles: StoredTile[], key: string): StoredTile[] {
  return tiles.filter((tile) => tile.key !== key);
}

/**
 * Move one tile by one place.
 *
 * A no-op at the ends rather than a wrap. A tile that jumps from the top of
 * the dashboard to the bottom because somebody pressed up once too often is
 * a reorder they then have to undo, and they will not be sure how.
 */
export function moved(tiles: StoredTile[], key: string, by: number): StoredTile[] {
  const from = tiles.findIndex((tile) => tile.key === key);
  if (from === -1) return tiles;
  const to = from + by;
  if (to < 0 || to >= tiles.length) return tiles;

  const next = [...tiles];
  const [moving] = next.splice(from, 1);
  next.splice(to, 0, moving!);
  return next;
}
