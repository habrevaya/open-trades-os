import { eq, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, effectiveScope, reporting, PERMISSIONS, type Permission } from "@opentradesos/core";
import { packs, packById, type TradePack } from "@opentradesos/trade-packs";
import { audit, guardedRead, timezoneOf, ConflictError, NotFoundError, type ServiceContext } from "./context";
import { CATALOGUE, KEYS, total, type BesideKey, type Entry, type Format, type Grouping, type Half } from "./kpi-catalogue";

/**
 * THE SCORECARD A TRADE PACK ALREADY SPECIFIED
 *
 * Eight packs declare sixty three KPIs, forty seven distinct keys, each with a
 * definition precise enough to name how that metric is usually computed wrongly.
 * `KpiSeed` validated every one of them at import and nothing read them.
 *
 * This is the reader. It answers one question per company: of the numbers your
 * trade's own pack says matter, what are they this month, and for the ones we
 * cannot give you, exactly what is missing.
 *
 * THAT SECOND HALF IS THE PRODUCT DECISION. A dashboard showing six real numbers
 * and naming the two it cannot compute is worth more than one showing eight
 * where two are guesses, because the two guesses are the ones somebody makes a
 * hiring decision on. Most of these definitions name an exclusion, and a KPI
 * computed without its exclusions is worse than an absent one: it looks like the
 * definition.
 *
 * EVERY NUMBER COMES BACK WITH ITS TWO HALVES. "$620" is an assertion;
 * "$186,000 over 300 jobs" is an arithmetic a contractor can argue with, and
 * arguing with it is how they come to trust it. Every definition in every pack
 * turns out to be a ratio of two countable things, which is not a coincidence: a
 * KPI that is not is usually one nobody can reproduce.
 */

export type KpiState = "computed" | "unavailable" | "elsewhere";

export interface KpiResult {
  key: string;
  label: string;
  /** The pack's own words. The reason the number is worth having. */
  definition: string;
  format: Format;
  target: string | null;
  state: KpiState;
  /** Null when the two halves cannot make a number: an empty denominator. */
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  numeratorLabel: string | null;
  denominatorLabel: string | null;
  /** Each half is dollars: the number is shown as money rather than as a count. */
  numeratorMoney: boolean;
  denominatorMoney: boolean;
  /** Set when the state is `unavailable`: the one datum that is missing. */
  needs: string | null;
  /** Set when the state is `elsewhere`: where to get it. */
  endpoint: string | null;
  /**
   * Counts beside the number and not in it: the records the definition
   * leaves out (`excluded`), and the ones it counts for a reason nobody
   * recorded (`unknown`). Empty for a figure that has neither, and the
   * scorecard always sends it; optional so a figure built elsewhere (a
   * screen's own test) need not invent one.
   */
  besides?: Array<{ key: BesideKey; label: string; count: string }>;
  /**
   * What the figure can be broken down by, from the groupings its records
   * carry (a stop's route and weekday). Empty for a figure whose records name
   * no grouping; optional for the same reason as `besides`.
   */
  groupings?: Array<{ key: string; label: string }>;
}

export interface Scorecard {
  tradePack: string | null;
  from: string;
  to: string;
  computed: KpiResult[];
  /** The ones this product cannot compute yet, each saying what it needs. */
  unavailable: KpiResult[];
  /** The ones another endpoint already answers, so nobody computes them twice. */
  elsewhere: KpiResult[];
}

/**
 * How two scalars become the number on the screen is core's `combine`: a zero
 * denominator is null and never zero, and it is tested there without a
 * database. The halves it is given come from the SQL in `kpi-catalogue.ts`.
 */
const combine = reporting.combine;

/**
 * A money total rather than a ratio.
 *
 * `replace_pipeline` and `panel_pipeline` are totals whose denominator is a
 * count, kept so the figure is checkable: forty thousand over three
 * recommendations is a different conversation from forty thousand over sixty.
 * Dividing would turn a pipeline into an average and lose the thing an owner is
 * looking at.
 */
const TOTALS: readonly string[] = ["replace_pipeline", "panel_pipeline"];

/**
 * Whether one half of a computed KPI is dollars: the half says so, and failing
 * that the numerator of a money KPI is (revenue over a count of jobs).
 */
function halfIsMoney(entry: Extract<Entry, { state: "computed" }>, half: KpiHalf): boolean {
  if (half !== "numerator" && half !== "denominator") return entry.measure.besides?.[half]?.money ?? false;
  return entry.measure[half].money ?? (entry.format === "money" && half === "numerator");
}

/** A permission as its own words, for a sentence an owner reads: "See job cost, gross margin and profitability". */
const permissionWords = (permission: Permission) => `"${PERMISSIONS[permission]}"`;

async function scalar(tx: Database, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await tx.execute<{ value: string | null }>(statement);
  return Number(rows[0]?.value ?? 0);
}

async function packOf(tx: Database, organizationId: string): Promise<TradePack | null> {
  const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  return org?.primaryTrade ? packById(org.primaryTrade) ?? null : null;
}

/**
 * The company's own trade pack's KPIs, for a window.
 *
 * `report:read`, because it is a report. The pack is the company's own
 * `primary_trade`, and a company that has applied none gets an empty scorecard
 * with its trade named as null rather than an error: "you have not chosen a
 * trade" is an answer.
 */
export function scorecard(ctx: ServiceContext, input: { from: string; to: string }) {
  return guardedRead(ctx, "report:read", async (tx): Promise<Scorecard> => {
    if (input.to < input.from) {
      throw new ConflictError("The end of the window is before its start.");
    }

    const pack = await packOf(tx, ctx.actor.organizationId);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const result: Scorecard = {
      tradePack: pack?.id ?? null,
      from: input.from,
      to: input.to,
      computed: [],
      unavailable: [],
      elsewhere: [],
    };
    if (!pack) return result;

    for (const kpi of pack.kpis) {
      const entry: Entry | undefined = CATALOGUE[kpi.key];
      if (!entry) {
        /**
         * Unreachable while the guard test passes, and here rather than as a
         * throw because a scorecard is not the place to discover a pack and a
         * catalogue disagreeing: an owner would get an error instead of the six
         * numbers that do work.
         */
        result.unavailable.push({
          key: kpi.key, label: kpi.label, definition: kpi.definition,
          format: (kpi.format as Format) ?? "number", target: kpi.target ?? null,
          state: "unavailable", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, numeratorMoney: false, denominatorMoney: false,
          needs: "This KPI is declared by the trade pack and has no entry in the catalogue, so "
            + "nobody has decided whether it can be computed. That is a bug rather than a gap.",
          endpoint: null, besides: [], groupings: [],
        });
        continue;
      }

      const base = {
        key: kpi.key,
        label: kpi.label,
        definition: kpi.definition,
        format: entry.format,
        target: kpi.target ?? null,
      };

      if (entry.state === "needs") {
        result.unavailable.push({
          ...base, state: "unavailable", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, numeratorMoney: false, denominatorMoney: false,
          needs: entry.needs, endpoint: null, besides: [], groupings: [],
        });
        continue;
      }

      if (entry.state === "elsewhere") {
        result.elsewhere.push({
          ...base, state: "elsewhere", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, numeratorMoney: false, denominatorMoney: false,
          needs: entry.why, endpoint: entry.endpoint, besides: [], groupings: [],
        });
        continue;
      }

      /**
       * A figure built from what work costs is refused to a reader who may not
       * read what work costs, and says which they lack. Not blanked and not
       * shown: a margin percentage handed to somebody without the permission
       * is the cost column one division away, and "unavailable" is the
       * honest word for a figure this reader cannot have.
       */
      const lacking = (entry.permissions ?? []).filter((permission) => !can(ctx.actor, permission));
      if (lacking.length > 0) {
        result.unavailable.push({
          ...base, state: "unavailable", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, numeratorMoney: false, denominatorMoney: false,
          needs: `This figure is built from what jobs cost, so reading it takes ${lacking.map(permissionWords).join(" and ")}.`,
          endpoint: null, besides: [], groupings: [],
        });
        continue;
      }

      const numerator = await scalar(tx, total(entry.measure.numerator.records(input.from, input.to, zone, pack.id)));
      const denominator = await scalar(tx, total(entry.measure.denominator.records(input.from, input.to, zone, pack.id)));
      const besides: NonNullable<KpiResult["besides"]> = [];
      for (const [key, half] of Object.entries(entry.measure.besides ?? {}) as Array<[BesideKey, Half]>) {
        besides.push({ key, label: half.label, count: String(await scalar(tx, total(half.records(input.from, input.to, zone, pack.id)))) });
      }
      const value = TOTALS.includes(kpi.key)
        ? numerator.toFixed(4)
        : combine(entry.format, numerator, denominator);

      result.computed.push({
        ...base,
        state: "computed",
        value,
        numerator: halfIsMoney(entry, "numerator") ? numerator.toFixed(4) : String(numerator),
        denominator: halfIsMoney(entry, "denominator") ? denominator.toFixed(4) : String(denominator),
        numeratorLabel: entry.measure.numerator.label,
        denominatorLabel: entry.measure.denominator.label,
        numeratorMoney: halfIsMoney(entry, "numerator"),
        denominatorMoney: halfIsMoney(entry, "denominator"),
        needs: null,
        endpoint: null,
        besides,
        groupings: (entry.measure.groupings ?? []).map((g) => ({ key: g.key, label: g.label })),
      });
    }

    await audit(tx, ctx, "kpi.scorecard", "organization", ctx.actor.organizationId, null, {
      from: input.from, to: input.to,
      computed: result.computed.length, unavailable: result.unavailable.length,
    });

    return result;
  });
}

/**
 * Every KPI every pack declares, and what this product can do about each.
 *
 * Not scoped to a company, which is why it takes no window and reads nothing: it
 * is the catalogue, for somebody deciding whether this product measures their
 * trade before they have applied a pack. `report:read` all the same, because a
 * list of what a competitor's software cannot compute is not for strangers.
 */
export function catalogue(ctx: ServiceContext, _input: Record<string, never>) {
  void _input;
  return guardedRead(ctx, "report:read", async () => {
    const byKey = new Map<string, { label: string; definition: string; packs: string[] }>();
    for (const pack of packs) {
      for (const kpi of pack.kpis) {
        const found = byKey.get(kpi.key)
          ?? { label: kpi.label, definition: kpi.definition, packs: [] };
        found.packs.push(pack.id);
        byKey.set(kpi.key, found);
      }
    }

    const data = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, meta]) => {
      const entry = CATALOGUE[key];
      return {
        key,
        label: meta.label,
        definition: meta.definition,
        trades: meta.packs,
        state: entry?.state === "computed"
          ? ("computed" as const)
          : entry?.state === "elsewhere" ? ("elsewhere" as const) : ("unavailable" as const),
        needs: entry?.state === "needs" ? entry.needs
          : entry?.state === "elsewhere" ? entry.why : null,
        endpoint: entry?.state === "elsewhere" ? entry.endpoint : null,
      };
    });

    return {
      data,
      /**
       * The three counts, so the honest summary is one line rather than something
       * a reader has to total themselves.
       */
      computed: data.filter((row) => row.state === "computed").length,
      elsewhere: data.filter((row) => row.state === "elsewhere").length,
      unavailable: data.filter((row) => row.state === "unavailable").length,
      accounted: KEYS.length,
    };
  });
}

/* -------------------------------------------------------------- the drill */

/** A half of the number, or one of the counts beside it. */
export type KpiHalf = "numerator" | "denominator" | BesideKey;

export interface KpiRecord {
  kind: string;
  id: string;
  label: string;
  onDay: string | null;
  /** What this record adds to the half: one, its revenue, its minutes. */
  value: string;
  href: string;
}

export interface KpiDrill {
  key: string;
  label: string;
  definition: string;
  format: Format;
  half: KpiHalf;
  /** The half's own words: "completed jobs", "minutes driving between stops". */
  halfLabel: string;
  from: string;
  to: string;
  records: KpiRecord[];
  /** How many records there are, whether or not all are listed. */
  count: number;
  /** The sum of every record's value, which is the half the scorecard shows. */
  total: string;
  /** True when the records fill more than one page. The total still covers all of them. */
  truncated: boolean;
  /** Which page of the records this is, from one, of how many, and how many to a page: a thousand unless fewer were asked for, as the report drill lists. */
  page: number;
  pages: number;
  perPage: number;
  /** Every record's value is dollars, so the list and its total are shown as money. */
  money: boolean;
  /**
   * The one group of a breakdown these records are, when the list was opened
   * from one: its grouping and its name. The count and the total are then
   * that group's half, as the breakdown shows it.
   */
  group: { by: string; byLabel: string; value: string; label: string | null } | null;
}

/** One group of a breakdown: which records it is, and its two halves. */
export interface KpiGroup {
  /** What tells the group apart, for opening its records. */
  value: string;
  label: string;
  /** Null when its denominator is empty, as the figure's own is. */
  figure: string | null;
  numerator: string;
  denominator: string;
  besides: Array<{ key: BesideKey; count: string }>;
}

export interface KpiBreakdown {
  key: string;
  label: string;
  format: Format;
  by: { key: string; label: string };
  from: string;
  to: string;
  numeratorLabel: string;
  denominatorLabel: string;
  numeratorMoney: boolean;
  denominatorMoney: boolean;
  besides: Array<{ key: BesideKey; label: string }>;
  groups: KpiGroup[];
  /** The groups added up, which are the scorecard's two halves. */
  numerator: string;
  denominator: string;
}

/**
 * What reading each kind of record needs. A KPI is one number for the whole
 * company; the records behind it are jobs, agreements and timesheets, and
 * listing them is reading them.
 */
const KIND_NEEDS: Record<string, Permission> = {
  job: "job:read",
  estimate: "estimate:read",
  agreement: "membership:read",
  visit: "visit:read",
  customer: "customer:read",
  technician_day: "timesheet:read",
  crew_day: "timesheet:read",
  time: "timesheet:read",
  deficiency: "equipment:read",
  equipment: "equipment:read",
  /**
   * A person's day of stops and miles is made from where they drove, so it
   * is listed to the people who may see where people are: the ones who
   * dispatch, who see the map.
   */
  route_day: "visit:dispatch",
  /** A street served, which opens on one of the addresses on it. */
  street: "property:read",
  /** A truck's water and stops, and one of its days: the fleet's. */
  truck: "asset:read",
  truck_day: "asset:read",
  /** A container and a haul of it: the fleet's. */
  container: "asset:read",
  haul: "asset:read",
};

const KIND_WORDS: Record<string, string> = {
  job: "jobs", estimate: "estimates", agreement: "agreements", visit: "visits", customer: "customers",
  technician_day: "timesheets", crew_day: "timesheets", time: "timesheets", deficiency: "the equipment register", equipment: "the equipment register",
  route_day: "each person's route days, made from where they drove",
  street: "the streets you serve",
  truck: "the fleet", truck_day: "the fleet", container: "the container fleet", haul: "the container fleet",
};

/**
 * THE RECORDS BEHIND ONE HALF OF ONE KPI.
 *
 * The same records query the scorecard summed, listed. So the total at the
 * bottom is the half that was clicked, and the rows are what each record added
 * to it: a completed job and its revenue, a technician day, the minutes of a
 * drive between two stops.
 *
 * REFUSED RATHER THAN TRIMMED, in words, in three cases. The figure is the
 * company's, so a reader whose scope is narrower than the company (a
 * technician who sees their own jobs) is refused: listing the company's
 * records would be the report builder's scope hole one click down, and
 * listing only their own would be a list that does not add up to the number
 * above it. A record kind the reader may not read is refused, naming it. A
 * money half is refused without the financial reports permission, because a
 * list of revenue per job is a financial report.
 */
/**
 * The checks every list made from a figure's records shares, the drill's and
 * the breakdown's: a KPI the company's own trade declares and this product
 * computes, a reader who sees the whole company, and the permissions the
 * figure itself takes. A breakdown is the records added up by group, so it is
 * refused exactly where the records would be.
 */
async function openFigure(tx: Database, ctx: ServiceContext, key: string) {
  const entry = CATALOGUE[key];
  if (!entry || entry.state !== "computed") {
    throw new NotFoundError("KPI");
  }
  const pack = await packOf(tx, ctx.actor.organizationId);
  const declared = pack?.kpis.find((k) => k.key === key);
  if (!declared) {
    /**
     * Only the company's own trade's numbers. A drill into a KPI the
     * scorecard never showed is a list of records under a heading nobody
     * clicked.
     */
    throw new NotFoundError("KPI");
  }

  if (effectiveScope(ctx.actor, "job") !== "all") {
    throw new ConflictError(
      "This figure is the whole company's, and your access covers only part of the company's work, "
      + "so the records behind it are not listed for you. Somebody who sees all of the work can open them.",
    );
  }
  /**
   * A figure built from what work costs lists what each job cost and earned,
   * so it takes what the figure takes: the same permissions the scorecard
   * refused it without.
   */
  const lacking = (entry.permissions ?? []).filter((permission) => !can(ctx.actor, permission));
  if (lacking.length > 0) {
    throw new ConflictError(
      `The records behind this figure are what each job cost and earned, and seeing them needs ${lacking.map(permissionWords).join(" and ")}.`,
    );
  }
  return { entry, declared, trade: pack?.id ?? "" };
}

/** A record kind the reader may not read, refused in words naming what it needs. */
function assertKindsReadable(ctx: ServiceContext, kinds: readonly string[]): void {
  for (const kind of kinds) {
    const needs = KIND_NEEDS[kind];
    if (!needs || !can(ctx.actor, needs)) {
      throw new ConflictError(
        `The records behind this figure are ${KIND_WORDS[kind] ?? kind}, and reading them needs `
        + `${needs ?? "a permission this product has not named"}.`,
      );
    }
  }
}

const MONEY_REFUSAL = "The records behind this figure are revenue per job, which is a financial report. "
  + "Seeing them needs report.financial:read.";

/** A grouping the measure declares, or a refusal naming the ones it has. */
function groupingOf(entry: Extract<Entry, { state: "computed" }>, by: string): Grouping {
  const grouping = (entry.measure.groupings ?? []).find((g) => g.key === by);
  if (!grouping) {
    const offered = (entry.measure.groupings ?? []).map((g) => g.label.toLowerCase());
    throw new ConflictError(offered.length > 0
      ? `This figure can be broken down by ${offered.join(" or ")}, not by "${by}".`
      : "The records behind this figure carry no grouping, so it is not broken down.");
  }
  return grouping;
}

/**
 * One half's records, narrowed to one group when asked, with the group's name
 * on every row. The grouping's key reaches the SQL only after it matched one
 * the catalogue declares; the value is a parameter.
 */
function recordsOf(records: SQL, grouping: Grouping | null, value: string | null): SQL {
  if (!grouping) return sql`select g.*, null::text as group_label from (${records}) as g`;
  return sql`
    select g.*, ${sql.raw(`g."g_${grouping.key}_label"`)}::text as group_label
    from (${records}) as g
    where ${sql.raw(`g."g_${grouping.key}"`)} = ${value}`;
}

export function drill(
  ctx: ServiceContext,
  input: {
    key: string; half: KpiHalf; from: string; to: string; page?: number | undefined;
    /** How many records to a page, one to a thousand. Left out, a thousand. */
    perPage?: number | undefined;
    /** One group of a breakdown: `by` names the grouping and `group` the value. Both or neither. */
    by?: string | undefined; group?: string | undefined;
  },
) {
  return guardedRead(ctx, "report:read", async (tx): Promise<KpiDrill> => {
    if (input.to < input.from) {
      throw new ConflictError("The end of the window is before its start.");
    }
    const { entry, declared, trade: declaredBy } = await openFigure(tx, ctx, input.key);
    const half: Half | undefined = input.half === "numerator" || input.half === "denominator"
      ? entry.measure[input.half] : entry.measure.besides?.[input.half];
    if (!half) throw new NotFoundError("KPI");
    const moneyHalf = halfIsMoney(entry, input.half);
    if (moneyHalf && !can(ctx.actor, "report.financial:read")) throw new ConflictError(MONEY_REFUSAL);
    if ((input.by === undefined) !== (input.group === undefined)) {
      throw new ConflictError("One group of a figure is named by its grouping and its value together.");
    }
    const grouping = input.by !== undefined ? groupingOf(entry, input.by) : null;

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const records = recordsOf(half.records(input.from, input.to, zone, declaredBy), grouping, input.group ?? null);
    /** A thousand to a page unless the caller asked for fewer, as the report drill pages. */
    const perPage = reporting.askedPerPage(input.perPage);
    /**
     * ONE PAGE, AND THE TOTAL OVER EVERY RECORD. The count, the total and the
     * kinds of record are one row over the whole half, with the page joined
     * onto it, so they are the same on every page and come back on a page
     * with nothing on it. The kinds are the whole half's rather than the
     * page's, so a record kind the reader may not read is refused on page one
     * and not first met on page three. The order ends on the record itself,
     * so a record is on exactly one page however many share a day.
     */
    const read = (offset: number) => tx.execute<{
      count: string; total: string; kinds: string[] | null; group_label: string | null;
      kind: string | null; id: string | null; label: string | null; on_day: string | null; value: string | null; href: string | null;
    }>(sql`
      with r as (${records}),
      t as (
        select count(*)::text as count, coalesce(sum(r.value), 0)::text as total,
               array_remove(array_agg(distinct r.kind), null) as kinds, max(r.group_label) as group_label
        from r
      )
      select t.count, t.total, t.kinds, t.group_label, p.kind, p.id, p.label, p.on_day, p.value, p.href
      from t
      left join lateral (
        select r.kind, r.id, r.label, r.on_day, r.value::text as value, r.href
        from r
        order by r.on_day desc nulls last, r.label, r.kind, r.id
        limit ${perPage} offset ${offset}
      ) as p on true
    `);

    const asked = reporting.askedPage(input.page);
    let rows = await read((asked - 1) * perPage);
    const count = Number(rows[0]?.count ?? 0);
    const paged = reporting.drillPage(count, asked, perPage);
    // A page past the end (the window's records changed since the link was made) is the last page.
    if (paged.page !== asked) rows = await read(paged.offset);

    assertKindsReadable(ctx, rows[0]?.kinds ?? []);

    const sum = rows[0]?.total ?? "0";

    await audit(tx, ctx, "kpi.drill", "organization", ctx.actor.organizationId, null, {
      key: input.key, half: input.half, from: input.from, to: input.to, count, page: paged.page,
      ...(grouping ? { by: grouping.key, group: input.group } : {}),
    });

    return {
      key: input.key,
      label: declared.label,
      definition: declared.definition,
      format: entry.format,
      half: input.half,
      halfLabel: half.label,
      from: input.from,
      to: input.to,
      records: rows.filter((row) => row.id !== null).map((row) => ({
        kind: row.kind ?? "",
        id: row.id ?? "",
        label: row.label ?? "Not named",
        onDay: row.on_day,
        value: row.value ?? "0",
        href: row.href ?? "",
      })),
      count,
      total: sum,
      truncated: paged.pages > 1,
      page: paged.page,
      pages: paged.pages,
      perPage: paged.perPage,
      money: moneyHalf,
      group: grouping
        ? { by: grouping.key, byLabel: grouping.label, value: input.group!, label: rows[0]?.group_label ?? null }
        : null,
    };
  });
}

/**
 * ONE FIGURE BROKEN DOWN BY A GROUPING ITS RECORDS CARRY.
 *
 * Each half's records, the same queries the scorecard sums and the drill
 * lists, added up by the group every record names: so each group's two halves
 * open onto that group's records, and the groups add up to the figure. A
 * group's figure is combined from its halves the way the figure is, so an
 * empty denominator is "not this window" for that group too, never nought.
 *
 * Refused exactly where the records behind the figure are, because a
 * breakdown names what the records name (a route, a person, a truck) and is
 * the records added up: a reader who sees only part of the company, a record
 * kind the reader may not read, and a money half without the financial
 * reports permission.
 */
export function breakdown(
  ctx: ServiceContext, input: { key: string; by: string; from: string; to: string },
) {
  return guardedRead(ctx, "report:read", async (tx): Promise<KpiBreakdown> => {
    if (input.to < input.from) {
      throw new ConflictError("The end of the window is before its start.");
    }
    const { entry, declared, trade } = await openFigure(tx, ctx, input.key);
    const grouping = groupingOf(entry, input.by);
    const numeratorMoney = halfIsMoney(entry, "numerator");
    const denominatorMoney = halfIsMoney(entry, "denominator");
    if ((numeratorMoney || denominatorMoney) && !can(ctx.actor, "report.financial:read")) {
      throw new ConflictError(MONEY_REFUSAL);
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const halves: Array<[KpiHalf, Half]> = [
      ["numerator", entry.measure.numerator],
      ["denominator", entry.measure.denominator],
      ...(Object.entries(entry.measure.besides ?? {}) as Array<[BesideKey, Half]>),
    ];

    const groups = new Map<string, { label: string; sums: Map<KpiHalf, string> }>();
    for (const [name, half] of halves) {
      const rows = await tx.execute<{ value: string; label: string | null; total: string; kinds: string[] | null }>(sql`
        select ${sql.raw(`r."g_${grouping.key}"`)}::text as value,
               max(${sql.raw(`r."g_${grouping.key}_label"`)})::text as label,
               coalesce(sum(r.value), 0)::text as total,
               array_remove(array_agg(distinct r.kind), null) as kinds
        from (${half.records(input.from, input.to, zone, trade)}) as r
        group by 1
      `);
      for (const row of rows) {
        assertKindsReadable(ctx, row.kinds ?? []);
        const group = groups.get(row.value) ?? { label: row.label ?? "Not set", sums: new Map() };
        group.sums.set(name, row.total);
        groups.set(row.value, group);
      }
    }

    const ordered = [...groups.entries()].sort(([a, x], [b, y]) => grouping.order === "key"
      ? Number(a) - Number(b) || a.localeCompare(b)
      : x.label.localeCompare(y.label) || a.localeCompare(b));
    const besideKeys = halves.slice(2).map(([key]) => key as BesideKey);
    const asHalf = (money: boolean, value: number) => (money ? value.toFixed(4) : String(value));

    let numerator = 0;
    let denominator = 0;
    const out: KpiGroup[] = ordered.map(([value, group]) => {
      const top = Number(group.sums.get("numerator") ?? 0);
      const bottom = Number(group.sums.get("denominator") ?? 0);
      numerator += top;
      denominator += bottom;
      return {
        value,
        label: group.label,
        figure: TOTALS.includes(input.key) ? top.toFixed(4) : combine(entry.format, top, bottom),
        numerator: asHalf(numeratorMoney, top),
        denominator: asHalf(denominatorMoney, bottom),
        besides: besideKeys.map((key) => ({ key, count: String(Number(group.sums.get(key) ?? 0)) })),
      };
    });

    await audit(tx, ctx, "kpi.breakdown", "organization", ctx.actor.organizationId, null, {
      key: input.key, by: grouping.key, from: input.from, to: input.to, groups: out.length,
    });

    return {
      key: input.key,
      label: declared.label,
      format: entry.format,
      by: { key: grouping.key, label: grouping.label },
      from: input.from,
      to: input.to,
      numeratorLabel: entry.measure.numerator.label,
      denominatorLabel: entry.measure.denominator.label,
      numeratorMoney,
      denominatorMoney,
      besides: besideKeys.map((key) => ({ key, label: entry.measure.besides![key]!.label })),
      groups: out,
      numerator: asHalf(numeratorMoney, numerator),
      denominator: asHalf(denominatorMoney, denominator),
    };
  });
}

export const handlers = {
  getKpiScorecard: (ctx: ServiceContext, input: { from: string; to: string }) =>
    scorecard(ctx, input),
  listKpiCatalogue: (ctx: ServiceContext, input: Record<string, never>) => catalogue(ctx, input),
  getKpiRecords: (ctx: ServiceContext, input: {
    key: string; half: KpiHalf; from: string; to: string; page?: number | undefined;
    perPage?: number | undefined; by?: string | undefined; group?: string | undefined;
  }) => drill(ctx, input),
  getKpiBreakdown: (ctx: ServiceContext, input: { key: string; by: string; from: string; to: string }) =>
    breakdown(ctx, input),
} as const;
