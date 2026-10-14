import { describe, it, expect } from "vitest";
import { resolveDashboard, checkShape, proportion, addsUp } from "../src/dashboard/index.js";
import type { DashboardDefinition, Tile } from "../src/dashboard/index.js";
import type { Dataset } from "../src/reporting/index.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * A dashboard is a list of reports with a shape attached. Everything worth
 * testing here is about the two joins that makes: whether the tile's shape
 * and its report agree, and what happens to a tile the reader cannot run.
 */
const INVOICES: Dataset = {
  key: "invoices",
  label: "Invoices",
  description: "",
  from: "public.invoice",
  permission: "report.financial:read" as Permission,
  scope: "invoice",
  dateColumn: "invoice.issued_on",
  records: {
    noun: "invoice", plural: "invoices", id: "invoice.id", label: "invoice.number::text",
    href: "/invoices/{id}", columns: [], orderBy: "invoice.issued_on",
  },
  dimensions: [
    { key: "status", label: "Status", sql: "invoice.status", type: "text" },
    { key: "month", label: "Month", sql: "to_char(x)", type: "date" },
    { key: "customer", label: "Customer", sql: "c.name", type: "text" },
  ],
  measures: [
    { key: "count", label: "Invoices", kind: "count", type: "number" },
    { key: "total", label: "Invoiced", kind: "sum", sql: "invoice.total", type: "money" },
  ],
};

const JOBS: Dataset = {
  key: "jobs",
  label: "Jobs",
  description: "",
  from: "public.job",
  permission: "job:read" as Permission,
  scope: "job",
  dateColumn: "job.created_at",
  records: {
    noun: "job", plural: "jobs", id: "job.id", label: "job.number::text",
    href: "/jobs/{id}", columns: [], orderBy: "job.created_at",
  },
  dimensions: [{ key: "status", label: "Status", sql: "job.status", type: "text" }],
  measures: [{ key: "count", label: "Jobs", kind: "count", type: "number" }],
};

const CATALOGUE = [INVOICES, JOBS];
const ALL = new Set<Permission>(["report.financial:read", "job:read"] as Permission[]);
const DISPATCHER = new Set<Permission>(["job:read"] as Permission[]);

const tile = (over: Partial<Tile>): Tile => ({
  key: "t", title: "A tile", kind: "number", width: 3,
  definition: { dataset: "invoices", dimensions: [], measures: ["total"] },
  ...over,
});

const board = (tiles: Tile[]): DashboardDefinition =>
  ({ key: "d", title: "A dashboard", description: "", tiles });

describe("the shape of a tile against its report", () => {
  it("refuses a number tile that groups by something", () => {
    // It would draw a hundred rows as whichever one came back first, which
    // is a number that looks fine and is not the total of anything.
    const decision = checkShape(
      tile({ kind: "number", definition: { dataset: "invoices", dimensions: ["status"], measures: ["total"] } }),
      INVOICES,
    );
    expect(decision.ok).toBe(false);
  });

  it("refuses a bar tile with no dimension, or with two", () => {
    for (const dimensions of [[], ["status", "customer"]]) {
      const decision = checkShape(
        tile({ kind: "bars", definition: { dataset: "invoices", dimensions, measures: ["total"] } }),
        INVOICES,
      );
      expect(decision.ok, dimensions.join("+")).toBe(false);
    }
  });

  it("refuses a trend that has no date to run along", () => {
    /**
     * The one worth catching. It renders as a perfectly ordinary chart, and
     * a chart over time implies a sequence: "invoiced by customer" drawn as
     * a trend reads as revenue rising, when the order is alphabetical.
     */
    const decision = checkShape(
      tile({ kind: "trend", definition: { dataset: "invoices", dimensions: ["customer"], measures: ["total"] } }),
      INVOICES,
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.detail).toMatch(/Customer/);
  });

  it("allows a trend over a date", () => {
    expect(checkShape(
      tile({ kind: "trend", definition: { dataset: "invoices", dimensions: ["month"], measures: ["total"] } }),
      INVOICES,
    ).ok).toBe(true);
  });

  it("refuses a tile drawing a measure its own report does not select", () => {
    // It would draw nothing, in a tile that looks like it is working.
    expect(checkShape(
      tile({ measure: "count", definition: { dataset: "invoices", dimensions: [], measures: ["total"] } }),
      INVOICES,
    ).ok).toBe(false);
  });
});

describe("resolving a whole dashboard", () => {
  it("drops a tile the reader may not run, silently", () => {
    /**
     * Same rule as the navigation, and for the same reason. A gap reading
     * "you need report.financial:read" teaches a dispatcher the shape of
     * what is being kept from them, which is both unkind and a disclosure.
     */
    const decision = resolveDashboard(
      board([
        tile({ key: "money" }),
        tile({ key: "work", definition: { dataset: "jobs", dimensions: [], measures: ["count"] } }),
      ]),
      CATALOGUE, DISPATCHER,
    );

    expect(decision.tiles.map((t) => t.tile.key)).toEqual(["work"]);
  });

  it("keeps a broken tile, with its reason", () => {
    // The opposite case, and the distinction is the whole point: hiding a
    // misconfigured tile means nobody ever finds out it is misconfigured.
    const decision = resolveDashboard(
      board([tile({ definition: { dataset: "invoices", dimensions: [], measures: ["nonsense"] } })]),
      CATALOGUE, ALL,
    );

    expect(decision.tiles).toHaveLength(1);
    expect(decision.tiles[0]!.ok).toBe(false);
    expect(decision.tiles[0]!.ok === false && "detail" in decision.tiles[0]!).toBe(true);
  });

  it("defaults to the only measure the tile selects", () => {
    const decision = resolveDashboard(board([tile({})]), CATALOGUE, ALL);
    expect(decision.tiles[0]!.ok === true && decision.tiles[0]!.measure).toBe("total");
  });

  it("keeps the tiles in the order they were laid out", () => {
    // A dashboard is a layout. Reordering it because one tile resolved
    // faster would move things around under somebody who knows where they
    // are, which is most of what a dashboard is for.
    const decision = resolveDashboard(
      board([tile({ key: "a" }), tile({ key: "b" }), tile({ key: "c" })]),
      CATALOGUE, ALL,
    );
    expect(decision.tiles.map((t) => t.tile.key)).toEqual(["a", "b", "c"]);
  });
});

describe("how long a bar is", () => {
  it("is the share of the biggest value", () => {
    expect(proportion(50, 100)).toBe(0.5);
    expect(proportion(100, 100)).toBe(1);
  });

  it("gives zero no bar at all", () => {
    // "None" and "a little" are different answers, and a hairline beside a
    // zero says the second one.
    expect(proportion(0, 100)).toBe(0);
  });

  it("survives an empty tile without dividing by nothing", () => {
    expect(proportion(0, 0)).toBe(0);
    expect(proportion(10, 0)).toBe(0);
    expect(proportion(Number.NaN, 100)).toBe(0);
  });

  it("never draws past the end", () => {
    expect(proportion(150, 100)).toBe(1);
  });
});

describe("a tile broken down by its report's second grouping", () => {
  const AVERAGED: Dataset = {
    ...INVOICES,
    measures: [...INVOICES.measures, { key: "average", label: "Average invoice", kind: "avg", sql: "invoice.total", type: "money" }],
  };
  const twoWays = (over: Partial<Tile>): Tile => tile({
    kind: "bars",
    definition: { dataset: "invoices", dimensions: ["customer", "status"], measures: ["total"] },
    ...over,
  });

  it("draws a report grouped by two things, stacked or side by side", () => {
    expect(checkShape(twoWays({ breakdown: "stacked" }), INVOICES).ok).toBe(true);
    expect(checkShape(twoWays({ breakdown: "grouped" }), INVOICES).ok).toBe(true);
  });

  it("still refuses two groupings with no breakdown, and says how to draw them", () => {
    // Before, the words only counted the groupings. Now they say the way out.
    const decision = checkShape(twoWays({}), INVOICES);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.detail).toMatch(/grouped by customer and status: break it down/);
  });

  it("needs exactly two groupings to break down: one to draw and one to cut by", () => {
    for (const dimensions of [["customer"], ["customer", "status", "month"]]) {
      const decision = checkShape(
        twoWays({ breakdown: "grouped", definition: { dataset: "invoices", dimensions, measures: ["total"] } }),
        INVOICES,
      );
      expect(decision.ok, dimensions.join("+")).toBe(false);
    }
  });

  it("refuses to stack an average, whose parts do not add up to the bar, and offers side by side", () => {
    /**
     * Two average invoices stacked draw a bar as long as their sum, which is
     * no figure at all and looks exactly like a total.
     */
    const averaged = twoWays({ definition: { dataset: "invoices", dimensions: ["customer", "status"], measures: ["average"] } });
    const stacked = checkShape({ ...averaged, breakdown: "stacked" }, AVERAGED);
    expect(stacked.ok).toBe(false);
    expect(stacked.ok === false && stacked.detail).toMatch(/Average invoice cannot be stacked.*Set status side by side/);
    expect(checkShape({ ...averaged, breakdown: "grouped" }, AVERAGED).ok).toBe(true);
  });

  it("judges the measure the tile draws, not only the report's first", () => {
    const both = twoWays({
      breakdown: "stacked", measure: "average",
      definition: { dataset: "invoices", dimensions: ["customer", "status"], measures: ["total", "average"] },
    });
    expect(checkShape(both, AVERAGED).ok).toBe(false);
    expect(checkShape({ ...both, measure: "total" }, AVERAGED).ok).toBe(true);
  });

  it("keeps a trend's first grouping a date", () => {
    expect(checkShape(twoWays({
      kind: "trend", breakdown: "stacked",
      definition: { dataset: "invoices", dimensions: ["month", "status"], measures: ["total"] },
    }), INVOICES).ok).toBe(true);
    const decision = checkShape(twoWays({ kind: "trend", breakdown: "stacked" }), INVOICES);
    expect(decision.ok === false && decision.detail).toMatch(/Customer/);
  });

  it("refuses a number tile broken down, which has nothing to cut", () => {
    expect(checkShape(tile({ kind: "number", breakdown: "stacked" }), INVOICES).ok).toBe(false);
  });

  it("adds up a count and a sum, and nothing else", () => {
    expect(["count", "sum", "avg", "min", "max"].map(addsUp)).toEqual([true, true, false, false, false]);
  });
});
