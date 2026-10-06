import { describe, it, expect } from "vitest";
import { automation } from "@opentradesos/core";
import { loadPack, packAutomations, packById, type TradePackInput } from "../src/index";

/**
 * A PACK'S RECOMMENDED AUTOMATIONS ARE CHECKED WHEN IT LOADS
 *
 * A pack author writes an automation as data, and the mistakes worth
 * catching are the honest ones: a step this build does not have, an event
 * nothing emits, a setting named and never declared. Each is refused at
 * load, with every problem named, rather than on a company's "Turn on".
 */
const base = packById("hvac")!;
const withAutomation = (automation: Record<string, unknown>): TradePackInput =>
  ({ ...base, id: "test-pack", automations: [automation] }) as unknown as TradePackInput;

const good = {
  key: "chase_permit",
  name: "Chase a permit",
  summary: "Ring the office about a job some days after it is booked.",
  parameters: [{ key: "days", label: "Days", default: 3, min: 1, max: 30 }],
  definition: {
    triggerEvents: ["job.created"],
    steps: [
      { kind: "wait", config: { days: { $param: "days" }, hours: 0 } },
      { kind: "stop_unless", config: { check: "job_not_done" } },
      { kind: "create_task", config: { title: "Ring about the permit", queue: "office" } },
    ],
  },
};

describe("a pack's recommended automations", () => {
  it("ships one example, in the HVAC pack, keyed by the pack", () => {
    expect(packAutomations.map((t) => t.key)).toEqual(["hvac.book_first_tune_up"]);
    const example = packAutomations[0]!;
    expect(example).toMatchObject({ packId: "hvac", definition: { triggerKind: "event", triggerEvents: ["agreement.sold"] } });
  });

  it("loads a good one", () => {
    expect(loadPack(withAutomation(good)).automations).toHaveLength(1);
  });

  it("refuses a step, an event and a question this build does not have, all at once", () => {
    const bad = {
      ...good,
      definition: {
        triggerEvents: ["job.exploded"],
        steps: [
          { kind: "launch_rocket" },
          { kind: "stop_unless", config: { check: "customer_is_happy" } },
        ],
      },
    };
    expect(() => loadPack(withAutomation(bad))).toThrow(/nothing emits job\.exploded/);
    expect(() => loadPack(withAutomation(bad))).toThrow(/launch_rocket, which this build cannot run/);
    expect(() => loadPack(withAutomation(bad))).toThrow(/customer_is_happy, which this build cannot ask/);
  });

  it("refuses a setting a step names and the automation does not declare", () => {
    const bad = { ...good, parameters: [] };
    expect(() => loadPack(withAutomation(bad))).toThrow(/names a setting "days" it does not declare/);
  });

  it("refuses a default outside its own bounds, and a dwell trigger", () => {
    expect(() => loadPack(withAutomation({ ...good, parameters: [{ key: "days", label: "Days", default: 40, min: 1, max: 30 }] })))
      .toThrow(/default outside its own bounds/);
    expect(() => loadPack(withAutomation({ ...good, definition: { ...good.definition, triggerKind: "dwell" } })))
      .toThrow(/invalid/);
  });

  it("refuses the same key twice in one pack", () => {
    const pack = { ...base, id: "test-pack", automations: [good, good] } as unknown as TradePackInput;
    expect(() => loadPack(pack)).toThrow(/declared twice/);
  });

  it("builds the workflow with the company's number in it, and refuses one outside the bounds", () => {
    const checked = automation.checkPackAutomation("test-pack", good, ["job.created"]);
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    const built = automation.buildPackTemplate(checked.template, { days: "5" });
    if (!built.ok) throw new Error(built.reason);
    expect(automation.flattenPlan(built.definition.steps)[0]).toEqual({ kind: "wait", config: { days: 5, hours: 0 } });
    expect(automation.buildPackTemplate(checked.template, {})).toMatchObject({ ok: true });
    expect(automation.buildPackTemplate(checked.template, { days: 31 })).toEqual({ ok: false, reason: "Days cannot be more than 30." });
  });
});
