import { describe, it, expect } from "vitest";
import {
  SEVERITIES, SEVERITY, SEVERITY_ORDER, worstSeverity, compareSeverity,
  validateTemplate, explainTemplateProblems, evaluateReading, describeRange,
  assessInspection, proposeWork, backlogStanding,
  type InspectionTemplate, type TemplateItem, type RecordedAnswer, type AnswerValue,
  type AnswerSpec, type Observation, type Severity, type DeficiencyInput,
} from "../src/inspection/index.js";

/**
 * INSPECTIONS AND DEFICIENCIES
 *
 * A technician walks a system, records what they found, and some of what they
 * found is work somebody should buy. Two failures are worth more than all the
 * others put together, and most of what is below is about one or the other:
 *
 * An inspection with half its items skipped reporting "passed". That report
 * goes in a compliance file and asserts that somebody looked at things nobody
 * looked at.
 *
 * A cracked heat exchanger and a capacitor reading low but inside its range
 * printed the same way on the same page. The customer cannot tell which line
 * is a hazard and which is a hunch, and that is the whole business model of
 * the products this one is trying not to be.
 */

const AT = new Date("2026-03-01T15:00:00Z");

const answer = (itemKey: string, value: AnswerValue, when: Date = AT): RecordedAnswer => ({
  itemKey, value, at: when, by: "tech-1",
});

const withNote = (recorded: RecordedAnswer, note: string): RecordedAnswer => ({ ...recorded, note });

/**
 * A real furnace inspection, near enough. Four items a technician has to
 * answer, one hazard, two readings and one photo, plus an optional item so the
 * optional path is exercised by something rather than asserted about nothing.
 */
const FURNACE: InspectionTemplate = {
  key: "furnace-annual",
  title: "Gas furnace, annual",
  discipline: "HVAC",
  sections: [
    {
      key: "combustion",
      title: "Combustion",
      items: [
        {
          key: "heat_exchanger",
          prompt: "Heat exchanger intact",
          answer: { kind: "pass_fail" },
          failureSeverity: "safety",
          codeReference: "NFPA 54 10.1",
          remedies: [{
            priceBookItemKey: "HX-REPLACE",
            label: "Replace heat exchanger",
            quantity: 1,
            rationale: "A cracked exchanger puts combustion gas into the air the house breathes.",
          }],
        },
        {
          key: "gas_pressure",
          prompt: "Manifold gas pressure",
          answer: { kind: "reading", unit: "in wc", range: { min: 3.2, max: 3.8, borderlineWithin: 0.1 } },
          failureSeverity: "failure",
          remedies: [{
            priceBookItemKey: "GAS-ADJ",
            label: "Adjust and re-test manifold pressure",
            quantity: 1,
            rationale: "Firing outside the rated pressure shortens the exchanger and wastes gas.",
          }],
        },
      ],
    },
    {
      key: "electrical",
      title: "Electrical",
      items: [
        {
          key: "capacitor",
          prompt: "Run capacitor",
          answer: { kind: "reading", unit: "uF", range: { min: 4.5, max: 5.5, borderlineWithin: 0.3 } },
          failureSeverity: "failure",
          borderlineSeverity: "recommendation",
          remedies: [{
            priceBookItemKey: "CAP-5",
            label: "Replace 5 uF run capacitor",
            quantity: 1,
            rationale: "A capacitor drifting low will drop the motor out on a hot day.",
          }],
        },
      ],
    },
    {
      key: "evidence",
      title: "Evidence",
      items: [
        { key: "nameplate_photo", prompt: "Photo of the nameplate", answer: { kind: "photo" } },
        { key: "attic_access", prompt: "Attic access clear", answer: { kind: "pass_fail" }, failureSeverity: "recommendation", optional: true },
      ],
    },
  ],
};

/** Every non-optional item answered, everything fine. The honest pass. */
const CLEAN: RecordedAnswer[] = [
  answer("heat_exchanger", { kind: "pass_fail", passed: true }),
  answer("gas_pressure", { kind: "reading", raw: "3.5" }),
  answer("capacitor", { kind: "reading", raw: "5.0" }),
  answer("nameplate_photo", { kind: "photo", photoIds: ["photo-1"] }),
];

const assess = (answers: RecordedAnswer[], template: InspectionTemplate = FURNACE) => {
  const result = assessInspection(template, answers);
  if (!result.ok) throw new Error(`expected an assessment, got ${result.reason}`);
  return result;
};

// ---------------------------------------------------------------------------

describe("the severity scale", () => {
  it("says what every level means to the person who owns the building", () => {
    // A level with no plain meaning means whatever the salesperson says it
    // means, and "severity 3" has no meaning at all to a homeowner.
    for (const key of SEVERITIES) {
      const level = SEVERITY[key];
      expect(level.label.length, key).toBeGreaterThan(0);
      expect(level.meaning.length, key).toBeGreaterThan(30);
      expect(level.heading.length, key).toBeGreaterThan(10);
    }
  });

  it("never lets a safety finding and a recommendation collapse into one severity", () => {
    /**
     * The distinction the module exists for. A cracked heat exchanger and a
     * capacitor reading low but in range are both findings and they are not
     * the same kind of thing, and every field a renderer might key off has to
     * separate them.
     */
    const hazard = SEVERITY.safety;
    const suggestion = SEVERITY.recommendation;

    expect(hazard.key).not.toBe(suggestion.key);
    expect(hazard.heading).not.toBe(suggestion.heading);
    expect(hazard.meaning).not.toBe(suggestion.meaning);
    expect(hazard.isSafety).toBe(true);
    expect(suggestion.isSafety).toBe(false);
    expect(hazard.takeOutOfService).toBe(true);
    expect(suggestion.takeOutOfService).toBe(false);
    expect(hazard.failsInspection).toBe(true);
    expect(suggestion.failsInspection).toBe(false);
    expect(hazard.rank).toBeLessThan(suggestion.rank);
  });

  it("gives every level its own heading, because the heading is the part a customer reads", () => {
    // Two levels sharing words on the page is the same failure as two levels
    // sharing a severity, arriving by a different route.
    const headings = SEVERITIES.map((key) => SEVERITY[key].heading);
    expect(new Set(headings).size).toBe(SEVERITIES.length);
    const meanings = SEVERITIES.map((key) => SEVERITY[key].meaning);
    expect(new Set(meanings).size).toBe(SEVERITIES.length);
  });

  it("only lets the levels that are actually urgent be presented as urgent", () => {
    // A red banner on a recommendation is the thing this module exists to
    // prevent, so a renderer has to ignore a field that says not to.
    expect(SEVERITY.safety.mayBePresentedAsUrgent).toBe(true);
    expect(SEVERITY.failure.mayBePresentedAsUrgent).toBe(true);
    expect(SEVERITY.wear.mayBePresentedAsUrgent).toBe(false);
    expect(SEVERITY.recommendation.mayBePresentedAsUrgent).toBe(false);
  });

  it("puts a clock on a hazard and no clock on a suggestion", () => {
    expect(SEVERITY.safety.respondWithinDays).toBe(0);
    expect(SEVERITY.recommendation.respondWithinDays).toBeNull();
  });

  it("finds the worst level in a set, whatever order it arrives in", () => {
    expect(worstSeverity(["recommendation", "safety"])).toBe("safety");
    expect(worstSeverity(["safety", "recommendation"])).toBe("safety");
    expect(worstSeverity(["wear", "failure", "recommendation"])).toBe("failure");
  });

  it("does not promote a set of recommendations into something worse", () => {
    // The direction that sells things. A list of suggestions summarises as a
    // suggestion, however long the list is.
    expect(worstSeverity(["recommendation", "recommendation", "recommendation"])).toBe("recommendation");
    expect(worstSeverity(["wear", "recommendation"])).toBe("wear");
  });

  it("has no worst level for an empty set, rather than a default", () => {
    // "Nothing was found" and "the mildest thing was found" are different
    // sentences, and a caller that cannot tell them apart prints the wrong one.
    expect(worstSeverity([])).toBeNull();
  });

  it("sorts worst first", () => {
    const shuffled: Severity[] = ["recommendation", "safety", "wear", "failure"];
    expect([...shuffled].sort(compareSeverity)).toEqual([...SEVERITY_ORDER]);
  });
});

// ---------------------------------------------------------------------------

describe("saving a template", () => {
  const brokenItem = (over: Partial<TemplateItem>): InspectionTemplate => ({
    key: "t", title: "T", discipline: "HVAC",
    sections: [{ key: "s", title: "S", items: [{ key: "i", prompt: "Something", ...over }] }],
  });

  const problems = (template: InspectionTemplate) => {
    const result = validateTemplate(template);
    if (result.ok) throw new Error("expected the template to be refused");
    return result.problems.map((p) => p.code);
  };

  it("accepts a template a technician could actually walk", () => {
    const result = validateTemplate(FURNACE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.itemCount).toBe(5);
  });

  it("refuses a range whose floor is above its ceiling", () => {
    /**
     * Every reading ever taken against it would fail, which reads on the
     * report as equipment that is broken rather than a template that is.
     */
    const template = brokenItem({
      answer: { kind: "reading", unit: "psi", range: { min: 450, max: 350 } },
      failureSeverity: "failure",
    });
    expect(problems(template)).toContain("range_floor_above_ceiling");
  });

  it("accepts a range that is open at one end, because half of them are", () => {
    // "At least 20 inches of water column" is a real specification. Forcing a
    // second bound produces a bound that is wrong and then gets enforced.
    const template = brokenItem({
      answer: { kind: "reading", unit: "in wc", range: { min: 20, max: null } },
      failureSeverity: "failure",
    });
    expect(validateTemplate(template).ok).toBe(true);
  });

  it("refuses a range open at both ends, which accepts everything", () => {
    const template = brokenItem({
      answer: { kind: "reading", unit: "psi", range: { min: null, max: null } },
      failureSeverity: "failure",
    });
    expect(problems(template)).toContain("range_open_at_both_ends");
  });

  it("refuses an item that does not say what kind of answer it takes", () => {
    // It renders as a question with no way to answer it.
    expect(problems(brokenItem({}))).toContain("no_answer_kind");
  });

  it("refuses two items with the same key", () => {
    // Two questions fighting over one answer slot, and the second one wins
    // silently.
    const template: InspectionTemplate = {
      key: "t", title: "T", discipline: "HVAC",
      sections: [
        { key: "a", title: "A", items: [{ key: "same", prompt: "One", answer: { kind: "note" } }] },
        { key: "b", title: "B", items: [{ key: "same", prompt: "Two", answer: { kind: "note" } }] },
      ],
    };
    expect(problems(template)).toContain("duplicate_item_key");
  });

  it("refuses a section with nothing in it", () => {
    // A heading a technician scrolls past believing they have completed it.
    const template: InspectionTemplate = {
      key: "t", title: "T", discipline: "HVAC",
      sections: [{ key: "empty", title: "Safety checks", items: [] }],
    };
    expect(problems(template)).toContain("empty_section");
  });

  it("refuses an item that can fail and does not say what failing means", () => {
    /**
     * Never defaulted. Default to safety and every unconfigured item
     * manufactures alarm; default to recommendation and a real hazard is
     * buried by whoever forgot the field.
     */
    expect(problems(brokenItem({ answer: { kind: "pass_fail" } }))).toContain("missing_failure_severity");
  });

  it("does not ask a photo or a note to declare a failure, because neither can fail", () => {
    const photo = brokenItem({ answer: { kind: "photo" } });
    expect(validateTemplate(photo).ok).toBe(true);
  });

  it("refuses a reading with no unit, because a bare number cannot be checked", () => {
    const template = brokenItem({
      answer: { kind: "reading", range: { min: 1, max: 2 } },
      failureSeverity: "failure",
    });
    expect(problems(template)).toContain("reading_without_unit");
  });

  it("refuses a count with nothing to count against", () => {
    /**
     * The same fault as a reading with no range, through the other door. No
     * count can ever fall short of nothing, so the item can never produce a
     * finding, and the failureSeverity the validator demands beside it
     * describes something that cannot happen. Zero extinguishers on the floor
     * would report as a pass.
     */
    const template = brokenItem({
      answer: { kind: "count" },
      failureSeverity: "safety",
    });
    expect(problems(template)).toContain("count_without_expectation");

    // And an expectation nothing can fall short of is the same vacuum.
    const negative = brokenItem({
      answer: { kind: "count", expectedAtLeast: -1 },
      failureSeverity: "safety",
    });
    expect(problems(negative)).toContain("count_without_expectation");

    // The counterpart, so this is not passing because counts are refused
    // outright: a count with a real minimum is a perfectly good item.
    const good = brokenItem({
      answer: { kind: "count", expectedAtLeast: 4 },
      failureSeverity: "safety",
    });
    expect(validateTemplate(good).ok).toBe(true);
  });

  it("refuses a suggested repair with no price book item behind it", () => {
    const template = brokenItem({
      answer: { kind: "pass_fail" },
      failureSeverity: "failure",
      remedies: [{ priceBookItemKey: "", label: "Something", quantity: 1, rationale: "Because." }],
    });
    expect(problems(template)).toContain("invalid_remedy");
  });

  it("reports every problem at once rather than the first one", () => {
    /**
     * A validator that stops at the first fault makes somebody save, fix,
     * save, fix, and by the fourth round they delete whatever the product
     * complained about instead of reading it.
     */
    const template: InspectionTemplate = {
      key: "t", title: "T", discipline: "HVAC",
      sections: [
        { key: "empty", title: "Nothing here", items: [] },
        { key: "s", title: "S", items: [
          { key: "dup", prompt: "One", answer: { kind: "reading", unit: "psi", range: { min: 9, max: 1 } }, failureSeverity: "failure" },
          { key: "dup", prompt: "Two", answer: undefined },
        ] },
      ],
    };
    const codes = problems(template);
    expect(codes).toContain("empty_section");
    expect(codes).toContain("range_floor_above_ceiling");
    expect(codes).toContain("duplicate_item_key");
    expect(codes).toContain("no_answer_kind");
  });

  it("explains itself in sentences somebody editing a template can act on", () => {
    const result = validateTemplate({ key: "t", title: "T", discipline: "HVAC", sections: [] });
    if (result.ok) throw new Error("expected a refusal");
    const text = explainTemplateProblems(result.problems);
    expect(text).toContain("no sections");
    for (const problem of result.problems) expect(problem.message.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------

describe("a reading against its range", () => {
  const plain: AnswerSpec = { kind: "reading", unit: "psi", range: { min: 350, max: 450 } };
  const banded: AnswerSpec = { kind: "reading", unit: "psi", range: { min: 350, max: 450, borderlineWithin: 10 } };

  const ok = (spec: AnswerSpec, raw: string | number | null) => {
    const verdict = evaluateReading(spec, raw);
    if (!verdict.ok) throw new Error(`expected a reading, got ${verdict.reason}`);
    return verdict;
  };

  it("reads a value exactly on the floor as in range", () => {
    /**
     * A manufacturer who writes 350 to 450 is saying 350 is acceptable.
     * Treating the edge as a failure turns every device running exactly to
     * spec into a sales opportunity.
     */
    const verdict = ok(plain, "350");
    expect(verdict.standing).toBe("in_range");
    expect(verdict.withinRange).toBe(true);
    expect(verdict.edge).toBeNull();
  });

  it("reads a value exactly on the ceiling as in range", () => {
    expect(ok(plain, 450).standing).toBe("in_range");
    expect(ok(plain, 450).withinRange).toBe(true);
  });

  it("calls the boundary borderline when a band is declared, and still in range", () => {
    /**
     * Borderline exists so a technician can say "inside its range and near the
     * edge" without that sentence becoming "failed" on the report.
     */
    const verdict = ok(banded, 350);
    expect(verdict.standing).toBe("borderline");
    expect(verdict.withinRange).toBe(true);
    expect(verdict.edge).toBe("below");
  });

  it("never lets borderline mean out of range", () => {
    // The single most profitable bug this module could have.
    for (const raw of [350, 355, 360, 440, 445, 450]) {
      const verdict = ok(banded, raw);
      expect(verdict.withinRange, String(raw)).toBe(true);
      expect(verdict.standing, String(raw)).not.toBe("out_of_range");
    }
  });

  it("names which end a reading fell off", () => {
    expect(ok(plain, 349).standing).toBe("out_of_range");
    expect(ok(plain, 349).edge).toBe("below");
    expect(ok(plain, 451).edge).toBe("above");
    expect(ok(plain, 451).withinRange).toBe(false);
  });

  it("judges a range that is open at one end against the end it has", () => {
    const openTop: AnswerSpec = { kind: "reading", unit: "in wc", range: { min: 20, max: null } };
    expect(ok(openTop, 9000).standing).toBe("in_range");
    expect(ok(openTop, 19).standing).toBe("out_of_range");
    expect(ok(openTop, 19).edge).toBe("below");
  });

  it("carries the value and the range together, so the screen can show both", () => {
    // A number with no spec beside it is a number the customer cannot check.
    const verdict = ok(plain, "412");
    expect(verdict.value).toBe(412);
    expect(verdict.unit).toBe("psi");
    expect(verdict.range.min).toBe(350);
    expect(verdict.range.max).toBe(450);
    expect(describeRange(verdict.range, verdict.unit)).toBe("350 to 450 psi");
  });

  it("refuses a reading nobody recorded", () => {
    for (const raw of [null, undefined, "", "   "]) {
      const verdict = evaluateReading(plain, raw);
      expect(verdict.ok, String(raw)).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("missing");
    }
  });

  it("refuses a reading that is not a number rather than guessing at it", () => {
    /**
     * parseFloat reads "12abc" as 12. A compliance record is the wrong place
     * to write down a number nobody measured.
     */
    for (const raw of ["about 12", "12 psi-ish", "--", "NaN"]) {
      const verdict = evaluateReading(plain, raw);
      expect(verdict.ok, raw).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("not_a_number");
    }
  });

  it("refuses to judge a reading with no range at all", () => {
    const verdict = evaluateReading({ kind: "reading", unit: "psi" }, "400");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("no_range");
  });

  it("describes a range in words for every shape it can take", () => {
    expect(describeRange({ min: 20, max: null }, "in wc")).toBe("at least 20 in wc");
    expect(describeRange({ min: null, max: 400 }, "ppm")).toBe("at most 400 ppm");
  });
});

// ---------------------------------------------------------------------------

describe("what an inspection reports", () => {
  it("does not report passed when items were left unanswered", () => {
    /**
     * THE MOST DANGEROUS OUTPUT THIS MODULE COULD PRODUCE. Three of the four
     * required items were answered and every one of them was fine, which is
     * exactly the shape that tempts a rollup into saying "passed": the only
     * thing wrong with this inspection is that part of it did not happen.
     */
    const result = assess(CLEAN.filter((a) => a.itemKey !== "capacitor"));

    expect(result.outcome).not.toBe("passed");
    expect(result.outcome).toBe("incomplete");
    expect(result.complete).toBe(false);
    expect(result.unanswered).toEqual(["capacitor"]);
    expect(result.deficiencies).toHaveLength(0);
    expect(result.statement.startsWith("Passed")).toBe(false);
    expect(result.statement).toContain("not checked");
  });

  it("does not let a harmless finding outrank an unfinished walk", () => {
    /**
     * The same rule as the test above, in the shape that actually gets past a
     * rollup. With no findings at all, almost any ordering of the rules lands
     * on "incomplete" by accident. Put one borderline reading in front of it
     * and a rollup that checks for findings before it checks for unanswered
     * items reports "passed_with_recommendations", whose sentence opens
     * "Passed. Every item was checked." while the capacitor sits unchecked.
     *
     * Incompleteness is not outranked by good news.
     */
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "capacitor" && a.itemKey !== "gas_pressure"),
      answer("gas_pressure", { kind: "reading", raw: "3.25" }),
    ]);

    expect(result.deficiencies).toHaveLength(1);
    expect(result.deficiencies[0]?.severity).toBe("recommendation");
    expect(result.unanswered).toEqual(["capacitor"]);
    expect(result.complete).toBe(false);
    expect(result.outcome).toBe("incomplete");
    expect(result.statement.startsWith("Passed")).toBe(false);
    expect(result.statement).toContain("not checked");
  });

  it("reports passed when the same walk is actually finished", () => {
    // The other half of the test above. Without this one, a rollup that never
    // says "passed" at all would look correct.
    const result = assess(CLEAN);
    expect(result.outcome).toBe("passed");
    expect(result.complete).toBe(true);
    expect(result.unanswered).toHaveLength(0);
  });

  it("does not count a not-applicable with no reason as an answer", () => {
    /**
     * One tap, and the item leaves the outstanding list. It is the most
     * convenient way in any inspection product to make a skipped item look
     * like a completed one.
     */
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "capacitor"),
      answer("capacitor", { kind: "not_applicable", why: "  " }),
    ]);
    expect(result.outcome).toBe("incomplete");
    expect(result.unanswered).toContain("capacitor");
    expect(result.unreadable).toContain("capacitor");
  });

  it("does count a not-applicable that says why", () => {
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "capacitor"),
      answer("capacitor", { kind: "not_applicable", why: "This unit is an ECM, it has no run capacitor." }),
    ]);
    expect(result.outcome).toBe("passed");
    expect(result.notApplicable).toEqual(["capacitor"]);
  });

  it("does not count a photo item with no photo as answered", () => {
    // The whole reason the item exists is that somebody wanted to see the thing.
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "nameplate_photo"),
      answer("nameplate_photo", { kind: "photo", photoIds: [] }),
    ]);
    expect(result.outcome).toBe("incomplete");
    expect(result.unanswered).toContain("nameplate_photo");
  });

  it("does not count a reading nobody could read as answered", () => {
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "gas_pressure"),
      answer("gas_pressure", { kind: "reading", raw: "about 3 and a half" }),
    ]);
    expect(result.outcome).toBe("incomplete");
    expect(result.unanswered).toContain("gas_pressure");
    expect(result.unreadable).toContain("gas_pressure");
  });

  it("fails on a safety finding even when the walk was not finished, and still says it was not finished", () => {
    /**
     * A hazard found on item three is not made less true by nobody reaching
     * item nine. Holding the failure back pending a complete walk is how a
     * cracked heat exchanger sits in a draft for a week. The incompleteness
     * does not disappear, it is reported alongside.
     */
    const result = assess([
      withNote(answer("heat_exchanger", { kind: "pass_fail", passed: false }), "Visible crack at the second cell."),
      answer("gas_pressure", { kind: "reading", raw: "3.5" }),
    ]);

    expect(result.outcome).toBe("failed");
    expect(result.complete).toBe(false);
    expect(result.counts.safety).toBe(1);
    expect(result.statement).toContain("not checked");
    expect(result.statement).toContain("should not be used");
  });

  it("passes with recommendations when the only finding is a reading near the edge", () => {
    /**
     * A capacitor reading low but inside its range. The system worked on the
     * day somebody looked at it, and the report has to be able to say so while
     * still mentioning the capacitor.
     */
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "capacitor"),
      answer("capacitor", { kind: "reading", raw: "4.7" }),
    ]);

    expect(result.outcome).toBe("passed_with_recommendations");
    expect(result.complete).toBe(true);
    expect(result.counts.recommendation).toBe(1);
    expect(result.counts.safety).toBe(0);
    expect(result.deficiencies[0]?.severity).toBe("recommendation");
    expect(result.deficiencies[0]?.observation.reading?.withinRange).toBe(true);
  });

  it("fails on a reading that is actually outside its range", () => {
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "gas_pressure"),
      answer("gas_pressure", { kind: "reading", raw: "4.4" }),
    ]);
    expect(result.outcome).toBe("failed");
    expect(result.deficiencies[0]?.severity).toBe("failure");
    expect(result.deficiencies[0]?.summary).toContain("outside 3.2 to 3.8 in wc");
  });

  it("lets an optional item be skipped without pretending the rest was not", () => {
    // The one loophole in the rollup, and it is named in the result so a
    // report can show how much of the walk was optional.
    const result = assess(CLEAN);
    expect(result.optionalSkipped).toEqual(["attic_access"]);
    expect(result.outcome).toBe("passed");
  });

  it("does not tell a customer every item was checked when an optional one was skipped", () => {
    /**
     * The report sentence is the part a customer and an insurer actually read.
     * "Every item was checked" printed over a walk where attic access was
     * never looked at is the same false claim as a pass over an unanswered
     * item, made quietly and about a smaller thing. The pass is honest; the
     * sentence has to be too.
     */
    const result = assess(CLEAN);
    expect(result.outcome).toBe("passed");
    expect(result.optionalSkipped).toEqual(["attic_access"]);
    expect(result.statement).not.toContain("Every item was checked");
    expect(result.statement).toContain("1 optional item was not");

    // The counterpart: with nothing optional left undone, the plain sentence
    // is true and is the one that gets printed.
    const everything: InspectionTemplate = {
      key: "e", title: "E", discipline: "HVAC",
      sections: [{ key: "s", title: "S", items: [
        { key: "hx", prompt: "Heat exchanger intact", answer: { kind: "pass_fail" }, failureSeverity: "safety" },
      ] }],
    };
    const whole = assess([answer("hx", { kind: "pass_fail", passed: true })], everything);
    expect(whole.optionalSkipped).toEqual([]);
    expect(whole.statement).toContain("Every item was checked");
  });

  it("sorts what it found worst first", () => {
    const result = assess([
      answer("heat_exchanger", { kind: "pass_fail", passed: false }),
      answer("gas_pressure", { kind: "reading", raw: "3.5" }),
      answer("capacitor", { kind: "reading", raw: "4.7" }),
      answer("nameplate_photo", { kind: "photo", photoIds: ["p"] }),
    ]);
    expect(result.deficiencies.map((d) => d.severity)).toEqual(["safety", "recommendation"]);
  });

  it("keeps the later of two answers for the same item", () => {
    // A technician who re-takes a reading meant the second one.
    const later = new Date(AT.getTime() + 60_000);
    const result = assess([
      ...CLEAN.filter((a) => a.itemKey !== "gas_pressure"),
      answer("gas_pressure", { kind: "reading", raw: "9.9" }),
      answer("gas_pressure", { kind: "reading", raw: "3.5" }, later),
    ]);
    expect(result.outcome).toBe("passed");
  });

  it("refuses an answer for an item that is not on the template", () => {
    /**
     * It means the template changed under a technician who was offline. The
     * work they did recording it is real, and dropping it loses the only
     * record that it happened.
     */
    const result = assessInspection(FURNACE, [...CLEAN, answer("blower_amps", { kind: "note", text: "7.1" })]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("unknown_item");
    if (result.reason === "unknown_item") expect(result.detail).toEqual(["blower_amps"]);
  });

  it("refuses an answer of the wrong kind rather than coercing it", () => {
    // A pass/fail recorded against a pressure reading is a client bug, and
    // guessing writes a number onto a compliance record on a guess.
    const result = assessInspection(FURNACE, [
      ...CLEAN.filter((a) => a.itemKey !== "gas_pressure"),
      answer("gas_pressure", { kind: "pass_fail", passed: true }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_answer_kind");
  });

  it("refuses to assess anything against a template that should not have been saved", () => {
    const broken: InspectionTemplate = {
      key: "t", title: "T", discipline: "HVAC",
      sections: [{ key: "s", title: "S", items: [{ key: "i", prompt: "Anything" }] }],
    };
    const result = assessInspection(broken, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_template");
  });

  it("never turns a free note into a finding on its own", () => {
    /**
     * A product that did would build a backlog out of "customer says it is
     * noisy sometimes", and a backlog full of invented work is one nobody
     * trusts, the contractor included.
     */
    const noted: InspectionTemplate = {
      key: "n", title: "N", discipline: "HVAC",
      sections: [{ key: "s", title: "S", items: [{ key: "note", prompt: "Anything else", answer: { kind: "note" } }] }],
    };
    const result = assess([answer("note", { kind: "note", text: "Homeowner says it is noisy some mornings." })], noted);
    expect(result.deficiencies).toHaveLength(0);
    expect(result.outcome).toBe("passed");
  });

  it("counts short on a count item and says what was expected", () => {
    const extinguishers: InspectionTemplate = {
      key: "fe", title: "Extinguishers", discipline: "Fire",
      sections: [{ key: "s", title: "S", items: [{
        key: "count", prompt: "Extinguishers present on this floor",
        answer: { kind: "count", expectedAtLeast: 4 }, failureSeverity: "failure",
      }] }],
    };
    const result = assess([answer("count", { kind: "count", count: 2 })], extinguishers);
    expect(result.outcome).toBe("failed");
    expect(result.deficiencies[0]?.summary).toContain("found 2, expected at least 4");
  });
});

// ---------------------------------------------------------------------------

describe("turning what was found into work somebody is asked to buy", () => {
  const found = () => assess([
    withNote(answer("heat_exchanger", { kind: "pass_fail", passed: false }), "Visible crack at the second cell."),
    answer("gas_pressure", { kind: "reading", raw: "3.5" }),
    answer("capacitor", { kind: "reading", raw: "4.7" }),
    answer("nameplate_photo", { kind: "photo", photoIds: ["p"] }),
  ]).deficiencies;

  const propose = (deficiencies: readonly DeficiencyInput[]) => {
    const result = proposeWork(deficiencies);
    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}`);
    return result;
  };

  it("refuses a deficiency with no observation attached", () => {
    /**
     * A price with a story and no evidence, which is the exact artefact this
     * module exists to make impossible to produce.
     */
    const result = proposeWork([{
      itemKey: "heat_exchanger",
      severity: "safety",
      summary: "Heat exchanger intact: failed.",
      remedies: [{ priceBookItemKey: "HX-REPLACE", label: "Replace heat exchanger", quantity: 1, rationale: "Because." }],
    }]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // The reason is asserted flatly rather than inside an `if` on the reason
    // itself: a conditional assertion on the thing under test passes happily
    // when the refusal arrives for some other reason, and then the detail
    // below is never checked at all.
    expect(result.reason).toBe("unobserved_deficiency");
    // Named, so somebody can go and attach the photo they took.
    if (result.reason === "unobserved_deficiency") expect(result.detail).toEqual(["heat_exchanger"]);
  });

  it("refuses one unobserved deficiency even when the rest are evidenced", () => {
    // The realistic case: one line slipped in beside four real ones.
    const result = proposeWork([
      ...found(),
      { itemKey: "invented", severity: "failure", summary: "Also the blower is tired.", remedies: [] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("unobserved_deficiency");
    if (result.reason === "unobserved_deficiency") expect(result.detail).toEqual(["invented"]);
  });

  it("refuses a remedy that does not say why the finding implies the work", () => {
    /**
     * The other half of the refusal above. These deficiencies come back out of
     * a database, not from a template that was just validated, which is why
     * this function takes the loose shape at all. A line carrying its
     * observation but no rationale is still a price nobody can defend: the
     * evidence is attached and the argument from the evidence is missing.
     */
    const [hazard] = found();
    if (!hazard) throw new Error("expected a finding");

    const result = proposeWork([{
      ...hazard,
      remedies: [{ priceBookItemKey: "HX-REPLACE", label: "Replace heat exchanger", quantity: 1, rationale: "   " }],
    }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("unjustified_remedy");
    if (result.reason === "unjustified_remedy") {
      expect(result.detail).toHaveLength(1);
      expect(result.detail[0]).toContain("heat_exchanger");
    }
  });

  it("refuses a proposed line for nothing, or for less than nothing", () => {
    // A quantity of zero is an estimate line for none of something, and a
    // negative one is worse. Neither reaches a customer.
    const [hazard] = found();
    if (!hazard) throw new Error("expected a finding");
    for (const quantity of [0, -3]) {
      const result = proposeWork([{
        ...hazard,
        remedies: [{ priceBookItemKey: "HX-REPLACE", label: "Replace heat exchanger", quantity, rationale: "A cracked exchanger vents combustion gas into the house." }],
      }]);
      expect(result.ok, String(quantity)).toBe(false);
      if (!result.ok) expect(result.reason, String(quantity)).toBe("unjustified_remedy");
    }

    // The counterpart: the same remedy with a real quantity goes through.
    const good = propose([hazard]);
    expect(good.lineCount).toBe(1);
  });

  it("carries the observation onto every single proposed line", () => {
    // Not a reference to one, the object. A proposal that can be printed
    // without its evidence will be.
    const proposal = propose(found());
    // The loop below proves nothing against an empty proposal, and an empty
    // proposal is exactly what a bug in the grouping would produce.
    expect(proposal.lineCount).toBe(2);
    expect(proposal.groups.flatMap((g) => g.lines)).toHaveLength(2);

    for (const group of proposal.groups) {
      for (const line of group.lines) {
        const observation: Observation = line.observation;
        expect(observation.itemKey, line.priceBookItemKey).toBe(line.deficiencyItemKey);
        expect(observation.recorded.length).toBeGreaterThan(0);
        expect(observation.by).toBe("tech-1");
        expect(line.rationale.length).toBeGreaterThan(10);
      }
    }
  });

  it("never puts a hazard and a recommendation under the same heading", () => {
    /**
     * The commercial and ethical point of the module, at the moment it turns
     * into a sales document. A customer reading a flat list cannot tell which
     * line is a cracked heat exchanger and which is a capacitor that still
     * works.
     */
    const proposal = propose(found());
    const safety = proposal.groups.find((g) => g.severity === "safety");
    const suggestion = proposal.groups.find((g) => g.severity === "recommendation");

    expect(safety).toBeDefined();
    expect(suggestion).toBeDefined();
    expect(safety?.heading).not.toBe(suggestion?.heading);
    expect(safety?.lines.map((l) => l.deficiencyItemKey)).toEqual(["heat_exchanger"]);
    expect(suggestion?.lines.map((l) => l.deficiencyItemKey)).toEqual(["capacitor"]);

    for (const group of proposal.groups) {
      for (const line of group.lines) expect(line.severity, group.heading).toBe(group.severity);
    }
  });

  it("only lets the group that is actually urgent be presented as urgent", () => {
    const proposal = propose(found());
    expect(proposal.groups.find((g) => g.severity === "safety")?.mayBePresentedAsUrgent).toBe(true);
    expect(proposal.groups.find((g) => g.severity === "recommendation")?.mayBePresentedAsUrgent).toBe(false);
  });

  it("puts the groups in front of the customer worst first", () => {
    const proposal = propose(found());
    const ranks = proposal.groups.map((g) => SEVERITY[g.severity].rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("hands back a finding with no price book item rather than dropping it", () => {
    /**
     * The quiet failure in the other direction: the findings that convert get
     * proposed, the ones with no SKU disappear, and the compliance record and
     * the proposal stop agreeing about what was found.
     */
    const [hazard] = found();
    if (!hazard) throw new Error("expected a finding");
    const proposal = propose([{ ...hazard, remedies: [] }]);

    expect(proposal.lineCount).toBe(0);
    expect(proposal.unmapped.map((u) => u.itemKey)).toEqual(["heat_exchanger"]);
    expect(proposal.unmapped[0]?.severity).toBe("safety");
    expect(proposal.unmapped[0]?.reason.length).toBeGreaterThan(20);
  });

  it("carries the code reference through, because the jurisdiction asks for it", () => {
    const proposal = propose(found());
    const line = proposal.groups.flatMap((g) => g.lines).find((l) => l.deficiencyItemKey === "heat_exchanger");
    expect(line?.codeReference).toBe("NFPA 54 10.1");
  });

  it("refuses to produce a proposal out of nothing", () => {
    // An inspection that found nothing is good news, not an opportunity.
    const result = proposeWork([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nothing_to_propose");
  });
});

// ---------------------------------------------------------------------------

describe("the backlog over time", () => {
  const foundAt = new Date("2026-01-01T00:00:00Z");
  const later = (days: number) => new Date(foundAt.getTime() + days * 86_400_000);

  it("ages against the date it is given rather than whenever the report ran", () => {
    // Run the same month end twice and it has to say the same thing.
    const standing = backlogStanding({ itemKey: "capacitor", severity: "wear", foundAt }, later(45));
    expect(standing.ageDays).toBe(45);
    expect(backlogStanding({ itemKey: "capacitor", severity: "wear", foundAt }, later(45)).ageDays).toBe(45);
  });

  it("makes a hazard overdue the day after it was found", () => {
    expect(backlogStanding({ itemKey: "hx", severity: "safety", foundAt }, later(0)).overdue).toBe(false);
    expect(backlogStanding({ itemKey: "hx", severity: "safety", foundAt }, later(1)).overdue).toBe(true);
  });

  it("never makes a recommendation overdue", () => {
    // There is no deadline on something that is not wrong, and a backlog that
    // turns suggestions red teaches people to ignore red.
    const standing = backlogStanding({ itemKey: "cap", severity: "recommendation", foundAt }, later(3650));
    expect(standing.overdue).toBe(false);
    expect(standing.respondWithinDays).toBeNull();
  });

  it("does not age backwards when a device clock was wrong", () => {
    // A negative age would sort to the top of a list of overdue work.
    const standing = backlogStanding({ itemKey: "hx", severity: "failure", foundAt }, later(-30));
    expect(standing.ageDays).toBe(0);
    expect(standing.overdue).toBe(false);
  });

  it("says what the age means in words, because a number alone does not", () => {
    const standing = backlogStanding({ itemKey: "hx", severity: "failure", foundAt }, later(90));
    expect(standing.statement).toContain("90 days");
    expect(standing.statement).toContain("30 day mark");
  });
});
