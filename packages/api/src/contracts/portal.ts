import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, Address, Timestamps } from "./common";
import { Estimate } from "./estimates";

/**
 * THE CUSTOMER SIDE
 *
 * Every route in this file is reached by a bearer token in the URL, held by
 * someone with no account and no session. That changes three things about how
 * they are written.
 *
 * They declare no permissions, because the grant IS the permission: its scope
 * says what may be done and to which single record, and it cannot be widened.
 * They never take an id the caller could change to reach another record; the
 * subject comes from the grant, not from the request. And they return only
 * what the customer is entitled to see, which is a much smaller shape than the
 * office sees of the same record.
 *
 * `internal: false` on all of them: these are the most public endpoints in the
 * product and their contract is part of the promise.
 */

export const PortalScope = z.enum(["estimate", "job", "invoice", "customer", "booking"]);

export const PortalSession = z.object({
  organizationName: z.string(),
  organizationLogoUrl: z.string().url().nullable(),
  customerName: z.string(),
  scope: PortalScope,
  expiresAt: z.string().datetime(),
});

/**
 * Exchanging a link for what it reaches. A read, so it does not spend a use:
 * every refresh of a tracking page would otherwise burn one, which makes a
 * single use payment link unusable.
 */
export const openPortalLink = defineRoute({
  method: "get",
  path: "/v1/portal/session",
  summary: "Open a customer link",
  description: "Takes the token from the link. Returns what it reaches and nothing else.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: PortalSession,
});

/** What the customer sees of their own estimate. No cost, no margin, ever. */
export const PortalEstimate = Estimate.omit({ options: true }).extend({
  organizationName: z.string(),
  propertyAddress: z.string(),
  options: z.array(z.object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    isRecommended: z.boolean(),
    subtotal: MoneyString,
    taxTotal: MoneyString,
    total: MoneyString,
    baseTotal: MoneyString,
    lines: z.array(z.object({
      id: Uuid,
      name: z.string(),
      description: z.string().nullable(),
      quantity: MoneyString,
      lineTotal: MoneyString,
      isOptional: z.boolean(),
      isSelected: z.boolean(),
    })),
  })),
  depositRequired: MoneyString.nullable(),
  /** The terms shown above the signature box, as displayed. */
  termsText: z.string().nullable(),
});

export const viewPortalEstimate = defineRoute({
  method: "get",
  path: "/v1/portal/estimate",
  summary: "View an estimate as the customer",
  description:
    "Marks the estimate viewed the first time, which is what makes 'sent and never opened' distinguishable from 'read and ignored'. Those two need different follow up.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: PortalEstimate,
});

/**
 * The customer says yes.
 *
 * This is the endpoint the whole phase exists for, and it spends the grant:
 * an approval link is single use, so a forwarded link cannot approve a second
 * time or approve a different option after the fact.
 *
 * The signature record captures the document hash rather than only the image.
 * A disagreement later about what was agreed is answerable from the hash and
 * unanswerable from a picture of a name.
 */
export const approvePortalEstimate = defineRoute({
  method: "post",
  path: "/v1/portal/estimate/approve",
  summary: "Approve an estimate",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: z.string().min(20).max(200),
    optionId: Uuid,
    selectedLineIds: z.array(Uuid).default([]),
    signerName: z.string().min(1).max(200),
    /** Data URL or uploaded reference. Optional: a typed name is a signature. */
    signatureImage: z.string().max(200_000).optional(),
    acceptedTerms: z.literal(true),
  }),
  output: z.object({
    estimate: PortalEstimate,
    /** Present when the company asks for money before the work. */
    depositDue: MoneyString.nullable(),
    paymentUrl: z.string().url().nullable(),
  }),
});

export const declinePortalEstimate = defineRoute({
  method: "post",
  path: "/v1/portal/estimate/decline",
  summary: "Decline an estimate",
  description:
    "The reason is optional and worth asking for anyway. Decline reasons are the only direct signal a company gets about its own pricing.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: z.string().min(20).max(200),
    reason: z.string().max(1000).optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
});

export const PortalTimelineEvent = z.object({
  kind: z.enum([
    "booked", "confirmed", "scheduled", "rescheduled", "dispatched",
    "on_the_way", "arrived", "in_progress", "completed", "cancelled",
    "estimate_sent", "estimate_viewed", "estimate_approved", "estimate_declined",
    "invoice_sent", "payment_received", "report_published", "message_sent",
  ]),
  headline: z.string(),
  detail: z.string().nullable(),
  occurredAt: z.string().datetime(),
});

/**
 * The tracking page. The heaviest read in the product: a customer refreshes it
 * through a four hour arrival window. The timeline is written as things happen
 * rather than assembled here, so this stays one indexed read.
 */
export const viewPortalJob = defineRoute({
  method: "get",
  path: "/v1/portal/job",
  summary: "Track a job",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: z.object({
    organizationName: z.string(),
    jobNumber: z.number().int(),
    status: z.string(),
    summary: z.string().nullable(),
    propertyAddress: z.string(),
    scheduledDate: z.string().date().nullable(),
    arrivalWindow: z.string().nullable(),
    /** First name and photo only. Never a phone number or a last name. */
    technician: z.object({
      firstName: z.string(),
      photoUrl: z.string().url().nullable(),
    }).nullable(),
    /** Set only once the technician is actually en route. */
    etaMinutes: z.number().int().nullable(),
    timeline: z.array(PortalTimelineEvent),
  }),
});

export const PortalGrant = z.object({
  id: Uuid,
  scope: PortalScope,
  subjectId: Uuid.nullable(),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
}).merge(Timestamps);

/** Issuing a link from the office or a technician's phone. */
export const issuePortalGrant = defineRoute({
  method: "post",
  path: "/v1/portal/grants",
  summary: "Issue a customer link",
  module: "M05",
  permissions: ["portal:grant"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    scope: PortalScope,
    subjectId: Uuid.optional(),
    expiresInDays: z.number().int().min(1).max(365).default(30),
    maxUses: z.number().int().min(1).max(1000).optional(),
  }),
  output: z.object({
    grant: PortalGrant,
    /** Exists exactly once, here. Only the hash is stored. */
    url: z.string().url(),
  }),
});

export const revokePortalGrant = defineRoute({
  method: "post",
  path: "/v1/portal/grants/{id}/revoke",
  summary: "Withdraw a customer link",
  module: "M05",
  permissions: ["portal:revoke"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const portalRoutes = {
  openPortalLink, viewPortalEstimate, approvePortalEstimate, declinePortalEstimate,
  viewPortalJob, issuePortalGrant, revokePortalGrant,
} as const;

export { Address };
