import { describe, it, expect } from "vitest";
import { keyFor, tileFromForm, withoutTile, moved } from "@/lib/dashboard-tiles";
import type { dashboards } from "@opentradesos/api/services";

type StoredTile = dashboards.StoredTile;

const tile = (key: string, over: Partial<StoredTile> = {}): StoredTile => ({
  key, kind: "bars", width: 6, builtIn: key, ...over,
});

const form = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
});

/**
 * Three small array functions and a parser. Exactly the size of thing that
 * looks too obvious to test and then drops a tile, swaps the wrong pair, or
 * mints a key that collides with one already on the dashboard, none of which
 * throws and none of which is visible until somebody's layout is wrong.
 */
describe("naming a new tile", () => {
  it("names it after the report it shows", () => {
    // Readable in the stored row, which is where somebody debugging a
    // dashboard actually looks.
    expect(keyFor("ar-aging", [])).toBe("ar-aging");
  });

  it("suffixes when that report is already on the dashboard", () => {
    // Legitimate: the same numbers as a headline and as a trend is a real
    // layout, and two tiles sharing a key means removing one removes both.
    expect(keyFor("ar-aging", [tile("ar-aging")])).toBe("ar-aging-2");
    expect(keyFor("ar-aging", [tile("ar-aging"), tile("ar-aging-2")])).toBe("ar-aging-3");
  });

  it("does not reuse a suffix that is taken out of order", () => {
    expect(keyFor("x", [tile("x"), tile("x-3")])).toBe("x-2");
    expect(keyFor("x", [tile("x"), tile("x-2"), tile("x-3")])).toBe("x-4");
  });
});

describe("reading the add form", () => {
  it("tells a saved report from one that ships", () => {
    /**
     * A uuid and a slug are both strings, so the kind travels with the
     * value. Guessing between them would be wrong exactly when somebody
     * names a saved report after a built-in one, which is the likeliest
     * time for somebody to have two of them.
     */
    expect(tileFromForm(form({ report: "saved:abc-123", kind: "bars", width: "6" }), []))
      .toEqual({ key: "abc-123", kind: "bars", width: 6, reportId: "abc-123" });

    expect(tileFromForm(form({ report: "builtIn:ar-aging", kind: "bars", width: "6" }), []))
      .toEqual({ key: "ar-aging", kind: "bars", width: 6, builtIn: "ar-aging" });
  });

  it("leaves the title off when it is blank", () => {
    // So the tile shows the report's own name, and keeps showing it after
    // somebody renames the report.
    const result = tileFromForm(
      form({ report: "builtIn:ar-aging", kind: "bars", width: "6", title: "   " }), [],
    );
    expect(result).not.toHaveProperty("title");
  });

  it("keeps a title somebody typed", () => {
    const result = tileFromForm(
      form({ report: "builtIn:ar-aging", kind: "bars", width: "6", title: " What we are owed " }), [],
    );
    expect(result?.title).toBe("What we are owed");
  });

  it("refuses a shape or a width it does not have", () => {
    expect(tileFromForm(form({ report: "builtIn:x", kind: "pie", width: "6" }), [])).toBeNull();
    expect(tileFromForm(form({ report: "builtIn:x", kind: "bars", width: "7" }), [])).toBeNull();
  });

  it("refuses a source that names neither kind", () => {
    expect(tileFromForm(form({ report: "ar-aging", kind: "bars", width: "6" }), [])).toBeNull();
    expect(tileFromForm(form({ report: "saved:", kind: "bars", width: "6" }), [])).toBeNull();
    expect(tileFromForm(form({ kind: "bars", width: "6" }), [])).toBeNull();
  });
});

describe("removing a tile", () => {
  it("removes exactly one", () => {
    const tiles = [tile("a"), tile("b"), tile("c")];
    expect(withoutTile(tiles, "b").map((t) => t.key)).toEqual(["a", "c"]);
  });

  it("does nothing to a key that is not there", () => {
    const tiles = [tile("a")];
    expect(withoutTile(tiles, "zzz")).toEqual(tiles);
  });

  it("does not mutate what it was given", () => {
    const tiles = [tile("a"), tile("b")];
    withoutTile(tiles, "a");
    expect(tiles.map((t) => t.key)).toEqual(["a", "b"]);
  });
});

describe("moving a tile", () => {
  const keys = (tiles: StoredTile[]) => tiles.map((t) => t.key);
  const three = () => [tile("a"), tile("b"), tile("c")];

  it("swaps it with its neighbour", () => {
    expect(keys(moved(three(), "b", -1))).toEqual(["b", "a", "c"]);
    expect(keys(moved(three(), "b", 1))).toEqual(["a", "c", "b"]);
  });

  it("does nothing at the ends, rather than wrapping", () => {
    /**
     * A tile that jumps from the top of the dashboard to the bottom because
     * somebody pressed up once too often is a change they then have to undo
     * and will not be sure how.
     */
    expect(keys(moved(three(), "a", -1))).toEqual(["a", "b", "c"]);
    expect(keys(moved(three(), "c", 1))).toEqual(["a", "b", "c"]);
  });

  it("loses nothing", () => {
    // The splice pair is where a tile goes missing, and a shorter list still
    // renders perfectly well.
    for (const key of ["a", "b", "c"]) {
      for (const by of [-1, 1]) {
        expect(moved(three(), key, by), `${key} ${by}`).toHaveLength(3);
      }
    }
  });

  it("does nothing to a key that is not there", () => {
    expect(keys(moved(three(), "zzz", 1))).toEqual(["a", "b", "c"]);
  });

  it("does not mutate what it was given", () => {
    const tiles = three();
    moved(tiles, "a", 1);
    expect(keys(tiles)).toEqual(["a", "b", "c"]);
  });
});
