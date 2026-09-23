import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { coverage, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * WHO IS PAYING FOR THIS, AND WHY
 *
 * Separate from the party model, which answers who. This answers why it is
 * free, or cheaper, or billed to somebody else, and the research this project
 * started from called it the single most load-bearing missing concept in the
 * products contractors already use.
 *
 * RESOLVED, NOT DERIVED. The row records what was decided at the time, and
 * nothing recomputes it on read. A warranty that expires next month did not
 * expire on the visit it covered, and a plan cancelled in June did not
 * uncover a visit delivered in March.
 *
 * The distinction that pays for the whole module: a zero dollar visit under
 * an agreement and a zero dollar visit that is our own rework look identical
 * on a revenue report and mean opposite things about the business. One is why
 * the company is worth what it is; the other is work being done twice.
 */

const usd = (value: string) => m.money(value, "USD");

export interface ResolveInput {
  jobId: string;
  visitId?: string;
  equipmentId?: string;
  source: coverage.CoverageSource;
  /** What granted it: the agreement, the contract, the warranty record. */
  grantingEntityType?: string;
  grantingEntityId?: string;
  /** Their claim or authorisation number. */
  externalReference?: string;
  coversLabour?: boolean;
  coversParts?: boolean;
  coversTrip?: boolean;
  coveragePercent?: string;
  coverageLimit?: string;
  customerResponsibility?: string;
  notes?: string;
}

/**
 * Record who is covering this job, filling in the source's defaults.
 *
 * The defaults matter because they are the pair people get backwards: a parts
 * warranty covers the part and not the labour, and a labour warranty is the
 * other way round. Getting them backwards bills a customer for something a
 * manufacturer owed.
 *
 * One per job, replaced rather than added to. Two resolutions on one job is
 * two answers to "who is paying", and every reader would have to pick.
 */
export async function resolve(ctx: ServiceContext, input: ResolveInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    const terms = coverage.withDefaults(input.source, {
      ...(input.coversLabour !== undefined ? { coversLabour: input.coversLabour } : {}),
      ...(input.coversParts !== undefined ? { coversParts: input.coversParts } : {}),
      ...(input.coversTrip !== undefined ? { coversTrip: input.coversTrip } : {}),
    });

    const [before] = await tx.select().from(schema.entitlement)
      .where(eq(schema.entitlement.jobId, input.jobId)).limit(1);
    if (before) {
      await tx.delete(schema.entitlement).where(eq(schema.entitlement.id, before.id));
    }

    const [row] = await tx.insert(schema.entitlement).values({
      organizationId: ctx.actor.organizationId,
      source: input.source,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      equipmentId: input.equipmentId ?? null,
      grantingEntityType: input.grantingEntityType ?? null,
      grantingEntityId: input.grantingEntityId ?? null,
      externalReference: input.externalReference ?? null,
      coversLabour: terms.coversLabour,
      coversParts: terms.coversParts,
      coversTrip: terms.coversTrip,
      coveragePercent: input.coveragePercent ?? null,
      coverageLimit: input.coverageLimit ?? null,
      customerResponsibility: input.customerResponsibility ?? null,
      resolvedByUserId: ctx.actor.userId,
      notes: input.notes ?? null,
    }).returning();

    await audit(tx, ctx, "entitlement.resolved", "job", input.jobId, before ?? null, row);
    return row!;
  });
}

/** Resolve inside a caller's transaction, for a service that already has one. */
export async function resolveIn(
  tx: Database,
  organizationId: string,
  input: ResolveInput & { resolvedByUserId?: string },
) {
  const terms = coverage.withDefaults(input.source);
  const [existing] = await tx.select({ id: schema.entitlement.id }).from(schema.entitlement)
    .where(eq(schema.entitlement.jobId, input.jobId)).limit(1);
  /**
   * Somebody already said who is paying. An automatic resolution must not
   * overrule a person: the office knowing this is a warranty callback beats
   * the system knowing the customer has a plan.
   */
  if (existing) return existing.id;

  const [row] = await tx.insert(schema.entitlement).values({
    organizationId,
    source: input.source,
    jobId: input.jobId,
    ...(input.grantingEntityType ? { grantingEntityType: input.grantingEntityType } : {}),
    ...(input.grantingEntityId ? { grantingEntityId: input.grantingEntityId } : {}),
    coversLabour: terms.coversLabour,
    coversParts: terms.coversParts,
    coversTrip: terms.coversTrip,
    ...(input.resolvedByUserId ? { resolvedByUserId: input.resolvedByUserId } : {}),
  }).returning({ id: schema.entitlement.id });
  return row!.id;
}

export async function forJob(ctx: ServiceContext, input: { jobId: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [row] = await tx.select().from(schema.entitlement)
      .where(eq(schema.entitlement.jobId, input.jobId)).limit(1);
    if (!row) return null;
    return { ...row, profile: coverage.COVERAGE[row.source] };
  });
}

export async function clear(ctx: ServiceContext, input: { jobId: string }) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [before] = await tx.select().from(schema.entitlement)
      .where(eq(schema.entitlement.jobId, input.jobId)).limit(1);
    if (!before) throw new NotFoundError("Entitlement");
    await tx.delete(schema.entitlement).where(eq(schema.entitlement.id, before.id));
    await audit(tx, ctx, "entitlement.cleared", "job", input.jobId, before, null);
  });
}

/** Load inside a caller's transaction, as the shape core's split expects. */
export async function termsFor(
  tx: Database, jobId: string,
): Promise<coverage.Entitlement | null> {
  const [row] = await tx.select().from(schema.entitlement)
    .where(eq(schema.entitlement.jobId, jobId)).limit(1);
  if (!row) return null;
  return {
    source: row.source,
    coversLabour: row.coversLabour,
    coversParts: row.coversParts,
    coversTrip: row.coversTrip,
    ...(row.coveragePercent ? { coveragePercent: row.coveragePercent } : {}),
    ...(row.coverageLimit ? { coverageLimit: usd(row.coverageLimit) } : {}),
    ...(row.customerResponsibility
      ? { customerResponsibility: usd(row.customerResponsibility) } : {}),
  };
}

/**
 * What the customer actually owes on this job, and what the coverage source
 * owes.
 *
 * The question somebody asks before they invoice, and the reason a deductible
 * is worked out across the whole visit rather than per line: adding it to
 * every line is how a customer gets charged their excess four times.
 */
export async function quote(
  ctx: ServiceContext,
  input: { jobId: string; charges: { kind: coverage.ChargeKind; amount: string }[] },
) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const terms = await termsFor(tx, input.jobId)
      ?? coverage.withDefaults("customer");
    const result = coverage.split(
      terms,
      input.charges.map((c) => ({ kind: c.kind, amount: usd(c.amount) })),
    );
    return {
      source: terms.source,
      profile: coverage.COVERAGE[terms.source],
      customer: m.toString(result.customer),
      covered: m.toString(result.covered),
    };
  });
}

/**
 * WHAT WE DID FOR NOTHING, AND WHY.
 *
 * The number nobody has and everybody needs. An agreement visit and a
 * callback both bill the customer zero; separating them is the only way "we
 * did too much free work last quarter" becomes a sentence with a cause
 * attached to it.
 */
export async function bySource(ctx: ServiceContext, input: { from?: string; to?: string } = {}) {
  return guardedRead(ctx, "report.financial:read", async (tx) => {
    const rows = await tx.execute<{ source: coverage.CoverageSource; jobs: number; value: string }>(sql`
      select e.source,
             count(distinct e.job_id)::int as jobs,
             coalesce(sum(j.total), 0)::text as value
      from public.entitlement e
      join public.job j on j.id = e.job_id and j.deleted_at is null
      where true
        ${input.from ? sql`and e.resolved_at >= ${input.from}::date` : sql``}
        ${input.to ? sql`and e.resolved_at < ${input.to}::date` : sql``}
      group by e.source
      order by count(distinct e.job_id) desc
    `);

    return rows.map((row) => ({
      source: row.source,
      jobs: Number(row.jobs),
      value: row.value,
      profile: coverage.COVERAGE[row.source],
      /**
       * Work we absorbed, as opposed to work somebody else is paying for.
       * Both read as zero revenue on every other report in the product.
       */
      ourCost: coverage.isOurCost(row.source),
    }));
  });
}

export async function recent(ctx: ServiceContext, input: { limit?: number } = {}) {
  return guardedRead(ctx, "job:read", async (tx) =>
    tx.select({
      entitlement: schema.entitlement,
      jobNumber: schema.job.number,
      summary: schema.job.summary,
    })
      .from(schema.entitlement)
      .innerJoin(schema.job, eq(schema.job.id, schema.entitlement.jobId))
      .orderBy(desc(schema.entitlement.resolvedAt))
      .limit(input.limit ?? 50));
}

/**
 * Refuse to bill the customer for work their coverage says they do not pay
 * for.
 *
 * A guard rather than a calculation, and deliberately: the sources this
 * refuses on are the ones where billing the customer is not a pricing
 * question but a mistake. We are back because of something we did, or we
 * chose to absorb it. Rework billed to a customer is the complaint that ends
 * a relationship, and it happens because the person invoicing was not the
 * person who decided.
 */
export function refusalFor(
  terms: coverage.Entitlement | null,
  charges: { kind: coverage.ChargeKind; amount: m.Money }[],
): string | null {
  if (!terms) return null;
  if (!coverage.isOurCost(terms.source)) return null;

  /**
   * When the source covers labour, parts and the trip there is nothing left
   * for the customer to pay, so a line nobody could classify is covered too.
   *
   * Everywhere else in this module an unclassifiable line is the customer's,
   * because guessing the other way loses revenue. Here the risk runs the
   * other way: a callback is a job where the answer is already "nothing",
   * and a badly named line is exactly how a customer ends up invoiced for
   * rework.
   */
  const coversEverything = terms.coversLabour && terms.coversParts && terms.coversTrip;

  const billed = charges.filter((c) => {
    if (m.isZero(c.amount)) return false;
    switch (c.kind) {
      case "labour": return terms.coversLabour;
      case "parts": return terms.coversParts;
      case "trip": return terms.coversTrip;
      case "other": return coversEverything;
    }
  });
  if (billed.length === 0) return null;

  return `This job is covered: ${coverage.COVERAGE[terms.source].description} `
    + `Billing the customer for ${[...new Set(billed.map((c) => c.kind))].join(" and ")} `
    + `contradicts that. Change who is paying, or take those lines off.`;
}

export { coverage };
