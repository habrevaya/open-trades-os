import { describe, it, expect } from "vitest";
import { money, payExtras as px } from "../src/index";

/** A tip rule for one job or one person, and sharing by the hours on one visit. */
describe("which rule a tip is shared by", () => {
  it("is the job's own rule first, whatever the people's", () => {
    expect(px.chooseTipRule({ company: "even", job: "lead", people: [{ technicianId: "a", rule: "hours" }] }))
      .toEqual({ rule: "lead", source: "job", note: "" });
  });

  it("is the people's own when everybody who has one agrees", () => {
    expect(px.chooseTipRule({
      company: "even", job: null,
      people: [{ technicianId: "a", rule: "hours" }, { technicianId: "b", rule: "hours" }],
    })).toEqual({ rule: "hours", source: "technician", note: "" });
  });

  it("is the company's, said in words, when two people's own rules differ", () => {
    const chosen = px.chooseTipRule({
      company: "even", job: null,
      people: [{ technicianId: "a", rule: "hours" }, { technicianId: "b", rule: "lead" }],
    });
    expect(chosen).toMatchObject({ rule: "even", source: "company" });
    expect(chosen.note).toMatch(/different tip rules of their own/);
  });

  it("is the company's with nobody's own", () => {
    expect(px.chooseTipRule({ company: "visit_hours", job: null, people: [] }))
      .toEqual({ rule: "visit_hours", source: "company", note: "" });
  });
});

describe("sharing by the hours on the visit", () => {
  const people: px.TipPerson[] = [
    { technicianId: "a", seconds: 4 * 3600, isLead: true, visitSeconds: 3600 },
    { technicianId: "b", seconds: 4 * 3600, isLead: false, visitSeconds: 3 * 3600 },
    { technicianId: "c", seconds: 3600, isLead: false, visitSeconds: 0 },
  ];

  it("shares by the visit's hours, not the job's, and leaves out somebody not on it", () => {
    const split = px.splitTipByRule("visit_hours", money.money("40"), people);
    expect(split.shares.map((s) => [s.technicianId, money.toString(s.amount)])).toEqual([["a", "10.0000"], ["b", "30.0000"]]);
    expect(split.rule).toBe("visit_hours");
    expect(split.note).toMatch(/no hours recorded on the visit/);
  });

  it("shares evenly and says so when nobody clocked in on the visit", () => {
    const split = px.splitTipByRule("visit_hours", money.money("30"),
      people.map((p) => ({ ...p, visitSeconds: 0 })));
    expect(split.rule).toBe("even");
    expect(split.shares).toHaveLength(3);
    expect(split.note).toMatch(/visit this tip was for/);
  });

  it("is one of the rules a company can choose, read back from settings", () => {
    expect(px.TIP_SPLIT_RULES).toContain("visit_hours");
    expect(px.readPayExtras({ tipSplit: "visit_hours" }).tipSplit).toBe("visit_hours");
  });
});
