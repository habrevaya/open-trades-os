import { describe, it, expect } from "vitest";
import { attributeLines, keptAsTheyAre, parseAttributeLines } from "../src/lib/unit-attributes";

/**
 * A UNIT'S OTHER DETAILS AS LINES OF TEXT
 *
 * Plain details are written as "Name: value" lines and read back the same way; what
 * a line cannot say (a list, a group) is never shown, never lost and never changed.
 */
describe("showing them", () => {
  it("writes plain details one a line and leaves out the empty and the complicated", () => {
    expect(attributeLines({ refrigerant: "R-410A", amps: 14, charged: true, note: "", gone: null, parts: ["a"], more: { x: 1 } }))
      .toBe("refrigerant: R-410A\namps: 14\ncharged: true");
    expect(attributeLines(null)).toBe("");
  });

  it("counts what the box cannot show", () => {
    expect(keptAsTheyAre({ a: "x", b: ["y"], c: { z: 1 }, d: null, e: "" })).toBe(2);
  });
});

describe("taking them back", () => {
  it("reads lines into details, trimming, and an unchanged line keeps its type", () => {
    const result = parseAttributeLines("  amps : 14 \nrefrigerant: R-410A\ncharged: true\nfilter: 16x25x1", { amps: 14, charged: true });
    expect(result).toEqual({ ok: true, attributes: { amps: 14, refrigerant: "R-410A", charged: true, filter: "16x25x1" } });
  });

  it("makes a typed over number text, and takes out a line that is gone", () => {
    expect(parseAttributeLines("amps: 15", { amps: 14, old: "x" })).toEqual({ ok: true, attributes: { amps: "15" } });
    expect(parseAttributeLines("", { a: "x" })).toEqual({ ok: true, attributes: {} });
  });

  it("keeps what it could not show, exactly as it was", () => {
    const list = ["a", "b"];
    const result = parseAttributeLines("refrigerant: R-22", { parts: list, group: { x: 1 }, refrigerant: "R-410A" });
    expect(result).toEqual({ ok: true, attributes: { parts: list, group: { x: 1 }, refrigerant: "R-22" } });
  });

  it("refuses in words rather than guessing", () => {
    expect(parseAttributeLines("R-410A", {})).toEqual({ ok: false, error: '"R-410A" needs a name, a colon and a value, like "Refrigerant: R-410A".' });
    expect(parseAttributeLines(": 12", {})).toMatchObject({ ok: false });
    expect(parseAttributeLines("amps:", {})).toEqual({ ok: false, error: '"amps" has no value. Give it one, or take the line out.' });
    expect(parseAttributeLines("amps: 1\namps: 2", {})).toEqual({ ok: false, error: '"amps" is on two lines. Put each detail on one line.' });
    expect(parseAttributeLines("parts: x", { parts: ["a"] })).toEqual({
      ok: false, error: '"parts" holds something this box cannot show, so it is kept as it is. Use another name.',
    });
    expect(parseAttributeLines(`a: ${"x".repeat(201)}`, {})).toMatchObject({ ok: false });
    expect(parseAttributeLines(`${"n".repeat(61)}: 1`, {})).toMatchObject({ ok: false });
    expect(parseAttributeLines(Array.from({ length: 31 }, (_, i) => `k${i}: v`).join("\n"), {})).toEqual({
      ok: false, error: "A unit can carry at most 30 other details. Take some out.",
    });
  });
});
