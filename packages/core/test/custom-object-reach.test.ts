import { describe, it, expect } from "vitest";
import * as co from "../src/custom-objects/index.js";

describe("what a kind of record can point at, now", () => {
  it("takes an invoice, a person and a record of a kind it names", () => {
    const decision = co.checkType({
      key: "inspection", label: "Inspection", links: ["record", "membership", "invoice"], recordKind: "truck",
    });
    expect(decision).toMatchObject({
      ok: true, definition: { links: ["invoice", "membership", "record"], recordKind: "truck" },
    });
  });

  it("needs the kind with a record link, and refuses one without", () => {
    const missing = co.checkType({ key: "inspection", label: "Inspection", links: ["record"] });
    expect(missing).toEqual({ ok: false, problems: ["Say which kind of record these point at, like truck."] });
    const stray = co.checkType({ key: "inspection", label: "Inspection", links: ["job"], recordKind: "truck" });
    expect(stray.ok).toBe(false);
    const badKey = co.checkType({ key: "inspection", label: "Inspection", links: ["record"], recordKind: "Truck!" });
    expect(badKey.ok).toBe(false);
  });

  it("is shown to customers only when asked, and only when it can point at a customer, a job or an invoice", () => {
    expect(co.checkType({ key: "permit", label: "Permit", links: ["job"] })).toMatchObject({ definition: { customerVisible: false } });
    expect(co.checkType({ key: "permit", label: "Permit", links: ["job"], customerVisible: true }))
      .toMatchObject({ ok: true, definition: { customerVisible: true } });
    // An address or a unit alone changes hands with the house.
    for (const links of [[], ["property"], ["equipment"], ["membership"]]) {
      expect(co.checkType({ key: "permit", label: "Permit", links, customerVisible: true }).ok).toBe(false);
    }
  });
});

describe("what a customer is shown of one record", () => {
  const definitions = [
    { key: "status", label: "Status", dataType: "select", customerVisible: true },
    { key: "notes", label: "Office notes", dataType: "text", customerVisible: false },
    { key: "expires", label: "Expires", dataType: "date", customerVisible: true },
    { key: "covered", label: "Covered", dataType: "boolean", customerVisible: true },
    { key: "parts", label: "Parts", dataType: "multiselect" },
  ];

  it("is the name and the marked fields holding a value, in the kind's order, and nothing else", () => {
    const shown = co.portalView({
      title: "REG-1",
      customFields: { status: "approved", notes: "SECRET", covered: true, parts: ["a"], stray: "not defined", expires: "" },
    }, definitions);
    expect(shown).toEqual({ title: "REG-1", fields: [{ label: "Status", value: "approved" }, { label: "Covered", value: "Yes" }] });
    expect(JSON.stringify(shown)).not.toContain("SECRET");
    expect(JSON.stringify(shown)).not.toContain("not defined");
  });

  it("never reads a value through a key the definitions do not mark, including the prototype's", () => {
    const shown = co.portalView({ title: "X", customFields: JSON.parse('{"__proto__": {"a": 1}, "constructor": "c"}') }, [
      { key: "constructor", label: "C", dataType: "text" },
    ]);
    expect(shown.fields).toEqual([]);
  });
});
