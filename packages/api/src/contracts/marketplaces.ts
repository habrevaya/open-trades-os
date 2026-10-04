import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THE LEAD MARKETPLACES AND THE LEAD INBOX
 *
 * Angi, Thumbtack and Yelp set up as lead sources that post to the same lead
 * endpoint the generic webhook uses, each verified its own way; a lead offer
 * read whole with its message thread; a reply sent back through the
 * marketplace; and the company's lead inbox address, which the marketplaces'
 * lead emails are forwarded to for the platforms with no API access. Every
 * marketplace API needs that marketplace's approval of the operator as a
 * partner; the code is tested against fakes of each.
 */

export const connectLeadMarketplace = defineRoute({
  method: "post",
  path: "/v1/lead-marketplaces",
  summary: "Set up Angi, Thumbtack or Yelp as a lead source, and get the address to give it",
  description:
    "One per marketplace per company; setting one up again changes it and keeps its address, because the marketplace is already posting there. Thumbtack and Yelp need the business id and the NAME of the secret holding the access token their partner API gave you. Angi and Thumbtack post with HTTP Basic credentials: give the name your secret store will keep the password under, and the password is returned once here, to keep there and to give to the marketplace. Yelp posts only that something happened, and the lead is read back from Yelp with the token. Each marketplace has to approve you as a partner before any of this answers.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    platform: z.enum(["angi", "thumbtack", "yelp"]),
    displayName: z.string().min(1).max(200).optional(),
    channelId: Uuid.optional(),
    campaignId: Uuid.optional(),
    businessId: z.string().min(1).max(200).optional(),
    apiTokenRef: z.string().min(1).max(200).optional(),
    webhookSecretRef: z.string().min(1).max(200).optional(),
  }),
  output: z.object({
    id: Uuid,
    platform: z.string(),
    displayName: z.string(),
    channelId: Uuid.nullable(),
    campaignId: Uuid.nullable(),
    /** Append to this deployment's public address to get the URL to give the marketplace. */
    webhookPath: z.string(),
    webhookSecretRef: z.string().nullable(),
    /** Shown once, for Angi and Thumbtack. Null on a repeat of the same request. */
    password: z.string().nullable(),
    replies: z.boolean(),
    needsApproval: z.boolean(),
    approval: z.string(),
  }),
});

export const LeadOfferMessage = z.object({
  id: Uuid,
  /** `inbound` from the customer, `outbound` from the office. */
  direction: z.string(),
  body: z.string(),
  /** `received`, `sending`, `sent` or `failed`. */
  state: z.string(),
  /** The marketplace's words when it refused a reply. */
  error: z.string().nullable(),
  at: z.string().datetime(),
});

export const getLeadOffer = defineRoute({
  method: "get",
  path: "/v1/lead-offers/{id}",
  summary: "One lead offer: who, what, where, what it cost, and its message thread",
  module: "M19",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    status: z.string(),
    connector: z.string(),
    kind: z.string(),
    source: z.string(),
    channelName: z.string().nullable(),
    campaignName: z.string().nullable(),
    externalId: z.string(),
    contactName: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
    serviceRequested: z.string().nullable(),
    notes: z.string().nullable(),
    addressLine1: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    estimatedValue: MoneyString.nullable(),
    /** What the marketplace charged for it, when it said. */
    charge: MoneyString.nullable(),
    expiresAt: z.string().datetime().nullable(),
    expired: z.boolean(),
    customerId: Uuid.nullable(),
    jobId: Uuid.nullable(),
    declineReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    /** Whether a reply can go back through the marketplace, and why not when it cannot. */
    canReply: z.boolean(),
    cannotReplyBecause: z.string().nullable(),
    messages: z.array(LeadOfferMessage),
  }),
});

export const sendLeadOfferMessage = defineRoute({
  method: "post",
  path: "/v1/lead-offers/{id}/messages",
  summary: "Reply to the customer on a lead, through the marketplace that sold it",
  description:
    "Thumbtack and Yelp only: a customer whose number the marketplace withholds can be reached through it and no other way. The reply is written down before the marketplace is asked, so a double press sends it once; a refusal is kept on the reply in the marketplace's words and the reply shows as not sent.",
  module: "M19",
  permissions: ["message:send"],
  idempotent: true,
  input: z.object({ id: Uuid, body: z.string().min(1).max(2000) }),
  output: z.object({ id: Uuid, state: z.string(), error: z.string().nullable() }),
});

const LeadInbox = z.object({
  /** The address to forward the marketplaces' lead emails to, or null while the company cannot receive email. */
  address: z.string().nullable(),
  missing: z.string().nullable(),
  platforms: z.array(z.object({
    key: z.string(), label: z.string(), api: z.string(), replies: z.boolean(), needsApproval: z.boolean(), approval: z.string(),
  })),
});

export const getLeadInbox = defineRoute({
  method: "get",
  path: "/v1/lead-inbox",
  summary: "The company's lead inbox address, and what each marketplace will let this product do",
  description:
    "`leads+TOKEN@` the domain the company's email provider receives replies on. Forward Angi's, HomeAdvisor's, Thumbtack's, Yelp's and Nextdoor's lead emails to it and each becomes a lead offer credited to the platform that sent it. The address is made the first time anybody asks for it.",
  module: "M19",
  permissions: ["integration:read"],
  input: z.object({}),
  output: LeadInbox,
});

export const rotateLeadInbox = defineRoute({
  method: "post",
  path: "/v1/lead-inbox/rotate",
  summary: "Give the lead inbox a new address and stop the old one",
  description: "For an address that leaked. Forwarding rules pointed at the old address stop delivering, so change them.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({}),
  output: LeadInbox,
});

export const listLeadEmails = defineRoute({
  method: "get",
  path: "/v1/lead-inbox/emails",
  summary: "Every email the lead inbox received and what became of it",
  description:
    "`lead` made an offer, `message` was the customer writing again on a lead already here, `duplicate` was a lead already here, and `unreadable` is kept with the reason for a person to read: a layout this could not read, a lead with nobody to call, or the mailbox's own confirmation of a forwarding rule.",
  module: "M19",
  permissions: ["job:read"],
  input: z.object({
    outcome: z.enum(["lead", "message", "duplicate", "unreadable"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    emails: z.array(z.object({
      id: Uuid,
      receivedAt: z.string().datetime(),
      from: z.string(),
      subject: z.string().nullable(),
      platform: z.string().nullable(),
      platformLabel: z.string().nullable(),
      outcome: z.string(),
      reason: z.string().nullable(),
      offerId: Uuid.nullable(),
      excerpt: z.string().nullable(),
    })),
  }),
});

export const marketplaceRoutes = {
  connectLeadMarketplace, getLeadOffer, sendLeadOfferMessage, getLeadInbox, rotateLeadInbox, listLeadEmails,
} as const;
