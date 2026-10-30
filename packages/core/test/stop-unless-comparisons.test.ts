import { describe, it, expect } from "vitest";
import {
  checkSettingsProblem, fieldComparison, ordered, typedValues, FIELD_COMPARISONS, MAX_TYPED_VALUE, MAX_TYPED_VALUES,
} from "../src/automation/index.js";

/**
 * THE RECORD QUESTION, ASKED MORE WAYS THAN EQUAL
 *
 * Beside "still says what the event carried" and "is a value typed in", the
 * record question can ask whether a field is greater than or less than a
 * typed value, one of several typed values, or still blank. These are the
 * rules the editor and the publish check share.
 */
const step = (over: Record<string, unknown>) => ({ check: "record_field_unchanged", field: "amount", ...over });

describe("which comparisons a step can name", () => {
  it("knows the six, and reads anything else as the event's value", () => {
    expect(FIELD_COMPARISONS).toEqual(["event", "value", "greater", "less", "one_of", "blank"]);
    for (const compare of FIELD_COMPARISONS) expect(fieldComparison(step({ compare }))).toBe(compare);
    expect(fieldComparison(step({ compare: "between" }))).toBe("event");
    expect(checkSettingsProblem(step({ compare: "between" }))).toMatch(/Compare the field with/);
  });
});

describe("greater and less", () => {
  it("need a value, not too long, and name the field and the direction when it is missing", () => {
    expect(checkSettingsProblem(step({ compare: "greater", value: "500" }))).toBeNull();
    expect(checkSettingsProblem(step({ compare: "less", value: "2026-03-01" }))).toBeNull();
    expect(checkSettingsProblem(step({ compare: "greater" }))).toBe("Type the value amount has to stay greater than.");
    expect(checkSettingsProblem(step({ compare: "less", value: "  " }))).toBe("Type the value amount has to stay less than.");
    expect(checkSettingsProblem(step({ compare: "greater", value: "9".repeat(MAX_TYPED_VALUE + 1) }))).toMatch(/longer than 200/);
  });

  it("compares a number as a number and a date as a date, and says when it cannot", () => {
    expect(ordered("number", "greater", 600, 500)).toBe("holds");
    expect(ordered("number", "greater", 500, 500)).toBe("not");
    expect(ordered("number", "less", 9, 10)).toBe("holds");
    /** Not as text: "9" is after "10" alphabetically and before it as a number. */
    expect(ordered("number", "greater", 10, 9)).toBe("holds");
    expect(ordered("date", "greater", "2026-03-02", "2026-03-01")).toBe("holds");
    expect(ordered("date", "less", "2026-03-02", "2026-03-01")).toBe("not");
    expect(ordered("number", "greater", null, 5)).toBe("blank");
    expect(ordered("date", "less", "", "2026-03-01")).toBe("blank");
    expect(ordered("text", "greater", "b", "a")).toBe("not_ordered");
    expect(ordered("select", "less", "b", "a")).toBe("not_ordered");
  });
});

describe("one of", () => {
  it("takes one value to a line, or a list, with the blanks dropped", () => {
    expect(typedValues({ values: "approved\n\n  issued \r\nclosed" })).toEqual(["approved", "issued", "closed"]);
    expect(typedValues({ values: ["a", " ", "b", 3] })).toEqual(["a", "b"]);
    expect(typedValues({})).toEqual([]);
  });

  it("needs at least one value, at most twenty, none too long", () => {
    expect(checkSettingsProblem(step({ compare: "one_of", values: ["approved", "issued"] }))).toBeNull();
    expect(checkSettingsProblem(step({ compare: "one_of", values: [] }))).toBe("Type the values amount may be, one to a line.");
    expect(checkSettingsProblem(step({ compare: "one_of", values: ["", "  "] }))).toBe("Type the values amount may be, one to a line.");
    expect(checkSettingsProblem(step({ compare: "one_of", values: Array.from({ length: MAX_TYPED_VALUES + 1 }, (_, i) => `v${i}`) })))
      .toBe(`Type at most ${MAX_TYPED_VALUES} values amount may be.`);
    expect(checkSettingsProblem(step({ compare: "one_of", values: ["x".repeat(MAX_TYPED_VALUE + 1)] }))).toMatch(/longer than 200/);
  });
});

describe("still blank", () => {
  it("needs no value, and still needs a field", () => {
    expect(checkSettingsProblem(step({ compare: "blank" }))).toBeNull();
    expect(checkSettingsProblem({ check: "record_field_unchanged", compare: "blank" })).toMatch(/Say which field/);
  });
});
