import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { packs, packById, type TradePack } from "@opentradesos/trade-packs";
import { audit, guardedRead, ConflictError, type ServiceContext } from "./context";
import { CATALOGUE, KEYS, type Entry, type Format } from "./kpi-catalogue";

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
  /** Set when the state is `unavailable`: the one datum that is missing. */
  needs: string | null;
  /** Set when the state is `elsewhere`: where to get it. */
  endpoint: string | null;
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
 * How two scalars become the number on the screen.
 *
 * A zero denominator is NULL and never zero. Nought per cent close rate says
 * every estimate lost; no estimates presented says there is nothing to measure,
 * and those are different months with different answers. This codebase has made
 * the same choice in `utilisation`, `reachRate` and `overageCapture`, and it is
 * the same reason each time.
 */
function combine(format: Format, numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  switch (format) {
    case "percent":
      return ((numerator / denominator) * 100).toFixed(1);
    case "money":
      /**
       * Four decimal places, as every money column in this schema is. A figure
       * rounded to cents here and summed elsewhere would not reconcile against
       * the ledger it came from.
       */
      return (numerator / denominator).toFixed(4);
    case "duration":
    case "number":
      return (numerator / denominator).toFixed(2);
  }
}

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
          numeratorLabel: null, denominatorLabel: null,
          needs: "This KPI is declared by the trade pack and has no entry in the catalogue, so "
            + "nobody has decided whether it can be computed. That is a bug rather than a gap.",
          endpoint: null,
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
          numeratorLabel: null, denominatorLabel: null, needs: entry.needs, endpoint: null,
        });
        continue;
      }

      if (entry.state === "elsewhere") {
        result.elsewhere.push({
          ...base, state: "elsewhere", value: null, numerator: null, denominator: null,
          numeratorLabel: null, denominatorLabel: null, needs: entry.why,
          endpoint: entry.endpoint,
        });
        continue;
      }

      const numerator = await scalar(tx, entry.measure.numerator(input.from, input.to));
      const denominator = await scalar(tx, entry.measure.denominator(input.from, input.to));
      const value = TOTALS.includes(kpi.key)
        ? numerator.toFixed(4)
        : combine(entry.format, numerator, denominator);

      result.computed.push({
        ...base,
        state: "computed",
        value,
        numerator: entry.format === "money" ? numerator.toFixed(4) : String(numerator),
        denominator: String(denominator),
        numeratorLabel: entry.measure.numeratorLabel,
        denominatorLabel: entry.measure.denominatorLabel,
        needs: null,
        endpoint: null,
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

export const handlers = {
  getKpiScorecard: (ctx: ServiceContext, input: { from: string; to: string }) =>
    scorecard(ctx, input),
  listKpiCatalogue: (ctx: ServiceContext, input: Record<string, never>) => catalogue(ctx, input),
} as const;
