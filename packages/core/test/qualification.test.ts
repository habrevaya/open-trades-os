import { describe, it, expect } from "vitest";
import { qualification } from "../src/index";

/**
 * ONE PERSON, ONE PIECE OF WORK
 *
 * The check the board's drag, the assignment API and the optimiser's
 * suggestions all make before sending somebody on their own.
 */

const evidence = (over: Partial<qualification.SkillEvidence> = {}): qualification.SkillEvidence => ({
  skill: "gas-fitting",
  certified: "uncertified",
  certifiedExplanation: "",
  typed: false,
  typedAnywhere: false,
  ...over,
});

describe("judging one skill", () => {
  it("clears a live certification, even when the profile forgot the skill", () => {
    const verdict = qualification.judgeSkill("Ray", evidence({
      certified: "covered", certifiedExplanation: "Ray Ortiz holds Gas Safe.",
    }));
    expect(verdict).toMatchObject({ outcome: "qualified", basis: "certification" });
  });

  it("refuses a lapsed certification with the register's own sentence", () => {
    const verdict = qualification.judgeSkill("Ray", evidence({
      certified: "lapsed", typed: true,
      certifiedExplanation: "Ray Ortiz's Gas Safe expired on 2026-03-01, so nobody here can take gas-fitting work today.",
    }));
    /**
     * Typed on the profile and lapsed in the register is refused: the register
     * knows the date, the profile is a string somebody typed two years ago.
     */
    expect(verdict.outcome).toBe("refused");
    expect(verdict.explanation).toContain("expired on 2026-03-01");
  });

  it("refuses somebody who holds no certification the company recognises for it", () => {
    expect(qualification.judgeSkill("Ray", evidence({
      certified: "absent", certifiedExplanation: "Nobody here holds a certification for gas-fitting.",
    })).outcome).toBe("refused");
  });

  it("falls back to the profile for a skill no certification grants", () => {
    expect(qualification.judgeSkill("Ray", evidence({ typed: true, typedAnywhere: true })))
      .toMatchObject({ outcome: "qualified", basis: "profile" });
  });

  it("refuses on the profile only once somebody in the company is recorded with the skill", () => {
    const verdict = qualification.judgeSkill("Sam", evidence({ typed: false, typedAnywhere: true }));
    expect(verdict.outcome).toBe("refused");
    expect(verdict.explanation).toBe("Sam is not recorded as doing gas-fitting, and others in the company are.");
  });

  it("calls a skill nobody is recorded with unknown, and does not refuse on it", () => {
    /**
     * Every trade pack declares skills on every job type and nothing wrote a
     * technician's skills before this check. Refusing here would stop every
     * assignment in every company on the day it shipped.
     */
    const verdict = qualification.judgeSkill("Sam", evidence());
    expect(verdict.outcome).toBe("unknown");
    expect(verdict.explanation).toMatch(/nothing here can say/);
  });
});

describe("judging the work", () => {
  it("passes when nothing refuses, and lists what it could not check", () => {
    const verdict = qualification.judge("Sam", [
      evidence({ skill: "hvac-service" }),
      evidence({ skill: "refrigerant", typed: true, typedAnywhere: true }),
    ]);
    expect(verdict.qualified).toBe(true);
    expect(verdict.refusal).toBeNull();
    expect(verdict.unknown).toEqual(["hvac-service"]);
  });

  it("refuses in one sentence naming every skill that refused", () => {
    const verdict = qualification.judge("Sam", [
      evidence({ skill: "gas-fitting", typedAnywhere: true }),
      evidence({ skill: "refrigerant", certified: "absent", certifiedExplanation: "Nobody here holds a certification for refrigerant." }),
      evidence({ skill: "ladders", typed: true, typedAnywhere: true }),
    ]);
    expect(verdict.qualified).toBe(false);
    expect(verdict.refusal).toBe(
      "Sam cannot be sent: this work needs gas-fitting and refrigerant. "
      + "Sam is not recorded as doing gas-fitting, and others in the company are. "
      + "Nobody here holds a certification for refrigerant.",
    );
  });

  it("passes work that needs nothing", () => {
    expect(qualification.judge("Sam", [])).toEqual({ qualified: true, skills: [], refusal: null, unknown: [] });
  });

  it("tidies a typed list", () => {
    expect(qualification.normaliseSkills([" hvac ", "hvac", "", "gas"])).toEqual(["hvac", "gas"]);
  });
});

describe("a drop that ends", () => {
  it("holds with no end, and through its last day, and not after", () => {
    expect(qualification.dropHolds({}, "2030-01-01")).toBe(true);
    expect(qualification.dropHolds({ through: null }, "2030-01-01")).toBe(true);
    expect(qualification.dropHolds({ through: "2026-10-20" }, "2026-10-19")).toBe(true);
    expect(qualification.dropHolds({ through: "2026-10-20" }, "2026-10-20")).toBe(true);
    expect(qualification.dropHolds({ through: "2026-10-20" }, "2026-10-21")).toBe(false);
    expect(qualification.dropEnded({ through: "2026-10-20" }, "2026-10-21")).toBe(true);
    expect(qualification.dropEnded({}, "2026-10-21")).toBe(false);
  });

  it("names the days a calendar has to ask again, once each, inside the range", () => {
    const drops = [
      { through: "2026-10-20" }, { through: "2026-10-20" }, { through: "2026-10-31" },
      { through: null }, {}, { through: "2026-09-01" }, { through: "2026-11-30" },
    ];
    expect(qualification.dropChangeDays(drops, "2026-10-15", "2026-11-05")).toEqual(["2026-10-21", "2026-11-01"]);
    /** The first day of the range is asked anyway, so a drop that ended the day before it changes nothing inside. */
    expect(qualification.dropChangeDays([{ through: "2026-10-14" }], "2026-10-15", "2026-11-05")).toEqual([]);
    /** A month end is not a trap: the day after the 31st is the 1st. */
    expect(qualification.dropChangeDays([{ through: "2026-12-31" }], "2026-12-30", "2027-01-05")).toEqual(["2027-01-01"]);
  });
});
