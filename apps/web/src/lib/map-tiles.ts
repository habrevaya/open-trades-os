/**
 * WHERE THE MAP'S PICTURES COME FROM
 *
 * Raster tiles in the `{z}/{x}/{y}` convention every tile server uses, from a
 * URL a deployment configures. OpenStreetMap's own servers by default,
 * because they need no key and no account; their tile usage policy asks for
 * the attribution below on every map, a real browser's referer (which a
 * browser sends), and no heavy use, so a company with a room full of
 * dispatchers points `MAP_TILE_URL` at a tile service it pays for or runs.
 *
 * Read on the server and handed to the map, rather than baked into the
 * client bundle at build time, so changing tile server is a restart and not
 * a rebuild.
 */
export interface TileSource {
  url: string;
  attribution: string;
  attributionUrl: string;
}

export function tileSource(env: Record<string, string | undefined> = process.env): TileSource {
  return {
    url: env["MAP_TILE_URL"]?.trim() || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: env["MAP_TILE_ATTRIBUTION"]?.trim() || "© OpenStreetMap contributors",
    attributionUrl: env["MAP_TILE_ATTRIBUTION_URL"]?.trim() || "https://www.openstreetmap.org/copyright",
  };
}
