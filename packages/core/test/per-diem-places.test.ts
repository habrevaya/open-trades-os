import { describe, it, expect } from "vitest";
import { payExtras as px } from "../src/index.js";

/**
 * A DAY AWAY THAT IS WORTH SOMETHING ELSE IN SOME PLACES
 *
 * The company keeps places with a day rate each, from a date. A day is worked out at the rate in
 * force at its place on that day, a place is found from a job's address by its city only, and
 * nothing is guessed from a near miss.
 */
const austin = (rates: px.PerDiemRate[] = [{ from: "2026-01-01", perDay: "75.00" }]): px.PerDiemPlace =>
  ({ id: "p-austin", name: "Austin", state: "TX", city: "Austin", rates, retired: false });
const away = (): px.PerDiemPlace =>
  ({ id: "p-away", name: "Out of state", state: null, city: null, rates: [{ from: "2026-01-01", perDay: "110.00" }], retired: false });

describe("adding a place", () => {
  it("tidies the name, the state and the city, and starts the place with its first rate", () => {
    const added = px.addPerDiemPlace([], { name: "  Round   Rock ", state: "tx", city: " Round Rock ", from: "2026-03-01", perDay: "80" }, "id-1");
    expect(added).toEqual({
      ok: true,
      places: [{ id: "id-1", name: "Round Rock", state: "TX", city: "Round Rock", rates: [{ from: "2026-03-01", perDay: "80.00" }], retired: false }],
    });
  });

  it("takes a place with only a name", () => {
    const added = px.addPerDiemPlace([], { name: "Out of state", from: "2026-01-01", perDay: "110" }, "id-2");
    expect(added.ok && added.places[0]).toMatchObject({ state: null, city: null });
  });

  it("refuses an empty name, a state that is not two letters, a bad rate and a bad day, in words", () => {
    const bad = (input: Partial<Parameters<typeof px.addPerDiemPlace>[1]>) =>
      px.addPerDiemPlace([], { name: "Austin", from: "2026-01-01", perDay: "75", ...input }, "x");
    expect(bad({ name: "  " })).toEqual({ ok: false, reason: "Give the place a name, like Austin or Out of state." });
    expect(bad({ state: "Texas" })).toMatchObject({ ok: false, reason: expect.stringContaining("two letters") });
    expect(bad({ perDay: "seventy" })).toMatchObject({ ok: false, reason: expect.stringContaining("dollars and cents") });
    expect(bad({ perDay: "5000" })).toMatchObject({ ok: false, reason: expect.stringContaining("slip of the keys") });
    expect(bad({ from: "soon" })).toEqual({ ok: false, reason: "Say the first day the rate applies." });
  });

  it("refuses a second place in use with the same name, however it was typed, but allows one that was retired", () => {
    const places = [austin()];
    expect(px.addPerDiemPlace(places, { name: " AUSTIN ", from: "2026-01-01", perDay: "75" }, "x"))
      .toMatchObject({ ok: false, reason: expect.stringContaining("already a place called AUSTIN") });
    const retired = [{ ...austin(), retired: true }];
    expect(px.addPerDiemPlace(retired, { name: "Austin", from: "2026-01-01", perDay: "75" }, "x").ok).toBe(true);
  });
});

describe("a place's rates", () => {
  it("is the latest that started on or before the day, and none before the first", () => {
    const place = austin([{ from: "2026-01-01", perDay: "75.00" }, { from: "2026-07-01", perDay: "85.00" }]);
    expect(px.perDiemRateOn(place, "2025-12-31")).toBeNull();
    expect(px.perDiemRateOn(place, "2026-01-01")).toBe("75.00");
    expect(px.perDiemRateOn(place, "2026-06-30")).toBe("75.00");
    expect(px.perDiemRateOn(place, "2026-07-01")).toBe("85.00");
  });

  it("adds a rate in date order and refuses a second for a day, naming the place", () => {
    const added = px.addPerDiemPlaceRate([austin()], "p-austin", { from: "2025-06-01", perDay: "70" });
    expect(added.ok && added.places[0]!.rates.map((r) => r.from)).toEqual(["2025-06-01", "2026-01-01"]);
    expect(px.addPerDiemPlaceRate([austin()], "p-austin", { from: "2026-01-01", perDay: "90" }))
      .toEqual({ ok: false, reason: "Austin already has a rate from 2026-01-01. Take it off first if it is wrong." });
    expect(px.addPerDiemPlaceRate([austin()], "nope", { from: "2026-02-01", perDay: "90" }))
      .toEqual({ ok: false, reason: "That place is not on the list." });
    expect(px.addPerDiemPlaceRate([{ ...austin(), retired: true }], "p-austin", { from: "2026-02-01", perDay: "90" }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("no longer used") });
  });

  it("takes a rate off by its day, and says when there is none", () => {
    const removed = px.removePerDiemPlaceRate([austin()], "p-austin", "2026-01-01");
    expect(removed.ok && removed.places[0]!.rates).toEqual([]);
    expect(px.removePerDiemPlaceRate([austin()], "p-austin", "2026-02-01"))
      .toEqual({ ok: false, reason: "Austin has no rate from 2026-02-01." });
  });
});

describe("which place a job's address is in", () => {
  it("is the place with that city, however the city was typed", () => {
    expect(px.placeForAddress([austin(), away()], { city: "  AUSTIN ", state: "tx" })).toMatchObject({ kind: "one", place: { id: "p-austin" } });
  });

  it("is none for a near miss, another state, a place that has no city, or a retired place", () => {
    expect(px.placeForAddress([austin()], { city: "Austin Heights", state: "TX" })).toEqual({ kind: "none" });
    expect(px.placeForAddress([austin()], { city: "Austin", state: "MN" })).toEqual({ kind: "none" });
    expect(px.placeForAddress([away()], { city: "Dallas", state: "TX" })).toEqual({ kind: "none" });
    expect(px.placeForAddress([{ ...austin(), retired: true }], { city: "Austin", state: "TX" })).toEqual({ kind: "none" });
  });

  it("matches a city place with no state on any state, and asks when two places match", () => {
    const anyState = { ...austin(), id: "p-any", name: "Any Austin", state: null };
    expect(px.placeForAddress([anyState], { city: "Austin", state: "MN" })).toMatchObject({ kind: "one" });
    const both = px.placeForAddress([austin(), anyState], { city: "Austin", state: "TX" });
    expect(both.kind).toBe("several");
  });
});

describe("reading the settings", () => {
  it("reads places, drops what is not a place, and keeps the first of two rates for a day", () => {
    const read = px.readPaySettings({
      perDiemPlaces: [
        { id: "a", name: "Austin", state: "tx", city: "Austin", rates: [{ from: "2026-07-01", perDay: "85" }, { from: "2026-01-01", perDay: "75" }, { from: "2026-01-01", perDay: "99" }, { from: "x", perDay: "1" }] },
        { id: "a", name: "Duplicate id" },
        { name: "No id" },
        "banana",
        { id: "b", name: "" },
        { id: "c", name: "Gone", retired: true },
      ],
    }).perDiemPlaces;
    expect(read.map((p) => p.id)).toEqual(["a", "c"]);
    expect(read[0]).toMatchObject({ state: "TX", rates: [{ from: "2026-01-01", perDay: "75.00" }, { from: "2026-07-01", perDay: "85.00" }] });
    expect(read[1]!.retired).toBe(true);
    expect(px.readPaySettings({}).perDiemPlaces).toEqual([]);
    expect(px.readPaySettings({ perDiemPlaces: "Austin" }).perDiemPlaces).toEqual([]);
  });
});
