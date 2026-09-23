/**
 * INSPECTIONS AND THE DEFICIENCY BACKLOG
 *
 * A technician walks a system, records what they found, and some of what they
 * found is work somebody should buy. That sentence contains the entire ethical
 * problem of this module, and most of the commercial one.
 *
 * THE LOOP THIS SERVES
 *
 * Fire protection, backflow, boiler, elevator, kitchen suppression, generator
 * and pressure vessel work all run the same way: the inspection finds the
 * deficiency, the deficiency becomes the proposal, the proposal becomes the
 * work order, the work order becomes the invoice. Contractors run that loop on
 * paper and a spreadsheet, and the backlog of found-and-not-yet-fixed work is
 * at the same time their compliance record and the highest converting sales
 * pipeline they own.
 *
 * THE THING THIS MODULE REFUSES TO DO
 *
 * A cracked heat exchanger and a capacitor reading low but inside its range
 * are both findings, and they are not the same kind of thing. One is a reason
 * to shut the equipment off tonight. The other is a note that a part is aging.
 *
 * A product that lets those two be presented identically is a product that
 * helps somebody upsell fear. It is trivially easy to build: give severity a
 * number, sort descending, print a list of prices. The customer cannot tell
 * which line is a hazard and which line is a hunch, and neither, six months
 * later, can the contractor. So severity here is a small declared scale where
 * each level carries what it MEANS to a homeowner, the proposal is grouped by
 * that meaning and never flattened, and every proposed line carries the
 * observation that produced it. What was observed and what is being sold are
 * inseparable by construction, because separating them is the sale.
 *
 * WHAT IS DATA AND WHAT IS CODE
 *
 * A template is DATA: sections, items, answer kinds, acceptable ranges and the
 * price book items an item maps to when it fails. It is validated against the
 * catalogues declared in this file and never evaluated. Same argument as the
 * report builder and the workflow conditions: this product is self hosted, a
 * template is edited by whoever holds the settings screen, and a template that
 * could contain an expression would be an expression engine reachable by
 * anybody who can edit a checklist.
 *
 * Everything here is pure. No clock, no database. `now` is a parameter,
 * because a deficiency's age is a fact about a moment somebody chose, and a
 * backlog report that quietly used the server's clock cannot be reproduced.
 */

// ---------------------------------------------------------------------------
// Severity, which is the part that matters
// ---------------------------------------------------------------------------

/**
 * The whole scale. Four levels, deliberately.
 *
 * Small because a scale people cannot hold in their head is a scale they use
 * inconsistently by the second week, and an inconsistent severity scale makes
 * the backlog unsortable and the compliance record worthless.
 *
 * Words rather than numbers because a number has no meaning to the homeowner
 * reading the report, and "severity 3" is whatever the person selling it needs
 * it to be. A named level with a stated meaning can be argued with.
 */
export const SEVERITIES = ["safety", "failure", "wear", "recommendation"] as const;

export type Severity = (typeof SEVERITIES)[number];

export interface SeverityLevel {
  key: Severity;
  /** What the office calls it. */
  label: string;
  /**
   * What it means to the person who owns the building, in their words rather
   * than ours. This is printed. A level with no plain meaning is a level that
   * means whatever the salesperson says it means.
   */
  meaning: string;
  /**
   * The heading this severity gets on a proposal.
   *
   * The heading IS the severity, rather than a separate mapping from severity
   * to heading. Any such mapping is a place where two levels can be given the
   * same words, and the words are the only part the customer actually reads.
   */
  heading: string;
  /** A hazard to a person, as opposed to a cost to a machine. */
  isSafety: boolean;
  /** The equipment should not be run until this is fixed. */
  takeOutOfService: boolean;
  /** Whether a finding at this level means the inspection did not pass. */
  failsInspection: boolean;
  /**
   * Whether this may be presented to a customer as urgent.
   *
   * False for everything that is not actually urgent. A renderer that puts a
   * red banner on a recommendation is doing the thing this module exists to
   * prevent, and it should have to ignore a field that says not to.
   */
  mayBePresentedAsUrgent: boolean;
  /**
   * How long the backlog may sit on this before it is late. Null means there
   * is no clock on it, which is an honest answer for an optional improvement
   * and a dishonest one for a gas leak.
   */
  respondWithinDays: number | null;
  /** Sort order only. Lower is worse. Never the identity of the level. */
  rank: number;
}

export const SEVERITY: Record<Severity, SeverityLevel> = {
  safety: {
    key: "safety",
    label: "Safety",
    meaning:
      "This can hurt somebody. Stop using the equipment until it is fixed.",
    heading: "Unsafe now: fix before the equipment is used again",
    isSafety: true,
    takeOutOfService: true,
    failsInspection: true,
    mayBePresentedAsUrgent: true,
    respondWithinDays: 0,
    rank: 0,
  },
  failure: {
    key: "failure",
    label: "Failed",
    meaning:
      "This is broken, or it does not meet code. It is not dangerous today, and it is not doing its job.",
    heading: "Not working or not to code",
    isSafety: false,
    takeOutOfService: false,
    failsInspection: true,
    mayBePresentedAsUrgent: true,
    respondWithinDays: 30,
    rank: 1,
  },
  wear: {
    key: "wear",
    label: "Wearing out",
    meaning:
      "This is working today and it is measurably outside where it should be. It will fail, and you get to choose when.",
    heading: "Working, and measurably outside spec",
    isSafety: false,
    takeOutOfService: false,
    /**
     * Does not fail the inspection. The system did work on the day somebody
     * looked at it, and saying otherwise to make the report look alarming is
     * the same lie as calling a recommendation a hazard, told quietly.
     */
    failsInspection: false,
    mayBePresentedAsUrgent: false,
    respondWithinDays: 180,
    rank: 2,
  },
  recommendation: {
    key: "recommendation",
    label: "Recommendation",
    meaning:
      "Nothing is wrong. This is something we would do if it were ours, and you can say no without consequence.",
    heading: "Optional, nothing is wrong today",
    isSafety: false,
    takeOutOfService: false,
    failsInspection: false,
    mayBePresentedAsUrgent: false,
    respondWithinDays: null,
    rank: 3,
  },
};

/** Worst first. The order a proposal is grouped and printed in. */
export const SEVERITY_ORDER: readonly Severity[] = ["safety", "failure", "wear", "recommendation"];

/**
 * The worst level in a set, or null for an empty set.
 *
 * Null rather than a default, because "no findings" and "the mildest finding"
 * are different sentences and a caller that cannot tell them apart will print
 * the wrong one on a report.
 */
export function worstSeverity(levels: readonly Severity[]): Severity | null {
  let worst: Severity | null = null;
  for (const level of levels) {
    if (worst === null || SEVERITY[level].rank < SEVERITY[worst].rank) worst = level;
  }
  return worst;
}

/** Sort comparator: worst first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY[a].rank - SEVERITY[b].rank;
}

// ---------------------------------------------------------------------------
// The template, as data
// ---------------------------------------------------------------------------

/**
 * Every kind of answer an item may take. Closed on purpose.
 *
 * A new kind is a decision about how the rollup treats it and what a failure
 * at that kind means, not something a template author invents in a text field.
 */
export const ANSWER_KINDS = ["pass_fail", "reading", "photo", "note", "count"] as const;

export type AnswerKind = (typeof ANSWER_KINDS)[number];

/**
 * An acceptable range for a reading.
 *
 * Open at either end on purpose. "At least 20 inches of water column" and "no
 * more than 400 parts per million" are both real specifications, and forcing a
 * template author to invent a second bound produces a bound that is wrong and
 * then gets enforced.
 */
export interface Range {
  /** Inclusive floor. Null means open at the bottom. */
  min: number | null;
  /** Inclusive ceiling. Null means open at the top. */
  max: number | null;
  /**
   * How close to an edge still counts as borderline, in the reading's own
   * units. Absent means no borderline band at all, and then a value on the
   * boundary is simply in range.
   */
  borderlineWithin?: number | undefined;
}

export interface AnswerSpec {
  kind: AnswerKind;
  /** Readings only. Printed next to the number, so a number is never bare. */
  unit?: string | undefined;
  /** Readings only. */
  range?: Range | undefined;
  /** Counts only. Below this many, the count is a finding. */
  expectedAtLeast?: number | undefined;
}

/**
 * A price book item this finding suggests, declared ON THE TEMPLATE.
 *
 * Deliberately data rather than logic in this file. The mapping from "the
 * backflow preventer failed its test" to "which part number do we sell for
 * that" is a decision each contractor makes differently, changes twice a year,
 * and must be visible to them. Buried in code it becomes our opinion about
 * their catalogue, and they cannot see it, edit it or argue with it.
 *
 * Note what is NOT here: a price. Pricing belongs to the price book and the
 * estimate, which know about cost, margin, tax and who is paying. A remedy
 * names an item and a quantity. An inspection module that carried prices would
 * be a second, stale copy of the price book living inside the sales pitch.
 */
export interface Remedy {
  /** A key into the contractor's own price book. Never a price. */
  priceBookItemKey: string;
  /** What it is, in words, so a proposal reads as English rather than as SKUs. */
  label: string;
  quantity: number;
  /**
   * Why this remedy follows from this finding. Printed beside the observation.
   *
   * Required, and this is the point of the field: if nobody can write a
   * sentence explaining why the observation implies the work, the work is not
   * implied by the observation.
   */
  rationale: string;
}

export interface TemplateItem {
  key: string;
  /** What the technician is being asked. Printed on the report. */
  prompt: string;
  /**
   * Optional in the TYPE, required by the validator.
   *
   * A template arrives as JSON: from the settings screen, from an import, from
   * a backup taken before a field existed. The type protects the code that
   * builds one and protects nothing at all at the moment one is loaded off
   * disk in a self hosted install, which is the moment that matters.
   */
  answer?: AnswerSpec | undefined;
  /**
   * What a failure of THIS item means. Required by the validator for anything
   * that can fail, and never defaulted.
   *
   * Defaulting is the trap. Default to safety and the template manufactures
   * alarm on every unconfigured item. Default to recommendation and a real
   * hazard is buried by an author who forgot a field. Refusing at save time is
   * the only answer that does not silently pick one.
   */
  failureSeverity?: Severity | undefined;
  /**
   * What a reading near the edge of its range means. Defaults to
   * `recommendation`, which is the only default that is safe to pick: a
   * reading that is still inside its range has not failed anything, and the
   * pressure will always be to call it something more urgent than that.
   */
  borderlineSeverity?: Severity | undefined;
  /** A clause in the code that applies, for the authority having jurisdiction. */
  codeReference?: string | undefined;
  remedies?: readonly Remedy[] | undefined;
  /**
   * May be skipped without leaving the inspection incomplete.
   *
   * Read the comment on the rollup before using this. It is the one way to
   * make a half finished inspection report as complete, and it exists because
   * some items genuinely do not apply to some equipment.
   */
  optional?: boolean | undefined;
}

export interface TemplateSection {
  key: string;
  title: string;
  items: readonly TemplateItem[];
}

export interface InspectionTemplate {
  key: string;
  title: string;
  /** Fire, backflow, boiler, HVAC. Free text: it is a label, not a behaviour. */
  discipline: string;
  sections: readonly TemplateSection[];
}

// ---------------------------------------------------------------------------
// Validating a template at save time
// ---------------------------------------------------------------------------

export type TemplateProblemCode =
  | "no_sections"
  | "empty_section"
  | "duplicate_section_key"
  | "duplicate_item_key"
  | "no_prompt"
  | "no_answer_kind"
  | "unknown_answer_kind"
  | "reading_without_range"
  | "count_without_expectation"
  | "reading_without_unit"
  | "range_floor_above_ceiling"
  | "range_open_at_both_ends"
  | "negative_borderline_band"
  | "missing_failure_severity"
  | "unknown_severity"
  | "invalid_remedy";

export interface TemplateProblem {
  code: TemplateProblemCode;
  /** Where it is, in keys, so the settings screen can point at it. */
  where: string;
  /** A sentence the person editing the template can act on. */
  message: string;
}

export type TemplateDecision =
  | { ok: true; template: InspectionTemplate; itemCount: number }
  | { ok: false; reason: "invalid_template"; problems: readonly TemplateProblem[] };

/**
 * Whether this template may be saved.
 *
 * EVERY problem is returned, not the first one. A validator that stops at the
 * first fault makes somebody save, fix, save, fix, six times, and by the
 * fourth round they stop reading the message and start deleting whatever the
 * product complained about. The template they end up with is worse than the
 * one they started with.
 *
 * All of these are refusals rather than warnings because each one produces a
 * specific bad day in the field: an item with no answer kind renders as a
 * question with no way to answer it, a range with the floor above the ceiling
 * fails every reading ever taken against it, a duplicate item key makes two
 * questions overwrite each other's answers, and an empty section is a heading
 * a technician scrolls past believing they have completed it.
 */
export function validateTemplate(template: InspectionTemplate): TemplateDecision {
  const problems: TemplateProblem[] = [];
  const seenSections = new Set<string>();
  const seenItems = new Set<string>();
  let itemCount = 0;

  if (template.sections.length === 0) {
    problems.push({
      code: "no_sections",
      where: template.key,
      message: "This template has no sections, so there is nothing for a technician to walk.",
    });
  }

  for (const section of template.sections) {
    if (seenSections.has(section.key)) {
      problems.push({
        code: "duplicate_section_key",
        where: section.key,
        message: `Two sections are both called "${section.key}". Section keys have to be unique.`,
      });
    }
    seenSections.add(section.key);

    if (section.items.length === 0) {
      problems.push({
        code: "empty_section",
        where: section.key,
        message: `The section "${section.title}" has no items. A heading with nothing under it reads as done.`,
      });
    }

    for (const item of section.items) {
      itemCount += 1;
      const where = `${section.key}.${item.key}`;

      if (seenItems.has(item.key)) {
        problems.push({
          code: "duplicate_item_key",
          where,
          message: `More than one item uses the key "${item.key}". Two items with one key means two answers fighting over one slot.`,
        });
      }
      seenItems.add(item.key);

      if (item.prompt.trim() === "") {
        problems.push({
          code: "no_prompt",
          where,
          message: "This item has no question on it, so nobody in the field knows what is being asked.",
        });
      }

      const answer = item.answer;
      if (!answer) {
        problems.push({
          code: "no_answer_kind",
          where,
          message: `"${item.prompt}" does not say what kind of answer it takes. Pick one of: ${ANSWER_KINDS.join(", ")}.`,
        });
        continue;
      }

      if (!ANSWER_KINDS.includes(answer.kind)) {
        /**
         * The type says this cannot happen. The type is not present at the
         * moment a template exported from an older version is imported into
         * this one, which is exactly when a kind goes missing.
         */
        problems.push({
          code: "unknown_answer_kind",
          where,
          message: `"${String(answer.kind)}" is not an answer kind this version understands. Pick one of: ${ANSWER_KINDS.join(", ")}.`,
        });
        continue;
      }

      if (answer.kind === "reading") {
        if (!answer.unit || answer.unit.trim() === "") {
          problems.push({
            code: "reading_without_unit",
            where,
            message: `"${item.prompt}" records a number with no unit. A bare number on a report is a number nobody can check.`,
          });
        }
        const range = answer.range;
        if (!range) {
          problems.push({
            code: "reading_without_range",
            where,
            message: `"${item.prompt}" records a reading with no acceptable range, so no reading can ever be judged. Use a note if there is no spec.`,
          });
        } else {
          if (range.min === null && range.max === null) {
            problems.push({
              code: "range_open_at_both_ends",
              where,
              message: `"${item.prompt}" has a range open at both ends, which accepts everything. Use a note if there is no spec.`,
            });
          }
          if (range.min !== null && range.max !== null && range.min > range.max) {
            problems.push({
              code: "range_floor_above_ceiling",
              where,
              message: `"${item.prompt}" accepts ${range.min} and above but also ${range.max} and below, which nothing satisfies. Every reading taken against this would fail.`,
            });
          }
          if (range.borderlineWithin !== undefined && range.borderlineWithin < 0) {
            problems.push({
              code: "negative_borderline_band",
              where,
              message: `"${item.prompt}" has a negative borderline band. It has to be zero or more.`,
            });
          }
        }
      }

      /**
       * A count with nothing to count against is the same fault as a reading
       * with no range, arriving by the other door: no count can ever be
       * judged, so the item can never produce a finding, and the
       * `failureSeverity` the rule below demands describes something that
       * cannot happen. Zero extinguishers on the floor would report as a pass.
       */
      if (answer.kind === "count") {
        const expected = answer.expectedAtLeast;
        if (expected === undefined) {
          problems.push({
            code: "count_without_expectation",
            where,
            message: `"${item.prompt}" counts something without saying how many there should be, so no count can ever fall short. Use a note if there is no minimum.`,
          });
        } else if (!Number.isFinite(expected) || expected < 0) {
          problems.push({
            code: "count_without_expectation",
            where,
            message: `"${item.prompt}" expects at least ${String(expected)}, which no count can fall short of. It has to be zero or more.`,
          });
        }
      }

      /**
       * Which kinds can produce a finding, and therefore have to say what that
       * finding means. A photo and a free note are evidence. They are never
       * automatically a deficiency, so they are not asked to declare one.
       */
      const canFail = answer.kind === "pass_fail" || answer.kind === "reading" || answer.kind === "count";
      if (canFail && item.failureSeverity === undefined) {
        problems.push({
          code: "missing_failure_severity",
          where,
          message: `"${item.prompt}" can fail and does not say what a failure means. Choose one of: ${SEVERITIES.join(", ")}.`,
        });
      }
      for (const declared of [item.failureSeverity, item.borderlineSeverity]) {
        if (declared !== undefined && !SEVERITIES.includes(declared)) {
          problems.push({
            code: "unknown_severity",
            where,
            message: `"${String(declared)}" is not a severity. Choose one of: ${SEVERITIES.join(", ")}.`,
          });
        }
      }

      for (const remedy of item.remedies ?? []) {
        if (remedy.priceBookItemKey.trim() === "" || remedy.quantity <= 0 || remedy.rationale.trim() === "") {
          problems.push({
            code: "invalid_remedy",
            where,
            message: `A suggested repair on "${item.prompt}" is missing a price book item, a quantity above zero, or the sentence saying why the finding implies the work.`,
          });
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, reason: "invalid_template", problems };
  return { ok: true, template, itemCount };
}

/** The problems as one block of text somebody can read. */
export function explainTemplateProblems(problems: readonly TemplateProblem[]): string {
  return problems.map((p) => `${p.where}: ${p.message}`).join("\n");
}

// ---------------------------------------------------------------------------
// A reading against its range
// ---------------------------------------------------------------------------

export type ReadingStanding = "in_range" | "borderline" | "out_of_range";

export interface ReadingEvaluation {
  ok: true;
  standing: ReadingStanding;
  /**
   * Whether the value is actually inside the acceptable range. Borderline is
   * INSIDE. Kept as its own field so a caller cannot reach for
   * `standing !== "in_range"` and quietly turn an acceptable reading into a
   * failure, which is the single most profitable bug this module could have.
   */
  withinRange: boolean;
  /** Both of these are carried so the screen shows the number and the spec. */
  value: number;
  unit: string;
  range: Range;
  /** Which end it is at or past. Null when it is comfortably inside. */
  edge: "below" | "above" | null;
}

export type ReadingRefusal =
  | { ok: false; reason: "missing"; detail: string }
  | { ok: false; reason: "not_a_number"; detail: string; raw: string }
  | { ok: false; reason: "no_range"; detail: string };

export type ReadingVerdict = ReadingEvaluation | ReadingRefusal;

/** "350 to 450 psi", "at least 20 in wc", "at most 400 ppm". */
export function describeRange(range: Range, unit: string): string {
  const suffix = unit.trim() === "" ? "" : ` ${unit}`;
  if (range.min !== null && range.max !== null) return `${range.min} to ${range.max}${suffix}`;
  if (range.min !== null) return `at least ${range.min}${suffix}`;
  if (range.max !== null) return `at most ${range.max}${suffix}`;
  return "any value";
}

/**
 * What a recorded reading means against the spec it was taken for.
 *
 * Three things this has to get right, and all three have bitten somebody:
 *
 * A VALUE ON THE BOUNDARY IS IN RANGE. The bounds are inclusive because that
 * is what a specification means: a manufacturer who writes 350 to 450 is
 * saying 350 is acceptable. Treating the edge as a failure turns every device
 * running exactly to spec into a sales opportunity.
 *
 * BORDERLINE IS NOT A FAILURE. It exists so a technician can say "this is
 * inside its range and near the edge of it" without that sentence becoming
 * "failed" on the report. It is reported separately and it stays within range.
 *
 * A READING THAT IS NOT A NUMBER IS NOT A READING. "about 12", "12 psi-ish"
 * and "" are all refused rather than coerced. Coercion here writes a number
 * onto a compliance record that nobody actually measured, and the value it
 * writes is whichever digits happened to come first.
 */
export function evaluateReading(
  spec: AnswerSpec,
  raw: string | number | null | undefined,
): ReadingVerdict {
  const range = spec.range;
  if (!range) {
    return {
      ok: false,
      reason: "no_range",
      detail: "This item has no acceptable range, so a reading cannot be judged against it.",
    };
  }

  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: false, reason: "missing", detail: "No reading was recorded for this item." };
  }

  const text = typeof raw === "number" ? String(raw) : raw.trim();
  // Number() rather than parseFloat: parseFloat reads "12abc" as 12, and a
  // compliance record is the wrong place to guess what somebody meant.
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      reason: "not_a_number",
      detail: `"${text}" is not a number, so it cannot be checked against ${describeRange(range, spec.unit ?? "")}.`,
      raw: text,
    };
  }

  const unit = spec.unit ?? "";
  const base = { ok: true as const, value, unit, range };

  if (range.min !== null && value < range.min) {
    return { ...base, standing: "out_of_range", withinRange: false, edge: "below" };
  }
  if (range.max !== null && value > range.max) {
    return { ...base, standing: "out_of_range", withinRange: false, edge: "above" };
  }

  const band = range.borderlineWithin ?? 0;
  if (band > 0) {
    if (range.min !== null && value <= range.min + band) {
      return { ...base, standing: "borderline", withinRange: true, edge: "below" };
    }
    if (range.max !== null && value >= range.max - band) {
      return { ...base, standing: "borderline", withinRange: true, edge: "above" };
    }
  }

  return { ...base, standing: "in_range", withinRange: true, edge: null };
}

// ---------------------------------------------------------------------------
// What the technician recorded
// ---------------------------------------------------------------------------

export type AnswerValue =
  | { kind: "pass_fail"; passed: boolean }
  | { kind: "reading"; raw: string | number | null }
  | { kind: "photo"; photoIds: readonly string[] }
  | { kind: "note"; text: string }
  | { kind: "count"; count: number }
  /**
   * Not applicable, WITH A REASON.
   *
   * The reason is required and the validator below treats a blank one as no
   * answer at all. Not applicable is the most convenient way in any inspection
   * product to make a skipped item look like a completed one: it takes one tap
   * and it removes the item from the outstanding list. Making somebody type
   * why costs three seconds and leaves a record that a person can read back.
   */
  | { kind: "not_applicable"; why: string };

export interface RecordedAnswer {
  itemKey: string;
  value: AnswerValue;
  /** When it was recorded, from the device. Passed in, never taken from a clock here. */
  at: Date;
  /** Who recorded it. A finding with no author is a finding nobody can ask about. */
  by: string;
  note?: string | undefined;
  photoIds?: readonly string[] | undefined;
}

/**
 * What was actually seen, as opposed to what is being proposed.
 *
 * Carried onto every proposed line further down. The two are one object by
 * the time anything renders, because a proposal that can be printed without
 * its evidence will be.
 */
export interface Observation {
  itemKey: string;
  prompt: string;
  /** What was recorded, in a sentence, for a person who was not there. */
  recorded: string;
  at: Date;
  by: string;
  photoIds: readonly string[];
  /** Present when the item was a reading, so the number and the spec travel together. */
  reading?: ReadingEvaluation | undefined;
}

export interface Deficiency {
  /** Unique within one inspection, which is the only scope this module knows about. */
  itemKey: string;
  sectionKey: string;
  severity: Severity;
  /** One line, for the backlog list. */
  summary: string;
  codeReference?: string | undefined;
  remedies: readonly Remedy[];
  observation: Observation;
  foundAt: Date;
}

// ---------------------------------------------------------------------------
// The rollup
// ---------------------------------------------------------------------------

export type InspectionOutcome =
  | "passed"
  | "passed_with_recommendations"
  | "failed"
  /**
   * Not a pass and not a fail. An inspection that has not finished happening.
   *
   * This outcome exists because the alternative is the most dangerous output
   * this module could produce: an inspection with half its items skipped
   * reporting "passed". That report goes in a compliance file, gets handed to
   * a buyer, gets shown to an insurer, and asserts that somebody looked at
   * things nobody looked at.
   */
  | "incomplete";

export interface InspectionAssessment {
  ok: true;
  outcome: InspectionOutcome;
  /** Every non-optional item has a usable answer. Always reported, whatever the outcome. */
  complete: boolean;
  answered: readonly string[];
  /**
   * Items with no usable answer. A blank reading, a photo item with no photo,
   * an empty note and a not-applicable with no reason all land here, because
   * each of them is an item nobody actually did.
   */
  unanswered: readonly string[];
  /**
   * Something was recorded for the item and it could not be read.
   *
   * These are also in `unanswered`, EXCEPT for optional items, which land in
   * `optionalSkipped` instead and do not hold up completeness. They are named
   * here either way, because a technician told only that the inspection is
   * incomplete, against a list that includes items they never opened,
   * concludes the product lost their work.
   */
  unreadable: readonly string[];
  notApplicable: readonly string[];
  /** Skipped and allowed to be. See the warning on `TemplateItem.optional`. */
  optionalSkipped: readonly string[];
  deficiencies: readonly Deficiency[];
  counts: Record<Severity, number>;
  /** The sentence that goes at the top of the report. */
  statement: string;
}

export type AssessmentRefusal =
  | { ok: false; reason: "invalid_template"; problems: readonly TemplateProblem[] }
  | { ok: false; reason: "unknown_item"; detail: readonly string[] }
  | { ok: false; reason: "wrong_answer_kind"; detail: readonly string[] };

export type AssessmentDecision = InspectionAssessment | AssessmentRefusal;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Whether an answer actually answers the question.
 *
 * Separate from whether it passes. The distinction is the whole of the
 * unanswered problem: "fail" is an answer, "" is not, and a product that
 * cannot tell them apart will happily report on an inspection nobody did.
 */
function isUsable(value: AnswerValue, spec: AnswerSpec): boolean {
  switch (value.kind) {
    case "pass_fail":
      return true;
    case "count":
      return Number.isFinite(value.count);
    case "note":
      return value.text.trim() !== "";
    case "photo":
      // A photo item with no photo is the item, unanswered. The whole reason
      // the item exists is that somebody wanted to see the thing.
      return value.photoIds.length > 0;
    case "reading":
      return evaluateReading(spec, value.raw).ok;
    case "not_applicable":
      return value.why.trim() !== "";
  }
}

/**
 * From a template and a set of answers to a result.
 *
 * THE ORDER OF THE RULES IS THE DESIGN.
 *
 *   1. Anything found at a severity that fails, fails the inspection. Even if
 *      the walk was not finished. A hazard found on item three is not made
 *      less true by nobody reaching item nine, and holding the failure back
 *      pending a complete walk is how a cracked heat exchanger sits in a draft
 *      for a week.
 *
 *   2. Otherwise, an unanswered item means incomplete. NOT passed. This is the
 *      rule the whole module is built around: an inspection cannot report that
 *      a system is fine on the strength of questions nobody answered.
 *
 *   3. Otherwise, findings that do not fail make it a pass with
 *      recommendations, which is an honest and common result.
 *
 *   4. Otherwise it passed.
 *
 * `complete` is reported alongside the outcome in every case, so a failed and
 * unfinished inspection still says out loud that it was unfinished.
 */
export function assessInspection(
  template: InspectionTemplate,
  answers: readonly RecordedAnswer[],
): AssessmentDecision {
  const validated = validateTemplate(template);
  if (!validated.ok) return { ok: false, reason: "invalid_template", problems: validated.problems };

  const items = new Map<string, { item: TemplateItem; sectionKey: string }>();
  for (const section of template.sections) {
    for (const item of section.items) items.set(item.key, { item, sectionKey: section.key });
  }

  /**
   * An answer for an item that is not on the template is refused rather than
   * dropped. It means the template changed under a technician who was offline,
   * and the work they did recording it is real. Silently discarding it loses
   * the only record that it happened.
   */
  const unknown = answers.filter((a) => !items.has(a.itemKey)).map((a) => a.itemKey);
  if (unknown.length > 0) {
    return { ok: false, reason: "unknown_item", detail: [...new Set(unknown)] };
  }

  /**
   * The last answer by occurrence time wins. A technician who re-takes a
   * reading meant the second one, and the first is still in the operation log
   * if anybody needs it. Ties go to the later position in the batch, which is
   * the device's own order.
   */
  const latest = new Map<string, RecordedAnswer>();
  for (const answer of answers) {
    const existing = latest.get(answer.itemKey);
    if (!existing || answer.at.getTime() >= existing.at.getTime()) latest.set(answer.itemKey, answer);
  }

  const mismatched: string[] = [];
  for (const [itemKey, answer] of latest) {
    const entry = items.get(itemKey);
    if (!entry?.item.answer) continue;
    if (answer.value.kind !== "not_applicable" && answer.value.kind !== entry.item.answer.kind) {
      mismatched.push(`${itemKey}: asked for ${entry.item.answer.kind}, got ${answer.value.kind}`);
    }
  }
  if (mismatched.length > 0) {
    // Refused rather than coerced. A pass/fail answer recorded against a
    // pressure reading is a client bug, and guessing which one is right here
    // writes a number onto a compliance record on the strength of a guess.
    return { ok: false, reason: "wrong_answer_kind", detail: mismatched };
  }

  const answered: string[] = [];
  const unanswered: string[] = [];
  const unreadable: string[] = [];
  const notApplicable: string[] = [];
  const optionalSkipped: string[] = [];
  const deficiencies: Deficiency[] = [];

  for (const section of template.sections) {
    for (const item of section.items) {
      const spec = item.answer;
      if (!spec) continue; // validateTemplate already refused this template.

      const answer = latest.get(item.key);
      if (!answer) {
        if (item.optional) optionalSkipped.push(item.key);
        else unanswered.push(item.key);
        continue;
      }

      if (!isUsable(answer.value, spec)) {
        /**
         * Something was recorded and it does not answer the question: a blank
         * reading, "about 12", a photo item with no photo, an empty note, a
         * not-applicable with no reason.
         *
         * It counts as unanswered for the rollup, and it is named separately
         * so the technician is told WHICH of their entries did not land. Being
         * told only that the inspection is incomplete, with a list that
         * includes items they never opened, is how somebody concludes the
         * product lost their work and stops trusting the list.
         */
        unreadable.push(item.key);
        if (item.optional) optionalSkipped.push(item.key);
        else unanswered.push(item.key);
        continue;
      }

      answered.push(item.key);

      if (answer.value.kind === "not_applicable") {
        notApplicable.push(item.key);
        continue;
      }

      const finding = findingFor(item, spec, answer);
      if (finding) {
        deficiencies.push({
          itemKey: item.key,
          sectionKey: section.key,
          severity: finding.severity,
          summary: finding.summary,
          ...(item.codeReference !== undefined ? { codeReference: item.codeReference } : {}),
          remedies: item.remedies ?? [],
          observation: finding.observation,
          foundAt: answer.at,
        });
      }
    }
  }

  const counts: Record<Severity, number> = { safety: 0, failure: 0, wear: 0, recommendation: 0 };
  for (const deficiency of deficiencies) counts[deficiency.severity] += 1;

  const complete = unanswered.length === 0;
  const fails = deficiencies.some((d) => SEVERITY[d.severity].failsInspection);

  let outcome: InspectionOutcome;
  if (fails) outcome = "failed";
  else if (!complete) outcome = "incomplete";
  else if (deficiencies.length > 0) outcome = "passed_with_recommendations";
  else outcome = "passed";

  return {
    ok: true,
    outcome,
    complete,
    answered,
    unanswered,
    unreadable,
    notApplicable,
    optionalSkipped,
    deficiencies: [...deficiencies].sort((a, b) => compareSeverity(a.severity, b.severity)),
    counts,
    statement: statementFor(outcome, complete, unanswered.length, optionalSkipped.length, counts),
  };
}

/**
 * What one answered item found, if anything.
 *
 * Note what never produces a finding: a photo and a free note. They are
 * evidence. A product that turned every note into a deficiency would generate
 * a backlog out of "customer says it is noisy sometimes", and a backlog full
 * of invented work is a backlog nobody trusts, including the contractor.
 */
function findingFor(
  item: TemplateItem,
  spec: AnswerSpec,
  answer: RecordedAnswer,
): { severity: Severity; summary: string; observation: Observation } | null {
  const photoIds = answer.photoIds ?? (answer.value.kind === "photo" ? answer.value.photoIds : []);
  const base = {
    itemKey: item.key,
    prompt: item.prompt,
    at: answer.at,
    by: answer.by,
    photoIds,
  };

  switch (answer.value.kind) {
    case "pass_fail": {
      if (answer.value.passed) return null;
      // failureSeverity is required by the validator for this kind, so the
      // fallback is unreachable rather than a policy. It is here because an
      // unreachable fallback is cheaper than a non-null assertion that stops
      // being true when somebody adds a kind.
      const severity = item.failureSeverity ?? "failure";
      const recorded = answer.note?.trim()
        ? `Failed. ${answer.note.trim()}`
        : "Failed.";
      return {
        severity,
        summary: `${item.prompt}: failed.`,
        observation: { ...base, recorded },
      };
    }
    case "reading": {
      const verdict = evaluateReading(spec, answer.value.raw);
      if (!verdict.ok) return null; // Handled as unanswered by the caller.
      const spoken = `${verdict.value}${verdict.unit ? ` ${verdict.unit}` : ""}`;
      const range = describeRange(verdict.range, verdict.unit);
      if (verdict.standing === "out_of_range") {
        return {
          severity: item.failureSeverity ?? "failure",
          summary: `${item.prompt}: read ${spoken}, outside ${range}.`,
          observation: { ...base, recorded: `Measured ${spoken}. Specification is ${range}.`, reading: verdict },
        };
      }
      if (verdict.standing === "borderline") {
        return {
          // The only severity that may be defaulted, and it is defaulted to
          // the least alarming one on purpose. See TemplateItem.
          severity: item.borderlineSeverity ?? "recommendation",
          summary: `${item.prompt}: read ${spoken}, inside ${range} and near the edge of it.`,
          observation: { ...base, recorded: `Measured ${spoken}. Specification is ${range}. Inside it.`, reading: verdict },
        };
      }
      return null;
    }
    case "count": {
      const expected = spec.expectedAtLeast;
      if (expected === undefined || answer.value.count >= expected) return null;
      return {
        severity: item.failureSeverity ?? "failure",
        summary: `${item.prompt}: found ${answer.value.count}, expected at least ${expected}.`,
        observation: { ...base, recorded: `Counted ${answer.value.count}. Expected at least ${expected}.` },
      };
    }
    case "photo":
    case "note":
    case "not_applicable":
      return null;
  }
}

function statementFor(
  outcome: InspectionOutcome,
  complete: boolean,
  unansweredCount: number,
  optionalSkippedCount: number,
  counts: Record<Severity, number>,
): string {
  const skipped = complete
    ? ""
    : ` ${plural(unansweredCount, "item was", "items were")} not checked, so this does not say anything about ${unansweredCount === 1 ? "it" : "them"}.`;

  /**
   * The sentence a passing report opens with, and the one place this module
   * was asserting something it had not established. An optional item that was
   * skipped is an item nobody looked at, and "Every item was checked" printed
   * over the top of one is the same false claim as a pass over an unanswered
   * item, made quietly and about a smaller thing.
   */
  const everyItem = optionalSkippedCount === 0
    ? "Every item was checked."
    : `Every required item was checked, and ${plural(optionalSkippedCount, "optional item was", "optional items were")} not.`;

  switch (outcome) {
    case "failed": {
      /**
       * Which findings mean the equipment has to stop is read off the severity
       * scale rather than hardcoded to `safety` here. A second mapping from
       * severity to meaning is a place for the two to disagree, and the field
       * says exactly this: the equipment should not be run until it is fixed.
       */
      const stopCount = SEVERITIES.reduce(
        (total, key) => (SEVERITY[key].takeOutOfService ? total + counts[key] : total),
        0,
      );
      const unsafe = stopCount > 0
        ? ` ${plural(stopCount, "finding is", "findings are")} unsafe and the equipment should not be used until ${stopCount === 1 ? "it is" : "they are"} fixed.`
        : "";
      return `Failed.${unsafe}${skipped}`;
    }
    case "incomplete":
      return `Not complete.${skipped} This inspection does not say the system passed.`;
    case "passed_with_recommendations":
      return `Passed. ${everyItem} ${plural(counts.wear + counts.recommendation, "thing is", "things are")} worth knowing about, and nothing found is unsafe or broken.`;
    case "passed":
      return `Passed. ${everyItem} Nothing was found.`;
  }
}

// ---------------------------------------------------------------------------
// Deficiencies into proposed work
// ---------------------------------------------------------------------------

/**
 * THIS IS WHERE THE PRESSURE TO OVERSELL LIVES.
 *
 * Everything above is a record of what somebody saw. Everything below is a
 * sales document, and every product in this category has the same gravity
 * pulling on it: the proposal converts better when the findings look worse,
 * and nobody reading the proposal can check.
 *
 * Three structural choices push back, and they are structural rather than
 * advisory because a comment asking people to be honest is a comment.
 *
 *   EVERY LINE CARRIES ITS OBSERVATION. Not a reference to one, the object. A
 *   line without evidence cannot be constructed, so a proposal cannot be
 *   printed without the evidence beside it.
 *
 *   GROUPING IS BY SEVERITY AND THE HEADINGS COME FROM THE SEVERITY SCALE. A
 *   renderer cannot merge the safety group into the recommendations group
 *   without deleting a heading somebody wrote on purpose, and the group tells
 *   it whether the contents may be presented as urgent.
 *
 *   A DEFICIENCY WITH NO PRICE BOOK MAPPING COMES BACK AS UNMAPPED, NOT
 *   DROPPED. The failure mode this prevents is quiet and expensive in the
 *   other direction: the findings that convert get proposed, the ones with no
 *   SKU disappear, and the compliance record and the proposal stop agreeing
 *   about what was found.
 */
export interface DeficiencyInput {
  itemKey: string;
  severity: Severity;
  summary: string;
  /**
   * Optional in the type and required in fact. Deficiencies come back out of a
   * database, where a column can be null, and the refusal below is the point
   * of accepting the loose shape.
   */
  observation?: Observation | undefined;
  remedies?: readonly Remedy[] | undefined;
  codeReference?: string | undefined;
}

export interface ProposedLine {
  deficiencyItemKey: string;
  priceBookItemKey: string;
  label: string;
  quantity: number;
  severity: Severity;
  /** Why this work follows from this finding. */
  rationale: string;
  /** What was actually seen. Not optional, by construction. */
  observation: Observation;
  codeReference?: string | undefined;
}

export interface ProposalGroup {
  severity: Severity;
  /** The words the customer reads, straight off the severity scale. */
  heading: string;
  meaning: string;
  mayBePresentedAsUrgent: boolean;
  lines: readonly ProposedLine[];
}

export interface UnmappedDeficiency {
  itemKey: string;
  severity: Severity;
  summary: string;
  /** What the office has to do about it, in words. */
  reason: string;
}

export type ProposalDecision =
  | {
      ok: true;
      groups: readonly ProposalGroup[];
      lineCount: number;
      /** Found, and with no price book item behind it. Shown, never dropped. */
      unmapped: readonly UnmappedDeficiency[];
    }
  | { ok: false; reason: "unobserved_deficiency"; detail: readonly string[] }
  | { ok: false; reason: "unjustified_remedy"; detail: readonly string[] }
  | { ok: false; reason: "nothing_to_propose"; detail: string };

/**
 * Turn a set of deficiencies into the groups an estimate would present.
 *
 * Refuses on a deficiency with no observation attached. That deficiency is a
 * price with a story and no evidence, which is the exact artefact this module
 * exists to make impossible to produce. The refusal names the items so
 * somebody can go and attach the photo or the reading they took.
 *
 * Refuses again on a remedy that does not justify itself, for the same reason
 * and on the same evidence: a line with a blank rationale is a price with no
 * sentence saying why the finding implies the work. Evidence with no argument
 * is the unevidenced proposal arriving by the other door.
 */
export function proposeWork(deficiencies: readonly DeficiencyInput[]): ProposalDecision {
  if (deficiencies.length === 0) {
    return {
      ok: false,
      reason: "nothing_to_propose",
      detail: "Nothing was found, so there is no work to propose. Send the inspection report on its own.",
    };
  }

  const unobserved = deficiencies.filter((d) => !d.observation).map((d) => d.itemKey);
  if (unobserved.length > 0) {
    return { ok: false, reason: "unobserved_deficiency", detail: unobserved };
  }

  /**
   * The same check `validateTemplate` runs, run again here because these
   * deficiencies did not come from a template that was just validated. They
   * come back out of a database, which is the reason this function accepts
   * the loose shape at all: the remedy may be JSON written before the check
   * existed, imported from elsewhere, or read out of a column that allows
   * null. A quantity of zero and a blank rationale both put a line on a
   * proposal that nobody can defend.
   */
  const unjustified: string[] = [];
  for (const deficiency of deficiencies) {
    for (const remedy of deficiency.remedies ?? []) {
      const missing: string[] = [];
      if (remedy.priceBookItemKey.trim() === "") missing.push("a price book item");
      if (!Number.isFinite(remedy.quantity) || remedy.quantity <= 0) missing.push("a quantity above zero");
      if (remedy.rationale.trim() === "") missing.push("the sentence saying why the finding implies the work");
      if (missing.length > 0) {
        const named = remedy.label.trim() === "" ? "a suggested repair" : `"${remedy.label.trim()}"`;
        unjustified.push(`${deficiency.itemKey}: ${named} is missing ${missing.join(", ")}.`);
      }
    }
  }
  if (unjustified.length > 0) {
    return { ok: false, reason: "unjustified_remedy", detail: unjustified };
  }

  const bySeverity = new Map<Severity, ProposedLine[]>();
  const unmapped: UnmappedDeficiency[] = [];
  let lineCount = 0;

  for (const deficiency of deficiencies) {
    const observation = deficiency.observation;
    if (!observation) continue; // Already refused above; this narrows the type.

    const remedies = deficiency.remedies ?? [];
    if (remedies.length === 0) {
      unmapped.push({
        itemKey: deficiency.itemKey,
        severity: deficiency.severity,
        summary: deficiency.summary,
        reason:
          "No price book item is mapped to this finding on the template. It still has to go on the proposal, priced by hand.",
      });
      continue;
    }

    for (const remedy of remedies) {
      const line: ProposedLine = {
        deficiencyItemKey: deficiency.itemKey,
        priceBookItemKey: remedy.priceBookItemKey,
        label: remedy.label,
        quantity: remedy.quantity,
        severity: deficiency.severity,
        rationale: remedy.rationale,
        observation,
        ...(deficiency.codeReference !== undefined ? { codeReference: deficiency.codeReference } : {}),
      };
      bySeverity.set(deficiency.severity, [...(bySeverity.get(deficiency.severity) ?? []), line]);
      lineCount += 1;
    }
  }

  const groups: ProposalGroup[] = [];
  for (const severity of SEVERITY_ORDER) {
    const lines = bySeverity.get(severity);
    if (!lines || lines.length === 0) continue;
    const level = SEVERITY[severity];
    groups.push({
      severity,
      heading: level.heading,
      meaning: level.meaning,
      mayBePresentedAsUrgent: level.mayBePresentedAsUrgent,
      lines,
    });
  }

  return { ok: true, groups, lineCount, unmapped };
}

// ---------------------------------------------------------------------------
// The backlog, over time
// ---------------------------------------------------------------------------

export interface BacklogStanding {
  itemKey: string;
  severity: Severity;
  ageDays: number;
  respondWithinDays: number | null;
  overdue: boolean;
  /** What the age means, given the severity. For the list, not for a chart. */
  statement: string;
}

const DAY_MS = 86_400_000;

/**
 * How long a finding has been sitting there, and whether that is now a problem.
 *
 * `now` is a parameter. A backlog report has to be reproducible: run it twice
 * for the same month end and it must say the same thing, which it cannot if
 * the ageing is measured against whenever the report happened to run.
 *
 * A find date in the future is clamped to zero days rather than going
 * negative. It means a device clock was wrong, which the field module already
 * records; an ageing report is not the place to litigate it, and a negative
 * age would sort to the top of a list of overdue work.
 */
export function backlogStanding(
  deficiency: { itemKey: string; severity: Severity; foundAt: Date },
  now: Date,
): BacklogStanding {
  const elapsed = now.getTime() - deficiency.foundAt.getTime();
  const ageDays = Math.max(0, Math.floor(elapsed / DAY_MS));
  const level = SEVERITY[deficiency.severity];
  const within = level.respondWithinDays;
  const overdue = within !== null && ageDays > within;

  const statement = within === null
    ? `Open ${plural(ageDays, "day", "days")}. There is no deadline on a recommendation.`
    : overdue
      ? `Open ${plural(ageDays, "day", "days")}, past the ${within} day mark for ${level.label.toLowerCase()}.`
      : `Open ${plural(ageDays, "day", "days")}, inside the ${within} day mark for ${level.label.toLowerCase()}.`;

  return { itemKey: deficiency.itemKey, severity: deficiency.severity, ageDays, respondWithinDays: within, overdue, statement };
}
