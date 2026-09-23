import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * MARKETING
 *
 * The routes exist because attribution is the one question a contractor
 * cannot answer from inside any other system they own. The ad account knows
 * what it spent, the CRM knows what was booked, and nobody joins them.
 *
 * TWO THINGS THIS API WILL NOT DO, both of them things every competing
 * product does:
 *
 * It does not pick a house attribution model. `GET /v1/jobs/{jobId}/attribution`
 * returns EVERY model with its answer and with what that model is wrong
 * about, because when first touch and last touch disagree, somebody is about
 * to cut the channel that starts every job.
 *
 * It does not invent a touch. A job with nothing recorded comes back as not
 * attributed, with a sentence saying so, never as `direct`. Giving the
 * untracked phone call to direct makes the pie chart add up and makes an
 * owner conclude their brand carries them.
 */

export const TouchBasis = z.enum(["utm", "click_id", "tracked_number", "referrer", "none"]);

export const AttributionModel = z.enum([
  "first_touch", "last_touch", "last_non_direct", "linear", "position_based",
]);

export const Touch = z.object({
  id: Uuid,
  /** A key from the lead source catalogue. */
  source: z.string(),
  /**
   * How we decided. A report that cannot separate "they tagged it" from "we
   * inferred it from the referring host" cannot say how much of its
   * attribution is evidence. Most of it is not.
   */
  basis: TouchBasis,
  campaign: z.string().nullable(),
  medium: z.string().nullable(),
  referrerHost: z.string().nullable(),
  clickId: z.string().nullable(),
  landingPath: z.string().nullable(),
  trackedNumberE164: z.string().nullable(),
  /** What was written when the source could not be placed. A worklist, not a log. */
  unrecognised: z.string().nullable(),
  occurredAt: z.string().datetime(),
});

export const listTouches = defineRoute({
  method: "get",
  path: "/v1/marketing/touches",
  summary: "Everything recorded for one customer, visitor or job",
  description:
    "Name one of the three. Every touch in the company is not a question anybody asked.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    customerId: Uuid.optional(),
    visitorId: z.string().max(200).optional(),
    jobId: Uuid.optional(),
  }),
  output: z.object({ touches: z.array(Touch) }),
});

export const SourceCredit = z.object({
  source: z.string(),
  /** Integer parts, fed to the money allocator. Never a percentage: those do not add back up. */
  parts: z.number().int(),
  touches: z.number().int(),
  /** Display only, to two places. Never feed it back into arithmetic. */
  percent: z.string(),
});

export const getJobAttribution = defineRoute({
  method: "get",
  path: "/v1/jobs/{jobId}/attribution",
  summary: "Who gets the credit, under every model at once",
  description:
    "The disagreement is the finding. Each model carries what it is wrong about, because a figure shown without its caveat is what moves a budget onto the wrong channel. A job with no touches is reported as not attributed rather than as direct.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    jobId: Uuid,
    models: z.array(AttributionModel).optional(),
  }),
  output: z.object({
    jobId: Uuid,
    touchCount: z.number().int(),
    /** False when the models name different channels, which is when to read all of them. */
    agree: z.boolean(),
    models: z.array(z.object({
      model: AttributionModel,
      label: z.string(),
      meaning: z.string(),
      wrongAbout: z.string(),
      attributed: z.boolean(),
      primary: z.string().optional(),
      credits: z.array(SourceCredit).optional(),
      note: z.string().nullable().optional(),
      /** Present only when nothing was recorded. Says so in words a person can act on. */
      detail: z.string().optional(),
    })),
  }),
});

export const SpendRow = z.object({
  source: z.string(),
  campaign: z.string().max(200).nullable().optional(),
  spentOn: z.string().date(),
  amount: MoneyString,
  impressions: z.number().int().min(0).nullable().optional(),
  clicks: z.number().int().min(0).nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
});

export const recordSpend = defineRoute({
  method: "post",
  path: "/v1/marketing/spend",
  summary: "Record what a channel cost on a day",
  description:
    "A day rather than a month: spend moves with the weather and a monthly figure cannot answer what the heat wave week cost per booked job. Impressions and clicks stay optional, because a yard sign has neither and offline spend is most of what a trades company buys.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: SpendRow,
  output: z.object({
    id: Uuid,
    source: z.string(),
    campaign: z.string().nullable(),
    spentOn: z.string(),
    amount: MoneyString,
    origin: z.string(),
  }),
});

export const importSpend = defineRoute({
  method: "post",
  path: "/v1/marketing/spend/import",
  summary: "Bring a whole export in at once",
  description:
    "Rows are accepted and refused individually. A three hundred row export with two bad campaign names loads two hundred and ninety eight and names the two: a monthly import that fails wholesale is one somebody stops doing. Re-running updates rather than doubling, keyed on source, campaign, day and origin.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({
    /** Which feed these came from. Keeps a typed figure and an imported one apart. */
    origin: z.string().min(1).max(50),
    rows: z.array(SpendRow).min(1).max(5000),
  }),
  output: z.object({
    accepted: z.number().int(),
    refused: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  }),
});

export const SourcePerformance = z.object({
  source: z.string(),
  spend: MoneyString,
  leads: z.number().int(),
  bookedJobs: z.number().int(),
  bookedValue: MoneyString,
  /**
   * Null rather than zero when there were no leads. Zero would sort the
   * worst line in the account to the top of "cheapest channels"; Infinity
   * does not survive JSON and renders as a word nobody reads as "none".
   */
  costPerLead: MoneyString.nullable(),
  costPerBookedJob: MoneyString.nullable(),
  roas: RateString.nullable(),
  bookingRate: RateString.nullable(),
  /** Which awkward case this row is, in words. */
  verdict: z.object({ kind: z.string(), message: z.string() }),
});

export const getPerformance = defineRoute({
  method: "get",
  path: "/v1/marketing/performance",
  summary: "What every channel cost and what it returned",
  description:
    "Results are counted from touches and work, never read off a spend row. Leads are counted by distinct customer, not by touch: counting touches makes a retargeting campaign that reached one homeowner eleven times look like eleven leads, which is the most flattering error an ad platform makes by default.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    from: z.string().date(),
    to: z.string().date(),
  }),
  output: z.object({
    reported: z.boolean(),
    /** Present when there was nothing to report, or the rows could not be combined. */
    detail: z.string().optional(),
    currency: z.string().optional(),
    rows: z.array(SourcePerformance).optional(),
    totalSpend: MoneyString.optional(),
    totalLeads: z.number().int().optional(),
    totalBookedJobs: z.number().int().optional(),
    totalBookedValue: MoneyString.optional(),
    blendedCostPerLead: MoneyString.nullable().optional(),
    blendedCostPerBookedJob: MoneyString.nullable().optional(),
    blendedRoas: RateString.nullable().optional(),
    /** Spend against sources that booked nothing. The first number to look at. */
    wastedSpend: MoneyString.optional(),
    wastedSources: z.array(z.string()).optional(),
    /** Booked work with no spend recorded. Usually a missing feed, not a free channel. */
    unpricedSources: z.array(z.string()).optional(),
  }),
});

export const listUnplacedSources = defineRoute({
  method: "get",
  path: "/v1/marketing/unplaced-sources",
  summary: "The campaigns no report can group",
  description:
    "A worklist. Every row is real money going into something with no name in the catalogue, and the fix is one alias. Left alone it becomes a quarter of the leads sitting under unknown with no way to find out what they were.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  output: z.object({
    sources: z.array(z.object({
      wrote: z.string(),
      medium: z.string().nullable(),
      touches: z.number().int(),
      lastSeen: z.string().datetime(),
    })),
  }),
});

export const marketingRoutes = {
  listTouches, getJobAttribution, recordSpend, importSpend,
  getPerformance, listUnplacedSources,
} as const;
