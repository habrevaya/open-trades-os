/**
 * WHERE THINGS ARE, AND HOW FAR APART
 *
 * Three small pieces of arithmetic the dispatch map and the route optimiser
 * share, kept here so a screen and a solver cannot disagree about how far it
 * is from one house to the next.
 *
 *   Coordinates, read from the text columns they are stored in and refused
 *   when they are not a place on Earth.
 *   Distance and drive time, estimated from a straight line.
 *   Web Mercator tile arithmetic, which is what turns a latitude into a pixel
 *   on a slippy map.
 *
 * WHY A STRAIGHT LINE AND NOT A ROAD NETWORK. A drive time matrix is a paid
 * routing API or a routing engine somebody has to run, and this product has
 * neither. A haversine distance stretched by a road factor and divided by an
 * average speed is wrong for any one pair of houses and about right across a
 * day, which is the scale an order of stops is decided at. Every figure that
 * comes out of it is called an estimate wherever it is shown, and a company
 * that has declared its own drive time on a route has that used instead.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A coordinate pair from the two text columns, or null.
 *
 * NULL ISLAND IS REFUSED. Zero, zero is in the Gulf of Guinea, and it is what
 * a geocoder, an import or a phone with no fix writes when it has nothing: a
 * pin there would draw a line from Austin to the coast of Africa on the
 * dispatch map and tell the optimiser a stop is eight thousand miles away.
 * Nobody in this product's market services a property at exactly 0, 0.
 */
export function parseLatLng(
  latitude: string | number | null | undefined,
  longitude: string | number | null | undefined,
): LatLng | null {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
    return null;
  }
  const lat = typeof latitude === "number" ? latitude : Number(String(latitude).trim());
  const lng = typeof longitude === "number" ? longitude : Number(String(longitude).trim());
  if (String(latitude).trim() === "" || String(longitude).trim() === "") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/**
 * Six decimal places, which is about eleven centimetres. More is noise from a
 * geocoder pretending to know which brick, and fewer moves a pin onto the
 * neighbour's drive in a dense street.
 */
export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

const EARTH_RADIUS_KM = 6371.0088;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DriveAssumptions {
  /** Average speed over the whole drive, stops and lights included. */
  averageKmh: number;
  /**
   * How much longer the road is than the straight line. Road networks run
   * between about 1.2 and 1.4 times the crow's distance in suburbs; 1.3 is
   * the middle, and a company on a river with three bridges will want more.
   */
  roadFactor: number;
}

/**
 * Forty kilometres an hour, about twenty five miles an hour, is a service van
 * across a metro area once parking and the last turn are counted. It is a
 * default and the company changes it, because a rural route and a downtown
 * one are not the same day.
 */
export const DEFAULT_DRIVE: DriveAssumptions = { averageKmh: 40, roadFactor: 1.3 };

export const KM_PER_MILE = 1.609344;

/**
 * Minutes from one point to another, estimated.
 *
 * Whole minutes, rounded up, and never zero between two different points: a
 * drive of twenty seconds is still getting back in the van, and a matrix of
 * zeros between neighbours makes every order of a street look equally good.
 */
export function driveMinutes(a: LatLng, b: LatLng, assumptions: DriveAssumptions = DEFAULT_DRIVE): number {
  if (a.lat === b.lat && a.lng === b.lng) return 0;
  if (!(assumptions.averageKmh > 0) || !(assumptions.roadFactor > 0)) {
    throw new RangeError("An average speed and a road factor must both be greater than zero.");
  }
  const km = haversineKm(a, b) * assumptions.roadFactor;
  return Math.max(1, Math.ceil((km / assumptions.averageKmh) * 60));
}

/* ------------------------------------------------------- web mercator */

/**
 * The latitude Web Mercator stops at. The projection runs to infinity at the
 * poles, so every slippy map cuts it here and draws the world as a square.
 */
export const MAX_LATITUDE = 85.05112878;

export const TILE_SIZE = 256;

/**
 * Where a point falls in the world at a zoom, in pixels from the top left
 * of the world square. Tile numbers are these divided by the tile size.
 */
export function project(point: LatLng, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point.lat));
  const sin = Math.sin(rad(lat));
  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** The inverse of `project`. */
export function unproject(pixel: { x: number; y: number }, zoom: number): LatLng {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (pixel.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * pixel.y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

export interface Viewport {
  center: LatLng;
  zoom: number;
}

/**
 * The view that shows every point, at the closest zoom that fits.
 *
 * Whole zooms only, because raster tiles exist at whole zooms and a map
 * scaled between two of them is blurred. A single point, or none, gets a
 * street level view of it or a default, rather than the infinite zoom the
 * arithmetic would ask for.
 */
export function fitBounds(
  points: readonly LatLng[],
  size: { width: number; height: number },
  options: { padding?: number; maxZoom?: number; minZoom?: number; fallback?: Viewport } = {},
): Viewport {
  const padding = options.padding ?? 40;
  const maxZoom = options.maxZoom ?? 16;
  const minZoom = options.minZoom ?? 2;
  if (points.length === 0) {
    return options.fallback ?? { center: { lat: 39.5, lng: -98.35 }, zoom: 4 };
  }
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const box = {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lngs), west: Math.min(...lngs),
  };
  const center = unproject({
    x: (project({ lat: box.north, lng: box.west }, 0).x + project({ lat: box.south, lng: box.east }, 0).x) / 2,
    y: (project({ lat: box.north, lng: box.west }, 0).y + project({ lat: box.south, lng: box.east }, 0).y) / 2,
  }, 0);

  const usableW = Math.max(1, size.width - padding * 2);
  const usableH = Math.max(1, size.height - padding * 2);
  for (let zoom = maxZoom; zoom >= minZoom; zoom--) {
    const nw = project({ lat: box.north, lng: box.west }, zoom);
    const se = project({ lat: box.south, lng: box.east }, zoom);
    if (se.x - nw.x <= usableW && se.y - nw.y <= usableH) return { center, zoom };
  }
  return { center, zoom: minZoom };
}

/**
 * The tiles covering a view, with where each one is drawn.
 *
 * X wraps around the antimeridian, Y does not: there is no tile above the
 * top of the world, and asking a tile server for one is a 404 per pan.
 */
export function tilesFor(view: Viewport, size: { width: number; height: number }): {
  z: number; x: number; y: number; left: number; top: number;
}[] {
  const z = view.zoom;
  const centre = project(view.center, z);
  const originX = centre.x - size.width / 2;
  const originY = centre.y - size.height / 2;
  const count = 2 ** z;
  const firstX = Math.floor(originX / TILE_SIZE);
  const lastX = Math.floor((originX + size.width) / TILE_SIZE);
  const firstY = Math.max(0, Math.floor(originY / TILE_SIZE));
  const lastY = Math.min(count - 1, Math.floor((originY + size.height) / TILE_SIZE));
  const out: { z: number; x: number; y: number; left: number; top: number }[] = [];
  for (let ty = firstY; ty <= lastY; ty++) {
    for (let tx = firstX; tx <= lastX; tx++) {
      out.push({
        z,
        x: ((tx % count) + count) % count,
        y: ty,
        left: Math.round(tx * TILE_SIZE - originX),
        top: Math.round(ty * TILE_SIZE - originY),
      });
    }
  }
  return out;
}

/** Where a point is drawn inside a view, in pixels from its top left. */
export function toScreen(point: LatLng, view: Viewport, size: { width: number; height: number }): { x: number; y: number } {
  const centre = project(view.center, view.zoom);
  const p = project(point, view.zoom);
  return { x: p.x - centre.x + size.width / 2, y: p.y - centre.y + size.height / 2 };
}

/** The point under a pixel inside a view: what a click on the map means. */
export function fromScreen(pixel: { x: number; y: number }, view: Viewport, size: { width: number; height: number }): LatLng {
  const centre = project(view.center, view.zoom);
  return unproject({
    x: centre.x + pixel.x - size.width / 2,
    y: centre.y + pixel.y - size.height / 2,
  }, view.zoom);
}

/**
 * A tile URL from a template in the `{z}/{x}/{y}` convention every raster tile
 * server uses, with `{s}` for the subdomain some still ask for.
 */
export function tileUrl(template: string, tile: { z: number; x: number; y: number }): string {
  const subdomains = ["a", "b", "c"];
  return template
    .replace("{s}", subdomains[(tile.x + tile.y) % subdomains.length]!)
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

export * from "./geocode.js";
