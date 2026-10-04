import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THE AD PLATFORMS: SIGNING IN, PULLING AND SENDING
 *
 * Google Ads, Local Services, Meta, Google Analytics and the Business Profile
 * are connected through `POST /v1/connectors/{provider}` like every other
 * integration, with settings and secret names. These routes are what an ad
 * platform needs beyond that: a person signing in on the platform's own
 * consent screen, the pulls and sends with their history, the map from the
 * platform's campaigns to the company's own, the record of every conversion
 * told to every platform, and the customer's own answer about whether their
 * details may be used to measure advertising.
 *
 * Every one of these platforms needs its own developer approval before any
 * of it moves real data (a Google Ads developer token, Meta app review, the
 * Business Profile API application), and the code behind these routes is
 * tested against fakes of each platform, not against live accounts.
 */

const Provider = z.string().min(1).max(50);

export const startConnectorSignIn = defineRoute({
  method: "post",
  path: "/v1/connectors/{provider}/authorize",
  summary: "Start a sign in with the platform, and get the address to send the person to",
  description:
    "The connection's settings must be saved first, with the name of the secret holding the OAuth client. Refused when this deployment has no CREDENTIAL_SEALING_KEY, because the grant that comes back would have nowhere safe to be kept, and a consent screen that ends in nothing being saved is a person granting access to nothing. The address is good for a quarter of an hour and for the person who asked.",
  module: "M25",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({ provider: Provider }),
  output: z.object({ url: z.string().url(), expiresAt: z.string().datetime() }),
});

export const finishConnectorSignIn = defineRoute({
  method: "post",
  path: "/v1/oauth/finish",
  summary: "Finish a sign in with what the platform sent the person back with",
  description:
    "Takes the state and the code from the return address, or the error when the person cancelled. The state is single use, expires, and belongs to the person who started it; anything else is refused. The grant is sealed under the deployment's key and the connection is connected. The platform's error words are passed through, never a token.",
  module: "M25",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    state: z.string().min(16).max(200),
    code: z.string().min(1).max(4000).optional(),
    error: z.string().max(200).optional(),
  }),
  output: z.object({ provider: z.string(), status: z.string(), accountLabel: z.string().nullable() }),
});

export const MarketingPlatform = z.object({
  provider: z.string(),
  label: z.string(),
  status: z.string(),
  accountLabel: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The sign in held here, without the grant. Null when nobody has signed in or the operator keeps their own token. */
  signedIn: z.object({
    grantedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    scopes: z.array(z.string()),
  }).nullable(),
  /** True when the connection uses a token from the deployment's own secret store instead. */
  ownCredential: z.boolean(),
  runs: z.array(z.object({
    entity: z.string(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    read: z.number().int(),
    written: z.number().int(),
    error: z.string().nullable(),
  })),
  campaigns: z.number().int(),
  unmapped: z.number().int(),
  /** Conversion sends by state. */
  sends: z.record(z.number().int()),
  notices: z.array(z.string()),
});

export const listMarketingPlatforms = defineRoute({
  method: "get",
  path: "/v1/marketing/platforms",
  summary: "Every connected ad platform, its last pulls and sends, and what it needs",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({}),
  output: z.object({ platforms: z.array(MarketingPlatform) }),
});

export const syncMarketingPlatform = defineRoute({
  method: "post",
  path: "/v1/marketing/platforms/{provider}/sync",
  summary: "Pull spend and leads and send conversions now, whatever the clock says",
  description:
    "The same pulls the worker runs on its cadence (spend every six hours, Local Services leads every ten minutes, conversions every quarter hour), run now, each recorded the same way. A Business Profile listing is fetched from the review screen instead, with `POST /v1/reviews/sync`.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({ provider: Provider }),
  output: z.object({
    provider: z.string(),
    runs: z.array(z.object({
      entity: z.string(), read: z.number().int(), written: z.number().int(),
      error: z.string().nullable(), needsSignIn: z.boolean(),
    })),
  }),
});

export const PlatformCampaign = z.object({
  id: Uuid,
  provider: z.string(),
  providerLabel: z.string(),
  accountId: z.string(),
  externalId: z.string(),
  name: z.string(),
  source: z.string(),
  /** The company's tracking campaign it is mapped to. */
  campaignId: Uuid.nullable(),
  campaignName: z.string().nullable(),
  /** `matched` when the names agreed, `person` when somebody chose, null while unmapped. */
  mappedBy: z.string().nullable(),
  lastSpentOn: z.string().nullable(),
});

export const listPlatformCampaigns = defineRoute({
  method: "get",
  path: "/v1/marketing/platform-campaigns",
  summary: "The platforms' campaigns, and which tracking campaign each is",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({}),
  output: z.object({ campaigns: z.array(PlatformCampaign) }),
});

export const mapPlatformCampaign = defineRoute({
  method: "patch",
  path: "/v1/marketing/platform-campaigns/{id}",
  summary: "Say which tracking campaign a platform's campaign is, or that it is none",
  description:
    "Every spend row already pulled for the platform campaign moves with it, because a mapping is a statement about the campaign and not about the day it was made. Null puts it back on the platform's own channel.",
  module: "M19",
  permissions: ["adspend:write"],
  input: z.object({ id: Uuid, campaignId: Uuid.nullable() }),
  output: z.object({ id: Uuid, campaignId: Uuid.nullable(), moved: z.number().int() }),
});

export const ConversionSend = z.object({
  id: Uuid,
  provider: z.string(),
  providerLabel: z.string(),
  kind: z.enum(["lead", "purchase"]),
  state: z.enum(["sending", "sent", "withheld", "refused", "failed"]),
  jobId: Uuid,
  jobNumber: z.number().int().nullable(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
  /** This platform's share of the job's revenue, for a purchase. */
  value: MoneyString.nullable(),
  currency: z.string().nullable(),
  /** What was sent, by name: click_id, email, phone, client_id, browser_id. Never the values. */
  identifiers: z.array(z.string()),
  withheldReason: z.string().nullable(),
  /** Ours for a withheld send, the platform's own words for a refused one. */
  detail: z.string().nullable(),
  attempts: z.number().int(),
  sentAt: z.string().datetime().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const listConversionSends = defineRoute({
  method: "get",
  path: "/v1/marketing/conversion-sends",
  summary: "Every conversion told to every platform, and every one that was not, with why",
  description:
    "One row per job, per platform, per kind, which is what makes a job impossible to report twice. A withheld row is a decision made here (the customer said no, nothing to match on, no credit under the company's model); a refused row is the platform's, in its words.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({
    state: z.enum(["sending", "sent", "withheld", "refused", "failed"]).optional(),
    provider: z.string().max(50).optional(),
    jobId: Uuid.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({ sends: z.array(ConversionSend) }),
});

export const retryConversionSend = defineRoute({
  method: "post",
  path: "/v1/marketing/conversion-sends/{id}/retry",
  summary: "Try a refused, failed or withheld send again, decided afresh",
  description:
    "Consent and value are decided again on the next pass. A send that reached the platform is refused, because sending it again would count the job twice.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, state: z.string() }),
});

export const AdData = z.object({
  customerId: Uuid,
  /** Null for a customer never asked, which the company's setting on each connection decides for. */
  choice: z.enum(["granted", "refused"]).nullable(),
  method: z.string().nullable(),
  proofText: z.string().nullable(),
  capturedAt: z.string().datetime().nullable(),
  history: z.array(z.object({
    choice: z.string(), method: z.string(), capturedAt: z.string().datetime(), supersededAt: z.string().datetime().nullable(),
  })),
});

export const getCustomerAdData = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/ad-data",
  summary: "Whether this customer's details may be used to measure advertising",
  module: "M19",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: AdData,
});

export const setCustomerAdData = defineRoute({
  method: "put",
  path: "/v1/customers/{id}/ad-data",
  summary: "Record what the customer said about their details and advertising",
  description:
    "A separate question from whether they may be texted or emailed. A no stops every future send about them to every platform, including the click id; what already went cannot be called back. Superseding, never editing: the earlier answer stays with who recorded it.",
  module: "M19",
  permissions: ["customer:write"],
  input: z.object({
    id: Uuid,
    choice: z.enum(["granted", "refused"]),
    method: z.enum(["verbal", "written", "web_form", "api"]).optional(),
    proofText: z.string().max(2000).optional(),
  }),
  output: AdData,
});

export const confirmReviewMatch = defineRoute({
  method: "post",
  path: "/v1/reviews/{id}/match",
  summary: "Say whether the suggested customer really wrote this review",
  description:
    "A review read from a listing is suggested a customer when the name and a recently finished job fit, and nothing ties it to that customer until a person says yes here. No clears the suggestion and it is not offered again.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({ id: Uuid, accept: z.boolean() }),
  output: z.object({ id: Uuid, customerId: Uuid.nullable(), jobId: Uuid.nullable() }),
});

export const syncReviews = defineRoute({
  method: "post",
  path: "/v1/reviews/sync",
  summary: "Read the connected listings' reviews and post the replies waiting, now",
  description:
    "The same read the worker makes every hour. Reviews arrive through the reviews module's own record, so the recovery clock and the work list are the same either way. Needs a review policy, as every recorded review does.",
  module: "M20",
  permissions: ["review:respond"],
  idempotent: true,
  input: z.object({}),
  output: z.object({
    listings: z.array(z.object({
      provider: z.string(), read: z.number().int(), written: z.number().int(), error: z.string().nullable(),
    })),
  }),
});


export const ConversionAdjustment = z.object({
  id: Uuid,
  provider: z.string(),
  providerLabel: z.string(),
  jobId: Uuid,
  jobNumber: z.number().int().nullable(),
  /** Its place in line among the adjustments to the same purchase. */
  sequence: z.number().int(),
  /** `restatement`, `retraction` (Google), `increase` (Meta) or `cannot_lower` (a decrease Meta cannot be told). */
  kind: z.string(),
  previousValue: MoneyString,
  newValue: MoneyString,
  /** What was sent: the new value, the increase, or nothing for a retraction. */
  sentValue: MoneyString.nullable(),
  state: z.enum(["sending", "sent", "withheld", "refused", "failed"]),
  detail: z.string().nullable(),
  attempts: z.number().int(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const listConversionAdjustments = defineRoute({
  method: "get",
  path: "/v1/marketing/conversion-adjustments",
  summary: "Every paid job told again because its revenue changed after it was sent",
  description:
    "A credit note or a second invoice after a purchase was sent changes what the job was worth to the platform. Google Ads is sent a restatement to the new value (a retraction when nothing is left), against the order id the conversion carried. Meta cannot change a value it was sent, so an increase goes as a second purchase carrying only the difference, and a decrease is written down here as withheld with that reason. Each change is recorded once: a pass that finds the value unchanged writes nothing.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ jobId: Uuid.optional(), limit: z.number().int().min(1).max(500).optional() }),
  output: z.object({ adjustments: z.array(ConversionAdjustment) }),
});

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const getMarketingOverview = defineRoute({
  method: "get",
  path: "/v1/marketing/overview",
  summary: "Sessions and searches from Google, beside the leads, booked jobs and revenue each source brought",
  description:
    "Sessions by source from Google Analytics 4 reports and search queries from Search Console, each read twice a day once connected, beside the funnel's leads, booked jobs and revenue for the same days, filed under the same lead source keys. Sessions are Google's count of visits and are never matched one to one with leads; the comparison is leads per hundred sessions.",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({ from: IsoDay, to: IsoDay }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    model: z.string(),
    modelLabel: z.string(),
    rows: z.array(z.object({
      source: z.string(),
      label: z.string(),
      channels: z.array(z.string()),
      sessions: z.number().int(),
      engagedSessions: z.number().int(),
      leads: z.number().int(),
      booked: z.string(),
      revenue: MoneyString,
      leadsPer100Sessions: z.string().nullable(),
    })),
    totals: z.object({
      sessions: z.number().int(),
      engagedSessions: z.number().int(),
      leads: z.number().int(),
      booked: z.string(),
      revenue: MoneyString,
      searchClicks: z.number().int(),
      searchImpressions: z.number().int(),
    }),
    queries: z.array(z.object({
      query: z.string(), clicks: z.number().int(), impressions: z.number().int(), position: z.string().nullable(),
    })),
    sources: z.array(z.object({
      provider: z.string(),
      label: z.string(),
      status: z.string().nullable(),
      lastPulledAt: z.string().datetime().nullable(),
      lastError: z.string().nullable(),
    })),
  }),
});

export const adsRoutes = {
  startConnectorSignIn, finishConnectorSignIn, listMarketingPlatforms, syncMarketingPlatform,
  listPlatformCampaigns, mapPlatformCampaign, listConversionSends, retryConversionSend,
  getCustomerAdData, setCustomerAdData, confirmReviewMatch, syncReviews,
  listConversionAdjustments, getMarketingOverview,
} as const;
