import { describe, it, expect } from "vitest";
import { checkSettingsProblem, fieldComparison, sameValue, MAX_TYPED_VALUE } from "../src/automation/index.js";
import { typedValue, type FieldDefinition } from "../src/custom-fields/index.js";

/**
 * THE RECORD QUESTION, COMPARED WITH A VALUE TYPED INTO THE STEP
 *
 * `stop_unless` could ask whether a field on one of the company's records still
 * said what the event carried. It can now also ask whether it still says a value
 * typed into the step. These are the rules both the editor and the service
 * share: what a step is refused for at publish, and how typed words are read as
 * the field's own kind.
 */
const field = (dataType: string, options: string[] = []): FieldDefinition =>
  ({ key: "f", label: "Permit status", dataType, options, required: false });

describe("what a step comparing with a typed value is refused for", () => {
  const step = (over: Record<string, unknown>) => ({ check: "record_field_unchanged", field: "status", ...over });

  it("is fine with what it always was: no comparison named means the event's value", () => {
    expect(checkSettingsProblem(step({}))).toBeNull();
    expect(checkSettingsProblem(step({ compare: "event" }))).toBeNull();
    expect(fieldComparison(step({}))).toBe("event");
    expect(fieldComparison(step({ compare: "event" }))).toBe("event");
  });

  it("takes a typed value, and nothing else is a way to compare", () => {
    expect(checkSettingsProblem(step({ compare: "value", value: "approved" }))).toBeNull();
    expect(fieldComparison(step({ compare: "value", value: "approved" }))).toBe("value");
    expect(checkSettingsProblem(step({ compare: "anything" })))
      .toBe("Compare the field with what the event said, or with a value you type.");
  });

  it("refuses a typed comparison with no value, a blank one or one too long, naming the field", () => {
    const need = "Type the value status has to still be, or compare it with what the event said.";
    expect(checkSettingsProblem(step({ compare: "value" }))).toBe(need);
    expect(checkSettingsProblem(step({ compare: "value", value: "   " }))).toBe(need);
    expect(checkSettingsProblem(step({ compare: "value", value: 7 }))).toBe(need);
    expect(checkSettingsProblem(step({ compare: "value", value: "x".repeat(MAX_TYPED_VALUE + 1) }))).toMatch(/longer than 200/);
    expect(checkSettingsProblem(step({ compare: "value", value: "x".repeat(MAX_TYPED_VALUE) }))).toBeNull();
  });

  it("still refuses a missing field first, and ignores a value on a check that has no field", () => {
    expect(checkSettingsProblem({ check: "record_field_unchanged", compare: "value", value: "approved" })).toMatch(/Say which field/);
    expect(checkSettingsProblem({ check: "task_open", compare: "value" })).toBeNull();
  });
});

describe("typed words, read as the field's own kind", () => {
  it("reads text and a choice as typed, and refuses a choice the field does not list", () => {
    expect(typedValue(field("text"), "  approved ")).toEqual({ ok: true, value: "approved" });
    expect(typedValue(field("select", ["submitted", "approved"]), "approved")).toEqual({ ok: true, value: "approved" });
    expect(typedValue(field("select", ["submitted", "approved"]), "done")).toEqual({
      ok: false, message: "Permit status is not one of the options (submitted, approved).",
    });
  });

  it("reads a number as a number, and refuses words", () => {
    expect(typedValue(field("number"), "12")).toEqual({ ok: true, value: 12 });
    expect(typedValue(field("number"), "12.50")).toEqual({ ok: true, value: 12.5 });
    expect(typedValue(field("number"), "twelve")).toEqual({ ok: false, message: "Permit status has to be a number." });
  });

  it("reads a yes or no field in the words a person types", () => {
    for (const yes of ["yes", "Yes", "true", " TRUE "]) expect(typedValue(field("boolean"), yes)).toEqual({ ok: true, value: true });
    for (const no of ["no", "No", "false"]) expect(typedValue(field("boolean"), no)).toEqual({ ok: true, value: false });
    expect(typedValue(field("boolean"), "maybe").ok).toBe(false);
  });

  it("reads a date only if it is a real one", () => {
    expect(typedValue(field("date"), "2026-03-01")).toEqual({ ok: true, value: "2026-03-01" });
    expect(typedValue(field("date"), "2026-02-31")).toEqual({ ok: false, message: "Permit status is not a real date." });
    expect(typedValue(field("date"), "March 1")).toEqual({ ok: false, message: "Permit status has to be a date like 2026-03-01." });
  });

  it("reads several choices separated by commas, in any order, each once", () => {
    const f = field("multiselect", ["a", "b", "c"]);
    const read = typedValue(f, "b, a");
    expect(read).toEqual({ ok: true, value: ["b", "a"] });
    expect(sameValue(read.ok ? read.value : null, ["a", "b"])).toBe(true);
    expect(typedValue(f, "a, z").ok).toBe(false);
    expect(typedValue(f, "a, a").ok).toBe(false);
  });

  it("needs something to compare with", () => {
    expect(typedValue(field("text"), "   ")).toEqual({ ok: false, message: "Permit status needs a value to compare with." });
    expect(typedValue(field("multiselect", ["a"]), " , ")).toEqual({ ok: false, message: "Permit status needs a value to compare with." });
  });
});
