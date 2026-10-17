import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

describe("fresh water per stop, per truck", () => {
  it("is a truck's water over its stops, on the days it has both", () => {
    const result = r.waterPerStopOf([
      { truck: "T1", gallons: 300, stops: 60 },
      { truck: "T1", gallons: 330, stops: 60 },
      { truck: "T2", gallons: 400, stops: 50 },
    ]);
    expect([result.gallons, result.stops]).toEqual([1030, 170]);
    expect(result.byTruck.get("T1")).toEqual({ gallons: 630, stops: 120 });
    expect(result.byTruck.get("T2")).toEqual({ gallons: 400, stops: 50 });
  });

  it("leaves a day with stops and no reading out of both halves, rather than reading it as no water", () => {
    const result = r.waterPerStopOf([{ truck: "T1", gallons: 300, stops: 60 }, { truck: "T1", gallons: null, stops: 70 }]);
    expect([result.gallons, result.stops, result.notRead]).toEqual([300, 60, 1]);
  });

  it("leaves water read on a day with no stop out of both halves", () => {
    const result = r.waterPerStopOf([{ truck: "T1", gallons: 80, stops: 0 }, { truck: "T2", gallons: null, stops: 0 }]);
    expect([result.gallons, result.stops, result.noStops, result.notRead]).toEqual([0, 0, 1, 0]);
  });
});
