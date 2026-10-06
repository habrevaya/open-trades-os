import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, qualification as q, time } from "@opentradesos/core";
import { ConflictError, timezoneOf, type ServiceContext } from "./context";
import { skillStanding } from "./people";

/**
 * IS THIS PERSON QUALIFIED FOR THIS WORK, ASKED IN ONE PLACE
 *
 * A crew has been checked against a job type's required skills since crews
 * existed. A technician sent on their own never was, which is how most work
 * goes out. This file is that check, and it is asked by every path that puts
 * one person on a visit: a drag on the board and the assignment API through
 * `dispatch.assign`, booking with a technician through `jobs`, and the
 * optimiser's suggestions through `dispatch-map`. One function, so a
 * suggestion can never propose somebody the assignment would then refuse.
 *
 * The rules are `qualification.judge` in core. This file gathers the evidence:
 * M24's certification standing for each person on the day of the work, the
 * person's own recorded skills, and whether anybody in the company is
 * recorded with each skill at all.
 *
 * A TRANSACTION RATHER THAN A CONTEXT, for the reason `people.skillStanding`
 * gives: callers are already inside one, and their own guard is what
 * authorizes the read.
 */

export async function qualify(
  tx: Database,
  organizationId: string,
  input: { technicianIds: readonly string[]; skills: readonly string[]; on: string },
): Promise<Map<string, q.QualificationVerdict>> {
  const skills = q.normaliseSkills(input.skills);
  const out = new Map<string, q.QualificationVerdict>();
  if (input.technicianIds.length === 0) return out;

  const people = await tx.select({
    id: schema.technician.id,
    displayName: schema.technician.displayName,
    skills: schema.technician.skills,
  }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, organizationId),
      inArray(schema.technician.id, [...input.technicianIds]),
    ));

  if (skills.length === 0) {
    for (const person of people) out.set(person.id, q.judge(person.displayName, []));
    return out;
  }

  /**
   * Who in the company is recorded with each skill at all. Active people
   * only: a skill held by somebody who left in March is not one the company
   * still tracks, and should not start refusing everybody else.
   */
  const everyone = await tx.select({ skills: schema.technician.skills })
    .from(schema.technician)
    .where(and(eq(schema.technician.organizationId, organizationId), eq(schema.technician.active, true)));
  const typedAnywhere = new Set(everyone.flatMap((t) => q.normaliseSkills(t.skills ?? [])));

  for (const person of people) {
    /**
     * Asked one person at a time. M24's standing is a question about a
     * GROUP (does anybody here hold it), which is the right question for a
     * crew and the wrong one for a person: Dana's licence does not qualify
     * Sam to go on his own.
     */
    const standing = await skillStanding(tx, organizationId, {
      technicianIds: [person.id], skills, on: input.on,
    });
    const bySkill = new Map(standing.map((s) => [s.skill, s]));
    const typed = new Set(q.normaliseSkills(person.skills ?? []));
    out.set(person.id, q.judge(person.displayName, skills.map((skill) => ({
      skill,
      certified: bySkill.get(skill)?.state ?? "uncertified",
      certifiedExplanation: bySkill.get(skill)?.explanation ?? "",
      typed: typed.has(skill),
      typedAnywhere: typedAnywhere.has(skill),
    }))));
  }
  return out;
}

/**
 * QUALIFIED ON EACH DAY OF A RANGE, NOT ONLY THE FIRST.
 *
 * A calendar of three weeks asked once, for its first day, offered the
 * Thursday after somebody's licence expired as if it had not. Asking
 * `qualify` for every day is twenty one questions per person when the
 * answer can only change on the day after a certification expires (the
 * day it expires is still a good day, `people.lapse`). So it is asked on
 * the first day and again on the day after each expiry inside the range,
 * and each day reads the answer from the latest of those on or before it.
 */
export async function qualifyDays(
  tx: Database,
  organizationId: string,
  input: { technicianIds: readonly string[]; skills: readonly string[]; from: string; until: string },
): Promise<(date: string) => Map<string, q.QualificationVerdict>> {
  const first = await qualify(tx, organizationId, { ...input, on: input.from });
  const skills = q.normaliseSkills(input.skills);
  if (skills.length === 0 || input.technicianIds.length === 0 || input.until <= input.from) return () => first;

  const expiring = await tx.select({ expiresOn: schema.personCertification.expiresOn })
    .from(schema.personCertification)
    .where(and(
      eq(schema.personCertification.organizationId, organizationId),
      inArray(schema.personCertification.technicianId, [...input.technicianIds]),
      gte(schema.personCertification.expiresOn, input.from),
      lt(schema.personCertification.expiresOn, input.until),
    ));
  const changes = [...new Set(expiring.map((e) => time.addDays(e.expiresOn!, 1)))].sort();
  const answers: { from: string; verdicts: Map<string, q.QualificationVerdict> }[] = [{ from: input.from, verdicts: first }];
  for (const on of changes) {
    answers.push({ from: on, verdicts: await qualify(tx, organizationId, { ...input, on }) });
  }
  return (date) => {
    let chosen = first;
    for (const answer of answers) if (answer.from <= date) chosen = answer.verdicts;
    return chosen;
  };
}

/**
 * The skills a visit's work needs: its job type's less any this one job
 * dropped (`job.dropped_skills`), and whatever it asks for beyond them
 * (`job.required_skills`). Empty when neither says anything.
 */
export async function requiredSkillsOf(tx: Database, visitId: string): Promise<{
  skills: string[]; windowStart: Date | null; windowEnd: Date | null;
  /** What the job dropped from its type's skills, with why, so the answer can say it was not checked. */
  dropped: { skill: string; reason: string }[];
}> {
  const [row] = await tx.select({
    skills: schema.jobType.requiredSkills,
    jobSkills: schema.job.requiredSkills,
    droppedSkills: schema.job.droppedSkills,
    windowStart: schema.visit.windowStart,
    windowEnd: schema.visit.windowEnd,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.job.jobTypeId))
    .where(eq(schema.visit.id, visitId)).limit(1);
  return {
    skills: workSkills(row?.skills, row?.jobSkills, row?.droppedSkills),
    windowStart: row?.windowStart ?? null,
    windowEnd: row?.windowEnd ?? null,
    dropped: liveDrops(row?.skills, row?.droppedSkills).map((d) => ({ skill: d.skill, reason: d.reason })),
  };
}

/**
 * WHAT THE WORK NEEDS: the job type's skills and the job's own, together.
 *
 * One function, called by every path that checks a person or a crew for a
 * job, so a skill asked for by one unusual job is checked exactly where the
 * type's are and cannot be checked on the board and forgotten at booking.
 */
export function workSkills(
  typeSkills: readonly string[] | null | undefined, jobSkills: readonly string[] | null | undefined,
  /**
   * What this job dropped from its type's skills. Required, so a caller that
   * reads a job's skills cannot forget the drops and check a skill the office
   * said this job does not need.
   */
  dropped: readonly { skill: string }[] | null | undefined,
): string[] {
  const gone = new Set(q.normaliseSkills((dropped ?? []).map((d) => d.skill)));
  return q.normaliseSkills([
    ...q.normaliseSkills(typeSkills ?? []).filter((s) => !gone.has(s)),
    ...(jobSkills ?? []),
  ]);
}

/** The drops that still apply: only for a skill the job's type still asks for. */
export function liveDrops<T extends { skill: string }>(
  typeSkills: readonly string[] | null | undefined, dropped: readonly T[] | null | undefined,
): T[] {
  const type = new Set(q.normaliseSkills(typeSkills ?? []));
  return (dropped ?? []).filter((d) => type.has(d.skill.trim()));
}

/**
 * A refusal the caller may be allowed to override. A `ConflictError`, so
 * every caller that already turns one into a sentence on the screen keeps
 * doing so, with the refusals attached for a screen that offers the override.
 */
export class QualificationRefusedError extends ConflictError {
  /**
   * The name stays `ConflictError` on purpose. Screens match refusals by
   * name, because the error classes can be duplicated by a bundler and
   * `instanceof` then quietly fails, and a refusal renamed to something they
   * do not know would be thrown at the person as a bug instead of shown to
   * them as a sentence. This marker is how a screen tells it apart.
   */
  readonly qualificationRefused = true as const;
  constructor(message: string, readonly refusals: { technicianId: string; refusal: string }[]) {
    super(message);
  }
}

export interface QualificationOutcome {
  /** A refusal was overridden to let this through. */
  overridden: boolean;
  /** The refusals, overridden or not, for the audit log. */
  refusals: { technicianId: string; refusal: string }[];
  /** Skills nothing could check for these people. */
  unknown: string[];
}

/**
 * The gate itself, for a write that is about to put these people on a job
 * needing these skills on this day.
 *
 * Throws `QualificationRefusedError` naming each person and skill. With an
 * override reason it asks for `visit:assign_unqualified` instead of
 * refusing, and hands the refusals back so the caller's audit entry records
 * exactly what was overridden: "sent anyway" without what was wrong is not a
 * record anybody can audit.
 *
 * NOT ASKED OF WORK WHOSE WINDOW HAS ENDED, the same rule as time off in
 * `jobs.assertAvailable`: a visit that already happened is a record, and
 * loading last year's history is not refused because a licence has since
 * lapsed.
 */
export async function gate(
  ctx: ServiceContext,
  tx: Database,
  input: {
    technicianIds: readonly string[];
    skills: readonly string[];
    windowStart: Date | null;
    windowEnd: Date | null;
    override?: { reason: string } | undefined;
  },
): Promise<QualificationOutcome> {
  const none = { overridden: false, refusals: [], unknown: [] };
  if (input.technicianIds.length === 0 || q.normaliseSkills(input.skills).length === 0) return none;
  if (input.windowEnd && input.windowEnd.getTime() < Date.now()) return none;

  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const on = time.dateIn(input.windowStart ?? new Date(), zone);
  const verdicts = await qualify(tx, ctx.actor.organizationId, {
    technicianIds: input.technicianIds, skills: input.skills, on,
  });
  const refusals = [...verdicts.entries()]
    .filter(([, v]) => !v.qualified)
    .map(([technicianId, v]) => ({ technicianId, refusal: v.refusal! }));
  const unknown = [...new Set([...verdicts.values()].flatMap((v) => v.unknown))];

  if (refusals.length === 0) return { overridden: false, refusals, unknown };
  if (!input.override) {
    throw new QualificationRefusedError(
      refusals.map((r) => r.refusal).join(" ")
      + " Choose somebody who is, or have somebody allowed to send unqualified people do it with a reason.",
      refusals,
    );
  }
  assertCan(ctx.actor, "visit:assign_unqualified");
  return { overridden: true, refusals, unknown };
}

