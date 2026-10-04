import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * NATIVE CALL TRACKING, THE WEBSITE SNIPPET AND REFERRALS
 *
 * Three pieces of M19 that measure what a company's own channels produce:
 * tracking numbers bought from its own carrier account and answered here, a
 * script on its own website that swaps numbers and records how visitors
 * arrived, and the referral links its customers share.
 *
 * The carrier's calls themselves arrive at `/api/webhooks/voice/{token}`,
 * beside the messaging webhook, because the caller is a carrier holding a
 * secret in a URL rather than a user holding a session.
 */

const NumberRow = z.object({
  id: Uuid, e164: z.string(), label: z.string().nullable(), purpose: z.string(),
  attributionSource: z.string().nullable(), channelId: Uuid.nullable(), campaignId: Uuid.nullable(),
  forwardsToE164: z.string().nullable(), routedHere: z.boolean(), whisper: z.boolean(),
  recordCalls: z.boolean(), routeByHours: z.boolean(), afterHoursForwardsToE164: z.string().nullable(),
  /** The phone menu that answers it, when one does. */
  menuId: Uuid.nullable(),
  /** Answered here but brought rather than bought: releasing it never gives it away at the carrier. */
  adopted: z.boolean(),
});

const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "A number in full international form: +15125550123");

export const searchAvailableNumbers = defineRoute({
  method: "get",
  path: "/v1/marketing/available-numbers",
  summary: "Numbers your Twilio account can buy, by area code or town",
  description:
    "Asks the carrier, through the company's own connected Twilio account. Needs settings:write because every search is a request against that account.",
  module: "M19",
  permissions: ["settings:write"],
  input: z.object({
    areaCode: z.string().max(3).optional(),
    locality: z.string().max(60).optional(),
    region: z.string().max(2).optional(),
  }),
  output: z.object({
    numbers: z.array(z.object({
      e164: z.string(), friendlyName: z.string(), locality: z.string().nullable(), region: z.string().nullable(),
    })),
  }),
});

export const buyTrackingNumber = defineRoute({
  method: "post",
  path: "/v1/marketing/tracking-numbers",
  summary: "Buy a tracking number and point its calls here",
  description:
    "Bought from the company's own Twilio account with its voice and status webhooks set to this installation. Everything that can be refused is checked before the carrier is asked; if the number cannot be recorded afterwards it is handed back at the carrier. A pool number is one the website snippet shows to one visitor at a time. Buying a number already held here returns it.",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    e164: E164,
    purpose: z.enum(["tracking", "pool"]),
    label: z.string().max(100).optional(),
    campaignId: Uuid.optional(),
    channelId: Uuid.optional(),
    forwardsToE164: E164.optional(),
    whisper: z.boolean().optional(),
    recordCalls: z.boolean().optional(),
    routeByHours: z.boolean().optional(),
    afterHoursForwardsToE164: E164.optional(),
  }),
  output: NumberRow,
});

export const setNumberRouting = defineRoute({
  method: "patch",
  path: "/v1/marketing/tracking-numbers/{id}/routing",
  summary: "How calls to a number are answered",
  description:
    "Where they ring, whether the person answering hears the channel and campaign first, whether the caller is asked to agree to recording, and what happens outside business hours.",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    forwardsToE164: E164.nullable().optional(),
    whisper: z.boolean().optional(),
    recordCalls: z.boolean().optional(),
    routeByHours: z.boolean().optional(),
    afterHoursForwardsToE164: E164.nullable().optional(),
    /** A phone menu answers instead: the menu in business hours, and outside them where the menu says. Null goes back to ringing. */
    menuId: Uuid.nullable().optional(),
  }),
  output: NumberRow,
});

export const releasePhoneNumber = defineRoute({
  method: "post",
  path: "/v1/marketing/tracking-numbers/{id}/release",
  summary: "Hand a number back, at the carrier as well",
  description:
    "A number bought here is released at Twilio first and then here; if the carrier refuses, nothing changes. A number the company brought with it and had answered here is never released at Twilio: its calls are handed back to where they went before. Calls it already took keep their campaign. Releasing one already released answers as before.",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().max(300).optional() }),
  output: z.object({ id: Uuid, released: z.literal(true), nowSendingFrom: z.string().nullable() }),
});

/* ---------------------------------------------------------- the website */

const VisitorInput = {
  /** The company's public key: its slug. */
  companyKey: z.string().min(1).max(100),
  visitorId: z.string().min(12).max(64),
  page: z.string().max(2000).optional(),
  query: z.string().max(4000).optional(),
  referrer: z.string().max(2000).optional(),
};

export const recordPublicTouch = defineRoute({
  method: "post",
  path: "/v1/public/touches",
  summary: "A visitor arrived on the company's website",
  description:
    "Posted by the website snippet. Only attribution is kept: the utm tags, the click ids (gclid, gbraid, wbraid, fbclid, msclkid), a referral code, the page's path and the referring host. Counted per company, per address and per visitor and refused past a ceiling. The same arrival from the same visitor within half an hour is recognised and not counted twice, which is what makes a retry safe.",
  module: "M19",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({
    ...VisitorInput,
    /**
     * The `_ga` cookie the company's own Google Analytics tag set, and the
     * `_fbp` cookie Meta's pixel set, read by the snippet on the company's own
     * domain. Kept only when they are in those platforms' own shapes, and
     * used for nothing but telling those platforms about a booked job.
     */
    ga: z.string().max(100).optional(),
    fbp: z.string().max(100).optional(),
    /**
     * Fill those two onto the visitor's latest touch and record nothing new.
     * The analytics tag usually sets its cookie after the snippet has already
     * posted the arrival, so the snippet sends them again once the page has
     * loaded.
     */
    identify: z.boolean().optional(),
  }),
  output: z.object({ recorded: z.boolean(), touchId: Uuid.nullable() }),
});

export const getVisitorNumber = defineRoute({
  method: "get",
  path: "/v1/public/dni",
  summary: "The phone number to show this visitor",
  description:
    "A number from the company's pool, held for this visitor until they are quiet for the company's idle time, so a call on it can be matched back to the visit. With the pool empty, the tracking number for the visitor's source or the main number, not held. `targets` are the numbers on the page the snippet replaces.",
  module: "M19",
  permissions: [],
  authorization: "public",
  input: z.object(VisitorInput),
  output: z.object({
    number: z.string().nullable(),
    pooled: z.boolean(),
    targets: z.array(z.string()),
    idleSeconds: z.number().int(),
  }),
});

export const getWebsiteTracking = defineRoute({
  method: "get",
  path: "/v1/marketing/website-tracking",
  summary: "The snippet's key, the number pool and who holds each number",
  module: "M19",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    companyKey: z.string(),
    idleMinutes: z.number().int(),
    pool: z.array(z.object({
      id: Uuid, e164: z.string(), label: z.string().nullable(), heldSince: z.string().nullable(),
    })),
  }),
});

export const setWebsiteTracking = defineRoute({
  method: "patch",
  path: "/v1/marketing/website-tracking",
  summary: "How long a quiet visitor keeps their number",
  module: "M19",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ idleMinutes: z.number().int().min(5).max(240) }),
  output: z.object({ idleMinutes: z.number().int() }),
});

/* ------------------------------------------------------------ referrals */

const RewardSettings = z.object({
  reward: z.enum(["credit_note", "owed", "none"]),
  amount: z.string(),
});

const Reward = z.object({
  id: Uuid, kind: z.string(), amount: MoneyString, state: z.string(),
  creditNoteId: Uuid.nullable(), paidAt: z.string().nullable(),
});

export const getReferrals = defineRoute({
  method: "get",
  path: "/v1/marketing/referrals",
  summary: "Who refers customers, who they sent, and what they earned",
  module: "M19",
  permissions: ["adspend:read"],
  input: z.object({}),
  output: z.object({
    settings: RewardSettings,
    referrers: z.array(z.object({ id: Uuid, name: z.string(), referred: z.number().int(), rewarded: z.number().int() })),
    referred: z.array(z.object({
      id: Uuid, name: z.string(), referrerId: Uuid.nullable(), referrerName: z.string().nullable(),
      since: z.string(), reward: Reward.nullable(),
    })),
  }),
});

export const setReferralSettings = defineRoute({
  method: "put",
  path: "/v1/marketing/referral-settings",
  summary: "What a referral earns",
  description:
    "A credit note on the referrer's account, or a fixed amount recorded as owed, granted once when the referred customer's first job is paid in full. Or nothing.",
  module: "M19",
  permissions: ["settings:write"],
  input: z.object({ reward: z.enum(["credit_note", "owed", "none"]), amount: z.string().max(12).optional() }),
  output: RewardSettings,
});

export const settleReferralReward = defineRoute({
  method: "post",
  path: "/v1/marketing/referral-rewards/{id}/settle",
  summary: "Mark an owed reward paid, or withdraw a reward",
  module: "M19",
  permissions: ["invoice:credit"],
  idempotent: true,
  input: z.object({ id: Uuid, action: z.enum(["paid", "void"]), note: z.string().max(500).optional() }),
  output: z.object({ id: Uuid, state: z.string() }),
});

export const getCustomerReferral = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/referral",
  summary: "A customer's referral code, their link, who referred them and who they referred",
  module: "M19",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    code: z.string(), link: z.string(),
    referredBy: z.object({ id: Uuid, name: z.string() }).nullable(),
    referred: z.array(z.object({
      id: Uuid, name: z.string(), reward: z.object({ state: z.string(), amount: z.string() }).nullable(),
    })),
  }),
});

export const setCustomerReferrer = defineRoute({
  method: "put",
  path: "/v1/customers/{id}/referrer",
  summary: "Who referred this customer",
  description:
    "For a referral that arrived by word of mouth. Recorded as a declared touch naming the referrer, so attribution hears about it. An existing referrer is replaced only with `replace`, and not at all once a reward has been given for it.",
  module: "M19",
  permissions: ["customer:write"],
  input: z.object({ id: Uuid, referrerId: Uuid.nullable(), replace: z.boolean().optional() }),
  output: z.object({ customerId: Uuid, referredByCustomerId: Uuid.nullable() }),
});

export const viewPortalReferral = defineRoute({
  method: "get",
  path: "/v1/portal/referral",
  summary: "The customer's own referral link, from their account link",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: z.object({
    code: z.string(), link: z.string(),
    reward: z.object({ kind: z.string(), amount: z.string() }).nullable(),
    referred: z.array(z.object({ firstName: z.string(), rewarded: z.boolean() })),
  }),
});

export const trackingRoutes = {
  searchAvailableNumbers, buyTrackingNumber, setNumberRouting, releasePhoneNumber,
  recordPublicTouch, getVisitorNumber, getWebsiteTracking, setWebsiteTracking,
  getReferrals, setReferralSettings, settleReferralReward, getCustomerReferral, setCustomerReferrer,
  viewPortalReferral,
} as const;
