/**
 * CAN THIS ONE PERSON DO THIS WORK
 *
 * A job type declares the skills its work needs. A crew was checked against
 * them and an individual technician never was, so the commonest way work
 * gets sent, one person in one van, had no qualification check at all.
 *
 * Two sources answer, and they are not equally good:
 *
 *   A CERTIFICATION, recorded against the person with an expiry and a
 *   status (M24). It can say whose, why and until when, and it is preferred
 *   wherever a certification type grants the skill. Covered clears the
 *   skill; lapsed and absent refuse it with the sentence M24 already writes.
 *
 *   THE TYPED LIST on the technician. A string somebody did or did not
 *   remember to put on a profile. Consulted only for skills no certification
 *   type in the company grants.
 *
 * THE TYPED LIST ONLY COUNTS AGAINST SOMEBODY ONCE THE COMPANY USES IT FOR
 * THAT SKILL. Nothing in this product wrote a technician's skills until this
 * check existed, and every trade pack declares required skills on every job
 * type, so refusing on an empty list would have stopped every assignment in
 * every company the day this shipped, with no row having changed. So a skill
 * nobody in the company is recorded as having, by either source, is
 * UNKNOWN: it does not refuse, and it says that nothing here can tell. The
 * moment one technician is recorded with it, the others are refused for it,
 * because from then on its absence on a profile means something.
 */
import { nextDay } from "../time/index.js";


/** M24's answer for one skill across the people asked about. */
export type CertifiedState = "covered" | "lapsed" | "absent" | "uncertified";

export interface SkillEvidence {
  skill: string;
  /** From the certification register, for this one technician. */
  certified: CertifiedState;
  /** M24's sentence, naming the person and the date where there is one. */
  certifiedExplanation: string;
  /** Whether the skill is on this technician's typed list. */
  typed: boolean;
  /** Whether ANY active technician in the company has it on their typed list. */
  typedAnywhere: boolean;
  /**
   * The day the record behind a typed skill ran out, when it has an expiry and
   * that day is before the work. A skill on the list whose record has lapsed
   * does not clear the check, the way a lapsed certification does not.
   */
  expiredOn?: string | null | undefined;
}

export type SkillOutcome = "qualified" | "refused" | "unknown";

export interface SkillVerdict {
  skill: string;
  outcome: SkillOutcome;
  /** Where the answer came from. */
  basis: "certification" | "profile" | "nothing";
  explanation: string;
}

export interface QualificationVerdict {
  /** False only when at least one skill is refused. Unknown does not refuse. */
  qualified: boolean;
  skills: SkillVerdict[];
  /** One sentence for a refusal, naming every skill that refused. Null when qualified. */
  refusal: string | null;
  /** The skills nothing could answer for, so a screen can say so beside a pass. */
  unknown: string[];
}

export function judgeSkill(name: string, evidence: SkillEvidence): SkillVerdict {
  const skill = evidence.skill;
  switch (evidence.certified) {
    case "covered":
      return { skill, outcome: "qualified", basis: "certification", explanation: evidence.certifiedExplanation };
    case "lapsed":
    case "absent":
      return { skill, outcome: "refused", basis: "certification", explanation: evidence.certifiedExplanation };
    case "uncertified":
      if (evidence.typed && evidence.expiredOn) {
        return {
          skill, outcome: "refused", basis: "profile",
          explanation: `${name}'s record of ${skill} ran out on ${evidence.expiredOn}. Renew it on their page to send them.`,
        };
      }
      if (evidence.typed) {
        return { skill, outcome: "qualified", basis: "profile", explanation: `${name} is recorded as doing ${skill}.` };
      }
      if (evidence.typedAnywhere) {
        return {
          skill, outcome: "refused", basis: "profile",
          explanation: `${name} is not recorded as doing ${skill}, and others in the company are.`,
        };
      }
      return {
        skill, outcome: "unknown", basis: "nothing",
        explanation:
          `Nobody in the company is recorded as doing ${skill}, so nothing here can say whether ${name} can. `
          + "Add it to the people who do it to make this a check.",
      };
  }
}

/** Every skill a piece of work needs, judged for one technician. */
export function judge(name: string, evidence: readonly SkillEvidence[]): QualificationVerdict {
  const skills = evidence.map((e) => judgeSkill(name, e));
  const refused = skills.filter((s) => s.outcome === "refused");
  return {
    qualified: refused.length === 0,
    skills,
    refusal: refused.length === 0
      ? null
      : `${name} cannot be sent: this work needs ${refused.map((s) => s.skill).join(" and ")}. `
        + refused.map((s) => s.explanation).join(" "),
    unknown: skills.filter((s) => s.outcome === "unknown").map((s) => s.skill),
  };
}

/** Trimmed, de-duplicated, empty strings dropped. A skill of "" matches nothing. */
export function normaliseSkills(skills: readonly string[]): string[] {
  return [...new Set(skills.map((s) => s.trim()).filter((s) => s !== ""))];
}

/**
 * A SKILL A JOB DROPPED, AND WHEN THE DROP ENDS.
 *
 * `through` is the last day the drop holds, a company date ("2026-10-20"),
 * so a drop "through Oct 20" still holds on the 20th and the type's skill is
 * asked again from the 21st. A drop with no `through` has no end, which is
 * how every drop was made before ends existed. The day it is judged on is the
 * day of the WORK (the visit's day), never the day somebody is looking: a
 * visit booked for the 25th cannot slip through a drop that ends on the 20th
 * just because it was assigned on the 18th.
 */
export interface SkillDrop {
  skill: string;
  through?: string | null | undefined;
}

/** Whether a drop still stands on a day: no end, or the day is not after it. */
export function dropHolds(drop: Pick<SkillDrop, "through">, on: string): boolean {
  return !drop.through || on <= drop.through;
}

/** Whether a drop has ended as of a day, which is said on the job as "asked again". */
export function dropEnded(drop: Pick<SkillDrop, "through">, on: string): boolean {
  return !dropHolds(drop, on);
}

/**
 * The days inside a range on which the skills asked for change because a drop
 * has just ended: the day after each `through` that falls from `from` up to
 * but not including `until`, ascending and without repeats. A calendar that
 * spans one has to ask twice.
 */
export function dropChangeDays(
  drops: readonly Pick<SkillDrop, "through">[], from: string, until: string,
): string[] {
  const days = new Set<string>();
  for (const drop of drops) {
    if (!drop.through) continue;
    const after = nextDay(drop.through);
    if (after > from && after <= until) days.add(after);
  }
  return [...days].sort();
}
