import { describe, it, expect } from "vitest";
import { geo, reporting as r } from "../src/index";

const home = (over: Partial<r.StreetSubscription> = {}): r.StreetSubscription =>
  ({ street: "Oak Street", city: "Austin", state: "TX", commercial: false, hasAddress: true, ...over });

describe("the street an address is on", () => {
  it("keeps the street as it was given, spaced once, and blank as nothing", () => {
    expect(geo.streetName("  Oak   Street ")).toBe("Oak Street");
    expect(geo.streetName("   ")).toBeNull();
    expect(geo.streetName(null)).toBeNull();
  });

  it("keys a street by its name, its town and its state, in small letters", () => {
    expect(geo.streetKey("Oak Street", "Austin", "TX")).toBe("oak street|austin|tx");
    expect(geo.streetKey(" oak  STREET", "austin ", "tx")).toBe(geo.streetKey("Oak Street", "Austin", "TX"));
    /** A Main Street in two towns is two streets. */
    expect(geo.streetKey("Main Street", "Austin", "TX")).not.toBe(geo.streetKey("Main Street", "Round Rock", "TX"));
    /** Nothing is expanded: two spellings typed by hand are two keys, which reads a lower density, never a higher. */
    expect(geo.streetKey("Oak St", "Austin", "TX")).not.toBe(geo.streetKey("Oak Street", "Austin", "TX"));
    expect(geo.streetKey("", "Austin", "TX")).toBeNull();
  });

  it("is the address's only while it answers for the address as it is now", () => {
    const state = { addressKey: "12 oak street|", street: "Oak Street", streetSource: "nominatim", streetForAddress: "12 oak street|", streetAttemptedAddress: "12 oak street|" };
    expect(geo.streetOf(state)).toBe("Oak Street");
    expect(geo.streetOf({ ...state, addressKey: "9 elm road|" })).toBeNull();
  });

  it("asks the geocoder once per address, never over a typed street, and after a back off", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const base = { addressKey: "a", street: null, streetSource: null, streetForAddress: null, streetAttemptedAddress: null, retryAt: null };
    expect(geo.streetDue(base, now)).toBe(true);
    expect(geo.streetDue({ ...base, streetAttemptedAddress: "a" }, now)).toBe(false);
    expect(geo.streetDue({ ...base, streetSource: geo.STREET_TYPED, streetForAddress: "a", street: "Oak Street" }, now)).toBe(false);
    /** Typed for an address it no longer is: asked again for the new one. */
    expect(geo.streetDue({ ...base, streetSource: geo.STREET_TYPED, streetForAddress: "old", street: "Oak Street" }, now)).toBe(true);
    expect(geo.streetDue({ ...base, retryAt: new Date("2026-06-01T13:00:00Z") }, now)).toBe(false);
    expect(geo.streetDue({ ...base, retryAt: new Date("2026-06-01T11:00:00Z") }, now)).toBe(true);
  });
});

describe("homes per served street", () => {
  it("is active subscriptions over the distinct streets they are on", () => {
    expect(r.streetDensityOf([
      home(), home({ street: "oak  street" }), home({ street: "Elm Road" }),
    ])).toEqual({ subscriptions: 3, streets: 2, commercial: 0, unknown: 0 });
  });

  it("leaves commercial stops out of both halves", () => {
    expect(r.streetDensityOf([home(), home({ street: "Mill Lane", commercial: true })]))
      .toEqual({ subscriptions: 1, streets: 1, commercial: 1, unknown: 0 });
  });

  it("leaves a home with no street recorded out of both halves rather than guessing it", () => {
    expect(r.streetDensityOf([home(), home({ street: null }), home({ hasAddress: false })]))
      .toEqual({ subscriptions: 1, streets: 1, commercial: 0, unknown: 2 });
  });

  it("counts a street in two towns as two streets", () => {
    expect(r.streetDensityOf([home({ street: "Main Street" }), home({ street: "Main Street", city: "Round Rock" })]))
      .toMatchObject({ subscriptions: 2, streets: 2 });
  });
});
