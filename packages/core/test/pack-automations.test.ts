import { describe, it, expect } from "vitest";
import { checkPackAutomation, buildPackTemplate, flattenPlan } from "../src/automation/index.js";

const EVENTS = ["record.updated", "job.created"];
const permitChase = {
  key: "permit_chase",
  name: "Chase a permit that has sat",
  summary: "A week after a permit goes to submitted, ring the office if it has not moved.",
  parameters: [{ key: "days", label: "Days to wait", help: "", default: 7, min: 1, max: 60 }],
  definition: {
    triggerEvents: ["record.updated"],
    steps: [
      { kind: "wait", config: { days: { $param: "days" } } },
      { kind: "stop_unless", config: { check: "record_field_unchanged", field: "status" } },
      {
        kind: "branch",
        config: { all: [{ path: "record.type", op: "eq", value: "permit" }] },
        then: [{ kind: "create_task", config: { title: "Ring the inspector", dueInHours: { $param: "days" } } }],
      },
    ],
  },
};

describe("a recommended automation a trade pack declares", () => {
  it("is keyed by its pack, so it cannot claim a built in key", () => {
    const checked = checkPackAutomation("permits", permitChase, EVENTS);
    expect(checked).toMatchObject({ ok: true, template: { key: "permits.permit_chase", packId: "permits" } });
  });

  it("fills every named setting, inside a branch too, and nothing else", () => {
    const checked = checkPackAutomation("permits", permitChase, EVENTS);
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    const built = buildPackTemplate(checked.template, { days: 10 });
    if (!built.ok) throw new Error(built.reason);
    const flat = flattenPlan(built.definition.steps);
    expect(flat[0]!.config).toEqual({ days: 10 });
    expect(flat[1]!.config).toEqual({ check: "record_field_unchanged", field: "status" });
    expect(flat[3]!.config).toEqual({ title: "Ring the inspector", dueInHours: 10 });
    expect(built.definition.description).toMatch(/from the permits trade pack/);
  });

  it("refuses a record question with no field, and a key that is not lowercase", () => {
    const steps = [{ kind: "stop_unless", config: { check: "record_field_unchanged" } }];
    const checked = checkPackAutomation("permits", {
      ...permitChase, key: "Permit", parameters: [], definition: { triggerEvents: ["record.updated"], steps },
    }, EVENTS);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.join("\n")).toMatch(/its key is lowercase/);
    expect(checked.problems.join("\n")).toMatch(/Say which field/);
  });

  it("refuses an event that is not offered, and no steps", () => {
    const checked = checkPackAutomation("permits", {
      ...permitChase, definition: { triggerEvents: ["estimate.dwelling"], steps: [] },
    }, EVENTS);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/nothing emits estimate\.dwelling/), expect.stringMatching(/at least one step/),
    ]));
  });
});
