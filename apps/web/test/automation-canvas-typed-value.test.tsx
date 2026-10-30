import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Canvas, type StepOption } from "../src/app/(app)/automations/Canvas";

const steps: StepOption[] = [
  { kind: "wait", label: "Wait", description: "Pauses the run.", permissions: [], allowed: true },
  { kind: "stop_unless", label: "Stop unless still true", description: "Ends the run quietly.", permissions: [], allowed: true },
];

/**
 * THE RECORD QUESTION ON THE CANVAS
 *
 * A render test cannot click, so it holds what the canvas draws for a
 * "Stop unless still true" step asking about a field on one of the company's
 * own records: the choice between what the event said and a value typed in,
 * the box only when a value is chosen, and what a saved step opens as. The
 * browser test walks the editing.
 */
const draw = (config: Record<string, unknown>) => renderToStaticMarkup(
  <Canvas steps={steps} triggerSummary="When a record changes"
          initial={[{ kind: "stop_unless", config }]} />,
);

describe("a stop unless step about a field on a record", () => {
  it("compares with what the event said by default, with no box for a value", () => {
    const html = draw({ check: "record_field_unchanged", field: "status" });
    expect(html).toContain("Compare the field with");
    expect(html).toMatch(/<option value="event" selected="">/);
    expect(html).not.toContain("The value it has to still be");
    expect(html).toContain("Compared with what the field said when the record was added or changed.");
  });

  it("opens a step comparing with a typed value as that choice, with the value in its box and how to type it", () => {
    const html = draw({ check: "record_field_unchanged", field: "status", compare: "value", value: "approved" });
    expect(html).toMatch(/<option value="value" selected="">/);
    expect(html).toContain("The value it has to still be");
    expect(html).toContain('value="approved"');
    expect(html).toContain("a date as 2026-03-01");
    expect(html).toContain("that step fails and says why");
  });

  it("offers neither choice on a question that asks about no field", () => {
    const html = draw({ check: "task_open" });
    expect(html).not.toContain("Compare the field with");
    expect(html).not.toContain("The value it has to still be");
  });

  it("says nothing with an en or em dash in what it draws for this step", () => {
    const html = draw({ check: "record_field_unchanged", field: "status", compare: "value", value: "approved" });
    expect(html.includes(String.fromCharCode(0x2013)) || html.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});
