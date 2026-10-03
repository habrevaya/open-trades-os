import { describe, it, expect } from "vitest";
import { safety } from "../src/index";

const now = new Date("2026-10-03T12:00:00Z");
const hourAgo = new Date("2026-10-03T11:00:00Z");

describe("an incident report", () => {
  it("needs a description, a time that has happened, and names", () => {
    const problems = safety.incidentProblems({
      kind: "near_miss", occurredAt: new Date("2026-10-04T12:00:00Z"), description: " ",
      people: [{ name: "", role: "witness" }],
    }, now);
    expect(problems.map((p) => p.path)).toEqual(["description", "occurredAt", "people.0.name"]);
  });

  it("must say who was hurt when somebody was", () => {
    expect(safety.incidentProblems({
      kind: "injury", occurredAt: hourAgo, description: "Fell", people: [{ name: "Bob", role: "witness" }],
    }, now).map((p) => p.path)).toEqual(["people"]);
    expect(safety.incidentProblems({
      kind: "injury", occurredAt: hourAgo, description: "Fell", people: [{ name: "Bob", role: "injured" }],
    }, now)).toEqual([]);
  });

  it("allows a phone clock a few minutes ahead", () => {
    expect(safety.incidentProblems({
      kind: "near_miss", occurredAt: new Date("2026-10-03T12:05:00Z"), description: "x", people: [],
    }, now)).toEqual([]);
  });
});

describe("signing a talk", () => {
  const held = { heldAt: hourAgo, closedAt: null };
  it("is allowed once held, for somebody on the list who has not signed", () => {
    expect(safety.signingRefusal(held, { signedAt: null }, now)).toBeNull();
  });
  it("is refused before it is held, after it closes, off the list, and twice", () => {
    expect(safety.signingRefusal({ heldAt: new Date("2026-10-05T00:00:00Z"), closedAt: null }, { signedAt: null }, now)).toMatch(/not happened/);
    expect(safety.signingRefusal({ heldAt: hourAgo, closedAt: now }, { signedAt: null }, now)).toMatch(/closed/);
    expect(safety.signingRefusal(held, null, now)).toMatch(/not on the list/);
    expect(safety.signingRefusal(held, { signedAt: hourAgo }, now)).toMatch(/already signed/);
  });
});
