import { describe, it, expect } from "vitest";
import { withSecondMeasure, withFollowsDates } from "@/lib/dashboard-tiles";
import type { dashboards } from "@opentradesos/api/services";

type StoredTile = dashboards.StoredTile;

const tile = (key: string, over: Partial<StoredTile> = {}): StoredTile => ({
  key, kind: "trend", width: 12, builtIn: key, ...over,
});

describe("a second measure on a tile", () => {
  it("sets it on that tile alone, takes it off on a blank, and does not mutate the list", () => {
    const before = [tile("a"), tile("b", { title: "Mine" })];
    const set = withSecondMeasure(before, "b", "count");
    expect(set[1]).toEqual({ ...before[1], secondMeasure: "count" });
    expect(set[0]).toBe(before[0]);
    expect(before[1]!.secondMeasure).toBeUndefined();
    const off = withSecondMeasure(set, "b", "");
    expect(off[1]).toEqual(before[1]);
    expect("secondMeasure" in off[1]!).toBe(false);
  });
});

describe("a tile following the dashboard's dates", () => {
  it("turns on and off for that tile alone", () => {
    const before = [tile("a"), tile("b")];
    const on = withFollowsDates(before, "a", true);
    expect(on[0]!.followsDates).toBe(true);
    expect(on[1]).toBe(before[1]);
    const off = withFollowsDates(on, "a", false);
    expect("followsDates" in off[0]!).toBe(false);
  });
});
