import { describe, it, expect } from "vitest";
import { withCut } from "@/lib/dashboard-tiles";
import type { dashboards } from "@opentradesos/api/services";

type StoredTile = dashboards.StoredTile;

const tile = (key: string, over: Partial<StoredTile> = {}): StoredTile => ({
  key, kind: "bars", width: 6, builtIn: key, breakdown: "stacked", ...over,
});

describe("cutting a tile by another of its report's groupings", () => {
  it("changes that tile's cut and nothing else, in place", () => {
    const before = [tile("a"), tile("b", { title: "Mine" }), tile("c")];
    const after = withCut(before, "b", "status");
    expect(after.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(after[1]).toEqual({ ...before[1], splitBy: "status" });
    expect(after[0]).toBe(before[0]);
    // Not mutated: the list the form carried is still what it was.
    expect(before[1]!.splitBy).toBeUndefined();
  });
});
