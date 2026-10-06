import { describe, it, expect } from "vitest";
import { CHECKS, isCheck, checkSettingsProblem, checkNeedsField, sameValue } from "../src/automation/index.js";

describe("the questions about an agreement, a task and the company's own records", () => {
  it("are in the catalogue, each about the record it reads", () => {
    for (const key of ["agreement_active", "agreement_not_renewed", "agreement_renewed", "task_open", "record_field_unchanged"]) {
      expect(isCheck(key)).toBe(true);
    }
    expect(CHECKS.agreement_active.entity).toBe("agreement");
    expect(CHECKS.agreement_renewed.entity).toBe("agreement");
    expect(CHECKS.task_open.entity).toBe("task");
    expect(CHECKS.record_field_unchanged.entity).toBe("custom_object_record");
  });

  it("asks for a field only on the record question", () => {
    expect(checkNeedsField("record_field_unchanged")).toBe(true);
    expect(checkNeedsField("task_open")).toBe(false);
    expect(checkNeedsField("__proto__")).toBe(false);
  });

  it("refuses the record question with no field, or a field that is not a key", () => {
    expect(checkSettingsProblem({ check: "record_field_unchanged" })).toMatch(/Say which field/);
    expect(checkSettingsProblem({ check: "record_field_unchanged", field: "  " })).toMatch(/Say which field/);
    expect(checkSettingsProblem({ check: "record_field_unchanged", field: "Status" })).toMatch(/not a field's key/);
    expect(checkSettingsProblem({ check: "record_field_unchanged", field: "__proto__" })).toMatch(/not a field's key/);
    expect(checkSettingsProblem({ check: "record_field_unchanged", field: "status" })).toBeNull();
    expect(checkSettingsProblem({ check: "task_open" })).toBeNull();
    // An unknown check is refused by its own rule, not this one.
    expect(checkSettingsProblem({ check: "nope" })).toBeNull();
  });

  it("compares stored values as M29 stores them", () => {
    expect(sameValue("submitted", "submitted")).toBe(true);
    expect(sameValue("submitted", "approved")).toBe(false);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue(undefined, "")).toBe(true);
    expect(sameValue(3, 3)).toBe(true);
    expect(sameValue(3, "3")).toBe(false);
    expect(sameValue(true, false)).toBe(false);
    // The order of a list of choices is not a change.
    expect(sameValue(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameValue(["a"], ["a", "b"])).toBe(false);
  });
});
