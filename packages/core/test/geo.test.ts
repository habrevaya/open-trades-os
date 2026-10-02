import { describe, it, expect } from "vitest";
import { geo } from "../src/index";

/**
 * DISTANCE, DRIVE TIME AND THE MAP'S ARITHMETIC
 *
 * The dispatch map and the route optimiser both lean on these, so a mistake
 * here is a pin in the wrong suburb and an order of stops that drives past
 * the same house twice. Checked against figures worked out independently.
 */

const AUSTIN_CAPITOL = { lat: 30.2747, lng: -97.7404 };
const ROUND_ROCK = { lat: 30.5083, lng: -97.6789 };

describe("reading a coordinate", () => {
  it("reads the two text columns as a point", () => {
    expect(geo.parseLatLng("30.274700", "-97.740400")).toEqual({ lat: 30.2747, lng: -97.7404 });
  });

  it("refuses what is not a place", () => {
    expect(geo.parseLatLng(null, "-97.7")).toBeNull();
    expect(geo.parseLatLng("", "")).toBeNull();
    expect(geo.parseLatLng("north", "-97.7")).toBeNull();
    expect(geo.parseLatLng("91", "0.5")).toBeNull();
    expect(geo.parseLatLng("30", "-181")).toBeNull();
  });

  it("refuses null island, which is what a geocoder writes when it has nothing", () => {
    /**
     * A pin at 0, 0 draws a line from Austin to the Gulf of Guinea and tells
     * the optimiser a stop is eight thousand miles away.
     */
    expect(geo.parseLatLng("0", "0")).toBeNull();
    expect(geo.parseLatLng("0", "0.0001")).not.toBeNull();
  });

  it("formats to six places, about eleven centimetres", () => {
    expect(geo.formatCoordinate(30.27470001)).toBe("30.274700");
  });
});

describe("distance and drive time", () => {
  it("measures the great circle distance", () => {
    // The capitol to Round Rock is about 26.6 km in a straight line.
    expect(geo.haversineKm(AUSTIN_CAPITOL, ROUND_ROCK)).toBeCloseTo(26.6, 0);
    expect(geo.haversineKm(AUSTIN_CAPITOL, AUSTIN_CAPITOL)).toBe(0);
  });

  it("estimates a drive from the straight line, a road factor and a speed", () => {
    // 26.6 km x 1.3 = 34.6 km at 40 km/h is 51.9 minutes, rounded up.
    expect(geo.driveMinutes(AUSTIN_CAPITOL, ROUND_ROCK)).toBe(52);
    // Twice the speed, half the time near enough.
    expect(geo.driveMinutes(AUSTIN_CAPITOL, ROUND_ROCK, { averageKmh: 80, roadFactor: 1.3 })).toBe(26);
  });

  it("never calls a drive between two different points free", () => {
    /**
     * Next door is still getting back in the van, and a matrix of zeros
     * between neighbours makes every order of a street look equally good.
     */
    const nextDoor = { lat: AUSTIN_CAPITOL.lat + 0.0001, lng: AUSTIN_CAPITOL.lng };
    expect(geo.driveMinutes(AUSTIN_CAPITOL, nextDoor)).toBe(1);
    expect(geo.driveMinutes(AUSTIN_CAPITOL, AUSTIN_CAPITOL)).toBe(0);
  });

  it("refuses a speed of zero rather than dividing by it", () => {
    expect(() => geo.driveMinutes(AUSTIN_CAPITOL, ROUND_ROCK, { averageKmh: 0, roadFactor: 1.3 }))
      .toThrow(RangeError);
  });
});

describe("web mercator", () => {
  it("puts the origin of the world where every tile server puts it", () => {
    // Zoom 0 is one 256 pixel tile; longitude zero, latitude zero is its middle.
    expect(geo.project({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 });
    const corner = geo.project({ lat: geo.MAX_LATITUDE, lng: -180 }, 0);
    expect(corner.x).toBe(0);
    expect(corner.y).toBeCloseTo(0, 5);
  });

  it("names the same tile OpenStreetMap does", () => {
    /**
     * The OSM wiki's formula worked by hand for the Texas capitol at zoom 12:
     * x = (180 - 97.7404) / 360 x 4096 = 935.9, and
     * y = (1 - ln(tan 30.2747 + sec 30.2747) / pi) / 2 x 4096 = 1686.4.
     */
    const p = geo.project(AUSTIN_CAPITOL, 12);
    expect(Math.floor(p.x / 256)).toBe(935);
    expect(Math.floor(p.y / 256)).toBe(1686);
  });

  it("round trips a point through a pixel", () => {
    const back = geo.unproject(geo.project(ROUND_ROCK, 14), 14);
    expect(back.lat).toBeCloseTo(ROUND_ROCK.lat, 9);
    expect(back.lng).toBeCloseTo(ROUND_ROCK.lng, 9);
  });

  it("draws a point at the centre of a view centred on it, and reads a click back", () => {
    const view = { center: AUSTIN_CAPITOL, zoom: 13 };
    const size = { width: 800, height: 600 };
    expect(geo.toScreen(AUSTIN_CAPITOL, view, size)).toEqual({ x: 400, y: 300 });
    const clicked = geo.fromScreen(geo.toScreen(ROUND_ROCK, view, size), view, size);
    expect(clicked.lat).toBeCloseTo(ROUND_ROCK.lat, 9);
    expect(clicked.lng).toBeCloseTo(ROUND_ROCK.lng, 9);
  });

  it("fits every point in the view at the closest whole zoom", () => {
    const size = { width: 800, height: 600 };
    const view = geo.fitBounds([AUSTIN_CAPITOL, ROUND_ROCK], size);
    expect(Number.isInteger(view.zoom)).toBe(true);
    for (const point of [AUSTIN_CAPITOL, ROUND_ROCK]) {
      const at = geo.toScreen(point, view, size);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(size.width);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeLessThanOrEqual(size.height);
    }
    // And one zoom closer would not fit them.
    const closer = { ...view, zoom: view.zoom + 1 };
    const spread = geo.toScreen(ROUND_ROCK, closer, size).y - geo.toScreen(AUSTIN_CAPITOL, closer, size).y;
    expect(Math.abs(spread)).toBeGreaterThan(size.height - 80);
  });

  it("gives one point a street level view rather than infinite zoom", () => {
    expect(geo.fitBounds([AUSTIN_CAPITOL], { width: 800, height: 600 }).zoom).toBe(16);
    expect(geo.fitBounds([], { width: 800, height: 600 }).zoom).toBe(4);
  });

  it("covers the view with tiles, wraps across the antimeridian and never asks above the world", () => {
    const tiles = geo.tilesFor({ center: { lat: 0, lng: 179.9 }, zoom: 2 }, { width: 512, height: 512 });
    expect(tiles.every((t) => t.x >= 0 && t.x < 4)).toBe(true);
    expect(tiles.some((t) => t.x === 0)).toBe(true);
    const top = geo.tilesFor({ center: { lat: geo.MAX_LATITUDE, lng: 0 }, zoom: 3 }, { width: 256, height: 512 });
    expect(top.every((t) => t.y >= 0)).toBe(true);
  });

  it("fills a tile URL template", () => {
    expect(geo.tileUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { z: 12, x: 935, y: 1686 }))
      .toBe("https://tile.openstreetmap.org/12/935/1686.png");
    expect(geo.tileUrl("https://{s}.example/{z}/{x}/{y}", { z: 1, x: 1, y: 0 })).toBe("https://b.example/1/1/0");
  });
});

describe("geocoding state", () => {
  const now = new Date("2026-10-02T15:00:00Z");
  const base = {
    addressKey: "4102 ramsey ave||austin|tx|78756|us",
    locatedAddress: null, locationSource: null,
    attemptedAddress: null, retryAt: null, attempts: 0,
  };

  it("asks for an address nobody has looked up", () => {
    expect(geo.geocodeDue(base, now)).toBe(true);
  });

  it("does not ask again for an address already answered", () => {
    expect(geo.geocodeDue({ ...base, locatedAddress: base.addressKey, locationSource: "nominatim" }, now)).toBe(false);
  });

  it("asks again when the address changed", () => {
    expect(geo.geocodeDue({
      ...base, locatedAddress: "1 old st||austin|tx|78701|us", locationSource: "nominatim",
      attemptedAddress: "1 old st||austin|tx|78701|us",
    }, now)).toBe(true);
  });

  it("never asks over a pin somebody placed by hand, even after the address changed", () => {
    /**
     * The pin is the office knowing the gate is round the back. A backfill
     * that moved it back to the front door would undo the one piece of local
     * knowledge the map holds.
     */
    expect(geo.geocodeDue({ ...base, locationSource: geo.PLACED_BY_HAND, locatedAddress: "something else" }, now))
      .toBe(false);
  });

  it("does not ask again for an address the geocoder could not find, until it changes", () => {
    expect(geo.geocodeDue({ ...base, attemptedAddress: base.addressKey, retryAt: null, attempts: 1 }, now)).toBe(false);
  });

  it("asks again after a transient failure once its back off has passed", () => {
    const retryAt = geo.retryAfter(1, now);
    expect(retryAt.getTime() - now.getTime()).toBe(5 * 60_000);
    expect(geo.geocodeDue({ ...base, attemptedAddress: base.addressKey, retryAt, attempts: 1 }, now)).toBe(false);
    expect(geo.geocodeDue({ ...base, attemptedAddress: base.addressKey, retryAt, attempts: 1 }, retryAt)).toBe(true);
  });

  it("backs off by doubling and stops at a day", () => {
    expect(geo.retryAfter(3, now).getTime() - now.getTime()).toBe(20 * 60_000);
    expect(geo.retryAfter(30, now).getTime() - now.getTime()).toBe(24 * 60 * 60_000);
  });

  it("asks a geocoder for the building and not the suite", () => {
    expect(geo.addressQuery({
      addressLine1: " 900  Congress Ave", addressLine2: "Suite 400",
      city: "Austin", state: "TX", postalCode: "78701", country: "US",
    })).toBe("900 Congress Ave, Austin, TX, 78701, US");
  });

  it("keys an address so spacing and capitals are not a change", () => {
    const a = geo.addressKey({ addressLine1: "4102 Ramsey  Ave", city: "Austin", state: "TX", postalCode: "78756", country: "US" });
    const b = geo.addressKey({ addressLine1: "4102 ramsey ave ", addressLine2: null, city: "AUSTIN", state: "tx", postalCode: "78756", country: "us" });
    expect(a).toBe(b);
    expect(a).toBe("4102 ramsey ave||austin|tx|78756|us");
  });

  it("says how close a pin is in words", () => {
    expect(geo.isStreetLevel("rooftop")).toBe(true);
    expect(geo.isStreetLevel("placed")).toBe(true);
    expect(geo.isStreetLevel("postal_code")).toBe(false);
    expect(geo.describePrecision("postal_code")).toMatch(/postcode only/);
    expect(geo.describePrecision(null)).toBe("Not placed");
  });
});
