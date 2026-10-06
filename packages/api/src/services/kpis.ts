import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, effectiveScope, reporting, PERMISSIONS, type Permission } from "@opentradesos/core";
import { packs, packById, type TradePack } from "@opentradesos/trade-packs";
import { audit, guardedRead, timezoneOf, ConflictError, NotFoundError, type ServiceContext } from "./context";
import { CATALOGUE, KEYS, total, type BesideKey, type Entry, type Format, type Half } from "./kpi-catalogue";

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
          endpoint: null, besides: [],
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
          needs: entry.needs, endpoint: null, besides: [],
        });
        continue;
      }

      if (entry.state === "elsewhere") {
        result.elsewhere.push({
          ...base, state: "elsewhere", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, numeratorMoney: false, denominatorMoney: false,
          needs: entry.why, endpoint: entry.endpoint, besides: [],
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
          endpoint: null, besides: [],
        });
        continue;
      }

      const numerator = await scalar(tx, total(entry.measure.numerator.records(input.from, input.to, zone)));
      const denominator = await scalar(tx, total(entry.measure.denominator.records(input.from, input.to, zone)));
      const besides: NonNullable<KpiResult["besides"]> = [];
      for (const [key, half] of Object.entries(entry.measure.besides ?? {}) as Array<[BesideKey, Half]>) {
        besides.push({ key, label: half.label, count: String(await scalar(tx, total(half.records(input.from, input.to, zone)))) });
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
  /** True when more records exist than are listed. The total still covers all of them. */
  truncated: boolean;
  /** Every record's value is dollars, so the list and its total are shown as money. */
  money: boolean;
}

/** A thousand, as the report drill lists. Nobody reads more on a screen. */
const DRILL_LIMIT = 1000;

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
};

const KIND_WORDS: Record<string, string> = {
  job: "jobs", estimate: "estimates", agreement: "agreements", visit: "visits", customer: "customers",
  technician_day: "timesheets", crew_day: "timesheets", time: "timesheets", deficiency: "the equipment register", equipment: "the equipment register",
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
export function drill(
  ctx: ServiceContext, input: { key: string; half: KpiHalf; from: string; to: string },
) {
  return guardedRead(ctx, "report:read", async (tx): Promise<KpiDrill> => {
    if (input.to < input.from) {
      throw new ConflictError("The end of the window is before its start.");
    }
    const entry = CATALOGUE[input.key];
    if (!entry || entry.state !== "computed") {
      throw new NotFoundError("KPI");
    }
    const pack = await packOf(tx, ctx.actor.organizationId);
    const declared = pack?.kpis.find((k) => k.key === input.key);
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
    const half: Half | undefined = input.half === "numerator" || input.half === "denominator"
      ? entry.measure[input.half] : entry.measure.besides?.[input.half];
    if (!half) throw new NotFoundError("KPI");
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
    const moneyHalf = halfIsMoney(entry, input.half);
    if (moneyHalf && !can(ctx.actor, "report.financial:read")) {
      throw new ConflictError(
        "The records behind this figure are revenue per job, which is a financial report. "
        + "Seeing them needs report.financial:read.",
      );
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const records = half.records(input.from, input.to, zone);
    const rows = await tx.execute<{
      kind: string; id: string; label: string | null; on_day: string | null; value: string; href: string;
    }>(sql`
      select r.kind, r.id, r.label, r.on_day, r.value::text as value, r.href,
             count(*) over () as count, coalesce(sum(r.value) over (), 0)::text as total
      from (${records}) as r
      order by r.on_day desc nulls last, r.label
      limit ${DRILL_LIMIT + 1}
    `);

    const kinds = [...new Set(rows.map((row) => row.kind))];
    for (const kind of kinds) {
      const needs = KIND_NEEDS[kind];
      if (!needs || !can(ctx.actor, needs)) {
        throw new ConflictError(
          `The records behind this figure are ${KIND_WORDS[kind] ?? kind}, and reading them needs `
          + `${needs ?? "a permission this product has not named"}.`,
        );
      }
    }

    const first = rows[0] as (typeof rows)[number] & { count?: string; total?: string } | undefined;
    const count = Number(first?.count ?? 0);
    const sum = first?.total ?? "0";

    await audit(tx, ctx, "kpi.drill", "organization", ctx.actor.organizationId, null, {
      key: input.key, half: input.half, from: input.from, to: input.to, count,
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
      records: rows.slice(0, DRILL_LIMIT).map((row) => ({
        kind: row.kind,
        id: row.id,
        label: row.label ?? "Not named",
        onDay: row.on_day,
        value: row.value,
        href: row.href,
      })),
      count,
      total: sum,
      truncated: count > DRILL_LIMIT,
      money: moneyHalf,
    };
  });
}

export const handlers = {
  getKpiScorecard: (ctx: ServiceContext, input: { from: string; to: string }) =>
    scorecard(ctx, input),
  listKpiCatalogue: (ctx: ServiceContext, input: Record<string, never>) => catalogue(ctx, input),
  getKpiRecords: (ctx: ServiceContext, input: { key: string; half: KpiHalf; from: string; to: string }) =>
    drill(ctx, input),
} as const;
