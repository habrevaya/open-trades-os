import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { payExtras as px, time, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, NotFoundError, scopeOf, timezoneOf, UnprocessableError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";
import { jobScopeFilter } from "./scope";
import { settingsWithin as payExtrasWithin } from "./pay-extras";

/**
 * M17. A TIP RULE FOR ONE JOB, ONE KIND OF WORK, ONE CREW OR ONE PERSON
 *
 * The company's rule for sharing a tip is on Pay rules (`pay-extras.ts`).
 * Some work does not fit it: a two day install whose second crew did the work
 * the customer saw, installs where the lead did the selling, a crew that
 * shares by hours, an apprentice who shares by the hours they put in until
 * they finish. So a job can have a rule of its own, and so can a kind of work
 * (a job type), a crew and a person, and the rule a tip is shared by is
 * chosen in core (`payExtras.chooseTipRule`), in this order:
 *
 *   1. the job's own;
 *   2. the job's kind of work's;
 *   3. a crew's, when everybody the tip is shared between is on that crew
 *      (an active crew) and every such crew with a rule agrees;
 *   4. the people's own that cover the day the money arrived, when everybody
 *      on the job who has one agrees;
 *   5. the company's.
 *
 * A person's own rule can have a first and a last day. A person can have
 * several, whose days never overlap, so on any day at most one is theirs.
 *
 * Read when a tip is shared, in the same transaction that writes the shares,
 * and kept on each share with where it came from. Setting, changing or taking
 * off a rule here never re-splits a tip already shared.
 *
 * `payroll:configure` to set one, because it is a statement about what people
 * are owed, like the company's rule. `timesheet:read` to read them, like the
 * company's rule. Audited.
 */

export type TipRuleKind = "job" | "job_type" | "crew" | "technician";

export interface TipRuleView {
  id: string;
  kind: TipRuleKind;
  jobId: string | null;
  jobNumber: number | null;
  jobSummary: string | null;
  jobTypeId: string | null;
  jobTypeName: string | null;
  crewId: string | null;
  crewName: string | null;
  technicianId: string | null;
  technicianName: string | null;
  rule: px.TipSplitRule;
  ruleLabel: string;
  /** The first and last day a person's own rule covers, both kept. Null is open at that end, and always null for the others. */
  startsOn: string | null;
  endsOn: string | null;
  note: string | null;
  setAt: Date;
}

const isRule = (value: string): value is px.TipSplitRule => (px.TIP_SPLIT_RULES as readonly string[]).includes(value);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const kindOf = (row: typeof schema.tipSplitOverride.$inferSelect): TipRuleKind =>
  row.jobId ? "job" : row.jobTypeId ? "job_type" : row.crewId ? "crew" : "technician";

const KIND_ORDER: Record<TipRuleKind, number> = { technician: 0, crew: 1, job_type: 2, job: 3 };

async function views(tx: Database, organizationId: string, ids?: string[]): Promise<TipRuleView[]> {
  const rows = await tx.select({
    row: schema.tipSplitOverride,
    jobNumber: schema.job.number,
    jobSummary: schema.job.summary,
    jobTypeName: schema.jobType.name,
    crewName: schema.crew.name,
    technicianName: schema.technician.displayName,
  }).from(schema.tipSplitOverride)
    .leftJoin(schema.job, eq(schema.job.id, schema.tipSplitOverride.jobId))
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.tipSplitOverride.jobTypeId))
    .leftJoin(schema.crew, eq(schema.crew.id, schema.tipSplitOverride.crewId))
    .leftJoin(schema.technician, eq(schema.technician.id, schema.tipSplitOverride.technicianId))
    .where(and(
      eq(schema.tipSplitOverride.organizationId, organizationId),
      ...(ids ? [inArray(schema.tipSplitOverride.id, ids)] : []),
    ))
    .orderBy(
      asc(schema.technician.displayName), sql`${schema.tipSplitOverride.startsOn} asc nulls first`,
      asc(schema.crew.name), asc(schema.jobType.name), asc(schema.job.number),
    );
  return rows.map(({ row, jobNumber, jobSummary, jobTypeName, crewName, technicianName }) => {
    const rule = isRule(row.rule) ? row.rule : "even";
    return {
      id: row.id,
      kind: kindOf(row),
      jobId: row.jobId, jobNumber: jobNumber ?? null, jobSummary: jobSummary ?? null,
      jobTypeId: row.jobTypeId, jobTypeName: jobTypeName ?? null,
      crewId: row.crewId, crewName: crewName ?? null,
      technicianId: row.technicianId, technicianName: technicianName ?? null,
      rule, ruleLabel: px.TIP_SPLIT_LABEL[rule],
      startsOn: row.startsOn, endsOn: row.endsOn,
      note: row.note, setAt: row.updatedAt,
    };
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** Every rule of its own: people first by name and first day, then crews, kinds of work and jobs. */
export async function list(ctx: ServiceContext): Promise<{ rules: TipRuleView[] }> {
  return guardedRead(ctx, "timesheet:read", async (tx) => ({ rules: await views(tx, ctx.actor.organizationId) }));
}

export interface SetTipRuleInput {
  jobId?: string | undefined;
  jobTypeId?: string | undefined;
  crewId?: string | undefined;
  technicianId?: string | undefined;
  rule: string;
  note?: string | undefined;
  /** For a person's own rule only: the first and last day it covers, both kept. Left out is open at that end. */
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  /** The job by the number it is printed with, as the office types it on Pay rules. */
  jobNumber?: number | undefined;
}

/**
 * Set a job's, a kind of work's, a crew's or a person's own rule. Exactly one
 * of them.
 *
 * A job, a kind of work or a crew that has one already has it changed in
 * place, and the audit row keeps what it was. A person's own rule with the
 * same first and last day as one they have is changed in place too; one
 * with other days is a second rule, refused when its days overlap one they
 * have, because on any day a person has at most one rule of their own. The
 * same rule sent again changes nothing and returns it; a retry with the same
 * idempotency key returns the first answer.
 */
export async function set(ctx: ServiceContext, input: SetTipRuleInput): Promise<TipRuleView> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const again = await replayed<TipRuleView>(tx, ctx, "tip_split_override");
    if (again) return { ...again, setAt: new Date(again.setAt) };
    const org = ctx.actor.organizationId;

    if (input.jobNumber !== undefined && !input.jobId) {
      const [byNumber] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(
          eq(schema.job.organizationId, org),
          eq(schema.job.number, input.jobNumber),
          sql`${schema.job.deletedAt} is null`,
        )).limit(1);
      if (!byNumber) {
        throw new UnprocessableError("No such job", [{ path: "jobNumber", message: `There is no job ${input.jobNumber}.` }]);
      }
      input = { ...input, jobId: byNumber.id };
    }

    if (!isRule(input.rule)) {
      throw new UnprocessableError("That rule cannot be used", [{ path: "rule", message: "Choose one of the ways a tip can be shared." }]);
    }
    const subjects = [input.jobId, input.jobTypeId, input.crewId, input.technicianId].filter((v) => !!v).length;
    if (subjects !== 1) {
      throw new UnprocessableError("Say who the rule is for", [{
        path: input.jobId ? "technicianId" : "jobId",
        message: "A rule of its own is for one job, one kind of work, one crew or one person: exactly one of them.",
      }]);
    }
    const startsOn = input.startsOn || null;
    const endsOn = input.endsOn || null;
    if ((startsOn || endsOn) && !input.technicianId) {
      throw new UnprocessableError("Only a person's rule has dates", [{
        path: "startsOn",
        message: "A first and last day is for a person's own rule. A job, a kind of work or a crew keeps its rule until it is taken off.",
      }]);
    }
    for (const [path, day] of [["startsOn", startsOn], ["endsOn", endsOn]] as const) {
      if (day !== null && !ISO_DAY.test(day)) {
        throw new UnprocessableError("That is not a day", [{ path, message: "A day is written like 2026-03-01." }]);
      }
    }
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new UnprocessableError("The last day is before the first", [{ path: "endsOn", message: "The last day has to be on or after the first." }]);
    }

    if (input.jobId) {
      const [found] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(
          eq(schema.job.id, input.jobId), eq(schema.job.organizationId, org), sql`${schema.job.deletedAt} is null`,
          jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
        ))
        .limit(1);
      if (!found) throw new NotFoundError("Job");
    } else if (input.jobTypeId) {
      const [found] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
        .where(and(eq(schema.jobType.id, input.jobTypeId), eq(schema.jobType.organizationId, org))).limit(1);
      if (!found) throw new NotFoundError("Kind of work");
    } else if (input.crewId) {
      const [found] = await tx.select({ id: schema.crew.id }).from(schema.crew)
        .where(and(eq(schema.crew.id, input.crewId), eq(schema.crew.organizationId, org))).limit(1);
      if (!found) throw new NotFoundError("Crew");
    } else {
      /** Locked, so two offices setting a person's rules at once take turns and the overlap check holds. */
      const [found] = await tx.select({ id: schema.technician.id }).from(schema.technician)
        .where(and(eq(schema.technician.id, input.technicianId!), eq(schema.technician.organizationId, org)))
        .limit(1).for("update");
      if (!found) throw new NotFoundError("Technician");
    }

    const subject = input.jobId
      ? eq(schema.tipSplitOverride.jobId, input.jobId)
      : input.jobTypeId
        ? eq(schema.tipSplitOverride.jobTypeId, input.jobTypeId)
        : input.crewId
          ? eq(schema.tipSplitOverride.crewId, input.crewId)
          : eq(schema.tipSplitOverride.technicianId, input.technicianId!);
    const theirs = await tx.select().from(schema.tipSplitOverride)
      .where(and(eq(schema.tipSplitOverride.organizationId, org), subject))
      .for("update");
    const there = input.technicianId
      ? theirs.find((r) => r.startsOn === startsOn && r.endsOn === endsOn)
      : theirs[0];
    if (input.technicianId && !there) {
      const clash = theirs.find((r) => px.tipRuleSpansOverlap(r, { startsOn, endsOn }));
      if (clash) {
        const span = clash.startsOn && clash.endsOn ? `from ${clash.startsOn} until ${clash.endsOn}`
          : clash.startsOn ? `from ${clash.startsOn} on`
            : clash.endsOn ? `until ${clash.endsOn}` : "with no dates";
        throw new UnprocessableError("Those days overlap a rule they have", [{
          path: "startsOn",
          message: `They already have a rule of their own ${span}. Take it off first, or choose days that do not overlap it.`,
        }]);
      }
    }
    const note = input.note?.trim() || null;
    const by = ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId;

    let id: string;
    if (there && there.rule === input.rule && there.note === note) {
      id = there.id;
    } else if (there) {
      const [row] = await tx.update(schema.tipSplitOverride)
        .set({ rule: input.rule, note, setByUserId: by, updatedAt: new Date() })
        .where(eq(schema.tipSplitOverride.id, there.id)).returning();
      await audit(tx, ctx, "tip_rule.changed", "tip_split_override", there.id, there, row);
      id = there.id;
    } else {
      const [row] = await tx.insert(schema.tipSplitOverride).values({
        organizationId: org,
        jobId: input.jobId ?? null,
        jobTypeId: input.jobTypeId ?? null,
        crewId: input.crewId ?? null,
        technicianId: input.technicianId ?? null,
        rule: input.rule,
        startsOn,
        endsOn,
        note,
        setByUserId: by,
      }).returning();
      await audit(tx, ctx, "tip_rule.set", "tip_split_override", row!.id, null, row);
      id = row!.id;
    }
    const [answer] = await views(tx, org, [id]);
    await remember(tx, ctx, "tip_split_override", id, answer!);
    return answer!;
  });
}

/** Take a rule of its own off: whoever it was for goes back to the next rule in the order from the next tip. Audited. */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const [row] = await tx.delete(schema.tipSplitOverride)
      .where(and(eq(schema.tipSplitOverride.id, input.id), eq(schema.tipSplitOverride.organizationId, ctx.actor.organizationId)))
      .returning();
    if (row) await audit(tx, ctx, "tip_rule.removed", "tip_split_override", row.id, row, null);
    return { id: input.id, removed: true };
  });
}

/**
 * The rule a tip on this job, shared between these people, on this company
 * day, is shared by: the job's own, its kind of work's, a crew's everybody is
 * on, the people's own covering the day, then the company's. Inside the
 * transaction that writes the shares.
 */
export async function ruleWithin(
  tx: Database, organizationId: string, company: px.TipSplitRule, jobId: string | null,
  technicianIds: readonly string[], day: string,
): Promise<px.TipRuleChoice> {
  const rules = schema.tipSplitOverride;
  const [own] = jobId === null ? [] : await tx.select({ rule: rules.rule }).from(rules)
    .where(and(eq(rules.organizationId, organizationId), eq(rules.jobId, jobId)))
    .limit(1);
  const [ofKind] = jobId === null ? [] : await tx.select({ rule: rules.rule }).from(rules)
    .innerJoin(schema.job, eq(schema.job.jobTypeId, rules.jobTypeId))
    .where(and(eq(rules.organizationId, organizationId), eq(schema.job.id, jobId)))
    .limit(1);

  const people = [...new Set(technicianIds)];
  const crewRules = people.length === 0 ? [] : await tx.select({ crewId: rules.crewId, rule: rules.rule }).from(rules)
    .innerJoin(schema.crew, eq(schema.crew.id, rules.crewId))
    .where(and(eq(rules.organizationId, organizationId), eq(schema.crew.active, true)));
  const members = crewRules.length === 0 ? [] : await tx.select({
    crewId: schema.crewMember.crewId, technicianId: schema.crewMember.technicianId,
  }).from(schema.crewMember)
    .where(and(
      inArray(schema.crewMember.crewId, crewRules.flatMap((c) => (c.crewId ? [c.crewId] : []))),
      inArray(schema.crewMember.technicianId, people),
    ));
  const crews = crewRules.flatMap((c) => {
    if (!c.crewId || !isRule(c.rule)) return [];
    const on = new Set(members.filter((m) => m.crewId === c.crewId).map((m) => m.technicianId));
    return people.every((p) => on.has(p)) ? [{ crewId: c.crewId, rule: c.rule }] : [];
  });

  const theirs = people.length === 0 ? [] : await tx.select({
    technicianId: rules.technicianId, rule: rules.rule, startsOn: rules.startsOn, endsOn: rules.endsOn,
  }).from(rules)
    .where(and(
      eq(rules.organizationId, organizationId),
      isNotNull(rules.technicianId),
      inArray(rules.technicianId, people),
    ));
  return px.chooseTipRule({
    company,
    job: own && isRule(own.rule) ? own.rule : null,
    jobType: ofKind && isRule(ofKind.rule) ? ofKind.rule : null,
    crews,
    people: theirs.flatMap((p) => (p.technicianId && isRule(p.rule) && px.tipRuleCovers(day, p.startsOn, p.endsOn)
      ? [{ technicianId: p.technicianId, rule: p.rule }] : [])),
  });
}

/**
 * Everybody who came out for a job: assigned to one of its visits that was
 * not cancelled and not recorded from history. Who a tip on the job is
 * shared between.
 */
export async function techniciansOnJob(tx: Database, jobId: string): Promise<{ id: string; displayName: string }[]> {
  return tx.selectDistinct({
    id: schema.technician.id,
    displayName: schema.technician.displayName,
  })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(and(
      eq(schema.visit.jobId, jobId),
      ne(schema.visit.status, "cancelled"),
      /** A visit recorded from history earns no share of a tip given here. */
      eq(schema.visit.fromHistory, false),
    ))
    .orderBy(asc(schema.technician.id));
}

export interface JobTipRule {
  /** The job's own rule, or null when it has none. */
  own: TipRuleView | null;
  /** What a tip on this job arriving today would be shared by, with the people on it now. */
  today: {
    rule: px.TipSplitRule;
    ruleLabel: string;
    source: px.TipRuleSource;
    sourceLabel: string;
    note: string;
    people: string[];
  };
}

/**
 * THE TIP RULE ON A JOB'S OWN PAGE: the job's own rule, and the rule a tip
 * arriving today would be shared by, worked out exactly as a tip is shared,
 * so the office can see which rule wins before the customer pays. Out of the
 * reader's branch reads as missing, as the job does.
 */
export async function forJob(ctx: ServiceContext, input: { jobId: string }): Promise<JobTipRule> {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(
        eq(schema.job.id, input.jobId), eq(schema.job.organizationId, org), sql`${schema.job.deletedAt} is null`,
        jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
      )).limit(1);
    if (!job) throw new NotFoundError("Job");
    const [ownRow] = await tx.select({ id: schema.tipSplitOverride.id }).from(schema.tipSplitOverride)
      .where(and(eq(schema.tipSplitOverride.organizationId, org), eq(schema.tipSplitOverride.jobId, job.id))).limit(1);
    const own = ownRow ? (await views(tx, org, [ownRow.id]))[0] ?? null : null;
    const people = await techniciansOnJob(tx, job.id);
    const company = (await payExtrasWithin(tx, org)).tipSplit;
    const day = time.dateIn(new Date(), await timezoneOf(tx, org));
    const chosen = await ruleWithin(tx, org, company, job.id, people.map((p) => p.id), day);
    return {
      own,
      today: {
        rule: chosen.rule, ruleLabel: px.TIP_SPLIT_LABEL[chosen.rule],
        source: chosen.source, sourceLabel: px.TIP_RULE_SOURCE_LABEL[chosen.source],
        note: chosen.note,
        people: people.map((p) => p.displayName).sort((a, b) => a.localeCompare(b)),
      },
    };
  });
}

export const handlers = {
  listTipRules: (ctx: ServiceContext) => list(ctx),
  setTipRule: (ctx: ServiceContext, input: SetTipRuleInput) => set(ctx, input),
  removeTipRule: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
  getJobTipRule: (ctx: ServiceContext, input: { jobId: string }) => forJob(ctx, input),
} as const;
