import { describe, it, expect } from "vitest";
import { sandbox } from "../src/index";

/**
 * A PRACTICE COPY, AND CARRYING SETTINGS BACK
 *
 * Two things here can hurt a real company: sample data that reaches a real
 * person, and a copy back that does something other than what the person
 * ticked. Both are decided without a database, so both are tested here.
 */

describe("sample customers", () => {
  it("carry the town and nothing else of the real customer", () => {
    const sample = sandbox.sampleCustomer(0, { city: "Austin", state: "TX", postalCode: "78701" });
    expect(sample).toEqual({
      name: "Sample customer 1",
      email: "sample1@example.com",
      phone: "+15125550100",
      addressLine1: "101 Sample Street",
      city: "Austin", state: "TX", postalCode: "78701",
    });
  });

  it("use only the 555-01xx numbers set aside for fiction, however many there are", () => {
    for (let i = 0; i < sandbox.MAX_SAMPLE * 5; i += 1) {
      expect(sandbox.sampleCustomer(i, {}).phone).toMatch(/^\+1512555010\d$|^\+151255501\d\d$/);
    }
  });

  it("are called a sandbox wherever the company's name is printed", () => {
    expect(sandbox.sandboxName("Lone Star Air")).toBe("Lone Star Air (sandbox)");
    expect(sandbox.sandboxSlug("lone-star-air")).toBe("lone-star-air-sandbox");
  });
});

describe("copying settings back", () => {
  const field = (key: string, label: string) => ({
    kind: "custom_field" as const, naturalKey: `job:${key}`, label, content: { label, dataType: "text", options: [] },
  });

  it("says, per ticked item, whether it would be made, changed or is already the same", () => {
    const plan = sandbox.planCopyBack(
      [
        field("permit_no", "Permit number"),
        field("gate", "Gate code"),
        field("crew", "Crew"),
        { kind: "workflow", naturalKey: "Follow up", label: "Follow up", content: { steps: [1] } },
        { kind: "custom_object", naturalKey: "permit", label: "Permit", content: { label: "Permit" } },
      ],
      [
        { ...field("gate", "Gate code"), content: { options: [], dataType: "text", label: "Gate code" } },
        field("crew", "Crew name"),
      ],
      ["custom_field:job:permit_no", "custom_field:job:gate", "custom_field:job:crew", "workflow:Follow up", "custom_object:permit"],
    );
    expect(plan.unknown).toEqual([]);
    expect(plan.items.map((item) => [item.kind, item.naturalKey, item.action])).toEqual([
      // A kind of record first, so its fields have something to belong to.
      ["custom_object", "permit", "create"],
      ["custom_field", "job:permit_no", "create"],
      // Key order is not a difference.
      ["custom_field", "job:gate", "same"],
      ["custom_field", "job:crew", "update"],
      ["workflow", "Follow up", "create"],
    ]);
  });

  it("copies nothing that was not ticked, and names a ticked id the sandbox does not hold", () => {
    const plan = sandbox.planCopyBack([field("gate", "Gate code")], [], ["custom_field:job:missing"]);
    expect(plan.items).toEqual([]);
    expect(plan.unknown).toEqual(["custom_field:job:missing"]);
  });
});
