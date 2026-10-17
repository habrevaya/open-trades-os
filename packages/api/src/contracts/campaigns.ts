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
/** `held` is kept back from a test for a person to send the winner to, and sent nothing yet. */
export const RecipientState = z.enum(["pending", "queued", "skipped", "held"]);
const Variant = z.enum(["a", "b", "c", "d"]);

const Result = z.object({
  selected: z.number().int(),
  queued: z.number().int(),
  skipped: z.number().int(),
  /** Reason to count. The worklist for the office, not diagnostics. */
  skippedBy: z.record(z.number().int()),
  /** Kept back from a test for the winner, and sent nothing yet. */
  held: z.number().int().optional(),
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
  /** Version B of an A/B test, or null when the campaign is not one. */
  variantBBody: z.string().nullable(),
  variantBSubject: z.string().nullable(),
  /** Versions C and D, each only when the one before it exists. */
  variantCBody: z.string().nullable(),
  variantCSubject: z.string().nullable(),
  variantDBody: z.string().nullable(),
  variantDSubject: z.string().nullable(),
  /** Each version's share of the list in whole percent, A first. Null is an even split. */
  variantShares: z.array(z.number().int()).nullable(),
  /** How many versions: 1 with no test, up to 4. */
  versions: z.number().int(),
  /** The split as a sentence, or null with no test. */
  splitInWords: z.string().nullable(),
  abTest: z.boolean(),
  /** The part of the list kept back from the test for the winner, in whole percent, or null for none. */
  holdBackShare: z.number().int().nullable(),
  /** The hold back as a sentence, or null with none. */
  holdBackInWords: z.string().nullable(),
  /** The version a person chose to send the held back part, once they have. */
  restVersion: Variant.nullable(),
  /** True when that version had won the test; false when nothing won and version A was sent. */
  restWasWinner: z.boolean().nullable(),
  restStartedAt: z.string().nullable(),
  restFinishedAt: z.string().nullable(),
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
    /**
     * The words, with merge fields in the message templates' own syntax:
     * {{ customer.firstName }}, {{ customer.name }}, {{ company.name }},
     * {{ company.phone }} and {{ campaign.utm }}. Anything else is refused, because the renderer
     * turns an unknown field into nothing and "Hi ," would go to everybody.
     * Optional only when `templateCode` is given.
     */
    body: z.string().min(1).max(20000).optional(),
    subject: z.string().max(300).nullable().optional(),
    /**
     * A message template (M18) on the same channel to start from. Its words
     * are copied in, so editing the template later does not change what this
     * campaign says it sent.
     */
    templateCode: z.string().min(1).max(64).optional(),
    /**
     * The second version of an A/B test. Given, the audience is split in two by
     * a stable hash of the customer id and the campaign id, and each half gets
     * one version. An email's version B with no subject of its own is sent
     * under version A's. {{ campaign.utm }} in either body writes the campaign's
     * link tag and the version, so a click says which version it came from.
     */
    variantBBody: z.string().min(1).max(20000).optional(),
    variantBSubject: z.string().max(300).nullable().optional(),
    /**
     * A third and a fourth version, each needing the one before it. Every
     * version is checked as version A is and must say something none of the
     * others says.
     */
    variantCBody: z.string().min(1).max(20000).optional(),
    variantCSubject: z.string().max(300).nullable().optional(),
    variantDBody: z.string().min(1).max(20000).optional(),
    variantDSubject: z.string().max(300).nullable().optional(),
    /**
     * Each version's share of the list, whole percent, A first, adding up to
     * 100, each at least 5: [90, 10] sends nine in ten version A. Absent or
     * null is an even split. The split is still a stable hash of the campaign
     * and the customer, so the same person gets the same version every run.
     */
    variantShares: z.array(z.number().int().min(1).max(99)).min(2).max(4).nullable().optional(),
    /**
     * The part of the list kept back from the test, whole percent, 5 to 95,
     * on a campaign with a version B. Those people are sent nothing when the
     * test goes; once it is judged a person sends them the winner (or version
     * A when nothing won) with POST /v1/campaigns/{id}/rest. Absent, null or 0
     * holds nobody back, the default.
     */
    holdBackShare: z.number().int().min(0).max(100).nullable().optional(),
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
    /** Version B of an A/B test. Null takes the test off the campaign, and versions C and D with it. */
    variantBBody: z.string().min(1).max(20000).nullable().optional(),
    variantBSubject: z.string().max(300).nullable().optional(),
    /** Version C, and version D. Null takes that version off, and any after it. */
    variantCBody: z.string().min(1).max(20000).nullable().optional(),
    variantCSubject: z.string().max(300).nullable().optional(),
    variantDBody: z.string().min(1).max(20000).nullable().optional(),
    variantDSubject: z.string().max(300).nullable().optional(),
    /**
     * Each version's share, as on create. Null is an even split. Shares kept
     * from before must still fit the versions there are after the change, or
     * the change is refused rather than guessed at.
     */
    variantShares: z.array(z.number().int().min(1).max(99)).min(2).max(4).nullable().optional(),
    /** The part held back for the winner, as on create. Null holds nobody back; a test taken off with a hold back kept is refused. */
    holdBackShare: z.number().int().min(0).max(100).nullable().optional(),
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
    /** Words to render for the first person on the list, when trying a campaign before saving it. */
    body: z.string().max(20000).optional(),
    subject: z.string().max(300).nullable().optional(),
  }),
  output: z.object({
    /**
     * The message as the first person on the list will read it, merge fields
     * filled in by the renderer the send uses. Null when there are no words
     * to render yet.
     */
    rendered: z.object({
      for: z.string().nullable(),
      body: z.string(),
      subject: z.string().nullable(),
    }).nullable(),
    /** Version B as the same first person would read it, for a saved A/B test. Null otherwise. */
    renderedB: z.object({
      for: z.string().nullable(),
      body: z.string(),
      subject: z.string().nullable(),
    }).nullable(),
    /** Every version after A as the same first person would read it, B first. Empty with no test. */
    renderedVersions: z.array(z.object({
      version: z.enum(["b", "c", "d"]),
      for: z.string().nullable(),
      body: z.string(),
      subject: z.string().nullable(),
    })),
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
    /** Kept back from the test for the winner and sent nothing. */
    held: z.number().int(),
  }),
});

export const sendCampaignRest = defineRoute({
  method: "post",
  path: "/v1/campaigns/{id}/rest",
  summary: "Send the winner to the part of the list held back from the test",
  description:
    "Only a person does this, never the clock: whether a result is good enough to act on is the owner's call. Allowed once the test has all gone out (the campaign is sent). `version` must be what the test says now: the named winner, or version A when nothing won, so a page loaded before the counts moved cannot send a version that no longer won. The first call fixes the version on the campaign; later calls (the next batch under a carrier's daily cap) must name the same one. Consent, STOP replies, unsubscribes and quiet hours are checked again for every person at send time, and somebody who no longer fits the rules or whose address has changed is skipped with that reason. Inside quiet hours nothing is written and the call is refused. One batch per call and safe to repeat. Links in the message carry utm_content=rest, so the rest's clicks are never counted in the test that chose it.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** The version the person means to send. Refused unless it is the winner, or version A when nothing won. */
    version: Variant,
    /** The instant to judge quiet hours against. Defaults to now. */
    at: z.string().datetime().optional(),
  }),
  output: z.object({
    campaignId: Uuid,
    version: Variant,
    wasWinner: z.boolean(),
    queued: z.number().int(),
    skipped: z.number().int(),
    skippedBy: z.record(z.number().int()),
    /** Still held back, for the next batch when a carrier's daily cap stopped this one. */
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
      /** The version of an A/B test this person was given. `a` on a campaign with no test. */
      variant: z.enum(["a", "b", "c", "d"]),
      /** Kept back from the test for the winner. Their version is the one they were later sent, once they have been. */
      heldBack: z.boolean(),
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
    "Replies, opt outs, jobs and revenue, and for an A/B test the versions side by side: people sent, people who clicked, people who replied where replies are read back, and people who booked, with the counts for each version and a plain sentence on each. Every version after the first is compared with the first. A winner is named only when a two proportion test says the gap is more than luck explains, with the bar divided across every measure and every version compared; otherwise `winner` is null and the counts speak for themselves. The job and revenue figures join through job.campaign_id, a column that has been on the job table since the first migration with no foreign key, written by nothing and read by nothing until now. NO CONVERSION RATE IS RETURNED, and that is deliberate: jobs divided by recipients is a figure whose numerator is attributed under whichever model the reader has not chosen, and quoting one here would make this answer differ from the attribution report's answer for the same campaign. The counts are facts; what share of them the campaign caused is what compareModels exists for, with the model named.",
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
    /** Null unless the campaign has a version B. */
    abTest: z.object({
      versions: z.array(z.object({
        version: z.enum(["a", "b", "c", "d"]),
        /** This version's share of the list in whole percent, as chosen or as the even split gives it. */
        share: z.number().int(),
        label: z.string(),
        selected: z.number().int(),
        /** Queued to this version: the people who could have acted. */
        sent: z.number().int(),
        skipped: z.number().int(),
        /** People who arrived on the campaign's tag with this version's utm_content. */
        clicks: z.number().int(),
        /** Null when replies are not read back (an email with no reply domain). */
        replies: z.number().int().nullable(),
        /** Recipients of this version with a job credited to the campaign. */
        booked: z.number().int(),
        jobs: z.number().int(),
        revenue: z.string(),
      })),
      repliesKnown: z.boolean(),
      /** People who followed the link with no version on it: in neither column. */
      untaggedClicks: z.number().int(),
      measures: z.array(z.object({
        measure: z.enum(["clicks", "replies", "booked"]),
        label: z.string(),
        /** The version compared with version A on this measure. */
        against: z.enum(["b", "c", "d"]),
        /** `b_higher` means the version named in `against` did better than A. */
        verdict: z.enum(["no_data", "too_few", "no_clear_difference", "a_higher", "b_higher"]),
        rateA: z.string().nullable(),
        /** The rate of the version named in `against`. */
        rateB: z.string().nullable(),
        /** The chance a gap this big is luck. Null when no test could be run. */
        pValue: z.number().nullable(),
        sentence: z.string(),
      })),
      /** Null unless the difference is more than luck explains. */
      winner: z.enum(["a", "b", "c", "d"]).nullable(),
      headline: z.string(),
      /** The part held back from the test, never counted in it. Null when the campaign held nobody back. */
      rest: z.object({
        share: z.number().int(),
        /** Held back and sent nothing yet. */
        waiting: z.number().int(),
        sent: z.number().int(),
        skipped: z.number().int(),
        /** The version a person sent them, or null before anybody has. */
        version: Variant.nullable(),
        wasWinner: z.boolean().nullable(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        /** People who arrived on the campaign's tag with utm_content=rest. */
        clicks: z.number().int(),
        booked: z.number().int(),
        jobs: z.number().int(),
        revenue: z.string(),
        /** What may be sent to them now: the winner, or version A when nothing won. Null once a person has chosen. */
        offer: z.object({ version: Variant, won: z.boolean(), sentence: z.string() }).nullable(),
      }).nullable(),
    }).nullable(),
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
  sendCampaignRest,
  campaignRecipients,
  campaignResults,
  describeUnsubscribe,
  confirmUnsubscribe,
} as const;
