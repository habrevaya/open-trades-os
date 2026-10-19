import { describe, it, expect } from "vitest";
import { checkShape, tileAxes, type Tile } from "../src/dashboard/index.js";
import type { Dataset } from "../src/reporting/index.js";
import type { Permission } from "../src/access/permissions.js";

/**
 * A TILE CUT BY THE GROUPING SOMEBODY PICKS
 *
 * A tile broken down was always cut by its report's second grouping; to cut
 * it the other way round, the report had to be saved again grouped the other
 * way. Now the tile picks which of the report's two groupings cuts it.
 */
const JOBS: Dataset = {
  key: "jobs", label: "Jobs", description: "", from: "public.job", permission: "job:read" as Permission,
  scope: "job", dateColumn: "job.created_at",
  records: { noun: "job", plural: "jobs", id: "job.id", label: "job.number::text", href: "/jobs/{id}", columns: [], orderBy: "job.created_at" },
  dimensions: [
    { key: "month", label: "Month", sql: "x", type: "date" },
    { key: "status", label: "Status", sql: "job.status", type: "status" },
    { key: "job_type", label: "Job type", sql: "jt.name", type: "text" },
  ],
  measures: [
    { key: "count", label: "Jobs", kind: "count", type: "number" },
    { key: "average", label: "Average", kind: "avg", sql: "1", type: "number" },
  ],
};

const tile = (over: Partial<Tile>): Tile => ({
  key: "t", title: "Jobs by month and status", kind: "bars", width: 6, breakdown: "stacked",
  definition: { dataset: "jobs", dimensions: ["month", "status"], measures: ["count"] },
  ...over,
});
/** The same tile, not broken down. */
const plain = (over: Partial<Tile>): Tile => {
  const { breakdown: _breakdown, ...rest } = tile(over);
  return rest;
};

describe("which grouping cuts a tile", () => {
  it("is the report's second unless the tile picks its first, which it then draws along the second", () => {
    expect(tileAxes(tile({}))).toEqual({ along: "month", cutBy: "status" });
    expect(tileAxes(tile({ splitBy: "status" }))).toEqual({ along: "month", cutBy: "status" });
    expect(tileAxes(tile({ splitBy: "month" }))).toEqual({ along: "status", cutBy: "month" });
    expect(tileAxes(plain({}))).toBeNull();
  });

  it("takes either of the report's own groupings and nothing else", () => {
    expect(checkShape(tile({ splitBy: "month" }), JOBS)).toEqual({ ok: true });
    const wrong = checkShape(tile({ splitBy: "job_type" }), JOBS);
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.detail).toBe(
      "\"Jobs by month and status\" can be cut by month or by status, the two things its report is grouped by, and not by \"job_type\".",
    );
  });

  it("refuses a cut on a tile that is not broken down", () => {
    const decision = checkShape(plain({ splitBy: "status", definition: { dataset: "jobs", dimensions: ["status"], measures: ["count"] } }), JOBS);
    expect(!decision.ok && decision.detail).toMatch(/not broken down, so there is nothing to cut it by/);
  });

  it("keeps a trend running along a date: cut by the date, it is refused in words", () => {
    expect(checkShape(tile({ kind: "trend" }), JOBS)).toEqual({ ok: true });
    const decision = checkShape(tile({ kind: "trend", splitBy: "month" }), JOBS);
    expect(!decision.ok && decision.detail).toBe(
      "A trend needs a date to run along. Cut by month, \"Jobs by month and status\" runs along status, which is not one: cut it by status instead.",
    );
  });

  it("names the grouping that cuts it when an average cannot be stacked", () => {
    const decision = checkShape(tile({ splitBy: "month", definition: { dataset: "jobs", dimensions: ["month", "status"], measures: ["average"] } }), JOBS);
    expect(!decision.ok && decision.detail).toMatch(/Set month side by side instead/);
  });
});
