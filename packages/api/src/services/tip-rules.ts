import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { payExtras as px, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";

/**
 * M17. A TIP RULE FOR ONE JOB, OR FOR ONE PERSON
 *
 * The company's rule for sharing a tip is on Pay rules (`pay-extras.ts`).
 * Some work does not fit it: a two day install whose second crew did the work
 * the customer saw, a job where the lead did the selling, an apprentice who
 * shares by the hours they put in. So a job can have a rule of its own, and so
 * can a person, and the rule a tip is shared by is chosen in core
 * (`payExtras.chooseTipRule`): the job's own first, then the people's own when
 * everybody on the job who has one agrees, then the company's.
 *
 * Read when a tip is shared, in the same transaction that writes the shares,
 * and kept on each share with where it came from. Setting, changing or taking
 * off a rule here never re-splits a tip already shared.
 *
 * `payroll:configure` to set one, because it is a statement about what people
 * are owed, like the company's rule. `timesheet:read` to read them, like the
 * company's rule. Audited.
 */

export interface TipRuleView {
  id: string;
  kind: "job" | "technician";
  jobId: string | null;
  jobNumber: number | null;
  jobSummary: string | null;
  technicianId: string | null;
  technicianName: string | null;
  rule: px.TipSplitRule;
  ruleLabel: string;
  note: string | null;
  setAt: Date;
}

const isRule = (value: string): value is px.TipSplitRule => (px.TIP_SPLIT_RULES as readonly string[]).includes(value);

async function views(tx: Database, organizationId: string, ids?: string[]): Promise<TipRuleView[]> {
  const rows = await tx.select({
    row: schema.tipSplitOverride,
    jobNumber: schema.job.number,
    jobSummary: schema.job.summary,
    technicianName: schema.technician.displayName,
  }).from(schema.tipSplitOverride)
    .leftJoin(schema.job, eq(schema.job.id, schema.tipSplitOverride.jobId))
    .leftJoin(schema.technician, eq(schema.technician.id, schema.tipSplitOverride.technicianId))
    .where(and(
      eq(schema.tipSplitOverride.organizationId, organizationId),
      ...(ids ? [inArray(schema.tipSplitOverride.id, ids)] : []),
    ))
    .orderBy(asc(schema.technician.displayName), asc(schema.job.number));
  return rows.map(({ row, jobNumber, jobSummary, technicianName }) => {
    const rule = isRule(row.rule) ? row.rule : "even";
    return {
      id: row.id,
      kind: row.jobId ? "job" as const : "technician" as const,
      jobId: row.jobId, jobNumber: jobNumber ?? null, jobSummary: jobSummary ?? null,
      technicianId: row.technicianId, technicianName: technicianName ?? null,
      rule, ruleLabel: px.TIP_SPLIT_LABEL[rule],
      note: row.note, setAt: row.updatedAt,
    };
  });
}

/** Every job's and person's own rule, people first by name, then jobs by number. */
export async function list(ctx: ServiceContext): Promise<{ rules: TipRuleView[] }> {
  return guardedRead(ctx, "timesheet:read", async (tx) => ({ rules: await views(tx, ctx.actor.organizationId) }));
}

/**
 * Set a job's or a person's own rule. Exactly one of a job and a person. A
 * job that has one already, or a person, has it changed in place, and the
 * audit row keeps what it was. The same rule sent again changes nothing and
 * returns it; a retry with the same idempotency key returns the first answer.
 */
export async function set(
  ctx: ServiceContext,
  input: {
    jobId?: string | undefined; technicianId?: string | undefined; rule: string; note?: string | undefined;
    /** The job by the number it is printed with, as the office types it on Pay rules. */
    jobNumber?: number | undefined;
  },
): Promise<TipRuleView> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const again = await replayed<TipRuleView>(tx, ctx, "tip_split_override");
    if (again) return { ...again, setAt: new Date(again.setAt) };

    if (input.jobNumber !== undefined && !input.jobId) {
      const [byNumber] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(
          eq(schema.job.organizationId, ctx.actor.organizationId),
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
    if (!!input.jobId === !!input.technicianId) {
      throw new UnprocessableError("Say who the rule is for", [{
        path: input.jobId ? "technicianId" : "jobId",
        message: "A rule of its own is for one job or for one person, not both and not neither.",
      }]);
    }
    const org = ctx.actor.organizationId;
    if (input.jobId) {
      const [found] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(eq(schema.job.id, input.jobId), eq(schema.job.organizationId, org), sql`${schema.job.deletedAt} is null`))
        .limit(1);
      if (!found) throw new NotFoundError("Job");
    } else {
      const [found] = await tx.select({ id: schema.technician.id }).from(schema.technician)
        .where(and(eq(schema.technician.id, input.technicianId!), eq(schema.technician.organizationId, org)))
        .limit(1);
      if (!found) throw new NotFoundError("Technician");
    }

    const [there] = await tx.select().from(schema.tipSplitOverride)
      .where(and(
        eq(schema.tipSplitOverride.organizationId, org),
        input.jobId
          ? eq(schema.tipSplitOverride.jobId, input.jobId)
          : eq(schema.tipSplitOverride.technicianId, input.technicianId!),
      )).limit(1).for("update");
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
        technicianId: input.technicianId ?? null,
        rule: input.rule,
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

/** Take a rule of its own off: the job or the person goes back to the company's rule from the next tip. Audited. */
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
 * The rule a tip on this job, for these people, is shared by: the job's own,
 * then the people's own, then the company's. Inside the transaction that
 * writes the shares.
 */
export async function ruleWithin(
  tx: Database, organizationId: string, company: px.TipSplitRule, jobId: string | null, technicianIds: readonly string[],
): Promise<px.TipRuleChoice> {
  const [own] = jobId === null ? [] : await tx.select({ rule: schema.tipSplitOverride.rule })
    .from(schema.tipSplitOverride)
    .where(and(eq(schema.tipSplitOverride.organizationId, organizationId), eq(schema.tipSplitOverride.jobId, jobId)))
    .limit(1);
  const people = technicianIds.length === 0 ? [] : await tx.select({
    technicianId: schema.tipSplitOverride.technicianId, rule: schema.tipSplitOverride.rule,
  }).from(schema.tipSplitOverride)
    .where(and(
      eq(schema.tipSplitOverride.organizationId, organizationId),
      isNotNull(schema.tipSplitOverride.technicianId),
      inArray(schema.tipSplitOverride.technicianId, [...technicianIds]),
    ));
  return px.chooseTipRule({
    company,
    job: own && isRule(own.rule) ? own.rule : null,
    people: people.flatMap((p) => (p.technicianId && isRule(p.rule) ? [{ technicianId: p.technicianId, rule: p.rule }] : [])),
  });
}

export const handlers = {
  listTipRules: (ctx: ServiceContext) => list(ctx),
  setTipRule: (ctx: ServiceContext, input: {
    jobId?: string | undefined; technicianId?: string | undefined; rule: string; note?: string | undefined;
  }) => set(ctx, input),
  removeTipRule: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
