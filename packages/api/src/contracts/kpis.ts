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
  /** Each half is dollars, so a screen shows it as money rather than as a count. */
  numeratorMoney: z.boolean(),
  denominatorMoney: z.boolean(),
  needs: z.string().nullable(),
  endpoint: z.string().nullable(),
});

export const getKpiScorecard = defineRoute({
  method: "get",
  path: "/v1/kpis",
  summary: "Your trade's own numbers, and what the rest need",
  description:
    "EVERY NUMBER COMES BACK WITH ITS TWO HALVES. '$620' is an assertion; '$186,000 over 300 jobs' is an arithmetic a contractor can argue with, and arguing with it is how they come to trust it. A zero denominator is null rather than zero, because nought per cent close rate says every estimate lost and no estimates presented says there is nothing to measure. THE UNAVAILABLE LIST IS THE OTHER HALF OF THE ANSWER: most of these definitions name an exclusion, a KPI computed without its exclusions is worse than an absent one because it looks like the definition, and each unavailable entry names the single datum that is missing rather than saying 'not built'. A dashboard showing six real numbers and naming the two it cannot compute is worth more than one showing eight where two are guesses, because the guesses are the ones somebody makes a hiring decision on. A figure built from what jobs cost (install gross margin) comes back unavailable, saying which permissions it takes, to a reader without job.cost:read and report.financial:read.",
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

export const getKpiRecords = defineRoute({
  method: "get",
  /** Flat, beside `/v1/kpis` rather than under it, so no literal sits beside a key at one depth. */
  path: "/v1/kpi-records",
  summary: "The records behind one half of one KPI",
  description:
    "The same records the scorecard summed, listed, each with what it added: a completed job and its revenue, a technician day, the minutes of a drive between two stops. The total is the half the scorecard shows, over every record even when the list stops at a thousand. Only a KPI the company's own trade pack declares and this product computes. Refused, in words, for a reader whose scope is narrower than the whole company (the figure is the company's, and a list of only their own records would not add up to it), for a record kind the reader may not read, and for a money half without report.financial:read, and, for install gross margin, which is built from what jobs cost, without job.cost:read as well.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({
    key: z.string().min(1).max(80),
    half: z.enum(["numerator", "denominator"]),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({
    key: z.string(),
    label: z.string(),
    definition: z.string(),
    format: z.enum(["percent", "money", "number", "duration"]),
    half: z.enum(["numerator", "denominator"]),
    halfLabel: z.string(),
    from: z.string(),
    to: z.string(),
    records: z.array(z.object({
      kind: z.string(),
      id: z.string(),
      label: z.string(),
      onDay: z.string().nullable(),
      value: z.string(),
      href: z.string(),
    })),
    count: z.number().int(),
    total: z.string(),
    truncated: z.boolean(),
    /** Every record's value is dollars, so the list and its total are shown as money. */
    money: z.boolean(),
  }),
});

export const kpiRoutes = { getKpiScorecard, listKpiCatalogue, getKpiRecords } as const;
