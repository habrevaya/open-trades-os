import { describe, it, expect } from "vitest";
import { buildInspection, type FieldInspectionProgram } from "@opentradesos/field-client";
import { checkTyped, notFinishedLine, photoAnswerLine } from "../src/lib/inspection";

/**
 * A PHOTO, A NOTE AND A COUNT ON THE PHONE.
 *
 * The phone checks a count as it is typed the way it checks a reading, says
 * what a photo checkpoint still needs, and leaves an optional checkpoint out
 * of the "not finished" question. The answers are the field client's, so the
 * phone files exactly what the day page files.
 */

const base = { requiresReading: false, unit: null, min: null, max: null };
const program: FieldInspectionProgram = {
  id: "p", name: "Sprinkler annual", standard: null, version: 3,
  checkpoints: [
    { key: "photo", label: "Nameplate photo", ...base, kind: "photo" },
    { key: "psi", label: "Churn pressure", requiresReading: true, unit: "psi", min: 90, max: 120 },
    { key: "heads", label: "Spare heads", ...base, kind: "count", expectedAtLeast: 6 },
    { key: "note", label: "Anything else", ...base, kind: "note", optional: true },
  ],
};

describe("an inspection with more than pass or fail", () => {
  it("checks a count and a reading as they are typed, and nothing else", () => {
    expect(checkTyped(program.checkpoints[2]!, { count: "3" })).toMatchObject({ state: "out_of_range" });
    expect(checkTyped(program.checkpoints[1]!, { reading: "130" })).toMatchObject({ state: "out_of_range" });
    expect(checkTyped(program.checkpoints[0]!, { photoIds: [] })).toBeNull();
    expect(checkTyped(program.checkpoints[3]!, { text: "x" })).toBeNull();
  });

  it("says what a photo checkpoint still needs", () => {
    expect(photoAnswerLine(0)).toBe("Take a photo to answer this.");
    expect(photoAnswerLine(1)).toBe("1 photo taken.");
    expect(photoAnswerLine(3)).toBe("3 photos taken.");
  });

  it("asks about the checkpoints left blank, and not the optional one", () => {
    const built = buildInspection({
      program, by: "Ray", at: new Date("2026-11-06T15:00:00Z"),
      entries: { psi: { reading: "100" }, heads: { count: "7" } },
    });
    expect(built.unanswered).toEqual(["Nameplate photo"]);
    expect(built.optionalSkipped).toEqual(["Anything else"]);
    expect(notFinishedLine(built.unanswered))
      .toBe("Not answered: Nameplate photo. It will be filed as not finished, which is not a pass.");
  });
});
