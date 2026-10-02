import { z } from "zod";
import { defineRoute } from "../lib/define";

/**
 * SIXTY THREE NUMBERS THE PACKS DEFINED AND NOTHING COMPUTED
 *
 * Eight trade packs declare sixty three KPIs, forty seven distinct keys, each
 * with a label, a format, a target and a definition precise enough to name the
 * way that metric is usually got wrong. `KpiSeed` validated every one at import.
 * Nothing read them: searching the product for `kpis` returned the schema line
 * that parses them and nothing else.
 */

const Format = z.enum(["percent", "money", "number", "duration"]);

const KpiResult = z.object({
  key: z.string(),
  label: z.string(),
  /** The pack's own words, which is the reason the number is worth having. */
  definition: z.string(),
  format: Format,
  target: z.string().nullable(),
  state: z.enum(["computed", "unavailable", "elsewhere"]),
  /** Null when the denominator is empty: nothing to measure is not nought. */
  value: z.string().nullable(),
  numerator: z.string().nullable(),
  denominator: z.string().nullable(),
  numeratorLabel: z.string().nullable(),
  denominatorLabel: z.string().nullable(),
  needs: z.string().nullable(),
  endpoint: z.string().nullable(),
});

export const getKpiScorecard = defineRoute({
  method: "get",
  path: "/v1/kpis",
  summary: "Your trade's own numbers, and what the rest need",
  description:
    "EVERY NUMBER COMES BACK WITH ITS TWO HALVES. '$620' is an assertion; '$186,000 over 300 jobs' is an arithmetic a contractor can argue with, and arguing with it is how they come to trust it. A zero denominator is null rather than zero, because nought per cent close rate says every estimate lost and no estimates presented says there is nothing to measure. THE UNAVAILABLE LIST IS THE OTHER HALF OF THE ANSWER: most of these definitions name an exclusion, a KPI computed without its exclusions is worse than an absent one because it looks like the definition, and each unavailable entry names the single datum that is missing rather than saying 'not built'. A dashboard showing six real numbers and naming the two it cannot compute is worth more than one showing eight where two are guesses, because the guesses are the ones somebody makes a hiring decision on.",
  module: "M21",
  permissions: ["report:read"],
  idempotent: true,
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({
    tradePack: z.string().nullable(),
    from: z.string(),
    to: z.string(),
    computed: z.array(KpiResult),
    unavailable: z.array(KpiResult),
    elsewhere: z.array(KpiResult),
  }),
});

export const listKpiCatalogue = defineRoute({
  method: "get",
  path: "/v1/kpi-catalogue",
  summary: "Every KPI every trade pack declares, and what we can do about each",
  description:
    "Not scoped to a company and reading nothing: it is the catalogue, for somebody deciding whether this product measures their trade before they have applied a pack. Every key is one of three things, and the counts come back so the honest summary is one line rather than something a reader has to total. `elsewhere` names the endpoint that already computes it, because the four rental KPIs are M22's fleet report and computing them twice would produce two figures that disagree in a meeting.",
  module: "M21",
  permissions: ["report:read"],
  idempotent: true,
  input: z.object({}),
  output: z.object({
    data: z.array(z.object({
      key: z.string(),
      label: z.string(),
      definition: z.string(),
      /** Which trades declare it. Several are cross trade. */
      trades: z.array(z.string()),
      state: z.enum(["computed", "unavailable", "elsewhere"]),
      needs: z.string().nullable(),
      endpoint: z.string().nullable(),
    })),
    computed: z.number().int(),
    elsewhere: z.number().int(),
    unavailable: z.number().int(),
    accounted: z.number().int(),
  }),
});

export const kpiRoutes = { getKpiScorecard, listKpiCatalogue } as const;
