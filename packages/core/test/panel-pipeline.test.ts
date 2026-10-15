import { describe, it, expect } from "vitest";
import { field, reporting as r } from "../src/index";

const RATINGS = ["60", "100", "125", "150", "200", "320", "400"];
const PANEL: field.DeclaredAttribute[] = [
  { key: "service_amps", label: "Service rating, amps", kind: "select", options: RATINGS },
  { key: "spaces_open", label: "Open spaces", kind: "numeric" },
  { key: "known_concern", label: "Flagged as a known problem panel", kind: "boolean" },
];

describe("a unit's details held to what its trade declares", () => {
  it("stores each declared detail as its kind, under its key, by key or label", () => {
    const typed = field.typedAttributes(PANEL, {
      "Service rating, amps": "100", spaces_open: "0", "flagged as a known problem panel": "Yes", Refrigerant: "R-410A",
    });
    expect(typed.problems).toEqual([]);
    expect(typed.attributes).toEqual({ service_amps: "100", spaces_open: 0, known_concern: true, Refrigerant: "R-410A" });
  });

  it("names what cannot be read as its kind, and keeps it as it was sent", () => {
    const typed = field.typedAttributes(PANEL, { service_amps: "100A", spaces_open: "four", known_concern: "maybe" });
    expect(typed.problems.map((p) => p.key)).toEqual(["service_amps", "spaces_open", "known_concern"]);
    expect(typed.problems[1]!.message).toBe('Open spaces is a number. "four" is not one.');
    expect(typed.attributes).toEqual({ service_amps: "100A", spaces_open: "four", known_concern: "maybe" });
  });
});

describe("a panel worth upgrading", () => {
  it("is full, a known problem, or rated below 100 amps", () => {
    expect(r.panelQualifies({ spaces_open: 0 }, RATINGS)).toBe("in");
    expect(r.panelQualifies({ known_concern: true }, RATINGS)).toBe("in");
    expect(r.panelQualifies({ service_amps: "60" }, RATINGS)).toBe("in");
    expect(r.panelQualifies({ service_amps: "100", spaces_open: 4, known_concern: false }, RATINGS)).toBe("out");
    expect(r.panelQualifies({}, RATINGS)).toBe("out");
  });

  it("does not read words typed before the register checked them, and says so", () => {
    expect(r.panelQualifies({ service_amps: "100A" }, RATINGS)).toBe("unknown");
    expect(r.panelQualifies({ spaces_open: "0" }, RATINGS)).toBe("unknown");
    expect(r.panelQualifies({ known_concern: "yes" }, RATINGS)).toBe("unknown");
    /** A value that does qualify settles it, whatever else is untyped. */
    expect(r.panelQualifies({ known_concern: true, spaces_open: "none" }, RATINGS)).toBe("in");
  });
});
