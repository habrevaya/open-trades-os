import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { permissionsFor, reporting } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { CATALOGUE } from "./report-catalogue";
import {
  jobScopeFilter, invoiceScopeFilter, estimateScopeFilter, jobVisibility,
  jobBranchFilter, invoiceBranchFilter, estimateBranchFilter, branchOfJob,
} from "./scope";
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
  visits: (ctx) => {
    const scope = scopeOf(ctx, "visit");
    if (scope === "all") return undefined;
    if (scope === "own") {
      return sql`exists (
        select 1 from public.visit_assignment va
        where va.visit_id = visit.id
          and va.technician_id = ${ctx.actor.technicianId ?? null}::uuid
      )`;
    }
    /**
     * A crew, a branch or a shop: whatever jobs that scope reaches, through
     * the visit's job. This used to apply the technician's own filter to
     * every scope narrower than the whole company, so a branch manager with
     * no technician record counted no visits at all: fail closed, and
     * useless.
     */
    return jobVisibility(scope, ctx.actor, sql`visit.job_id`) ?? sql`false`;
  },
  // Not scoped by work. Reads of the queue are gated on `task:read`.
  tasks: () => undefined,
  /**
   * A row per job, so it scopes exactly like the jobs dataset.
   *
   * Not optional, and not "the permission already covers it". A technician
   * granted `job.cost:read` and `report.financial:read` on a custom role is a
   * real configuration: a working owner gives themselves a technician record
   * and keeps the money. Without this line that person reads the margin on
   * every job in the company, and `scopeFilterFor` would be the only thing
   * between them and it.
   */
  profitability: (ctx) => jobScopeFilter(scopeOf(ctx, "job"), ctx.actor),
  /**
   * Not scoped by work: a call is the company's marketing, not a technician's
   * job, and the dataset needs `adspend:read`, which no field role holds.
   */
  calls: () => undefined,
};

/**
 * ONE BRANCH, CHOSEN ON THE REPORT, for each dataset whose records belong to
 * one. The same filters the lists use, so a report narrowed to Houston counts
 * exactly the records the Houston job list shows.
 *
 * A dataset missing here cannot be narrowed to a branch, and asking is
 * refused rather than ignored: a task report "for Houston" that quietly
 * counted every task in the company is the report somebody acts on.
 */
export const BRANCH_FILTERS: Record<string, (businessUnitId: string) => SQL> = {
  jobs: (unit) => jobBranchFilter(unit),
  profitability: (unit) => jobBranchFilter(unit),
  invoices: (unit) => invoiceBranchFilter(unit),
  estimates: (unit) => estimateBranchFilter(unit),
  visits: (unit) => branchOfJob(unit, sql`visit.job_id`),
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

/**
 * WHICH RECORDS A DEFINITION IS ABOUT
 *
 * Scope, soft deletes, the date range and the filters, as one list of
 * conditions. Shared by the aggregate and by the drill, because the whole
 * promise of a drill is that it opens exactly the records the aggregate
 * counted, and two copies of this list would be two definitions of "the records
 * behind this number" that could come apart the day somebody fixed one.
 */
function conditionsFor(
  ctx: ServiceContext,
  dataset: reporting.Dataset,
  definition: reporting.ReportDefinition,
): SQL[] {
  const conditions: SQL[] = [];
  const scoped = scopeFilterFor(ctx, dataset);
  if (scoped) conditions.push(scoped);

  /**
   * Soft deletes, when the table has them. A report that counts deleted
   * records disagrees with every list screen in the product, and the person
   * reading it has no way to know which is right.
   */
  if (["jobs", "invoices", "estimates", "visits", "profitability"].includes(dataset.key)) {
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

  if (definition.branchId) {
    const narrow = BRANCH_FILTERS[dataset.key];
    if (!narrow) {
      throw new ConflictError(
        `${dataset.label} do not belong to branches, so this report cannot be narrowed to one. Clear the branch to run it.`,
      );
    }
    conditions.push(narrow(definition.branchId));
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

  return conditions;
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

    /**
     * The numeric form of each measure, kept for ORDER BY.
     *
     * A money measure is selected as TEXT, deliberately, because a sum of
     * `numeric` arriving as a float loses cents at scale. But `order by
     * "balance"` names the output column, which is that text, so Postgres
     * sorts it alphabetically: "9.0000" lands above "1000.0000" and the
     * receivables report puts a nine dollar debt at the top of the chasing
     * list. Ordering by the aggregate itself keeps the precision in the
     * value and the arithmetic in the sort.
     */
    const numeric = new Map<string, string>();
    for (const m of measures) {
      const expression = m.kind === "count"
        ? "count(*)"
        : `${m.kind}(${m.sql})`;
      // `coalesce` so a group with no matching rows reads 0 rather than a
      // blank cell, which looks like missing data rather than none.
      const total = `coalesce(${expression}, 0)`;
      numeric.set(m.key, total);
      const wrapped = m.type === "money" ? `${total}::text` : `${total}::float8`;
      selects.push(sql`${sql.raw(wrapped)} as ${sql.raw(`"${m.key}"`)}`);
    }

    const conditions = conditionsFor(ctx, dataset, definition);

    const groupBy = dimensions.length > 0
      ? sql` group by ${sql.raw(dimensions.map((_, i) => String(i + 1)).join(", "))}`
      : sql``;

    /**
     * WHAT A REPORT IS SORTED BY, AND WHY A DATE IS DIFFERENT
     *
     * Biggest first is right for a category: "who owes us" is a list you read
     * from the top and stop. It is wrong for a date, and wrong in a way that
     * looks fine. Revenue by month sorted by revenue is the same twelve
     * numbers with the shape taken out, and with a limit on it, it keeps the
     * twelve BIGGEST months rather than the twelve most recent, so a chart
     * labelled "last 18 months" quietly shows the best 18 the company ever
     * had.
     *
     * So a report grouped by one date orders by that date unless the
     * definition asks for something else, and `orderBy` may now name a
     * dimension as well as a measure.
     */
    /**
     * A dimension is SEQUENTIAL when its values have an order of their own.
     * Two do: a date, and a bucket carrying a sort prefix. The aging buckets
     * are the second kind, and the prefix exists for exactly this: "Over 90"
     * sorts between "1 to 30" and "31 to 60" without it.
     *
     * Everything else is a category, and categories have no order but size.
     */
    const sequential = dimensions.length === 1
      && (dimensions[0]!.type === "date" || dimensions[0]!.sortPrefix === true)
      ? dimensions[0]! : null;

    const asked = definition.orderBy;
    const orderKey =
      (asked && dimensions.some((d) => d.key === asked) ? asked : null)
      ?? (asked && measures.some((m) => m.key === asked) ? asked : null)
      ?? sequential?.key
      ?? measures[0]!.key;

    /**
     * Descending either way, because the limit has to keep the recent end
     * rather than the far one. The reading order is produced by reversing
     * what came back, below, rather than by sorting ascending and then
     * throwing away the eighteen months somebody wanted.
     */
    const chronological = sequential !== null && orderKey === sequential.key;
    // A measure sorts by its own aggregate, a dimension by its output
    // column, where text order is the order we want.
    const orderExpression = numeric.get(orderKey) ?? `"${orderKey}"`;
    const order = dimensions.length > 0
      ? sql` order by ${sql.raw(orderExpression)} desc nulls last`
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
    const kept = truncated ? rows.slice(0, limit) : rows;
    // Oldest first for a reader, after the limit has taken the newest.
    const ordered = chronological ? [...kept].reverse() : kept;
    return {
      columns: [
        ...dimensions.map((d) => ({
          key: d.key, label: d.label, type: d.type, role: "dimension" as const,
          ...(d.sortPrefix ? { sortPrefix: true as const } : {}),
        })),
        ...measures.map((m) => ({ key: m.key, label: m.label, type: m.type, role: "measure" as const })),
      ],
      rows: ordered as ReportResult["rows"],
      truncated,
    };
  });
}

// ---------------------------------------------------------------------------
// Drill through
// ---------------------------------------------------------------------------

export interface DrillColumn {
  key: string;
  label: string;
  type: string;
  /**
   * `record` describes the record; `measure` is what this record added to the
   * number that was clicked. The screen right aligns one and not the other,
   * and puts a total under the second.
   */
  role: "record" | "measure";
}

export interface DrillRow {
  id: string;
  label: string;
  /** Where this record opens. */
  href: string;
  values: Record<string, string | number | null>;
  /** Where a value that names another record opens, by column. */
  links: Record<string, string>;
}

export interface DrillResult {
  noun: string;
  plural: string;
  /** What was pinned, in the words and order of the report's own columns. */
  pinned: { key: string; label: string; type: string; value: string | null; sortPrefix?: boolean }[];
  columns: DrillColumn[];
  rows: DrillRow[];
  /**
   * Each measure over EVERY record behind the number, not only the ones shown,
   * so a list cut off at a thousand still totals to what was clicked.
   */
  totals: Record<string, string | null>;
  /** How many records there are, which can be more than `rows` holds. */
  count: number;
  truncated: boolean;
}

/** A thousand, for the same reason a report stops there. */
const MAX_DRILL_ROWS = 1_000;

/**
 * THE RECORDS BEHIND ONE ROW OF A REPORT.
 *
 * The report's own definition, run through the same `conditionsFor` the
 * aggregate used, with each grouped dimension pinned to the value on the row
 * that was clicked and the grouping taken off. Nothing about which records
 * count is decided here a second time, which is why the totals at the bottom
 * agree with the number on the report: the same scope, the same soft deletes,
 * the same date range, the same filters, and the same SQL fragment for every
 * measure, evaluated one record at a time instead of summed.
 *
 * A pin is compared with `is not distinct from`, so a group that came back as
 * null ("Not set" on the screen) opens the records with nothing in that field
 * rather than none at all.
 */
export async function drill(
  ctx: ServiceContext,
  request: reporting.DrillRequest,
): Promise<DrillResult> {
  const held = permissionsFor(ctx.actor);
  const decision = reporting.resolveDrill(request, CATALOGUE, held);
  if (!decision.ok) throw new ConflictError(reporting.explainRefusal(decision));

  const { dataset, pinned, measures, record } = decision;

  return guardedRead(ctx, dataset.permission, async (tx) => {
    const conditions = conditionsFor(ctx, dataset, request.definition);
    for (const pin of pinned) {
      // Bound as a parameter, like a filter value: it came off a URL.
      conditions.push(sql`(${sql.raw(pin.dimension.sql)})::text is not distinct from ${pin.value}::text`);
    }

    /**
     * Inside, every value is selected in its own type, so the window totals
     * below are numeric arithmetic and not string concatenation. Outside, the
     * money and the hours come back as TEXT, for the same reason the report
     * selects money as text: a float would lose the cents the totals are
     * meant to agree to.
     */
    const inner: SQL[] = [
      sql.raw(`(${record.id})::text as "__id"`),
      sql.raw(`(${record.linkId ?? record.id})::text as "__link"`),
      sql.raw(`(${record.label})::text as "__label"`),
      sql.raw(`(${record.orderBy}) as "__sort"`),
    ];
    for (const column of record.columns) {
      inner.push(sql.raw(`(${column.sql}) as "c_${column.key}"`));
      if (column.link) inner.push(sql.raw(`(${column.link.id})::text as "l_${column.key}"`));
    }
    for (const measure of measures) {
      const value = measure.kind === "count" ? "1::numeric" : `(${measure.sql})::numeric`;
      inner.push(sql.raw(`${value} as "m_${measure.key}"`));
    }

    const outer: string[] = [`"__id"`, `"__link"`, `"__label"`, `count(*) over () as "__count"`];
    for (const column of record.columns) {
      outer.push(`"c_${column.key}"`);
      if (column.link) outer.push(`"l_${column.key}"`);
    }
    for (const measure of measures) {
      outer.push(`"m_${measure.key}"::text as "m_${measure.key}"`);
      const over = measure.kind === "count"
        ? `count(*) over ()`
        : measure.kind === "sum"
          ? `coalesce(sum("m_${measure.key}") over (), 0)`
          : `${measure.kind}("m_${measure.key}") over ()`;
      outer.push(`(${over})::text as "t_${measure.key}"`);
    }

    const rows = await tx.execute<Record<string, string | number | null>>(sql`
      with drilled as (
        select ${sql.join(inner, sql.raw(", "))}
        from ${sql.raw(dataset.from)}
        ${conditions.length > 0 ? sql` where ${and(...conditions)!}` : sql``}
      )
      select ${sql.raw(outer.join(", "))}
      from drilled
      order by "__sort" desc nulls last, "__id"
      limit ${MAX_DRILL_ROWS + 1}
    `);

    const truncated = rows.length > MAX_DRILL_ROWS;
    const kept = truncated ? rows.slice(0, MAX_DRILL_ROWS) : rows;
    const first = rows[0];

    const href = (pattern: string, id: string | number | null | undefined) =>
      pattern.includes("{id}") ? pattern.replace("{id}", String(id ?? "")) : pattern;

    return {
      noun: record.noun,
      plural: record.plural,
      pinned: pinned.map((pin) => ({
        key: pin.dimension.key,
        label: pin.dimension.label,
        type: pin.dimension.type,
        value: pin.value,
        ...(pin.dimension.sortPrefix ? { sortPrefix: true } : {}),
      })),
      columns: [
        ...record.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, role: "record" as const })),
        ...measures.map((m) => ({ key: m.key, label: m.label, type: m.type, role: "measure" as const })),
      ],
      rows: kept.map((row) => {
        const values: DrillRow["values"] = {};
        const links: DrillRow["links"] = {};
        for (const column of record.columns) {
          values[column.key] = row[`c_${column.key}`] ?? null;
          const linked = column.link ? row[`l_${column.key}`] : null;
          if (column.link && linked) links[column.key] = href(column.link.href, linked);
        }
        for (const measure of measures) values[measure.key] = row[`m_${measure.key}`] ?? null;
        return {
          id: String(row["__id"]),
          label: String(row["__label"] ?? ""),
          href: href(record.href, row["__link"]),
          values,
          links,
        };
      }),
      totals: Object.fromEntries(measures.map((m) => [
        m.key,
        first ? (first[`t_${m.key}`] as string | null) ?? null : m.kind === "count" || m.kind === "sum" ? "0" : null,
      ])),
      count: first ? Number(first["__count"]) : 0,
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

      /** A rename collides the same way a create does, and refuses the same way. */
      const [after] = await refusingDuplicate(
        "report_name_idx",
        `There is already a report called "${name}".`,
        () => tx.update(schema.report).set({
          name,
          description: input.description ?? null,
          definition: input.definition as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }).where(eq(schema.report.id, input.id!)).returning(),
      );

      await audit(tx, ctx, "report.updated", "report", input.id, before, after);
      return after!;
    }

    /**
     * The name is unique per company, and a name is a thing a person types.
     * Two people saving "Monthly revenue" is the ordinary case, not a bug, so it
     * is a sentence rather than a crashed screen. `services/duplicates.ts`.
     */
    const [created] = await refusingDuplicate(
      "report_name_idx",
      `There is already a report called "${name}". Open that one, or give this one a name that `
      + `says how it differs, because a list of two reports with one name is a list nobody trusts.`,
      () => tx.insert(schema.report).values({
        organizationId: ctx.actor.organizationId,
        name,
        description: input.description ?? null,
        definition: input.definition as unknown as Record<string, unknown>,
        createdByUserId: ctx.actor.userId,
      }).returning(),
    );

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


/* --------------------------------------------------------------- handlers */

/**
 * A definition off the wire, with nothing an optional field could carry as
 * `undefined` that the definition type does not allow.
 */
function definitionFromWire(input: {
  dataset: string;
  dimensions: string[];
  measures: string[];
  filters?: { dimension: string; op: "eq" | "neq" | "in"; value: string | string[] }[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  orderBy?: string | undefined;
  limit?: number | undefined;
}): reporting.ReportDefinition {
  return {
    dataset: input.dataset,
    dimensions: input.dimensions,
    measures: input.measures,
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.orderBy ? { orderBy: input.orderBy } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };
}

export const handlers = {
  drillReport: (ctx: ServiceContext, input: {
    definition: Parameters<typeof definitionFromWire>[0];
    match: Record<string, string | null>;
  }): Promise<DrillResult> => drill(ctx, { definition: definitionFromWire(input.definition), match: input.match }),
} as const;
