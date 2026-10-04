import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * DIRECT MAIL
 *
 * A mailing: an audience by the same rules a text campaign uses, a postcard
 * or letter design, the tracking campaign whose number is printed on it and
 * to which every response is credited, and a price per piece. Sending it
 * writes one piece per customer the rules select, each with its own code,
 * personal web address and QR code, and hands them to the mail house; what
 * they cost is recorded as spend on the tracking campaign. Creating and
 * sending is `campaign:write`, because it spends money by the piece.
 */

const Rule = z.record(z.unknown());
const Kind = z.enum(["postcard", "letter"]);

const MailInput = {
  name: z.string().min(1).max(200),
  kind: Kind,
  size: z.enum(["4x6", "6x9", "6x11"]).nullable().optional(),
  /** Core's audience rules, the same as a text campaign's. */
  audience: z.array(Rule).min(1).max(20),
  /** The tracking campaign responses are credited to. Left out, one is made under the direct mail channel. */
  acquisitionCampaignId: Uuid.nullable().optional(),
  /** HTML, with {{ mail.url }} printed somewhere a person can type it. */
  front: z.string().min(1).max(100_000),
  back: z.string().max(100_000).nullable().optional(),
  landingHeadline: z.string().max(200).nullable().optional(),
  landingBody: z.string().max(4000).nullable().optional(),
  pricePerPiece: MoneyString.nullable().optional(),
};

export const MailPieceCounts = z.object({
  id: Uuid,
  state: z.string(),
  pieces: z.number().int(),
  sent: z.number().int(),
  skipped: z.number().int(),
  refused: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int(),
});

export const listMailCampaigns = defineRoute({
  method: "get",
  path: "/v1/marketing/mail",
  summary: "Every mailing, with how many went and how many people opened their own address",
  module: "M19",
  permissions: ["campaign:read"],
  input: z.object({}),
  output: z.object({
    campaigns: z.array(z.object({
      id: Uuid, name: z.string(), kind: z.string(), size: z.string().nullable(), state: z.string(),
      sentOn: z.string().nullable(), trackingCampaign: z.string().nullable(),
      sent: z.number().int(), visited: z.number().int(), createdAt: z.string().datetime(),
    })),
  }),
});

export const createMailCampaign = defineRoute({
  method: "post",
  path: "/v1/marketing/mail",
  summary: "Draft a mailing",
  description:
    "Refused with the reason for an audience with no rules (it would be everybody), a design that uses a placeholder this cannot fill in (it would print as nothing), or one that does not print {{ mail.url }}, each person's own address, which is what ties a visit from the card to the mailing.",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object(MailInput),
  output: z.object({ id: Uuid }),
});

export const getMailCampaign = defineRoute({
  method: "get",
  path: "/v1/marketing/mail/{id}",
  summary: "One mailing, its pieces by state, and what it brought",
  description:
    "What it brought since it went: how many people opened their own address and how often, calls to its tracking number, jobs credited to its tracking campaign and their revenue, against what it cost.",
  module: "M19",
  permissions: ["campaign:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid, name: z.string(), kind: z.string(), size: z.string().nullable(), state: z.string(),
    sentOn: z.string().nullable(), audience: z.array(Rule), sentence: z.string().nullable(),
    acquisitionCampaignId: Uuid, trackingCampaign: z.string().nullable(),
    front: z.string(), back: z.string().nullable(),
    landingHeadline: z.string().nullable(), landingBody: z.string().nullable(),
    pricePerPiece: MoneyString.nullable(),
    pieces: MailPieceCounts,
    results: z.object({
      visited: z.number().int(), visits: z.number().int(), calls: z.number().int(), jobs: z.number().int(),
      revenue: MoneyString, spend: MoneyString,
    }),
  }),
});

export const updateMailCampaign = defineRoute({
  method: "patch",
  path: "/v1/marketing/mail/{id}",
  summary: "Change a mailing that has not gone",
  description: "A mailing that has gone to the printer cannot be changed: what is in letterboxes is a record.",
  module: "M19",
  permissions: ["campaign:write"],
  input: z.object({
    id: Uuid,
    name: MailInput.name.optional(),
    kind: Kind.optional(),
    size: MailInput.size,
    audience: MailInput.audience.optional(),
    acquisitionCampaignId: MailInput.acquisitionCampaignId,
    front: MailInput.front.optional(),
    back: MailInput.back,
    landingHeadline: MailInput.landingHeadline,
    landingBody: MailInput.landingBody,
    pricePerPiece: MailInput.pricePerPiece,
  }),
  output: z.object({ id: Uuid }),
});

export const previewMailCampaign = defineRoute({
  method: "get",
  path: "/v1/marketing/mail/{id}/preview",
  summary: "Who it would go to, how many can be posted, what it would cost, and how the first card reads",
  module: "M19",
  permissions: ["campaign:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    sentence: z.string(),
    selected: z.number().int(),
    overflow: z.boolean(),
    postable: z.number().int(),
    noAddress: z.number().int(),
    estimatedCost: MoneyString,
    trackingPhone: z.string().nullable(),
    returnAddress: z.object({
      name: z.string(), line1: z.string(), line2: z.string().nullable(), city: z.string(), state: z.string(), postalCode: z.string(),
    }).nullable(),
    sample: z.array(z.object({ customerId: Uuid, name: z.string(), address: z.string(), postable: z.boolean() })),
    front: z.string(),
    back: z.string().nullable(),
  }),
});

export const sendMailCampaign = defineRoute({
  method: "post",
  path: "/v1/marketing/mail/{id}/send",
  summary: "Send a mailing: freeze who it goes to and hand the first hundred pieces to the printer",
  description:
    "The first press writes one piece per customer the rules select, a customer with no postable address skipped with the reason, and hands the first hundred to the mail house, each under its own id as the printer's idempotency key; the worker sends the rest. Safe to repeat. Needs a mail house connected, the office's address under Settings, Locations (the return address) and PUBLIC_URL (each piece's own address is on this installation).",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: MailPieceCounts,
});

export const cancelMailCampaign = defineRoute({
  method: "post",
  path: "/v1/marketing/mail/{id}/cancel",
  summary: "Stop a mailing: a draft never goes, and pieces not yet with the printer are not sent",
  module: "M19",
  permissions: ["campaign:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, state: z.string() }),
});

export const listMailPieces = defineRoute({
  method: "get",
  path: "/v1/marketing/mail/{id}/pieces",
  summary: "Every piece of a mailing: who, where, its own address, what the printer said, and its visits",
  module: "M19",
  permissions: ["campaign:read"],
  input: z.object({
    id: Uuid,
    status: z.enum(["pending", "sent", "skipped", "refused", "failed"]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  output: z.object({
    pieces: z.array(z.object({
      id: Uuid, customerId: Uuid, name: z.string(), address: z.string(), code: z.string(), url: z.string(),
      status: z.string(), reason: z.string().nullable(), providerId: z.string().nullable(),
      expectedDeliveryOn: z.string().nullable(), sentAt: z.string().datetime().nullable(),
      firstVisitedAt: z.string().datetime().nullable(), visits: z.number().int(),
    })),
  }),
});

export const directMailRoutes = {
  listMailCampaigns, createMailCampaign, getMailCampaign, updateMailCampaign, previewMailCampaign,
  sendMailCampaign, cancelMailCampaign, listMailPieces,
} as const;
