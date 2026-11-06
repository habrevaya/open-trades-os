import { describe, it, expect } from "vitest";
import {
  buildInspection, checkCount, checkpointKind, expectationText, sectionsOf,
  type FieldInspectionProgram,
} from "../src/index";

/**
 * PHOTO, NOTE AND COUNT CHECKPOINTS, OPTIONAL ONES AND SECTIONS, ON THE PHONE.
 *
 * The same rule as a reading: what was seen is sent, a checkpoint with
 * nothing usable on it is named and never guessed at, and the verdict is the
 * server's. An optional checkpoint left blank is named as skipped and does
 * not hold the inspection up.
 */

const base = { requiresReading: false, unit: null, min: null, max: null };
const program: FieldInspectionProgram = {
  id: "p1", name: "Sprinkler annual", standard: "NFPA 25", version: 1,
  checkpoints: [
    { key: "photo", label: "Nameplate photo", ...base, kind: "photo", section: "Pump room" },
    { key: "psi", label: "Churn pressure", requiresReading: true, unit: "psi", min: 90, max: 120, section: "Pump room", codeReference: "NFPA 25 8.3.3.1" },
    { key: "heads", label: "Spare heads", ...base, kind: "count", expectedAtLeast: 6, section: "Riser" },
    { key: "note", label: "Anything else", ...base, kind: "note", optional: true, section: "Riser" },
    { key: "gauge", label: "Gauges in date", ...base, optional: true, section: "Riser" },
  ],
};
const at = new Date("2026-10-03T15:00:00Z");
const iso = at.toISOString();

describe("the kinds a checkpoint takes", () => {
  it("reads a kind, and falls back to a reading or a pass or fail from an older server", () => {
    expect(program.checkpoints.map(checkpointKind)).toEqual(["photo", "reading", "count", "note", "pass_fail"]);
  });

  it("puts the checkpoints under their headings in order", () => {
    expect(sectionsOf(program).map((s) => [s.title, s.checkpoints.map((c) => c.key)])).toEqual([
      ["Pump room", ["photo", "psi"]],
      ["Riser", ["heads", "note", "gauge"]],
    ]);
    const flat = { ...program, checkpoints: program.checkpoints.map(({ section: _section, ...c }) => c) };
    expect(sectionsOf(flat).map((s) => s.title)).toEqual([null]);
  });

  it("says what passes beside the box", () => {
    expect(program.checkpoints.map(expectationText)).toEqual(["", "90 to 120", "at least 6", "", ""]);
  });

  it("says a count short of what there should be, and refuses one that is not a whole number", () => {
    const heads = program.checkpoints[2]!;
    expect(checkCount(heads, "")).toEqual({ state: "empty" });
    expect(checkCount(heads, "6")).toEqual({ state: "in_range" });
    expect(checkCount(heads, "4")).toMatchObject({ state: "out_of_range", message: expect.stringMatching(/Fewer than the 6/) });
    expect(checkCount(heads, "4.5")).toMatchObject({ state: "not_a_number" });
  });
});

describe("building the answers", () => {
  it("sends a photo, a count and a note as their own answers, and names an optional one skipped", () => {
    const built = buildInspection({
      program, by: "Ray Nunez", at,
      entries: {
        photo: { photoIds: ["u1", "u2"] },
        psi: { reading: "104", photoIds: ["u3"] },
        heads: { count: "4", note: "Two used last month" },
        note: { text: "  Riser room used for storage " },
      },
    });
    expect(built.answers).toEqual([
      { itemKey: "photo", value: { kind: "photo", photoIds: ["u1", "u2"] }, at: iso, by: "Ray Nunez" },
      { itemKey: "psi", value: { kind: "reading", raw: 104 }, at: iso, by: "Ray Nunez", photoIds: ["u3"] },
      { itemKey: "heads", value: { kind: "count", count: 4 }, at: iso, by: "Ray Nunez", note: "Two used last month" },
      { itemKey: "note", value: { kind: "note", text: "Riser room used for storage" }, at: iso, by: "Ray Nunez" },
    ]);
    expect(built.unanswered).toEqual([]);
    expect(built.optionalSkipped).toEqual(["Gauges in date"]);
  });

  it("leaves out a photo checkpoint with no photo, a blank note and a count that is not a number", () => {
    const built = buildInspection({
      program, by: "R", at,
      entries: { photo: { photoIds: [] }, heads: { count: "a few" }, note: { text: "   " } },
    });
    expect(built.answers).toEqual([]);
    expect(built.unanswered).toEqual(["Nameplate photo", "Churn pressure", "Spare heads"]);
    expect(built.unreadable).toEqual(["Spare heads"]);
    expect(built.optionalSkipped).toEqual(["Anything else", "Gauges in date"]);
  });

  it("takes not applicable on any kind, with a reason", () => {
    const built = buildInspection({ program, by: "R", at, entries: { photo: { notApplicable: "No nameplate left on it" } } });
    expect(built.answers).toContainEqual(expect.objectContaining({
      itemKey: "photo", value: { kind: "not_applicable", why: "No nameplate left on it" },
    }));
  });
});
