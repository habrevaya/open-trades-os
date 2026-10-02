import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M19 COULD MEASURE A CHANNEL AND COULD NOT USE ONE
 *
 * Every route in `marketing.ts` is about traffic somebody else sent: a touch
 * arrives, it is credited, and at the end of the quarter an owner learns what
 * a channel cost per booked job. The list a trades company owns outright could
 * not be contacted from this product. `campaign:read` and `campaign:write`
 * were granted to the owner and the marketing manager from the first migration
 * and checked by nothing.
 *
 * The unsubscribe routes at the bottom are the other half, and they are not a
 * nicety: `email.queue` has refused every marketing email without an
 * unsubscribe URL since it was written, and this product served no page to
 * point one at.
 */

/* ----------------------------------------------------------- the audience */

/**
 * NINE RULES, A CLOSED SET, AND NO FREE FORM QUERY.
 *
 * A query builder here would be an injection surface against a database where
 * row level security is the only thing between two companies' customer lists,
 * an unbounded test matrix, and an audience nobody can explain back to the
 * person about to spend money on it. Each rule below knows how to describe
 * itself in a sentence, which is what `audienceInWords` returns.
 */
export const AudienceRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_job_since"), days: z.number().int().min(1).max(7300) }),
  z.object({
    kind: z.literal("equipment_older_than"),
    years: z.number().int().min(1).max(50),
    category: z.string().min(1).max(100).optional(),
  }),
  z.object({ kind: z.literal("agreement_ending_within"), days: z.number().int().min(1).max(7300) }),
  z.object({ kind: z.literal("agreement_lapsed") }),
  z.object({ kind: z.literal("no_agreement") }),
  z.object({ kind: z.literal("postal_code_in"), codes: z.array(z.string().min(1).max(20)).min(1).max(200) }),
  z.object({ kind: z.literal("tagged_any"), tags: z.array(z.string().min(1).max(100)).min(1).max(200) }),
  z.object({ kind: z.literal("open_deficiency") }),
  z.object({ kind: z.literal("served_at_least_once") }),
]);

export const CampaignChannel = z.enum(["sms", "email"]);
export const CampaignState = z.enum(["draft", "scheduled", "sending", "sent", "cancelled"]);
export const RecipientState = z.enum(["pending", "queued", "skipped"]);

const Result = z.object({
  selected: z.number().int(),
  queued: z.number().int(),
  skipped: z.number().int(),
  /** Reason to count. The worklist for the office, not diagnostics. */
  skippedBy: z.record(z.number().int()),
});

const CampaignView = z.object({
  id: Uuid,
  name: z.string(),
  channel: CampaignChannel,
  state: CampaignState,
  audience: z.array(z.record(z.unknown())),
  /** The rules as one sentence, for the confirmation screen. */
  audienceInWords: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  utmCampaign: z.string(),
  messagingCampaignId: Uuid.nullable(),
  scheduledFor: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  createdAt: z.string(),
  result: Result,
});

export const createCampaign = defineRoute({
  method: "post",
  path: "/v1/campaigns",
  summary: "Write a campaign to part of the customer list",
  description:
    "The audience is a closed set of nine rules combined with AND, never a free form query: a query builder here is an injection surface against a database where row level security is the only thing between two companies' lists, and it produces audiences nobody can explain back to the person about to pay for them. An empty rule list is refused outright, because no rules means every customer, which is how a company's sending number gets flagged and its domain blocked in one afternoon. An SMS campaign carrying a subject line is refused rather than silently dropping it.",
  module: "M19",
  permissions: ["campaign:write"],
  /**
   * A retry on a flaky connection must not produce two campaigns to the same
   * audience. The unique index on `(organization, utm_campaign)` where neither
   * deleted nor cancelled is the backstop, and it is why the second POST is a
   * refusal rather than a duplicate.
   */
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    channel: CampaignChannel,
    audience: z.array(AudienceRule),
    body: z.string().min(1).max(20000),
    subject: z.string().max(300).nullable().optional(),
    /** Defaulted from the name. Two fields that must agree are two spellings in a report. */
    utmCampaign: z.string().min(1).max(100).optional(),
    /** The registered carrier campaign, on SMS. Its throughput is what the send paces against. */
    messagingCampaignId: Uuid.nullable().optional(),
  }),
  output: CampaignView,
});

export const updateCampaign = defineRoute({
  method: "patch",
  path: "/v1/campaigns/{id}",
  summary: "Change a campaign that has not gone out",
  description:
    "Editable only while it is a draft or scheduled. The body of a sent campaign is what is in four thousand inboxes, and a record of it that somebody can edit afterwards is not a record of anything. Setting a date schedules it; clearing the date puts it back to draft, which is one field rather than two ways to say the same thing.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    audience: z.array(AudienceRule).optional(),
    body: z.string().min(1).max(20000).optional(),
    subject: z.string().max(300).nullable().optional(),
    scheduledFor: z.string().datetime().nullable().optional(),
    messagingCampaignId: Uuid.nullable().optional(),
  }),
  output: CampaignView,
});

export const cancelCampaign = defineRoute({
  method: "post",
  path: "/v1/campaigns/{id}/cancel",
  summary: "Stop a campaign",
  description:
    "Stops what has not gone. What already went stays queued, because a text handed to a carrier is gone and a record saying otherwise is a record of what somebody wished had happened.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().max(500).optional() }),
  output: CampaignView,
});

export const deleteCampaign = defineRoute({
  method: "delete",
  path: "/v1/campaigns/{id}",
  summary: "Throw a draft away",
  description:
    "Drafts only, and refused when any recipient row exists. A campaign that has sent anything is cancelled rather than deleted, because the record of what a company sent to real people is not something a state column should be able to authorise removing. Soft, so the partial unique index on the utm value lets the name be reused; without this operation one abandoned draft would hold a campaign name forever.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.boolean() }),
});

export const getCampaign = defineRoute({
  method: "get",
  path: "/v1/campaigns/{id}",
  summary: "One campaign, with its counts",
  description:
    "Sent, skipped and the reasons are derived from the recipient rows on every read rather than kept on the campaign, for the same reason a stock level is derived: a stored total is a number somebody can edit into agreement with what they hoped for, and this is the total an owner is judging a spend against.",
  module: "M19",
  permissions: ["campaign:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: CampaignView,
});

export const listCampaigns = defineRoute({
  method: "get",
  path: "/v1/campaigns",
  summary: "Campaigns, newest first",
  description: "Filterable by state, so a dashboard can show what is scheduled without the archive.",
  module: "M19",
  permissions: ["campaign:read"],
  idempotent: true,
  input: z.object({
    state: CampaignState.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ data: z.array(CampaignView) }),
});

export const previewCampaign = defineRoute({
  method: "post",
  path: "/v1/campaigns/preview",
  summary: "Who this would reach, without sending",
  description:
    "Returns a count, the audience as a sentence, the pacing a carrier's daily cap imposes, and a SAMPLE OF NAMES. The names are the point: a count is only checkable against an expectation the owner already has, and 'why is my commercial account in a homeowner tune up offer' is a question somebody can only ask if they can see who is in the list. Takes a saved campaign's id, or a channel and an audience to try before saving one.",
  module: "M19",
  permissions: ["campaign:read"],
  idempotent: true,
  input: z.object({
    id: Uuid.optional(),
    channel: CampaignChannel.optional(),
    audience: z.array(AudienceRule).optional(),
    sample: z.number().int().min(0).max(100).optional(),
  }),
  output: z.object({
    count: z.number().int(),
    /** True when the rules matched more than one campaign will take. */
    overflow: z.boolean(),
    inWords: z.string(),
    pace: z.object({
      firstBatch: z.number().int(),
      days: z.number().int(),
      secondsBetween: z.number().nullable(),
      staged: z.boolean(),
    }),
    sample: z.array(z.object({ customerId: Uuid, name: z.string(), address: z.string() })),
  }),
});

export const sendCampaign = defineRoute({
  method: "post",
  path: "/v1/campaigns/{id}/send",
  summary: "Hand this campaign's next batch to the outbox",
  description:
    "One batch per call and safe to repeat. A campaign under a carrier's declared daily cap sends that many and leaves the rest pending; the next call takes the next batch. Every recipient gets a row INCLUDING the ones it will not send to, with the reason on it, because filtering the unreachable out before the list is stored is how a company comes to believe it sent four thousand texts when it sent nine hundred. Consent, suppression and quiet hours are all checked per recipient at send time, never at write time.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** The instant to judge quiet hours against. Defaults to now. */
    at: z.string().datetime().optional(),
  }),
  output: z.object({
    campaignId: Uuid,
    state: CampaignState,
    selected: z.number().int(),
    queued: z.number().int(),
    skipped: z.number().int(),
    skippedBy: z.record(z.number().int()),
    remaining: z.number().int(),
  }),
});

export const campaignRecipients = defineRoute({
  method: "get",
  path: "/v1/campaigns/{id}/recipients",
  summary: "Who it went to, and who it did not",
  description:
    "The skipped list is the useful half. Every row on it reading no_consent is a customer whose number this company holds and may not text, which is a worklist for the office rather than a statistic: ask at the next visit and the next campaign is that much bigger. The refusal comes back as a sentence as well as an identifier.",
  module: "M19",
  permissions: ["campaign:read"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    state: RecipientState.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({
    data: z.array(z.object({
      id: Uuid,
      customerId: Uuid,
      customerName: z.string().nullable(),
      address: z.string(),
      state: RecipientState,
      skipReason: z.string().nullable(),
      skipExplanation: z.string().nullable(),
      messageId: Uuid.nullable(),
      queuedAt: z.string().nullable(),
    })),
  }),
});

export const campaignResults = defineRoute({
  method: "get",
  path: "/v1/campaigns/{id}/results",
  summary: "What the campaign brought back",
  description:
    "Replies, opt outs, jobs and revenue. The job and revenue figures join through job.campaign_id, a column that has been on the job table since the first migration with no foreign key, written by nothing and read by nothing until now. NO CONVERSION RATE IS RETURNED, and that is deliberate: jobs divided by recipients is a figure whose numerator is attributed under whichever model the reader has not chosen, and quoting one here would make this answer differ from the attribution report's answer for the same campaign. The counts are facts; what share of them the campaign caused is what compareModels exists for, with the model named.",
  module: "M19",
  permissions: ["campaign:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    campaign: CampaignView.omit({ result: true }),
    result: Result,
    reachRate: z.string().nullable(),
    replies: z.number().int(),
    optOuts: z.number().int(),
    jobs: z.number().int(),
    revenue: z.string(),
  }),
});

/* ------------------------------------------------------------ unsubscribe */

const UnsubscribeView = z.object({
  known: z.boolean(),
  /** Masked. The holder knows their own address; a forwarded link reaches somebody who does not. */
  address: z.string().nullable(),
  company: z.string().nullable(),
  done: z.boolean(),
  message: z.string(),
});

export const describeUnsubscribe = defineRoute({
  method: "get",
  path: "/v1/public/unsubscribe/{token}",
  summary: "What this unsubscribe link is about",
  description:
    "WRITES NOTHING, and that asymmetry with the POST is the whole design. Every link prefetcher, corporate mail scanner, security product and chat preview follows URLs in inbound mail with a GET. If GET unsubscribed, a company's whole list would be opted out by software over a few months with no human having clicked anything. An unknown or expired token gets the same answer as one that never existed, so this cannot be used to test whether a token is live.",
  module: "M19",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({ token: z.string().min(16).max(200) }),
  output: UnsubscribeView,
});

export const confirmUnsubscribe = defineRoute({
  method: "post",
  path: "/v1/public/unsubscribe/{token}",
  summary: "Unsubscribe from marketing email",
  description:
    "RFC 8058 one click: this is what a mailbox provider POSTs when somebody presses the unsubscribe control Gmail draws next to the sender's name. Writes a suppression for email MARKETING and a consent revocation, never a blanket suppression: somebody who stops wanting promotions has not stopped wanting their invoice or their appointment confirmation, and reading unsubscribe as never-contact-again breaks the company's ability to do business with a customer who is still a customer. Idempotent, and a second press is answered with the same page rather than an error, because somebody clicking twice is somebody who is not sure it worked. There is no expiry, ever: telling somebody their unsubscribe link has expired sends them to the spam button, which costs the sending domain more than ten unsubscribes.",
  module: "M19",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({ token: z.string().min(16).max(200) }),
  output: UnsubscribeView,
});

export const campaignRoutes = {
  createCampaign,
  updateCampaign,
  cancelCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  previewCampaign,
  sendCampaign,
  campaignRecipients,
  campaignResults,
  describeUnsubscribe,
  confirmUnsubscribe,
} as const;
