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


/* ---------------------------------------------------------------- forms */

/**
 * Exactly core's `FieldType`, and swept against it in vocabulary.test.ts.
 *
 * The first version of this was written from memory: it invented `boolean`
 * and `address`, and omitted `service_address`, `hidden` and `honeypot`. A
 * client generated from that document could not have built the two fields
 * every trades lead form has (where the property is, and what is wrong with
 * it), and could not have built the honeypot, which is the spam check.
 */
export const FormFieldType = z.enum([
  "text", "long_text", "email", "phone", "service_address",
  "choice", "multi_choice", "number", "date", "consent",
  "hidden", "honeypot",
]);

export const FormField = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  type: FormFieldType,
  required: z.boolean(),
  /** Shown under the field. The place to say why you are asking. */
  help: z.string().max(300).optional(),
  rules: z.array(z.union([
    z.object({ rule: z.literal("min_length"), value: z.number().int() }),
    z.object({ rule: z.literal("max_length"), value: z.number().int() }),
    z.object({ rule: z.literal("min"), value: z.number() }),
    z.object({ rule: z.literal("max"), value: z.number() }),
    z.object({ rule: z.literal("pattern"), value: z.enum(["us_zip", "digits", "letters_and_spaces", "us_state"]) }),
  ])).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const listForms = defineRoute({
  method: "get",
  path: "/v1/marketing/forms",
  summary: "The lead forms on the website",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({}),
  output: z.object({
    forms: z.array(z.object({
      id: Uuid, slug: z.string(), title: z.string(),
      source: z.string(), fields: z.number().int(),
    })),
  }),
});

export const saveForm = defineRoute({
  method: "put",
  path: "/v1/marketing/forms/{slug}",
  summary: "Create or replace a lead form",
  description:
    "The definition is validated before it is stored and again when a submission is checked against it, because a form is edited by an office user and then executed against input from the open internet.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({
    slug: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    /** The lead source every submission to this form counts as. */
    source: z.string().max(50).optional(),
    fields: z.array(FormField).min(1).max(40),
    /**
     * Below this, a submission is treated as a robot. A person cannot read
     * a form, type an address and describe a broken water heater in under
     * three seconds; a script can. Only measured when the page reported
     * when it was opened, because refusing on a missing timestamp throws
     * away real leads from browsers that blocked the script.
     */
    minimumFillSeconds: z.number().int().min(0).max(300).optional(),
  }),
  output: z.object({ id: Uuid, slug: z.string(), title: z.string(), source: z.string() }),
});

export const submitForm = defineRoute({
  method: "post",
  path: "/v1/public/forms/{formSlug}",
  summary: "Fill in a lead form",
  description:
    "Every field is checked and ALL the refusals come back together. Returning the first makes somebody fix their phone number, submit, and be told about the address, which is where a homeowner with a leak rings the next company on the list. A refused submission is stored with its refusals, because a form that silently drops what it cannot parse is a form whose owner believes it works.",
  module: "M19",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({
    organizationSlug: z.string().min(1).max(100),
    formSlug: z.string().min(1).max(100),
    values: z.record(z.unknown()),
    /** When the page was opened, if it could tell. Used only for the timing check. */
    startedAt: z.string().datetime().optional(),
    visitorId: z.string().max(200).optional(),
    landingQuery: z.string().max(4000).optional(),
    referrer: z.string().max(2000).optional(),
  }),
  output: z.object({
    accepted: z.boolean(),
    submissionId: Uuid,
    /** Written for the person filling the form in, never for a developer. */
    refusals: z.array(z.object({
      field: z.string(), reason: z.string(), message: z.string(),
    })),
    customerId: Uuid.nullable(),
  }),
});

export const listSubmissions = defineRoute({
  method: "get",
  path: "/v1/marketing/submissions",
  summary: "What arrived, including what was refused",
  description:
    "The refused ones are the point. A list of accepted submissions is the same form builder every contractor already has, and its losses are invisible by construction.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    formId: Uuid.optional(),
    state: z.enum(["received", "accepted", "rejected", "spam"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    submissions: z.array(z.object({
      id: Uuid,
      formId: Uuid,
      state: z.string(),
      refusals: z.array(z.object({ field: z.string(), reason: z.string(), message: z.string() })),
      customerId: Uuid.nullable(),
      jobId: Uuid.nullable(),
      createdAt: z.string().datetime(),
    })),
  }),
});

export const getFormRefusals = defineRoute({
  method: "get",
  path: "/v1/marketing/forms/{formId}/refusals",
  summary: "Which fields are losing people",
  description:
    "Not 'the form gets some submissions' but 'eleven people in a fortnight could not get past the phone number field'. One of those is a fact somebody can act on in an afternoon.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ formId: Uuid }),
  output: z.object({
    refusals: z.array(z.object({
      field: z.string(), reason: z.string(), count: z.number().int(),
    })),
  }),
});

/* ------------------------------------------------- closing the loop back */

export const getConversions = defineRoute({
  method: "get",
  path: "/v1/marketing/conversions",
  summary: "Booked jobs to report back to the ad accounts",
  description:
    "An ads platform optimises towards whatever it is told a conversion is. Left alone it is told about form fills, learns to buy form fills, and a contractor pays more and more for people who were never going to book. Reporting the JOB, with money on it, against the click id, is what makes the account bid towards work. The value is this source's SHARE, split so the parts sum to the invoice: sending the full amount to two platforms tells each it produced twice the revenue it did.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    from: z.string().date(),
    to: z.string().date(),
    /** Which model splits the money. Named, because this is where a modelling choice becomes real spend. */
    model: AttributionModel.optional(),
    /** Omit for JSON. `google` or `meta` returns that platform's own upload format. */
    format: z.enum(["google", "meta"]).optional(),
  }),
  output: z.object({
    model: AttributionModel,
    rows: z.array(z.object({
      clickId: z.string(),
      source: z.string(),
      convertedAt: z.string().datetime(),
      value: MoneyString,
      jobId: Uuid,
    })),
    /** Present when a format was asked for: the file, ready to upload. */
    csv: z.string().optional(),
  }),
});

export const marketingRoutes = {
  listTouches, getJobAttribution, recordSpend, importSpend,
  getPerformance, listUnplacedSources,
  listForms, saveForm, submitForm, listSubmissions, getFormRefusals,
  getConversions,
} as const;
