import { describe, it, expect } from "vitest";
import { payExtras as px } from "../src/index";

/** A tip rule for a kind of work or a crew, read in its place, and a person's own rule with dates. */
describe("the order tip rules are read in", () => {
  it("reads the job's own, then the kind of work's, then the crew's, then the people's, then the company's", () => {
    const people = [{ technicianId: "a", rule: "hours" as const }];
    const crews = [{ crewId: "c", rule: "visit_hours" as const }];
    expect(px.chooseTipRule({ company: "even", job: "lead", jobType: "hours", crews, people }))
      .toEqual({ rule: "lead", source: "job", note: "" });
    expect(px.chooseTipRule({ company: "even", job: null, jobType: "lead", crews, people }))
      .toEqual({ rule: "lead", source: "job_type", note: "" });
    expect(px.chooseTipRule({ company: "even", job: null, jobType: null, crews, people }))
      .toEqual({ rule: "visit_hours", source: "crew", note: "" });
    expect(px.chooseTipRule({ company: "even", job: null, jobType: null, crews: [], people }))
      .toEqual({ rule: "hours", source: "technician", note: "" });
    expect(px.chooseTipRule({ company: "lead", job: null, people: [] }))
      .toEqual({ rule: "lead", source: "company", note: "" });
  });

  it("passes over crews that disagree, says so, and reads the people's own next", () => {
    const chosen = px.chooseTipRule({
      company: "even", job: null, jobType: null,
      crews: [{ crewId: "c", rule: "lead" }, { crewId: "d", rule: "hours" }],
      people: [{ technicianId: "a", rule: "visit_hours" }],
    });
    expect(chosen).toMatchObject({ rule: "visit_hours", source: "technician" });
    expect(chosen.note).toMatch(/crews with different tip rules/);

    const nobody = px.chooseTipRule({
      company: "even", job: null,
      crews: [{ crewId: "c", rule: "lead" }, { crewId: "d", rule: "hours" }],
      people: [{ technicianId: "a", rule: "visit_hours" }, { technicianId: "b", rule: "lead" }],
    });
    expect(nobody).toMatchObject({ rule: "even", source: "company" });
    expect(nobody.note).toMatch(/crews with different tip rules/);
    expect(nobody.note).toMatch(/different tip rules of their own/);
  });

  it("uses one crew rule when two crews agree", () => {
    expect(px.chooseTipRule({
      company: "even", job: null,
      crews: [{ crewId: "c", rule: "lead" }, { crewId: "d", rule: "lead" }], people: [],
    })).toEqual({ rule: "lead", source: "crew", note: "" });
  });

  it("names every source in words", () => {
    for (const source of px.TIP_RULE_SOURCES) expect(px.TIP_RULE_SOURCE_LABEL[source]).toBeTruthy();
  });
});

describe("a person's own rule with dates", () => {
  it("covers its first and last day and the days between, and is open where a date is not given", () => {
    expect(px.tipRuleCovers("2026-03-01", "2026-03-01", "2026-03-31")).toBe(true);
    expect(px.tipRuleCovers("2026-03-31", "2026-03-01", "2026-03-31")).toBe(true);
    expect(px.tipRuleCovers("2026-02-28", "2026-03-01", "2026-03-31")).toBe(false);
    expect(px.tipRuleCovers("2026-04-01", "2026-03-01", "2026-03-31")).toBe(false);
    expect(px.tipRuleCovers("1999-01-01", null, "2026-03-31")).toBe(true);
    expect(px.tipRuleCovers("2099-01-01", "2026-03-01", null)).toBe(true);
    expect(px.tipRuleCovers("2026-06-01", null, null)).toBe(true);
  });

  it("finds two spans that share a day, and lets spans that touch end to start alone", () => {
    const march = { startsOn: "2026-03-01", endsOn: "2026-03-31" };
    expect(px.tipRuleSpansOverlap(march, { startsOn: "2026-03-31", endsOn: null })).toBe(true);
    expect(px.tipRuleSpansOverlap(march, { startsOn: "2026-04-01", endsOn: null })).toBe(false);
    expect(px.tipRuleSpansOverlap(march, { startsOn: null, endsOn: "2026-02-28" })).toBe(false);
    expect(px.tipRuleSpansOverlap(march, { startsOn: null, endsOn: null })).toBe(true);
    expect(px.tipRuleSpansOverlap({ startsOn: null, endsOn: null }, { startsOn: null, endsOn: null })).toBe(true);
  });
});
