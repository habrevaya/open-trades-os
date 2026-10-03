import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";
import { AttributionModel } from "./marketing";

/**
 * CHANNEL > TRACKING CAMPAIGN > TRACKING NUMBER, AND THE FUNNEL ACROSS THEM
 *
 * The question these answer is the one a contractor asks first and could not
 * get out of this product: "the Spring AC tune up on Google Ads, with its own
 * phone number, cost me this much. How many people rang, how many booked,
 * what did it bill, and what did each of those cost me?"
 *
 * A CHANNEL is the company's own name for where work comes from, each mapped
 * to one key of the lead source catalogue so every report still rolls up. A
 * TRACKING CAMPAIGN sits under a channel with its dates, its cost and the utm
 * tag its links carry. Tracking numbers, spend, touches and jobs point at it.
 * Not the outbound text and email campaigns at `/v1/campaigns`, and not the
 * carrier's 10DLC registration: three things called campaign is two too many,
 * which is why this one is "tracking" everywhere it appears.
 */

export const Channel = z.object({
  id: Uuid,
  name: z.string(),
  /** The catalogue key it rolls up to. */
  sourceKey: z.string(),
  sourceLabel: z.string(),
  archived: z.boolean(),
});

export const CostModel = z.enum(["recorded", "fixed", "per_lead"]);

export const TrackingCampaign = z.object({
  id: Uuid,
  name: z.string(),
  channelId: Uuid,
  channelName: z.string().nullable(),
  sourceKey: z.string().nullable(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  /**
   * `recorded`: the spend entered or imported against it. `fixed`: one price
   * spread evenly over its days. `per_lead`: a price times its leads.
   */
  costModel: CostModel,
  /** The fixed price, or the price of one lead. Null when the spend rows are the cost. */
  costAmount: MoneyString.nullable(),
  /** What was meant to be spent. A plan beside the cost, never added to it. */
  budget: MoneyString.nullable(),
  utmCampaign: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
});

const Include = z.enum(["live", "all"]).optional();

export const listChannels = defineRoute({
  method: "get",
  path: "/v1/marketing/channels",
  summary: "The company's channels",
  description:
    "Seeded from the lead source catalogue the first time anything asks, one per key, and then the company's own: add Angi and Thumbtack under the marketplace key, rename the van, archive the radio station you stopped buying. Archived channels keep their history.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ include: Include }),
  output: z.object({ channels: z.array(Channel) }),
});

export const listChannelOptions = defineRoute({
  method: "get",
  path: "/v1/marketing/channel-options",
  summary: "Live channels and their live tracking campaigns, for a lead source picker",
  description:
    "Readable by anybody who books work, because the person choosing a lead source on a new job is a CSR and does not read the marketing report. Names only: what a channel cost is not here.",
  module: "M19",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({
    channels: z.array(Channel.extend({
      campaigns: z.array(z.object({ id: Uuid, name: z.string() })),
    })),
  }),
});

export const createChannel = defineRoute({
  method: "post",
  path: "/v1/marketing/channels",
  summary: "Add a channel",
  description:
    "A name the office will recognise and the catalogue key it is a kind of. The key is required, because a channel nothing rolls up from is a text column again, one table along. Two live channels with one name are refused.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({ name: z.string().min(1).max(80), sourceKey: z.string().min(1).max(50) }),
  output: Channel,
});

export const updateChannel = defineRoute({
  method: "patch",
  path: "/v1/marketing/channels/{id}",
  summary: "Rename, remap or archive a channel",
  description:
    "Changing the key moves the channel's history with it in the roll up, and the tracking numbers on it follow. Archived rather than deleted, because last year's jobs still came from it.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(80).optional(),
    sourceKey: z.string().min(1).max(50).optional(),
    archived: z.boolean().optional(),
  }),
  output: Channel,
});

export const listTrackingCampaigns = defineRoute({
  method: "get",
  path: "/v1/marketing/tracking-campaigns",
  summary: "The tracking campaigns, with how many numbers each has",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ channelId: Uuid.optional(), include: Include }),
  output: z.object({ campaigns: z.array(TrackingCampaign.extend({ numbers: z.number().int() })) }),
});

export const getTrackingCampaign = defineRoute({
  method: "get",
  path: "/v1/marketing/tracking-campaigns/{id}",
  summary: "One tracking campaign, its numbers and what has been recorded against it",
  description:
    "Each number comes with its inbound calls in the last ninety days, so one still being paid for that nobody rings is visible on the page where somebody decides whether to keep it.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ id: Uuid }),
  output: TrackingCampaign.extend({
    numbers: z.array(z.object({
      id: Uuid, e164: z.string(), label: z.string().nullable(), calls: z.number().int(),
    })),
    recordedSpend: MoneyString,
  }),
});

const CampaignFields = {
  name: z.string().min(1).max(120),
  startsOn: z.string().date().nullable().optional(),
  endsOn: z.string().date().nullable().optional(),
  costModel: CostModel.optional(),
  costAmount: MoneyString.nullable().optional(),
  budget: MoneyString.nullable().optional(),
  utmCampaign: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
};

export const createTrackingCampaign = defineRoute({
  method: "post",
  path: "/v1/marketing/tracking-campaigns",
  summary: "Start a tracking campaign under a channel",
  description:
    "A fixed price needs both dates, because it is spread over them; a price per lead needs the price; a campaign costed by what is recorded has no price of its own. A utm tag is lower cased and must be unique among live campaigns, so a click carrying it is credited here without anybody matching it by hand.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({ channelId: Uuid, ...CampaignFields }),
  output: TrackingCampaign,
});

export const updateTrackingCampaign = defineRoute({
  method: "patch",
  path: "/v1/marketing/tracking-campaigns/{id}",
  summary: "Change or archive a tracking campaign",
  description:
    "Checked as a whole after the change, so switching to a fixed price on a campaign with no end date is refused. Moving it to another channel moves its numbers with it.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    channelId: Uuid.optional(),
    ...CampaignFields,
    name: CampaignFields.name.optional(),
    archived: z.boolean().optional(),
  }),
  output: TrackingCampaign,
});

export const MarketingSettings = z.object({
  /** The model every marketing figure uses until a reader picks another. */
  attributionModel: AttributionModel,
  /** Whether every new customer and job must say where it came from. */
  requireLeadSource: z.boolean(),
});

export const getMarketingSettings = defineRoute({
  method: "get",
  path: "/v1/marketing/settings",
  summary: "The company's attribution model, and whether a lead source is required",
  module: "M19",
  permissions: ["job:read"],
  input: z.object({}),
  output: MarketingSettings,
});

export const setMarketingSettings = defineRoute({
  method: "patch",
  path: "/v1/marketing/settings",
  summary: "Choose the attribution model, or require a lead source on new work",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: MarketingSettings.partial(),
  output: MarketingSettings,
});

/* ------------------------------------------------------------- the funnel */

const Dimension = z.enum(["channel", "campaign", "number"]);
const Measure = z.enum([
  "spend", "calls", "answered", "missed", "firstTime", "leads", "booked", "completed", "revenue",
]);

export const FunnelCells = z.object({
  spend: MoneyString,
  calls: z.number().int(),
  answered: z.number().int(),
  missed: z.number().int(),
  firstTime: z.number().int(),
  /** Distinct people: the customer, else the number that rang, else the browser. */
  leads: z.number().int(),
  /** Credited booked jobs as a person reads them, "3" or "1.5" under a split model. */
  booked: z.string(),
  /** The same in ten thousandths of a job, for anything that adds them up. */
  bookedWeight: z.number().int(),
  completed: z.string(),
  completedWeight: z.number().int(),
  /** Invoiced revenue: the ledger's revenue on the job, net of discounts and credits, without tax. */
  revenue: MoneyString,
  /** Null wherever the denominator is empty. Never zero for "unknown". */
  bookingRate: RateString.nullable(),
  averageTicket: MoneyString.nullable(),
  costPerLead: MoneyString.nullable(),
  costPerBookedJob: MoneyString.nullable(),
  /** (revenue minus spend) over spend, as a percentage. */
  roi: RateString.nullable(),
  /** Revenue over spend. */
  roas: RateString.nullable(),
});

const FunnelQuery = {
  from: z.string().date(),
  to: z.string().date(),
  by: Dimension,
  /** Omit for the company's own model. */
  model: AttributionModel.optional(),
};

export const getMarketingFunnel = defineRoute({
  method: "get",
  path: "/v1/marketing/funnel",
  summary: "Spend, calls, leads, booked jobs, revenue and return, by channel, campaign or number",
  description:
    "Every cell is the size of a list of rows that `GET /v1/marketing/funnel/rows` returns, computed by the same code, so a figure can always be opened and counted. Booked jobs are the jobs created in the range, each credited across its own touches under the model, so a split model puts half a job on two rows and the halves add back to one; a job nothing was recorded for is on a row called not attributed, never on direct. Leads are people with a touch in the range. A customer who rang in March and booked in April is a March lead and an April job, which is why a booking rate on a short range can pass a hundred per cent and is reported rather than refused.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object(FunnelQuery),
  output: z.object({
    from: z.string(),
    to: z.string(),
    by: Dimension,
    model: AttributionModel,
    modelLabel: z.string(),
    /** What the model is wrong about. Shown beside the figures, always. */
    modelWrongAbout: z.string(),
    rows: z.array(FunnelCells.extend({
      /** A channel, tracking campaign or phone number id, or `none`. */
      key: z.string(),
      label: z.string(),
      detail: z.string().nullable(),
    })),
    total: FunnelCells,
  }),
});

export const drillMarketingFunnel = defineRoute({
  method: "get",
  path: "/v1/marketing/funnel/rows",
  summary: "The calls, people, jobs or spend lines behind one cell of the funnel",
  description:
    "`key` is a row's key, or `all` for the total row. The rows are taken from the same buckets the cell was summed from, so they add up to it: calls and people count to it, jobs' shares and revenue sum to it, and spend lines sum to it.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ ...FunnelQuery, key: z.string().min(1).max(64), measure: Measure }),
  output: z.object({
    key: z.string(),
    label: z.string(),
    measure: Measure,
    model: AttributionModel,
    cell: FunnelCells,
    kind: z.enum(["calls", "leads", "jobs", "spend"]),
    calls: z.array(z.object({
      callId: Uuid, startedAt: z.string(), from: z.string(), receivedOn: z.string().nullable(),
      status: z.string(), outcome: z.string(), outcomeLabel: z.string(),
      answered: z.boolean(), missed: z.boolean(), firstTime: z.boolean().nullable(),
      durationSeconds: z.number().int().nullable(),
      customerId: Uuid.nullable(), customerName: z.string().nullable(), jobId: Uuid.nullable(),
    })).optional(),
    leads: z.array(z.object({
      key: z.string(), customerId: Uuid.nullable(), customerName: z.string().nullable(),
      callerE164: z.string().nullable(), firstAt: z.string(), touches: z.number().int(),
    })).optional(),
    jobs: z.array(z.object({
      jobId: Uuid, number: z.number().int(), summary: z.string(),
      customerId: Uuid, customerName: z.string().nullable(),
      createdAt: z.string(), status: z.string(), completed: z.boolean(),
      /** This row's share of the job. */
      share: z.string(), weight: z.number().int(), revenue: MoneyString,
    })).optional(),
    spend: z.array(z.object({
      kind: z.enum(["recorded", "fixed", "per_lead"]),
      spendId: Uuid.nullable(), campaignId: Uuid.nullable(), spentOn: z.string().nullable(),
      label: z.string(), amount: MoneyString, note: z.string().nullable(),
    })).optional(),
  }),
});

/* ------------------------------------------------------------- the calls */

export const MarketingCall = z.object({
  id: Uuid,
  startedAt: z.string(),
  from: z.string(),
  receivedOn: z.string().nullable(),
  channelId: Uuid.nullable(),
  channelName: z.string().nullable(),
  campaignId: Uuid.nullable(),
  campaignName: z.string().nullable(),
  status: z.string(),
  durationSeconds: z.number().int().nullable(),
  firstTimeCaller: z.boolean().nullable(),
  /** Core's call outcome, from the facts rather than a status somebody picked. */
  outcome: z.string(),
  outcomeLabel: z.string(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
  jobId: Uuid.nullable(),
});

export const listMarketingCalls = defineRoute({
  method: "get",
  path: "/v1/marketing/calls",
  summary: "Inbound calls, with the number, campaign, channel and what each amounted to",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    from: z.string().date(),
    to: z.string().date(),
    numberId: Uuid.optional(),
    campaignId: Uuid.optional(),
    channelId: Uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    /**
     * Words said on the call, searched in its redacted transcript, or digits
     * of the number that rang. "water heater" finds the call where somebody
     * said the water heater is leaking.
     */
    q: z.string().max(200).optional(),
  }),
  output: z.object({
    calls: z.array(MarketingCall.extend({
      numberLabel: z.string().nullable(), outcomeWhy: z.string(),
      /** The line of the transcript that matched a search, when there was one. */
      transcriptMatch: z.string().nullable(),
    })),
  }),
});

export const getMarketingCall = defineRoute({
  method: "get",
  path: "/v1/marketing/calls/{id}",
  summary: "One inbound call",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ id: Uuid }),
  output: MarketingCall.extend({
    /** Whether this product keeps the call's recording, or a voicemail, to play. */
    hasRecording: z.boolean(),
    hasVoicemail: z.boolean(),
    /** Why a call to one of the company's own numbers went where it went. */
    routedBecause: z.string().nullable(),
    /** Why nothing was recorded, when recording was asked for and refused. */
    recordingRefusal: z.string().nullable(),
    /** What the caller pressed in each phone menu on the way, in order. */
    menuChoices: z.array(z.object({ menu: z.string(), key: z.string().nullable(), label: z.string(), at: z.string() })),
    /**
     * The words of the recording or voicemail, already redacted, one line
     * per stretch of speech with its time into the audio. Empty when there
     * is none.
     */
    transcript: z.array(z.object({ at: z.string(), speaker: z.string(), text: z.string(), startMs: z.number().int() })),
    /** `pending`, `working`, `done`, `failed` or null, with the reason when it failed. */
    transcriptStatus: z.string().nullable(),
    transcriptError: z.string().nullable(),
    transcriptSource: z.string().nullable(),
    /** How many card numbers and the like were taken out, by kind. */
    transcriptRedactions: z.record(z.string(), z.number().int()),
    /** False when the speech to text was unsure enough that somebody should listen before acting on it. */
    transcriptReliable: z.boolean().nullable(),
  }),
});

/* --------------------------------------------------------------- spend */

export const listSpend = defineRoute({
  method: "get",
  path: "/v1/marketing/spend",
  summary: "Spend rows over a range, newest day first",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ from: z.string().date(), to: z.string().date() }),
  output: z.object({
    spend: z.array(z.object({
      id: Uuid, spentOn: z.string(), source: z.string(),
      channelId: Uuid.nullable(), channelName: z.string().nullable(),
      campaignId: Uuid.nullable(), campaignName: z.string().nullable(),
      label: z.string().nullable(), amount: MoneyString, origin: z.string(),
    })),
  }),
});

export const removeSpend = defineRoute({
  method: "delete",
  path: "/v1/marketing/spend-rows/{id}",
  summary: "Take out a spend row typed against the wrong day or campaign",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

/* ------------------------------------------------------ tracking numbers */

export const listTrackingNumbers = defineRoute({
  method: "get",
  path: "/v1/marketing/tracking-numbers",
  summary: "Every tracking number, its campaign and channel, and its calls in the last ninety days",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({}),
  output: z.object({
    numbers: z.array(z.object({
      id: Uuid, e164: z.string(), label: z.string().nullable(), source: z.string().nullable(),
      campaignId: Uuid.nullable(), channelId: Uuid.nullable(), calls: z.number().int(),
    })),
  }),
});

export const assignTrackingNumber = defineRoute({
  method: "patch",
  path: "/v1/marketing/tracking-numbers/{id}",
  summary: "Put a tracking number on a campaign or a channel",
  description:
    "The campaign implies the channel and the channel implies the lead source key the number map reads, so all three are written together. Calls already taken keep the campaign they arrived under.",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    campaignId: Uuid.nullable().optional(),
    channelId: Uuid.nullable().optional(),
    label: z.string().max(100).nullable().optional(),
  }),
  output: z.object({
    id: Uuid, e164: z.string(), label: z.string().nullable(), purpose: z.string(),
    attributionSource: z.string().nullable(), channelId: Uuid.nullable(), campaignId: Uuid.nullable(),
  }),
});

export const acquisitionRoutes = {
  listChannels, listChannelOptions, createChannel, updateChannel,
  listTrackingCampaigns, getTrackingCampaign, createTrackingCampaign, updateTrackingCampaign,
  getMarketingSettings, setMarketingSettings,
  getMarketingFunnel, drillMarketingFunnel, listMarketingCalls, getMarketingCall,
  listSpend, removeSpend, listTrackingNumbers, assignTrackingNumber,
} as const;
