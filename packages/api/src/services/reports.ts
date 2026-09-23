import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { permissionsFor, reporting } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, scopeOf, inTenant,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { CATALOGUE } from "./report-catalogue";
import { jobScopeFilter, invoiceScopeFilter, estimateScopeFilter } from "./scope";
import { audit } from "./customers";
import { BUILT_IN } from "./report-built-in";

export { CATALOGUE, BUILT_IN };

/**
 * RUNNING A REPORT
 *
 * The definition is data. This turns it into SQL, and every fragment it
 * concatenates came out of the catalogue rather than out of the request:
 * `resolveReport` hands back the catalogue objects, and anything it could not
 * find is a refusal before a query is built.
 *
 * Filter VALUES are the exception and are bound as parameters, never
 * interpolated, because a value genuinely is user input.
 */

export interface ReportResult {
  columns: {
    key: string;
    label: string;
    type: string;
    /**
     * What you grouped by, or what you counted. The screen needs the
     * difference to right-align one and not the other, and inferring it from
     * the type would quietly break the day somebody adds a numeric dimension.
     */
    role: "dimension" | "measure";
    sortPrefix?: boolean;
  }[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

/** Nobody reads a ten thousand row report on a screen. */
const MAX_ROWS = 1_000;

/**
 * The scope filter for each dataset, as a lookup rather than a switch.
 *
 * A report is a read like any other. Without this, the report builder is the
 * most convenient way around scope in the product: a technician who cannot
 * list the company's jobs could count them by status instead, and read the
 * customer names off the group labels.
 *
 * A record and not a `switch` so the keys can be compared against the
 * catalogue in a test. The failure this is guarding against is somebody
 * adding a dataset and not a filter, which a `switch` hides behind a default
 * that nothing ever reaches.
 */
export const SCOPE_FILTERS: Record<string, (ctx: ServiceContext) => SQL | undefined> = {
  jobs: (ctx) => jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
  invoices: (ctx) => invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor),
  estimates: (ctx) => estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor),
  /**
   * A visit is scoped through its job, and `jobScopeFilter` is written
   * against the job table. Expressed as an exists rather than reaching for a
   * second filter, so there is one definition of what a technician may see
   * and not two that can disagree.
   */
  visits: (ctx) => scopeOf(ctx, "visit") === "all" ? undefined : sql`exists (
    select 1 from public.visit_assignment va
    where va.visit_id = visit.id
      and va.technician_id = ${ctx.actor.technicianId ?? null}::uuid
  )`,
  // Not scoped by work. Reads of the queue are gated on `task:read`.
  tasks: () => undefined,
};

export function scopeFilterFor(ctx: ServiceContext, dataset: reporting.Dataset): SQL | undefined {
  const filter = SCOPE_FILTERS[dataset.key];
  /**
   * A dataset in the catalogue with no filter here would otherwise be
   * unscoped, which is the quiet version of the leak this exists to prevent.
   * Fail closed, and let the test above it say so out loud.
   */
  return filter ? filter(ctx) : sql`false`;
}

export async function run(
  ctx: ServiceContext,
  definition: reporting.ReportDefinition,
): Promise<ReportResult> {
  const held = permissionsFor(ctx.actor);
  const decision = reporting.resolveReport(definition, CATALOGUE, held);
  if (!decision.ok) throw new ConflictError(reporting.explainRefusal(decision));

  const { dataset, dimensions, measures } = decision;

  return guardedRead(ctx, dataset.permission, async (tx) => {
    const selects: SQL[] = [];
    for (const d of dimensions) {
      selects.push(sql`${sql.raw(d.sql)} as ${sql.raw(`"${d.key}"`)}`);
    }
    for (const m of measures) {
      const expression = m.kind === "count"
        ? "count(*)"
        : `${m.kind}(${m.sql})`;
      // `coalesce` so a group with no matching rows reads 0 rather than a
      // blank cell, which looks like missing data rather than none.
      const wrapped = m.type === "money"
        ? `coalesce(${expression}, 0)::text`
        : `coalesce(${expression}, 0)::float8`;
      selects.push(sql`${sql.raw(wrapped)} as ${sql.raw(`"${m.key}"`)}`);
    }

    const conditions: SQL[] = [];
    const scoped = scopeFilterFor(ctx, dataset);
    if (scoped) conditions.push(scoped);

    /**
     * Soft deletes, when the table has them. A report that counts deleted
     * records disagrees with every list screen in the product, and the person
     * reading it has no way to know which is right.
     */
    if (["jobs", "invoices", "estimates", "visits"].includes(dataset.key)) {
      /**
       * The table is its own alias, deliberately. The scope filters are
       * written against the drizzle schema and render as `"job"."column"`,
       * so a short alias in the FROM clause makes every one of them an
       * invalid reference. A test caught it; a short alias reads nicer and
       * would have silently broken scope on every report.
       */
      const table = dataset.from.replace("public.", "");
      conditions.push(sql.raw(`"${table}".deleted_at is null`));
    }

    if (definition.from) {
      conditions.push(sql`${sql.raw(dataset.dateColumn)} >= ${definition.from}::date`);
    }
    if (definition.to) {
      // Exclusive, so a range of one month does not silently include the
      // first moment of the next one.
      conditions.push(sql`${sql.raw(dataset.dateColumn)} < ${definition.to}::date`);
    }

    for (const filter of definition.filters ?? []) {
      const dimension = dataset.dimensions.find((d) => d.key === filter.dimension)!;
      const expression = sql.raw(`(${dimension.sql})`);
      if (filter.op === "in" && Array.isArray(filter.value)) {
        // Bound as one array parameter. Joining the values into the string is
        // how a report builder becomes a SQL console.
        conditions.push(sql`${expression} = any(${sql.param(filter.value)}::text[])`);
      } else if (filter.op === "neq") {
        conditions.push(sql`${expression} <> ${String(filter.value)}`);
      } else {
        conditions.push(sql`${expression} = ${String(filter.value)}`);
      }
    }

    const groupBy = dimensions.length > 0
      ? sql` group by ${sql.raw(dimensions.map((_, i) => String(i + 1)).join(", "))}`
      : sql``;

    const orderKey = definition.orderBy && measures.some((m) => m.key === definition.orderBy)
      ? definition.orderBy
      : measures[0]!.key;
    const order = dimensions.length > 0
      ? sql` order by ${sql.raw(`"${orderKey}"`)} desc nulls last`
      : sql``;

    const limit = Math.min(definition.limit ?? MAX_ROWS, MAX_ROWS);

    const rows = await tx.execute<Record<string, string | number | null>>(sql`
      select ${sql.join(selects, sql.raw(", "))}
      from ${sql.raw(dataset.from)}
      ${conditions.length > 0 ? sql` where ${and(...conditions)!}` : sql``}
      ${groupBy}${order}
      limit ${limit + 1}
    `);

    const truncated = rows.length > limit;
    return {
      columns: [
        ...dimensions.map((d) => ({
          key: d.key, label: d.label, type: d.type, role: "dimension" as const,
          ...(d.sortPrefix ? { sortPrefix: true as const } : {}),
        })),
        ...measures.map((m) => ({ key: m.key, label: m.label, type: m.type, role: "measure" as const })),
      ],
      rows: (truncated ? rows.slice(0, limit) : rows) as ReportResult["rows"],
      truncated,
    };
  });
}

/** What a reader may pick from, given what they hold. */
export function available(ctx: ServiceContext) {
  const held = permissionsFor(ctx.actor);
  return CATALOGUE
    .filter((d) => held.has(d.permission))
    .map((d) => ({
      key: d.key,
      label: d.label,
      description: d.description,
      dimensions: d.dimensions
        .filter((x) => !x.permission || held.has(x.permission))
        .map((x) => ({ key: x.key, label: x.label })),
      measures: d.measures
        .filter((x) => !x.permission || held.has(x.permission))
        .map((x) => ({ key: x.key, label: x.label })),
    }));
}

/**
 * The reports that ship with the product.
 *
 * Filtered by what the reader holds, so an owner and a dispatcher see
 * different lists rather than the same list with half of it erroring.
 */
export function builtIn(ctx: ServiceContext) {
  const held = permissionsFor(ctx.actor);
  return BUILT_IN.filter((report) => {
    const decision = reporting.resolveReport(report.definition, CATALOGUE, held);
    return decision.ok;
  });
}

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "report:read", async (tx) =>
    tx.select().from(schema.report)
      .where(isNull(schema.report.deletedAt))
      .orderBy(schema.report.name));
}

export async function save(
  ctx: ServiceContext,
  input: { id?: string; name: string; description?: string; definition: reporting.ReportDefinition },
) {
  const name = input.name.trim();
  if (name === "") throw new ConflictError("A report needs a name");

  return guardedWrite(ctx, "report:build", async (tx) => {
    /**
     * Validated against what the AUTHOR holds, before it is stored.
     *
     * Saving a definition somebody cannot run is a report that fails for its
     * own creator, and worse, a way to leave a definition lying around for
     * somebody with more permissions to run later without ever seeing what is
     * in it.
     */
    const decision = reporting.resolveReport(input.definition, CATALOGUE, permissionsFor(ctx.actor));
    if (!decision.ok) throw new ConflictError(reporting.explainRefusal(decision));

    if (input.id) {
      const [before] = await tx.select().from(schema.report)
        .where(and(eq(schema.report.id, input.id), isNull(schema.report.deletedAt))).limit(1);
      if (!before) throw new NotFoundError("Report");

      const [after] = await tx.update(schema.report).set({
        name,
        description: input.description ?? null,
        definition: input.definition as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      }).where(eq(schema.report.id, input.id)).returning();

      await audit(tx, ctx, "report.updated", "report", input.id, before, after);
      return after!;
    }

    const [created] = await tx.insert(schema.report).values({
      organizationId: ctx.actor.organizationId,
      name,
      description: input.description ?? null,
      definition: input.definition as unknown as Record<string, unknown>,
      createdByUserId: ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "report.created", "report", created!.id, null, created);
    return created!;
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const [before] = await tx.select().from(schema.report)
      .where(and(eq(schema.report.id, input.id), isNull(schema.report.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Report");

    await tx.update(schema.report).set({ deletedAt: new Date() })
      .where(eq(schema.report.id, input.id));
    await audit(tx, ctx, "report.deleted", "report", input.id, before, null);
  });
}

export async function runSaved(ctx: ServiceContext, input: { id: string }) {
  const [saved] = await inTenant(ctx, async (tx) =>
    tx.select().from(schema.report)
      .where(and(eq(schema.report.id, input.id), isNull(schema.report.deletedAt))).limit(1));
  if (!saved) throw new NotFoundError("Report");

  /**
   * Re-checked against whoever is RUNNING it, not whoever saved it.
   *
   * A saved report is a stored intention, not a stored permission. An owner
   * saving "revenue by month" must not make it runnable by a dispatcher, and
   * `run` resolves against the caller for exactly that reason.
   */
  const definition = saved.definition as unknown as reporting.ReportDefinition;
  return { report: saved, result: await run(ctx, definition) };
}

